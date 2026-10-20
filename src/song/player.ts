import type { Song, SongNote } from './types';

export type StepState = 'upcoming' | 'current' | 'done' | 'missed';

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
}

export interface TempoWindow {
  /** Насколько раньше доли можно сыграть, с. */
  earlySec: number;
  /** Насколько позже доли можно сыграть, с. */
  lateSec: number;
}

export const DEFAULT_WINDOW: TempoWindow = { earlySec: 0.18, lateSec: 0.18 };

/**
 * Логика прохождения песни, без DOM и аудио.
 *
 * «Ожидание»: ноты едут к линии; если текущий шаг дошёл до линии, а не сыгран — время
 * останавливается. Сыграть текущий шаг можно и заранее.
 *
 * «В такт»: время не останавливается. Позиция считается прямо от аудиочасов (tick), у каждого
 * шага есть момент доли; удар засчитывается, если пришёлся в окно [доля − early, доля + late].
 * Раньше окна — ошибка «рано» (шаг ещё можно сыграть вовремя), окно прошло — шаг «пропущен».
 */
export class SongPlayer {
  readonly steps: Step[];
  /** Позиция линии удара, доли. До начала — отрицательная (вступление). */
  beat: number;
  waiting = false;
  hits = 0;
  mistakes = 0;
  /** Пропущенные шаги («В такт»). */
  misses = 0;
  /** Время игры, с. */
  elapsedSec = 0;
  /** Последнее отклонение попадания от доли, с («В такт»). */
  lastOffsetSec: number | null = null;
  private idx = 0;
  /** Аудиовремя, когда beat = −leadIn («В такт»). */
  private startTime: number | null = null;
  private endTime: number | null = null;

  constructor(
    readonly song: Song,
    readonly mode: PlayMode = 'wait',
    readonly leadInBeats = 4,
    readonly window: TempoWindow = DEFAULT_WINDOW,
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
    }));
    this.beat = -leadInBeats;
    this.markCurrent();
  }

  get current(): Step | null {
    return this.steps[this.idx] ?? null;
  }

  get finished(): boolean {
    return this.idx >= this.steps.length;
  }

  get secPerBeat(): number {
    return 60 / this.song.bpm;
  }

  /** Ноты, которые сейчас нужно сыграть (для анализатора). */
  expected(): number[] {
    const cur = this.current;
    return cur ? [...new Set(cur.notes.map((n) => n.pitch))].sort((a, b) => a - b) : [];
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
      this.beat = next; // песня сыграна — ноты уезжают вниз
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
  }

  /**
   * «В такт»: выставить позицию по аудиочасам и закрыть шаги, чьё окно прошло.
   * holdMiss — анализатор ещё разбирает удар: не помечать пропуск, пока не придёт вердикт
   * (удар в конце окна даёт вердикт уже после окна; лаг измеряется по атаке, а не по вердикту).
   * Возвращает шаги, которые только что стали «пропущенными».
   */
  tick(now: number, holdMiss = false): Step[] {
    if (this.startTime === null) this.startTime = now;
    this.beat = -this.leadInBeats + (now - this.startTime) / this.secPerBeat;
    const missed: Step[] = [];
    let cur = this.current;
    while (cur && !holdMiss && now > this.stepTime(cur)! + this.window.lateSec) {
      cur.state = 'missed';
      this.misses++;
      missed.push(cur);
      this.idx++;
      this.markCurrent();
      cur = this.current;
    }
    if (this.finished && this.endTime === null) this.endTime = now;
    this.elapsedSec = Math.max(0, (this.endTime ?? now) - this.startTime - this.leadInBeats * this.secPerBeat);
    return missed;
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

  /** «В такт»: вердикт анализатора + момент удара (аудиовремя атаки). */
  judge(passed: boolean, onsetTime: number): Judgement {
    const cur = this.current;
    const t = cur ? this.stepTime(cur) : null;
    if (!cur || t === null) return 'ignored';
    const dt = onsetTime - t;
    if (!passed) {
      cur.mistakes++;
      this.mistakes++;
      return 'wrong';
    }
    if (dt < -this.window.earlySec) {
      cur.mistakes++;
      this.mistakes++;
      return 'early';
    }
    if (dt > this.window.lateSec) {
      // Окно уже закрылось (вердикт пришёл позже tick) — шаг будет пропущен
      cur.mistakes++;
      this.mistakes++;
      return 'late';
    }
    cur.offsetSec = dt;
    this.lastOffsetSec = dt;
    this.complete(cur);
    if (this.finished && this.endTime === null && this.startTime !== null) {
      this.endTime = onsetTime; // конец песни — последний удар
      this.elapsedSec = Math.max(0, onsetTime - this.startTime - this.leadInBeats * this.secPerBeat);
    }
    return 'hit';
  }

  restart(): void {
    for (const s of this.steps) {
      s.state = 'upcoming';
      s.mistakes = 0;
      s.offsetSec = null;
    }
    this.idx = 0;
    this.beat = -this.leadInBeats;
    this.waiting = false;
    this.hits = this.mistakes = this.misses = 0;
    this.elapsedSec = 0;
    this.lastOffsetSec = null;
    this.startTime = this.endTime = null;
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
    this.idx++;
    this.waiting = false;
    this.markCurrent();
  }

  private markCurrent(): void {
    const cur = this.current;
    if (cur) cur.state = 'current';
  }
}
