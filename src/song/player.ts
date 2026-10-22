import type { Song, SongNote } from './types';

export type StepState = 'upcoming' | 'current' | 'done';

/** «Ожидание» — ноты стоят, пока не сыграешь; «В такт» — ноты едут, играть надо в окно у линии. */
export type PlayMode = 'wait' | 'tempo';

/** Итог удара в режиме «В такт». */
export type Judgement = 'hit' | 'early' | 'late' | 'wrong' | 'ignored';

/** Шаг песни — ноты с одинаковым началом (одиночная нота или аккорд). */
export interface Step {
  index: number;
  start: number;
  notes: SongNote[];
  state: StepState;
  mistakes: number;
  /** Отклонение удара от доли, с (только «В такт», после попадания). */
  offsetSec: number | null;
  /** «В такт»: сыграно после окна (игра стояла и ждала). */
  late: boolean;
  /** «В такт»: была попытка раньше окна (не засчитана). */
  early: boolean;
  /** Запись: шаг проехал, не сыгран (игра не ждёт). */
  missed: boolean;
}

export interface TempoWindow {
  /** Насколько раньше доли можно сыграть, с. */
  earlySec: number;
  /** Насколько позже доли можно сыграть, с. */
  lateSec: number;
  /**
   * Поправка на задержку всей цепочки (экран → человек → пианино → микрофон → детектор), с:
   * удар через latencySec после касания нотой линии считается сыгранным ровно в долю.
   * На iPhone + цифровом пианино живые удары «вовремя» шли с +100…+164 мс и ни одного раньше.
   */
  latencySec: number;
}

export const DEFAULT_WINDOW: TempoWindow = { earlySec: 0.18, lateSec: 0.18, latencySec: 0.12 };

/**
 * Логика прохождения песни, без DOM и аудио.
 *
 * «Ожидание»: ноты едут к линии; если текущий шаг дошёл до линии, а не сыгран — время
 * останавливается. Сыграть текущий шаг можно и заранее.
 *
 * «В такт»: позиция идёт от аудиочасов (tick), у каждого шага есть момент доли; удар «вовремя»,
 * если пришёлся в окно [доля − early, доля + late] (нота касается линии). Раньше окна — «рано»:
 * не засчитано, шаг ещё можно сыграть вовремя. Окно прошло — игра ОСТАНАВЛИВАЕТСЯ и ждёт правильную ноту; сыгранная после
 * остановки нота засчитывается как «поздно», и ритм продолжается от этого удара.
 */
export class SongPlayer {
  readonly steps: Step[];
  /** Позиция линии удара, доли. До начала — отрицательная (вступление). */
  beat: number;
  /**
   * Позиция для отрисовки. «В такт»: сдвинута на поправку задержки (нота касается линии в момент,
   * когда нужно ударить) и НЕ уходит за линию, пока текущий шаг не сыгран — нота стоит над
   * клавишей; после удара позиция плавно догоняет ритм.
   */
  displayBeat: number;
  waiting = false;
  hits = 0;
  mistakes = 0;
  /** Шаги, сыгранные после окна («В такт»). */
  lates = 0;
  /** Нажатия раньше окна («В такт») — не засчитаны и не ошибки. */
  earlies = 0;
  /** Сыгранные (засчитанные) ноты за эту игру — каждая нота аккорда отдельно; основа оплаты. */
  playedNotes = 0;
  /** Время игры, с. */
  elapsedSec = 0;
  /** Последнее отклонение попадания от доли, с («В такт»). */
  lastOffsetSec: number | null = null;
  private idx = 0;
  /** Аудиовремя, когда beat = −leadIn («В такт»). */
  private startTime: number | null = null;
  private endTime: number | null = null;
  /** «В такт»: аудиовремя, с которого игра стоит в ожидании (окно текущего шага прошло). */
  private pausedAt: number | null = null;
  private lastTickAt: number | null = null;

  constructor(
    readonly song: Song,
    readonly mode: PlayMode = 'wait',
    readonly leadInBeats = 4,
    readonly window: TempoWindow = DEFAULT_WINDOW,
    /** Множитель темпа (0.5–1): учиться можно медленнее, чем записано в песне. */
    readonly tempoFactor = 1,
    /**
     * Запись по сценарию («В такт» без остановок): ноты едут в своём темпе, не сыгранный шаг
     * проезжает; у каждого шага своё окно (recordWindow) — в нём проверяем именно его ноты.
     */
    readonly freeRun = false,
  ) {
    const byStart = new Map<number, SongNote[]>();
    for (const n of [...song.notes].sort((a, b) => a.start - b.start)) {
      const key = Math.round(n.start * 1000) / 1000;
      if (!byStart.has(key)) byStart.set(key, []);
      byStart.get(key)!.push(n);
    }
    this.steps = [...byStart.entries()].map(([start, notes], index) => ({
      index,
      start,
      notes,
      state: 'upcoming',
      mistakes: 0,
      offsetSec: null,
      late: false,
      early: false,
      missed: false,
    }));
    this.beat = -leadInBeats;
    this.displayBeat = this.beat;
    this.markCurrent();
  }

  get current(): Step | null {
    return this.steps[this.idx] ?? null;
  }

  get finished(): boolean {
    return this.idx >= this.steps.length;
  }

  /** Темп игры с учётом множителя. */
  get bpm(): number {
    return this.song.bpm * this.tempoFactor;
  }

  get secPerBeat(): number {
    return 60 / this.bpm;
  }

  /** Ноты, которые сейчас нужно сыграть (для анализатора). */
  expected(): number[] {
    const cur = this.current;
    return cur ? this.checkFor(cur) : [];
  }

  /** Что анализатор проверяет на шаге: обычно его ноты, в записи — возможно, тайно другие. */
  checkFor(step: Step): number[] {
    const secret = this.song.checkAs?.find((c) => Math.abs(c.start - step.start) < 1e-3);
    return [...new Set(secret ? secret.midis : step.notes.map((n) => n.pitch))].sort((a, b) => a - b);
  }

  /**
   * Запись: окно шага в аудиовремени — от чуть раньше его доли (с поправкой задержки) до начала окна
   * следующего. Запас до доли — половина промежутка от прошлого шага, но не больше 0.3 с.
   */
  recordWindow(i: number): [number, number] | null {
    const s = this.steps[i];
    const t = s ? this.stepTime(s) : null;
    if (!s || t === null) return null;
    const startOf = (k: number) => {
      const tk = this.stepTime(this.steps[k])! + this.window.latencySec;
      const gap = k > 0 ? (this.steps[k].start - this.steps[k - 1].start) * this.secPerBeat : 1;
      return tk - Math.min(0.3, gap / 2);
    };
    const end = i + 1 < this.steps.length ? startOf(i + 1) : t + this.window.latencySec + 1.2;
    return [startOf(i), end];
  }

  /** Аудиовремя доли шага («В такт»); null — песня ещё не запущена. */
  stepTime(step: Step): number | null {
    return this.startTime === null ? null : this.startTime + (step.start + this.leadInBeats) * this.secPerBeat;
  }

  /** «Ожидание»: продвинуть время на dt секунд звука. */
  advance(dt: number): void {
    if (dt <= 0) return;
    const next = this.beat + dt / this.secPerBeat;
    const cur = this.current;
    if (!cur) {
      this.beat = this.displayBeat = next; // песня сыграна — ноты уезжают вниз
      return;
    }
    this.elapsedSec += dt;
    if (next >= cur.start) {
      this.beat = Math.max(this.beat, cur.start);
      this.waiting = true;
    } else {
      this.beat = next;
      this.waiting = false;
    }
    this.displayBeat = this.beat;
  }

  /** «В такт»: выставить позицию по аудиочасам; если окно текущего шага прошло — встать и ждать. */
  tick(now: number): void {
    if (this.startTime === null) this.startTime = now;
    if (this.freeRun) {
      // Запись: без остановок; окно шага прошло — шаг проехал
      this.beat = -this.leadInBeats + (now - this.startTime) / this.secPerBeat;
      while (this.current && now >= this.recordWindow(this.idx)![1]) {
        const cur = this.current;
        cur.state = 'done';
        cur.missed = true;
        this.idx++;
        this.markCurrent();
      }
      this.displayBeat = this.beat - this.window.latencySec / this.secPerBeat;
      this.waiting = false;
      if (this.finished && this.endTime === null) this.endTime = now;
      this.elapsedSec = Math.max(0, (this.endTime ?? now) - this.startTime - this.leadInBeats * this.secPerBeat);
      return;
    }
    if (this.pausedAt === null) {
      this.beat = -this.leadInBeats + (now - this.startTime) / this.secPerBeat;
      const cur = this.current;
      if (cur) {
        const deadline = this.stepTime(cur)! + this.window.latencySec + this.window.lateSec;
        if (now > deadline) {
          this.pausedAt = deadline;
          this.beat = cur.start + (this.window.latencySec + this.window.lateSec) / this.secPerBeat;
        }
      }
    }
    this.waiting = this.pausedAt !== null;
    // Отрисовка: со сдвигом на поправку задержки и не дальше линии, пока шаг не сыгран
    const cur = this.current;
    let raw = this.beat - this.window.latencySec / this.secPerBeat;
    if (cur) raw = Math.min(raw, cur.start);
    const dt = this.lastTickAt === null ? 1 : Math.max(0, now - this.lastTickAt);
    this.lastTickAt = now;
    // Назад — сразу (ноту не «утаскивает» за линию), вперёд — плавно догоняем (~0.12 с)
    const next = raw <= this.displayBeat ? raw : this.displayBeat + (raw - this.displayBeat) * Math.min(1, dt / 0.12);
    this.displayBeat = raw - next < 1e-3 ? raw : next; // доехали — встаём точно на линию
    if (this.finished && this.endTime === null) this.endTime = now;
    const pause = this.pausedAt !== null ? now - this.pausedAt : 0;
    this.elapsedSec = Math.max(0, (this.endTime ?? now) - pause - this.startTime - this.leadInBeats * this.secPerBeat);
  }

  /** «Ожидание»: вердикт по текущему шагу. Возвращает true, если шаг засчитан. */
  result(passed: boolean): boolean {
    const cur = this.current;
    if (!cur) return false;
    if (!passed) {
      cur.mistakes++;
      this.mistakes++;
      return false;
    }
    this.complete(cur);
    return true;
  }

  /**
   * «В такт»: вердикт анализатора + момент удара (аудиовремя атаки) + текущее аудиовремя.
   * Удар оценивается по атаке, а не по вердикту — задержка распознавания на ритм не влияет.
   */
  judge(passed: boolean, onsetTime: number, _now: number): Judgement {
    const cur = this.current;
    const t = cur ? this.stepTime(cur) : null;
    if (!cur || t === null) return 'ignored';
    const dt = onsetTime - t - this.window.latencySec;
    if (this.freeRun) {
      // Запись: окно шага задаёт сам сценарий, «рано»/«поздно» не нужны
      if (!passed) {
        cur.mistakes++;
        this.mistakes++;
        return 'wrong';
      }
      cur.offsetSec = dt;
      this.complete(cur);
      return 'hit';
    }
    if (!passed) {
      cur.mistakes++;
      this.mistakes++;
      return 'wrong';
    }
    // Нота засчитывается, только когда она касается линии (решение пользователя: иначе теряется
    // смысл — ноты не играются в такт). Раньше окна — «рано»: не засчитано, не ошибка, нота летит
    // дальше; UI обязан это показать, иначе выглядит как «не слышит нажатие».
    if (dt < -this.window.earlySec) {
      cur.early = true;
      this.earlies++;
      return 'early';
    }
    const late = dt > this.window.lateSec;
    cur.offsetSec = dt;
    cur.late = late;
    if (late) this.lates++;
    else this.lastOffsetSec = dt;
    this.complete(cur);
    if (late) this.hits--; // «поздно» — не «вовремя»
    if (late && this.startTime !== null) {
      // «Поздно»: ритм продолжается ОТ УДАРА — следующий шаг ровно через свою длительность после него.
      // (Если продолжать с места остановки, следующая нота придёт раньше, чем через долю после удара,
      // и человек, играющий в свой ритм, получает «поздно» цепочкой — так было в живом отчёте.)
      this.startTime = onsetTime - this.window.latencySec - (cur.start + this.leadInBeats) * this.secPerBeat;
    }
    this.pausedAt = null;
    this.waiting = false;
    if (this.finished && this.endTime === null) this.endTime = onsetTime; // конец песни — последний удар
    return late ? 'late' : 'hit';
  }

  /**
   * Предложение подстройки поправки: медиана отклонений сыгранных шагов (кроме долгих ожиданий),
   * если таких шагов не меньше 5. Возвращает сдвиг, с, или null.
   */
  suggestLatencyShift(): number | null {
    const o = this.steps
      .map((s) => s.offsetSec)
      .filter((x): x is number => x !== null && Math.abs(x) < 0.4)
      .sort((a, b) => a - b);
    if (o.length < 5) return null;
    return o.length % 2 ? o[o.length >> 1] : 0.5 * (o[o.length / 2 - 1] + o[o.length / 2]);
  }

  restart(): void {
    for (const s of this.steps) {
      s.state = 'upcoming';
      s.mistakes = 0;
      s.offsetSec = null;
      s.late = false;
      s.early = false;
      s.missed = false;
    }
    this.idx = 0;
    this.beat = this.displayBeat = -this.leadInBeats;
    this.waiting = false;
    this.hits = this.mistakes = this.lates = this.earlies = this.playedNotes = 0;
    this.lastTickAt = null;
    this.elapsedSec = 0;
    this.lastOffsetSec = null;
    this.startTime = this.endTime = this.pausedAt = null;
    this.markCurrent();
  }

  /** Диапазон нот песни. */
  range(): { low: number; high: number } {
    const p = this.song.notes.map((n) => n.pitch);
    return { low: Math.min(...p), high: Math.max(...p) };
  }

  private complete(cur: Step): void {
    cur.state = 'done';
    this.hits++;
    this.playedNotes += cur.notes.length;
    this.idx++;
    this.waiting = false;
    this.markCurrent();
  }

  private markCurrent(): void {
    const cur = this.current;
    if (cur) cur.state = 'current';
  }
}
