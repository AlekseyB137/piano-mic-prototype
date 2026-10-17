export interface OnsetParams {
  /** Множитель медианы недавнего потока (адаптивная часть порога). */
  multiplier: number;
  /** Абсолютная добавка к порогу (задаётся калибровкой шума). */
  delta: number;
  /** Минимальный интервал между атаками, с. */
  minIntervalSec: number;
}

export interface OnsetResult {
  flux: number;
  threshold: number;
  /** Время обнаруженной атаки (с) или null. */
  onsetTime: number | null;
  onsetFlux: number;
}

/**
 * Детектор атаки по спектральному потоку (spectral flux).
 * Логарифмическое сжатие log(1 + γ·|X|) гасит мелкие флуктуации шума,
 * а положительные приращения по бинам ловят новые удары — в том числе
 * повтор той же ноты при нажатой педали (амплитуда партиалов резко растёт).
 */
export class SpectralFluxOnset {
  private readonly prev: Float32Array;
  private hasPrev = false;
  private readonly history: Float32Array;
  private histCount = 0;
  private histPos = 0;
  private readonly sortBuf: Float32Array;
  // Пик-пикинг с задержкой в 1 кадр: нужен локальный максимум
  private f1 = 0;
  private f2 = 0;
  private thr1 = Infinity;
  private t1 = 0;
  private allowed1 = false;
  private lastOnset = -Infinity;

  constructor(
    private readonly kLo: number,
    private readonly kHi: number,
    historyLen = 10,
    private readonly gamma = 1000,
  ) {
    this.prev = new Float32Array(kHi + 1);
    this.history = new Float32Array(historyLen);
    this.sortBuf = new Float32Array(historyLen);
  }

  private median(): number {
    const n = this.histCount;
    if (n === 0) return 0;
    const b = this.sortBuf.subarray(0, n);
    b.set(this.history.subarray(0, n));
    b.sort();
    return n % 2 ? b[(n - 1) >> 1] : 0.5 * (b[n / 2 - 1] + b[n / 2]);
  }

  /**
   * mags — амплитудный спектр текущего кадра; t — время кадра;
   * allowed — разрешена ли атака (например, сигнал выше шума).
   */
  process(mags: Float32Array, t: number, allowed: boolean, p: OnsetParams): OnsetResult {
    const { kLo, kHi, prev, gamma } = this;
    let flux = 0;
    for (let k = kLo; k <= kHi; k++) {
      const v = Math.log1p(gamma * mags[k]);
      if (this.hasPrev) {
        const d = v - prev[k];
        if (d > 0) flux += d; // полуволновое выпрямление: только рост энергии
      }
      prev[k] = v;
    }
    flux /= kHi - kLo + 1;
    this.hasPrev = true;

    const threshold = p.delta + p.multiplier * this.median();

    // Предыдущий кадр — пик, если он выше порога и выше соседей
    let onsetTime: number | null = null;
    let onsetFlux = 0;
    if (
      this.allowed1 &&
      this.f1 > this.thr1 &&
      this.f1 > this.f2 &&
      this.f1 >= flux &&
      this.t1 - this.lastOnset >= p.minIntervalSec
    ) {
      onsetTime = this.t1;
      onsetFlux = this.f1;
      this.lastOnset = this.t1;
    }

    this.history[this.histPos] = flux;
    this.histPos = (this.histPos + 1) % this.history.length;
    if (this.histCount < this.history.length) this.histCount++;

    this.f2 = this.f1;
    this.f1 = flux;
    this.thr1 = threshold;
    this.t1 = t;
    this.allowed1 = allowed;
    return { flux, threshold, onsetTime, onsetFlux };
  }
}
