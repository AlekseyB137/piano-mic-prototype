import { FFT } from './fft';

export interface PitchEstimate {
  freq: number;
  /** 1 − d'(τ): чем ближе к 1, тем «чище» периодичность. */
  clarity: number;
}

/**
 * Монофонический детектор высоты YIN (de Cheveigné & Kawahara, 2002).
 * Разностная функция считается через FFT-корреляцию, поэтому O(N log N), а не O(N²):
 *   d(τ) = Σ x_j² + Σ x_{j+τ}² − 2·Σ x_j·x_{j+τ},  j = 0..W/2−1
 */
export class YinDetector {
  private readonly fft: FFT;
  private readonly aRe: Float32Array;
  private readonly aIm: Float32Array;
  private readonly xRe: Float32Array;
  private readonly xIm: Float32Array;
  private readonly cmnd: Float32Array;
  private readonly prefix: Float64Array;

  constructor(
    readonly sampleRate: number,
    readonly windowSize: number,
    public minFreq = 60,
    public maxFreq = 2000,
  ) {
    const n = windowSize * 2; // нулевое дополнение — корреляция без «заворота»
    this.fft = new FFT(n);
    this.aRe = new Float32Array(n);
    this.aIm = new Float32Array(n);
    this.xRe = new Float32Array(n);
    this.xIm = new Float32Array(n);
    this.cmnd = new Float32Array(windowSize / 2);
    this.prefix = new Float64Array(windowSize + 1);
  }

  /** x — последние windowSize сэмплов. threshold — классический порог YIN (0.1–0.2). */
  detect(x: Float32Array, threshold: number): PitchEstimate | null {
    const W = this.windowSize;
    const half = W >>> 1;
    const { aRe, aIm, xRe, xIm, cmnd, prefix } = this;
    aRe.fill(0); aIm.fill(0); xRe.fill(0); xIm.fill(0);
    for (let i = 0; i < half; i++) aRe[i] = x[i];
    for (let i = 0; i < W; i++) xRe[i] = x[i];

    // Взаимная корреляция первой половины окна со всем окном: c(τ) = IFFT(conj(A)·X)
    this.fft.transform(aRe, aIm);
    this.fft.transform(xRe, xIm);
    for (let k = 0; k < aRe.length; k++) {
      const re = aRe[k] * xRe[k] + aIm[k] * xIm[k];
      const im = aRe[k] * xIm[k] - aIm[k] * xRe[k];
      xRe[k] = re;
      xIm[k] = im;
    }
    this.fft.transform(xRe, xIm, true);

    // Энергии через префиксные суммы
    prefix[0] = 0;
    for (let i = 0; i < W; i++) prefix[i + 1] = prefix[i] + x[i] * x[i];
    const e1 = prefix[half];
    if (e1 < 1e-10) return null;

    const tauMax = Math.min(half - 2, Math.floor(this.sampleRate / this.minFreq));
    const tauMin = Math.max(2, Math.floor(this.sampleRate / this.maxFreq));

    // Кумулятивная нормированная разностная функция d'(τ)
    cmnd[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= tauMax + 1; tau++) {
      const e2 = prefix[tau + half] - prefix[tau];
      let d = e1 + e2 - 2 * xRe[tau];
      if (d < 0) d = 0;
      running += d;
      cmnd[tau] = running > 0 ? (d * tau) / running : 1;
    }

    // Первый провал ниже порога → спуск до локального минимума.
    // Берём именно ПЕРВЫЙ (наименьший τ), это снижает ошибки «на октаву ниже».
    let tau = -1;
    for (let t = tauMin; t <= tauMax; t++) {
      if (cmnd[t] < threshold) {
        while (t + 1 <= tauMax && cmnd[t + 1] < cmnd[t]) t++;
        tau = t;
        break;
      }
    }
    if (tau < 0) {
      // Порог не пройден — берём глобальный минимум, но с низкой уверенностью
      let best = Infinity;
      for (let t = tauMin; t <= tauMax; t++) if (cmnd[t] < best) { best = cmnd[t]; tau = t; }
      if (tau < 0) return null;
    }

    // Параболическая интерполяция для субсэмпловой точности
    let shift = 0;
    if (tau > tauMin && tau < tauMax) {
      const a = cmnd[tau - 1], b = cmnd[tau], c = cmnd[tau + 1];
      const denom = a - 2 * b + c;
      if (denom !== 0) shift = Math.max(-1, Math.min(1, (0.5 * (a - c)) / denom));
    }
    const clarity = Math.max(0, Math.min(1, 1 - cmnd[tau]));
    return { freq: this.sampleRate / (tau + shift), clarity };
  }
}
