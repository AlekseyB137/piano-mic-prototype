export interface NoiseProfile {
  rmsDb: number;
  fluxMean: number;
  fluxStd: number;
  /** Средняя амплитуда шума по бинам большого FFT (сглажена максимумом по ±2 бинам). */
  spectrum: Float32Array;
}

/** Накопление статистики фонового шума за заданное время. */
export class NoiseCalibrator {
  private remaining = 0;
  private running = false;
  private powSum = 0;
  private powN = 0;
  private fluxSum = 0;
  private fluxSq = 0;
  private fluxN = 0;
  private spec: Float64Array | null = null;
  private specN = 0;

  get active(): boolean {
    return this.running;
  }

  start(seconds: number, bins: number): void {
    this.remaining = seconds;
    this.running = true;
    this.powSum = this.powN = 0;
    this.fluxSum = this.fluxSq = this.fluxN = 0;
    this.spec = new Float64Array(bins);
    this.specN = 0;
  }

  addHop(rms: number, flux: number, dt: number): void {
    if (!this.running) return;
    this.powSum += rms * rms;
    this.powN++;
    this.fluxSum += flux;
    this.fluxSq += flux * flux;
    this.fluxN++;
    this.remaining -= dt;
  }

  addSpectrum(mags: Float32Array): void {
    if (!this.running || !this.spec) return;
    for (let k = 0; k < this.spec.length; k++) this.spec[k] += mags[k];
    this.specN++;
  }

  /** Возвращает профиль, когда время вышло; иначе null. */
  finishIfDone(): NoiseProfile | null {
    if (!this.running || this.remaining > 0 || !this.spec || this.specN === 0) return null;
    this.running = false;
    const n = this.spec.length;
    const mean = new Float32Array(n);
    for (let k = 0; k < n; k++) mean[k] = this.spec[k] / this.specN;
    // Консервативное сглаживание: максимум по соседям, чтобы случайные пики шума не проходили порог
    const spectrum = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      let m = 0;
      for (let j = Math.max(0, k - 2); j <= Math.min(n - 1, k + 2); j++) if (mean[j] > m) m = mean[j];
      spectrum[k] = m;
    }
    const fluxMean = this.fluxSum / Math.max(1, this.fluxN);
    const fluxVar = this.fluxSq / Math.max(1, this.fluxN) - fluxMean * fluxMean;
    const rms = Math.sqrt(this.powSum / Math.max(1, this.powN));
    return {
      rmsDb: 20 * Math.log10(rms + 1e-12),
      fluxMean,
      fluxStd: Math.sqrt(Math.max(0, fluxVar)),
      spectrum,
    };
  }
}
