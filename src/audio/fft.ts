/**
 * Комплексное БПФ radix-2 (in-place) с предвычисленными таблицами.
 * Без аллокаций в горячем цикле — годится для AudioWorklet.
 */
export class FFT {
  readonly size: number;
  private readonly cos: Float32Array;
  private readonly sin: Float32Array;
  private readonly rev: Uint32Array;
  private readonly re: Float32Array;
  private readonly im: Float32Array;

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) throw new Error(`FFT size must be a power of 2, got ${size}`);
    this.size = size;
    const levels = Math.round(Math.log2(size));
    this.rev = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < levels; b++) r |= ((i >>> b) & 1) << (levels - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float32Array(size / 2);
    this.sin = new Float32Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / size);
      this.sin[i] = Math.sin((2 * Math.PI * i) / size);
    }
    this.re = new Float32Array(size);
    this.im = new Float32Array(size);
  }

  /** Прямое (или обратное, с нормировкой 1/N) преобразование на месте. */
  transform(re: Float32Array, im: Float32Array, inverse = false): void {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >>> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const wr = this.cos[k];
          const wi = inverse ? this.sin[k] : -this.sin[k];
          const tr = re[l] * wr - im[l] * wi;
          const ti = re[l] * wi + im[l] * wr;
          re[l] = re[j] - tr;
          im[l] = im[j] - ti;
          re[j] += tr;
          im[j] += ti;
        }
      }
    }
    if (inverse) {
      const s = 1 / n;
      for (let i = 0; i < n; i++) { re[i] *= s; im[i] *= s; }
    }
  }

  /**
   * Амплитудный спектр вещественного сигнала с окном.
   * Нормировка 2/sum(window): синус амплитуды A даёт пик ≈ A (0 дБFS для полной шкалы).
   * out должен иметь длину size/2 + 1.
   */
  magnitudes(input: Float32Array, window: Float32Array, out: Float32Array): void {
    const n = this.size;
    const re = this.re, im = this.im;
    let wsum = 0;
    for (let i = 0; i < n; i++) {
      re[i] = input[i] * window[i];
      im[i] = 0;
      wsum += window[i];
    }
    this.transform(re, im);
    const scale = 2 / wsum;
    for (let k = 0; k <= n / 2; k++) out[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]) * scale;
  }
}

export function hannWindow(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}
