import type { NoteEvidence } from './chord-check';

export interface CheckNoteResult {
  midi: number;
  passed: boolean;
  hits: number;
  /** Лучший (по score) кадр за окно оценки. */
  evidence: NoteEvidence | null;
}

export interface CheckResult {
  onsetTime: number;
  decidedAt: number;
  latencyMs: number;
  allPassed: boolean;
  notes: CheckNoteResult[];
}

/** Задержка перед началом оценки: атака должна «въехать» в окно большого FFT. */
const SETTLE_SEC = 0.03;
/** Атаки ближе этого считаем одним ударом (неровно взятый аккорд). */
const SAME_STRIKE_SEC = 0.08;

/**
 * Окно оценки после атаки. Нота засчитывается, если проходит проверку
 * minHits кадров подряд в течение windowSec после удара.
 */
export class CheckSession {
  private active = false;
  private start = 0;
  private hits = new Map<number, number>();
  private bestHits = new Map<number, number>();
  private best = new Map<number, NoteEvidence>();
  private expected: number[] = [];
  reference: Float32Array | null = null;

  get isActive(): boolean {
    return this.active;
  }

  get startTime(): number {
    return this.start;
  }

  /** Вызывается при атаке. Возвращает результат предыдущего окна, если его пришлось закрыть. */
  onOnset(t: number, expected: number[], reference: Float32Array | null, minHits: number): CheckResult | null {
    if (expected.length === 0) return null;
    if (this.active && t - this.start < SAME_STRIKE_SEC) return null;
    const prev = this.active ? this.finalize(t, minHits) : null;
    this.active = true;
    this.start = t;
    this.expected = expected.slice();
    this.hits.clear();
    this.bestHits.clear();
    this.best.clear();
    this.reference = reference ? reference.slice() : null;
    return prev;
  }

  cancel(): void {
    this.active = false;
    this.reference = null;
  }

  update(t: number, evidence: NoteEvidence[], windowSec: number, minHits: number): CheckResult | null {
    if (!this.active) return null;
    if (t < this.start + SETTLE_SEC) return null;
    for (const e of evidence) {
      const h = e.passed ? (this.hits.get(e.midi) ?? 0) + 1 : 0;
      this.hits.set(e.midi, h);
      this.bestHits.set(e.midi, Math.max(h, this.bestHits.get(e.midi) ?? 0));
      const prev = this.best.get(e.midi);
      // Храним самый показательный кадр: прошедший, а среди равных — с большим score
      if (!prev || (e.passed && !prev.passed) || (e.passed === prev.passed && e.score > prev.score)) {
        this.best.set(e.midi, e);
      }
    }
    const allDone = this.expected.every((m) => (this.bestHits.get(m) ?? 0) >= minHits);
    if (allDone || t >= this.start + windowSec) return this.finalize(t, minHits);
    return null;
  }

  private finalize(t: number, minHits: number): CheckResult {
    this.active = false;
    this.reference = null;
    const notes = this.expected.map((midi) => {
      const hits = this.bestHits.get(midi) ?? 0;
      return { midi, hits, passed: hits >= minHits, evidence: this.best.get(midi) ?? null };
    });
    return {
      onsetTime: this.start,
      decidedAt: t,
      latencyMs: Math.round((t - this.start) * 1000),
      allPassed: notes.every((n) => n.passed),
      notes,
    };
  }
}
