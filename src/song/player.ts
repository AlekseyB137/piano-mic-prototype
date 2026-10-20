import type { Song, SongNote } from './types';

export type StepState = 'upcoming' | 'current' | 'done';

/** Шаг песни — ноты с одинаковым началом (одиночная нота или аккорд). */
export interface Step {
  index: number;
  start: number;
  notes: SongNote[];
  state: StepState;
  mistakes: number;
}

/**
 * Логика режима ожидания, без DOM и аудио: позиция в долях, текущий шаг, засчитывание.
 * Ноты едут к линии; если текущий шаг дошёл до линии, а не сыгран — время останавливается.
 * Сыграть текущий шаг можно и заранее, пока он ещё подлетает.
 */
export class SongPlayer {
  readonly steps: Step[];
  /** Позиция линии удара, доли. До начала — отрицательная (вступление). */
  beat: number;
  waiting = false;
  hits = 0;
  mistakes = 0;
  /** Время игры (только пока идёт звук), с. */
  elapsedSec = 0;
  private idx = 0;

  constructor(
    readonly song: Song,
    readonly leadInBeats = 4,
  ) {
    const byStart = new Map<number, SongNote[]>();
    for (const n of [...song.notes].sort((a, b) => a.start - b.start)) {
      const key = Math.round(n.start * 1000) / 1000;
      if (!byStart.has(key)) byStart.set(key, []);
      byStart.get(key)!.push(n);
    }
    this.steps = [...byStart.entries()].map(([start, notes], index) => ({ index, start, notes, state: 'upcoming', mistakes: 0 }));
    this.beat = -leadInBeats;
    this.markCurrent();
  }

  get current(): Step | null {
    return this.steps[this.idx] ?? null;
  }

  get finished(): boolean {
    return this.idx >= this.steps.length;
  }

  /** Ноты, которые сейчас нужно сыграть (для анализатора). */
  expected(): number[] {
    const cur = this.current;
    return cur ? [...new Set(cur.notes.map((n) => n.pitch))].sort((a, b) => a - b) : [];
  }

  /** Продвинуть время на dt секунд звука. */
  advance(dt: number): void {
    if (dt <= 0) return;
    const next = this.beat + (dt * this.song.bpm) / 60;
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

  /** Вердикт по текущему шагу. Возвращает true, если шаг засчитан и песня пошла дальше. */
  result(passed: boolean): boolean {
    const cur = this.current;
    if (!cur) return false;
    if (!passed) {
      cur.mistakes++;
      this.mistakes++;
      return false;
    }
    cur.state = 'done';
    this.hits++;
    this.idx++;
    this.waiting = false;
    this.markCurrent();
    return true;
  }

  restart(): void {
    for (const s of this.steps) {
      s.state = 'upcoming';
      s.mistakes = 0;
    }
    this.idx = 0;
    this.beat = -this.leadInBeats;
    this.waiting = false;
    this.hits = this.mistakes = 0;
    this.elapsedSec = 0;
    this.markCurrent();
  }

  /** Диапазон нот песни. */
  range(): { low: number; high: number } {
    const p = this.song.notes.map((n) => n.pitch);
    return { low: Math.min(...p), high: Math.max(...p) };
  }

  private markCurrent(): void {
    const cur = this.current;
    if (cur) cur.state = 'current';
  }
}
