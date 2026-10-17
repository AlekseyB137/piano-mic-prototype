import { FFT, hannWindow } from './fft';
import { YinDetector } from './pitch-yin';
import { SpectralFluxOnset } from './onset';
import { NoiseCalibrator } from './noise';
import { countTunedPeaks, evaluateNotes, partialSnrDb, type NoteEvidence, type SpectrumContext } from './chord-check';
import { CheckSession } from './check-session';
import { expectedStretchCents, freqToMidiFloat, midiToName } from './notes';
import { DEFAULT_PARAMS, type AnalyzerParams } from './params';
import type { AnalyzerEvent, AttackInfo, CheckEvent, PitchInfo } from './messages';

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
/** Струна не меняет высоту без удара: ноту подтверждаем только в этом окне после атаки. */
const NOTE_AFTER_ONSET_SEC = 0.35;
/** Сколько кадров подряд высота должна быть устойчивой. */
const CONFIRM_FRAMES = 3;
/** Атаки ближе этого к уже подтверждённой — тот же удар (дребезг детектора). */
const SAME_STRIKE_SEC = 0.08;
/** Нечётные партиалы (3f, 5f) должны быть выше фона, чтобы поверить в низкую октаву. */
const ODD_PARTIAL_DB = 8;
/** Огибающая: после удара громкость не должна вырасти больше чем на столько дБ (у слога — растёт). */
const ENVELOPE_RISE_DB = 3;
const ENV_HISTORY = 64;
/** Минимальный порог атаки после калибровки: в очень тихой комнате иначе срабатывают согласные речи. */
const MIN_ONSET_DELTA = 0.01;
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
  private stableMidi: number | null = null;
  private silentFrames = 0;
  private mismatchFrames = 0;
  // Подтверждение текущей атаки
  private restrikePending = false;
  private onsetAt = -Infinity;
  private attack: AttackInfo = { flux: 0, rmsDb: -120 };
  private attackConfirmed = false;
  private track: number[] = []; // дробные MIDI последних кадров после удара
  private seen: string[] = []; // диагностика: что видел детектор после удара
  private lastReject = '';
  // «Фортепианность» удара, открывшего окно проверки
  private sessionPiano = false;
  private sessionAttack: AttackInfo = { flux: 0, rmsDb: -120 };
  private sessionRef: Float32Array | null = null;
  private ignoredAttacks = 0;
  /** Вердикт проверки, ждущий подтверждения «это был удар по струне». */
  private pendingCheck: { res: Omit<CheckEvent, 'type' | 'attack'>; deadline: number } | null = null;
  // Короткая огибающая: RMS каждого hop (512 сэмплов ≈ 11 мс)
  private readonly envDb = new Float32Array(ENV_HISTORY);
  private readonly envT = new Float64Array(ENV_HISTORY);
  private envPos = 0;

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
    this.pendingCheck = null;
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
    let hopSum = 0;
    for (let i = SMALL_FFT - HOP; i < SMALL_FFT; i++) hopSum += this.smallBuf[i] * this.smallBuf[i];
    this.envDb[this.envPos] = 10 * Math.log10(hopSum / HOP + 1e-24);
    this.envT[this.envPos] = t;
    this.envPos = (this.envPos + 1) % ENV_HISTORY;
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

    if (o.onsetTime !== null && !this.calib.active) this.onOnset(o.onsetTime, o.onsetFlux, o.threshold, rmsDb, events);

    if (this.hopIndex % 2 !== 0) return;

    // --- Большой спектр (нужен и для проверки октавы в басу) ---
    this.copyLast(this.bigBuf);
    this.bigFft.magnitudes(this.bigBuf, this.bigWin, this.bigMags);
    if (this.calib.active) this.feedCalibration(events);
    const ctx = this.spectrumContext(this.session.isActive ? this.session.reference : null);

    // --- Высота ---
    let pitch: PitchInfo | null = null;
    let pitchWindow = SMALL_FFT;
    if (gateOpen) {
      let est = this.yin.detect(this.smallBuf, p.yinThreshold);
      // Басы: в 2048 сэмплах у A2 всего ~2 периода — уточняем по длинному окну
      if (!est || est.freq < 2 * LOW_PITCH_HZ) {
        this.copyLast(this.longBuf);
        const low = this.yinLong.detect(this.longBuf, p.yinThreshold);
        if (low && low.freq < LOW_PITCH_HZ && low.clarity >= p.minClarity) {
          // Длинное окно склонно находить субоктаву (A2 → A1). Настоящая низкая нота
          // обязана иметь НЕЧЁТНЫЕ партиалы 3f и 5f — у ноты октавой выше их нет.
          const oddDb = Math.max(partialSnrDb(ctx, 3 * low.freq, p.toleranceCents), partialSnrDb(ctx, 5 * low.freq, p.toleranceCents));
          const octaveUp = est !== null && Math.abs(1200 * Math.log2(est.freq / (2 * low.freq))) < 50;
          if (oddDb >= ODD_PARTIAL_DB && (!est || octaveUp || low.clarity > est.clarity)) {
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
    this.confirmNote(pitch, pitchWindow / this.sampleRate, t, events);

    // --- Проверка ожидаемых нот ---
    let live: NoteEvidence[] | null = null;
    if (this.expected.length > 0) {
      live = evaluateNotes(ctx, this.expected, p);
      // Аккорд YIN не определит — «фортепианность» берём по новым пикам в нотах строя
      const sessionStart = this.session.isActive ? this.session.startTime : this.pendingCheck?.res.onsetTime;
      if (sessionStart !== undefined && !this.sessionPiano && this.sessionRef && t - sessionStart >= 0.05) {
        const tp = countTunedPeaks(this.spectrumContext(this.sessionRef), { fMin: 60, fMax: 2000, promDb: 12, riseDb: 6, tolCents: p.maxDetuneCents + 10, maxPeaks: 10 });
        if (tp.peaks >= 3 && tp.tuned / tp.peaks >= 0.75 && this.looksStruck(sessionStart, t)) this.sessionPiano = true;
      }
      const res = this.session.update(t, live, p.checkWindowMs / 1000, p.checkMinHits);
      if (res) this.emitCheck(res, events);
    }
    this.flushPendingCheck(t, events);

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
      ignoredAttacks: this.ignoredAttacks,
      loadMsPerSec: this.loadMsPerSec,
    });
  }

  private spectrumContext(reference: Float32Array | null): SpectrumContext {
    return {
      mags: this.bigMags,
      noise: this.noiseSpectrum,
      noiseFloor: this.noiseSpectrum ? CALIBRATED_FLOOR : UNCALIBRATED_FLOOR,
      sampleRate: this.sampleRate,
      fftSize: this.bigN,
      reference,
    };
  }

  private feedCalibration(events: AnalyzerEvent[]): void {
    this.calib.addSpectrum(this.bigMags);
    const prof = this.calib.finishIfDone();
    if (!prof) return;
    this.noiseRmsDb = prof.rmsDb;
    this.noiseSpectrum = prof.spectrum;
    // Порог атаки: среднее + 4σ потока в тишине, но не ниже MIN_ONSET_DELTA
    const delta = Math.max(MIN_ONSET_DELTA, prof.fluxMean + 4 * prof.fluxStd);
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

  private onOnset(t: number, flux: number, threshold: number, rmsDb: number, events: AnalyzerEvent[]): void {
    // Дребезг: вторая атака сразу после уже подтверждённой ноты — тот же удар
    if (this.attackConfirmed && t - this.onsetAt < SAME_STRIKE_SEC) return;
    events.push({ type: 'onset', t, flux, threshold, rmsDb });

    // Если новая атака закрыла предыдущее окно проверки — решаем его судьбу со СТАРЫМИ флагами
    const prev = this.session.onOnset(t, this.expected, this.hasPrevBig ? this.prevBigMags : null, this.params.checkMinHits);
    if (prev) this.emitCheck(prev, events);
    if (this.session.isActive && this.session.startTime === t) {
      this.dropPendingCheck(events); // недоподтверждённый прошлый вердикт — уже не актуален
      this.sessionRef = this.session.reference;
      this.sessionPiano = false;
      this.sessionAttack = { flux, rmsDb };
    }

    if (this.restrikePending && !this.attackConfirmed) {
      // Прошлая атака так и не стала нотой — её перебил новый удар
      this.drop(this.onsetAt, `перебита новой атакой через ${Math.round((t - this.onsetAt) * 1000)} мс${this.lastReject ? '; ' + this.lastReject : ''}`, events);
    }
    this.restrikePending = true;
    this.attackConfirmed = false;
    this.onsetAt = t;
    this.attack = { flux, rmsDb };
    this.track = [];
    this.seen = [];
    this.lastReject = '';
  }

  private drop(t: number, reason: string, events: AnalyzerEvent[], attack: AttackInfo = this.attack): void {
    this.ignoredAttacks++;
    events.push({ type: 'dropped', t, reason, attack, seen: this.seen.slice(-10).join(' ') });
  }

  /**
   * Вердикт выдаём, только если удар подтверждён как фортепианный (нота подтверждена
   * или новые пики в строе + огибающая удара). Иначе ждём подтверждения до дедлайна,
   * а затем молча отбрасываем — голос, хлопки и стук не дают ни «засчитано», ни «нет».
   */
  private emitCheck(res: Omit<CheckEvent, 'type' | 'attack'>, events: AnalyzerEvent[]): void {
    this.dropPendingCheck(events);
    if (this.sessionPiano) {
      events.push({ type: 'check', ...res, attack: this.sessionAttack });
      return;
    }
    this.pendingCheck = { res, deadline: res.onsetTime + NOTE_AFTER_ONSET_SEC };
  }

  private flushPendingCheck(t: number, events: AnalyzerEvent[]): void {
    const pc = this.pendingCheck;
    if (!pc) return;
    if (this.sessionPiano) {
      this.pendingCheck = null;
      events.push({ type: 'check', ...pc.res, attack: this.sessionAttack });
    } else if (t > pc.deadline) this.dropPendingCheck(events);
  }

  private dropPendingCheck(events?: AnalyzerEvent[]): void {
    const pc = this.pendingCheck;
    if (!pc) return;
    this.pendingCheck = null;
    if (events) this.drop(pc.res.onsetTime, `проверка: удар не подтверждён (${pc.res.allPassed ? 'был бы ✓' : 'был бы ✗'})`, events, this.sessionAttack);
    else this.ignoredAttacks++;
  }

  /**
   * Форма огибающей удара молоточка: максимум громкости — в первые ~25 мс, дальше только спад.
   * У слога речи после щелчка согласной идёт гласная, которая ГРОМЧЕ щелчка.
   */
  private looksStruck(onsetT: number, now: number): boolean {
    return this.envelopeRiseDb(onsetT, now) <= ENVELOPE_RISE_DB;
  }

  /** Насколько громкость после удара превысила громкость самого удара, дБ (+∞ — нет данных). */
  private envelopeRiseDb(onsetT: number, now: number): number {
    let early = -Infinity, late = -Infinity;
    for (let i = 0; i < ENV_HISTORY; i++) {
      const tt = this.envT[i];
      if (tt < onsetT - 0.015 || tt > now) continue;
      if (tt <= onsetT + 0.025) early = Math.max(early, this.envDb[i]);
      else late = Math.max(late, this.envDb[i]);
    }
    if (early === -Infinity) return Infinity;
    return late === -Infinity ? 0 : late - early;
  }

  /**
   * Подтверждение ноты после удара.
   * Струна не меняет высоту без нового удара, а после удара её высота неподвижна
   * и стоит в строе. Поэтому нота = атака + CONFIRM_FRAMES кадров подряд с той же нотой,
   * дрейфом ≤ maxDriftCents и отклонением от строя ≤ maxDetuneCents.
   * Голос (дрейф, вибрато, «мимо строя»), стук и шум сюда не проходят и никуда не выводятся.
   */
  private confirmNote(pitch: PitchInfo | null, windowSec: number, t: number, events: AnalyzerEvent[]): void {
    const p = this.params;
    if (!pitch) {
      this.track = [];
      if (this.restrikePending && t - this.onsetAt >= windowSec / 2) this.seen.push('·');
      if (++this.silentFrames >= 5) this.stableMidi = null;
      if (this.restrikePending && t - this.onsetAt > NOTE_AFTER_ONSET_SEC) {
        this.restrikePending = false;
        this.drop(this.onsetAt, this.lastReject || 'нет устойчивой высоты', events);
      }
      return;
    }
    this.silentFrames = 0;
    // Звучит что-то другое (например, голос поверх затухающей ноты) — гасим подсветку
    if (this.stableMidi !== null && pitch.midi !== this.stableMidi) {
      if (++this.mismatchFrames >= 5) this.stableMidi = null;
    } else this.mismatchFrames = 0;

    if (!this.restrikePending) return;
    if (t - this.onsetAt > NOTE_AFTER_ONSET_SEC) {
      this.restrikePending = false;
      this.drop(this.onsetAt, this.lastReject || (this.seen.length ? 'мало кадров с высотой' : 'нет высоты'), events);
      return;
    }
    // Сразу после удара окно в основном содержит ПРЕДЫДУЩИЙ звук — пропускаем
    if (t - this.onsetAt < windowSec / 2) return;

    const mf = freqToMidiFloat(pitch.freq);
    const c = Math.round((mf - Math.round(mf)) * 100);
    this.seen.push(`${midiToName(Math.round(mf))}${c >= 0 ? '+' : ''}${c}`);
    this.track.push(mf);
    if (this.track.length > CONFIRM_FRAMES) this.track.shift();
    if (this.track.length < CONFIRM_FRAMES) return;

    const midis = this.track.map(Math.round);
    if (!midis.every((m) => m === midis[0])) {
      this.lastReject = 'высота прыгает между нотами';
      return;
    }
    const drift = (Math.max(...this.track) - Math.min(...this.track)) * 100;
    const mean = this.track.reduce((a, b) => a + b, 0) / this.track.length;
    const detune = (mean - Math.round(mean)) * 100;
    // Отклонение считаем от ожидаемой растяжки регистра, а не от «идеального» строя
    const offTune = detune - expectedStretchCents(midis[0]);
    if (drift > p.maxDriftCents) {
      this.lastReject = `дрейф ${Math.round(drift)} ц > ${p.maxDriftCents}`;
      return;
    }
    if (Math.abs(offTune) > p.maxDetuneCents) {
      this.lastReject = `мимо строя: ${Math.round(detune)} ц (ожидалось ${Math.round(expectedStretchCents(midis[0]))}±${p.maxDetuneCents})`;
      return;
    }
    const rise = this.envelopeRiseDb(this.onsetAt, t);
    if (rise > ENVELOPE_RISE_DB) {
      // Высота устойчива, но громкость после «атаки» выросла — это слог, а не удар
      this.restrikePending = false;
      this.drop(this.onsetAt, `громкость выросла после атаки: +${Number.isFinite(rise) ? rise.toFixed(1) : '?'} дБ`, events);
      return;
    }

    this.restrikePending = false;
    this.attackConfirmed = true;
    this.stableMidi = pitch.midi;
    this.mismatchFrames = 0;
    const sessionStart = this.session.isActive ? this.session.startTime : this.pendingCheck?.res.onsetTime;
    if (sessionStart === this.onsetAt) this.sessionPiano = true;
    events.push({ type: 'note', t, pitch: { ...pitch, cents: Math.round(detune) }, attack: this.attack });
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

