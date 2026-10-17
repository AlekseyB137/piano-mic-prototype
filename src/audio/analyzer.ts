import { FFT, hannWindow } from './fft';
import { YinDetector } from './pitch-yin';
import { SpectralFluxOnset } from './onset';
import { NoiseCalibrator } from './noise';
import { evaluateNotes, type NoteEvidence } from './chord-check';
import { CheckSession } from './check-session';
import { freqToMidiFloat } from './notes';
import { DEFAULT_PARAMS, type AnalyzerParams } from './params';
import type { AnalyzerEvent, PitchInfo } from './messages';

export const PREVIEW_BANDS = 96;
export const PREVIEW_FMIN = 40;
export const PREVIEW_FMAX = 6000;

/** Границы логарифмических полос превью спектра (PREVIEW_BANDS + 1 значений, Гц). */
export function previewBandEdges(): Float32Array {
  const e = new Float32Array(PREVIEW_BANDS + 1);
  for (let i = 0; i <= PREVIEW_BANDS; i++) e[i] = PREVIEW_FMIN * Math.pow(PREVIEW_FMAX / PREVIEW_FMIN, i / PREVIEW_BANDS);
  return e;
}

export interface AnalyzerOptions {
  /** Размер большого FFT для проверки аккордов: 8192 (лучше разрешение) или 4096 (быстрее реакция). */
  bigFft?: number;
  params?: Partial<AnalyzerParams>;
}

const HOP = 512;
const SMALL_FFT = 2048;
/** Длинное окно YIN для басов: в 2048 сэмплах у A2 помещается всего ~2 периода. */
const LONG_YIN = 4096;
/** Ниже этой частоты доверяем длинному окну. */
const LOW_PITCH_HZ = 160;
/** Струна не меняет высоту без удара: ноту фиксируем только в этом окне после атаки. */
const NOTE_AFTER_ONSET_SEC = 0.3;
/** Фон по умолчанию до калибровки. */
const DEFAULT_NOISE_DB = -70;
const UNCALIBRATED_FLOOR = 1e-4; // ≈ −80 дБFS на бин
const CALIBRATED_FLOOR = 1e-6;

/**
 * Весь конвейер анализа, без зависимостей от DOM и Web Audio:
 * на вход — сырые сэмплы (любыми блоками), на выход — события.
 * Можно запускать в AudioWorklet, Web Worker, Node (для тестов на записях).
 *
 * Каждые HOP сэмплов (~11 мс):
 *   малое FFT (2048) → RMS, spectral flux → атака;
 * каждые 2·HOP (~21 мс):
 *   YIN по последним 2048 сэмплам → высота (свободный режим);
 *   большое FFT (8192) → проверка ожидаемых нот, превью спектра, калибровка.
 */
export class Analyzer {
  readonly sampleRate: number;
  readonly hop = HOP;
  readonly smallN = SMALL_FFT;
  readonly bigN: number;
  params: AnalyzerParams;

  private readonly ring: Float32Array;
  private readonly mask: number;
  private w = 0;
  private samples = 0;
  private sinceHop = 0;
  private hopIndex = 0;

  private readonly smallBuf: Float32Array;
  private readonly bigBuf: Float32Array;
  private readonly smallWin: Float32Array;
  private readonly bigWin: Float32Array;
  private readonly smallFft: FFT;
  private readonly bigFft: FFT;
  private readonly smallMags: Float32Array;
  private readonly bigMags: Float32Array;
  private readonly prevBigMags: Float32Array;
  private hasPrevBig = false;

  private readonly yin: YinDetector;
  private readonly yinLong: YinDetector;
  private readonly longBuf = new Float32Array(LONG_YIN);
  private readonly onset: SpectralFluxOnset;
  private readonly calib = new NoiseCalibrator();
  private readonly session = new CheckSession();
  private readonly bandBins: Int32Array;

  private noiseRmsDb = DEFAULT_NOISE_DB;
  private noiseSpectrum: Float32Array | null = null;
  private expected: number[] = [];

  // Стабилизация высоты для свободного режима
  private candidate: number | null = null;
  private candidateCount = 0;
  private stableMidi: number | null = null;
  private silentFrames = 0;
  private restrikePending = false;
  private onsetAt = -Infinity;
  private lastIgnoredMidi: number | null = null;
  private lastIgnoredAt = -Infinity;

  private lastFlux = 0;
  private lastThreshold = 0;
  private lastRmsDb = -120;
  private loadAccum = 0;
  private loadSamples = 0;
  private loadMsPerSec: number | null = null;

  constructor(sampleRate: number, opts: AnalyzerOptions = {}) {
    this.sampleRate = sampleRate;
    this.bigN = opts.bigFft === 4096 ? 4096 : 8192;
    this.params = { ...DEFAULT_PARAMS, ...opts.params };
    this.ring = new Float32Array(this.bigN);
    this.mask = this.bigN - 1;
    this.smallBuf = new Float32Array(SMALL_FFT);
    this.bigBuf = new Float32Array(this.bigN);
    this.smallWin = hannWindow(SMALL_FFT);
    this.bigWin = hannWindow(this.bigN);
    this.smallFft = new FFT(SMALL_FFT);
    this.bigFft = new FFT(this.bigN);
    this.smallMags = new Float32Array(SMALL_FFT / 2 + 1);
    this.bigMags = new Float32Array(this.bigN / 2 + 1);
    this.prevBigMags = new Float32Array(this.bigN / 2 + 1);
    this.yin = new YinDetector(sampleRate, SMALL_FFT, 60, 2200);
    this.yinLong = new YinDetector(sampleRate, LONG_YIN, 40, 400);

    // Поток считаем в полосе 30 Гц – 6 кГц: там основная энергия удара по струне
    const binHz = sampleRate / SMALL_FFT;
    this.onset = new SpectralFluxOnset(Math.max(1, Math.round(30 / binHz)), Math.min(SMALL_FFT / 2, Math.round(6000 / binHz)));

    // Таблица: какие бины большого FFT попадают в полосы превью
    const edges = previewBandEdges();
    const bigBinHz = sampleRate / this.bigN;
    this.bandBins = new Int32Array(PREVIEW_BANDS * 2);
    for (let b = 0; b < PREVIEW_BANDS; b++) {
      const lo = Math.max(1, Math.floor(edges[b] / bigBinHz));
      const hi = Math.max(lo, Math.min(this.bigN / 2, Math.ceil(edges[b + 1] / bigBinHz) - 1));
      this.bandBins[b * 2] = lo;
      this.bandBins[b * 2 + 1] = hi;
    }
  }

  info(): AnalyzerEvent {
    return { type: 'info', sampleRate: this.sampleRate, hop: HOP, smallFft: SMALL_FFT, bigFft: this.bigN };
  }

  setParams(p: Partial<AnalyzerParams>): void {
    this.params = { ...this.params, ...p };
  }

  setExpected(midis: number[]): void {
    this.expected = Array.from(new Set(midis)).sort((a, b) => a - b);
    this.session.cancel();
  }

  startCalibration(seconds: number): void {
    this.calib.start(seconds, this.bigMags.length);
  }

  /** Подать очередной блок сэмплов. Возвращает события, накопленные за блок. */
  process(input: Float32Array): AnalyzerEvent[] {
    const events: AnalyzerEvent[] = [];
    const now = typeof performance !== 'undefined' ? () => performance.now() : null;
    const t0 = now ? now() : 0;
    const { ring, mask } = this;
    for (let i = 0; i < input.length; i++) {
      ring[this.w] = input[i];
      this.w = (this.w + 1) & mask;
      this.samples++;
      if (++this.sinceHop >= HOP) {
        this.sinceHop = 0;
        this.onHop(events);
      }
    }
    if (now) {
      this.loadAccum += now() - t0;
      this.loadSamples += input.length;
      if (this.loadSamples >= this.sampleRate) {
        this.loadMsPerSec = (this.loadAccum * this.sampleRate) / this.loadSamples;
        this.loadAccum = 0;
        this.loadSamples = 0;
      }
    }
    return events;
  }

  /** Скопировать последние out.length сэмплов из кольцевого буфера. */
  private copyLast(out: Float32Array): void {
    const n = out.length;
    let start = (this.w - n) & this.mask;
    for (let i = 0; i < n; i++) {
      out[i] = this.ring[start];
      start = (start + 1) & this.mask;
    }
  }

  private onHop(events: AnalyzerEvent[]): void {
    this.hopIndex++;
    const t = this.samples / this.sampleRate;
    const p = this.params;

    // --- Уровень и атака (каждый hop) ---
    this.copyLast(this.smallBuf);
    let sum = 0;
    for (let i = 0; i < SMALL_FFT; i++) sum += this.smallBuf[i] * this.smallBuf[i];
    const rms = Math.sqrt(sum / SMALL_FFT);
    const rmsDb = 20 * Math.log10(rms + 1e-12);
    this.lastRmsDb = rmsDb;
    const gateOpen = rmsDb > this.noiseRmsDb + p.gateDb;

    this.smallFft.magnitudes(this.smallBuf, this.smallWin, this.smallMags);
    // Атаку разрешаем чуть раньше гейта высоты — чтобы ловить тихие удары
    const onsetAllowed = rmsDb > this.noiseRmsDb + p.gateDb * 0.5;
    const o = this.onset.process(this.smallMags, t, onsetAllowed, {
      multiplier: p.onsetMultiplier,
      delta: p.onsetDelta,
      minIntervalSec: p.onsetMinIntervalMs / 1000,
    });
    this.lastFlux = o.flux;
    this.lastThreshold = o.threshold;

    if (this.calib.active) this.calib.addHop(rms, o.flux, HOP / this.sampleRate);

    if (o.onsetTime !== null && !this.calib.active) {
      events.push({ type: 'onset', t: o.onsetTime, flux: o.onsetFlux, threshold: o.threshold, rmsDb });
      this.restrikePending = true;
      this.onsetAt = o.onsetTime;
      // Опорный спектр — последний большой FFT ДО удара
      const prev = this.session.onOnset(o.onsetTime, this.expected, this.hasPrevBig ? this.prevBigMags : null, p.checkMinHits);
      if (prev) events.push({ type: 'check', ...prev });
    }

    if (this.hopIndex % 2 !== 0) return;

    // --- Высота (каждые 2 hop) ---
    let pitch: PitchInfo | null = null;
    let pitchWindow = SMALL_FFT;
    if (gateOpen) {
      let est = this.yin.detect(this.smallBuf, p.yinThreshold);
      // Басы: уточняем по длинному окну (и ловим случай, когда короткое ошиблось на октаву вверх)
      if (!est || est.freq < 2 * LOW_PITCH_HZ) {
        this.copyLast(this.longBuf);
        const low = this.yinLong.detect(this.longBuf, p.yinThreshold);
        // Берём длинное окно, только если оно лучше: короткое молчит, менее уверено
        // или ошиблось ровно на октаву вверх (частая ошибка на басах телефонного микрофона)
        if (low && low.freq < LOW_PITCH_HZ && low.clarity >= p.minClarity) {
          const octaveUp = est !== null && Math.abs(1200 * Math.log2(est.freq / (2 * low.freq))) < 50;
          if (!est || octaveUp || low.clarity > est.clarity) {
            est = low;
            pitchWindow = LONG_YIN;
          }
        }
      }
      if (est && est.clarity >= p.minClarity) {
        const mf = freqToMidiFloat(est.freq);
        const midi = Math.round(mf);
        pitch = { freq: est.freq, midi, cents: Math.round((mf - midi) * 100), clarity: est.clarity };
      }
    }
    this.updateStable(pitch, pitchWindow / this.sampleRate, t, events);

    // --- Большой спектр ---
    this.copyLast(this.bigBuf);
    this.bigFft.magnitudes(this.bigBuf, this.bigWin, this.bigMags);

    if (this.calib.active) {
      this.calib.addSpectrum(this.bigMags);
      const prof = this.calib.finishIfDone();
      if (prof) {
        this.noiseRmsDb = prof.rmsDb;
        this.noiseSpectrum = prof.spectrum;
        // Порог атаки: среднее + 4σ потока в тишине
        const delta = Math.max(0.005, prof.fluxMean + 4 * prof.fluxStd);
        this.params.onsetDelta = Math.round(delta * 1000) / 1000;
        events.push({
          type: 'calibrated',
          rmsDb: prof.rmsDb,
          fluxMean: prof.fluxMean,
          fluxStd: prof.fluxStd,
          onsetDelta: this.params.onsetDelta,
          noisePreview: this.preview(prof.spectrum),
        });
      }
    }

    let live: NoteEvidence[] | null = null;
    if (this.expected.length > 0) {
      live = evaluateNotes(
        {
          mags: this.bigMags,
          noise: this.noiseSpectrum,
          noiseFloor: this.noiseSpectrum ? CALIBRATED_FLOOR : UNCALIBRATED_FLOOR,
          sampleRate: this.sampleRate,
          fftSize: this.bigN,
          reference: this.session.isActive ? this.session.reference : null,
        },
        this.expected,
        p,
      );
      const res = this.session.update(t, live, p.checkWindowMs / 1000, p.checkMinHits);
      if (res) events.push({ type: 'check', ...res });
    }

    this.prevBigMags.set(this.bigMags);
    this.hasPrevBig = true;

    events.push({
      type: 'frame',
      t,
      rmsDb: this.lastRmsDb,
      gateOpen,
      flux: this.lastFlux,
      fluxThreshold: this.lastThreshold,
      pitch,
      stableMidi: this.stableMidi,
      spectrum: this.preview(this.bigMags),
      noiseRmsDb: this.noiseRmsDb,
      calibrated: this.noiseSpectrum !== null,
      live,
      checking: this.session.isActive,
      loadMsPerSec: this.loadMsPerSec,
    });
  }

  /**
   * Фиксация ноты в свободном режиме.
   * Новая нота принимается ТОЛЬКО в окне NOTE_AFTER_ONSET_SEC после атаки (2 совпадающих кадра).
   * Высота без атаки — голос, свист, гул, «плавание» затухающей струны — не считается нотой;
   * о ней сообщаем один раз (afterOnset: false) для диагностики.
   */
  private updateStable(pitch: PitchInfo | null, windowSec: number, t: number, events: AnalyzerEvent[]): void {
    // Сразу после удара окно ещё в основном содержит ПРЕДЫДУЩИЙ звук — такие кадры пропускаем
    if (this.restrikePending && pitch && t - this.onsetAt < windowSec / 2) return;
    if (!pitch) {
      if (++this.silentFrames >= 5) {
        this.stableMidi = null;
        this.candidate = null;
        this.candidateCount = 0;
        this.lastIgnoredMidi = null;
      }
      return;
    }
    this.silentFrames = 0;
    if (pitch.midi === this.candidate) this.candidateCount++;
    else {
      this.candidate = pitch.midi;
      this.candidateCount = 1;
    }
    if (this.restrikePending && t - this.onsetAt > NOTE_AFTER_ONSET_SEC) this.restrikePending = false;

    if (this.restrikePending) {
      if (this.candidateCount >= 2) {
        this.stableMidi = pitch.midi;
        this.restrikePending = false;
        this.lastIgnoredMidi = pitch.midi;
        events.push({ type: 'note', t, pitch, afterOnset: true });
      }
      return;
    }
    // Диагностика «высота без удара» — не чаще раза в секунду, чтобы голос не забивал лог
    if (
      this.candidateCount >= 4 &&
      pitch.midi !== this.stableMidi &&
      pitch.midi !== this.lastIgnoredMidi &&
      t - this.lastIgnoredAt >= 1
    ) {
      this.lastIgnoredMidi = pitch.midi;
      this.lastIgnoredAt = t;
      events.push({ type: 'note', t, pitch, afterOnset: false });
    }
  }

  private preview(mags: Float32Array): Float32Array {
    const out = new Float32Array(PREVIEW_BANDS);
    for (let b = 0; b < PREVIEW_BANDS; b++) {
      let m = 0;
      for (let k = this.bandBins[b * 2]; k <= this.bandBins[b * 2 + 1]; k++) if (mags[k] > m) m = mags[k];
      out[b] = Math.max(-120, 20 * Math.log10(m + 1e-12));
    }
    return out;
  }
}

