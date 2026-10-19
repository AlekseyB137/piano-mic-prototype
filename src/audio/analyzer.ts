import { FFT, hannWindow } from './fft';
import { YinDetector } from './pitch-yin';
import { SpectralFluxOnset } from './onset';
import { NoiseCalibrator } from './noise';
import { countTunedPeaks, evaluateNotes, partialFreq, partialPeak, partialSnrDb, type NoteEvidence, type SpectrumContext } from './chord-check';
import { CheckSession } from './check-session';
import { expectedStretchCents, freqToMidiFloat, KEY_HIGH, KEY_LOW, midiToFreq, midiToName } from './notes';
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
/** Атаки ближе этого к уже подтверждённой — тот же удар (дребезг детектора, стук клавиши; на iPhone 85–128 мс). */
const SAME_STRIKE_SEC = 0.12;
/** Нечётные партиалы (3f, 5f) должны быть выше фона, чтобы поверить в низкую октаву. */
const ODD_PARTIAL_DB = 8;
/** Сколько последних малых спектров храним, чтобы взять спектр ДО атаки (детектор срабатывает с задержкой). */
const SMALL_HISTORY = 4;
/** История средних спектров (кадр = 2 hop ≈ 21 мс): самый старый — ~40–60 мс до атаки. */
const MID_HISTORY = 3;
/**
 * Нота должна «не затухать» после атаки: максимум роста партиалов за кадры подтверждения ≥ этого, дБ.
 * Затухающая предыдущая нота даёт −1…−8 дБ; повторный удар той же ноты складывается со старым
 * колебанием в случайной фазе, поэтому рост бывает маленьким — строгий порог тут вреден.
 */
const NOTE_RISE_DB = 1.5;
/** Интервалы от ноты до её гармоник ×2…×8, полутоны. */
const SUBHARMONIC_SEMIS = [12, 19, 24, 28, 31, 34, 36];
/** После выбора нот на экране столько секунд атаки не открывают проверку: стук пальца по телефону. */
const SCREEN_TAP_MUTE_SEC = 0.6;
/**
 * Пик громкости за окно проверки тише медианы недавних засчитанных ударов больше чем на столько дБ —
 * это не удар (касание, стук). Меряем пик за окно, а не в момент атаки: атака часто срабатывает на
 * стуке клавиши раньше звука.
 */
const STRIKE_LEVEL_MARGIN_DB = 20;
/** Пока засчитанных ударов не было — пик окна должен быть громче фона хотя бы на столько дБ. */
const STRIKE_OVER_NOISE_DB = 15;
const STRIKE_HISTORY = 6;
/** Окно, закрытое новым ударом раньше этого и без единой засчитанной ноты, — предвестник удара (щелчок пальца). */
const PRECURSOR_SEC = 0.3;
/** История энергии полосы 2–6 кГц по hop'ам (≈ 11 мс). */
const HF_HISTORY = 16;
const HF_LO_HZ = 2000;
const HF_HI_HZ = 6000;
/** Атака в пределах этого времени после ещё не подтверждённой — тот же удар, подтверждение продолжаем. */
const MERGE_ONSET_SEC = 0.15;
/** Спектральный путь: допуск частоты партиала, центы (строже общего — иначе ловим склоны соседних пиков). */
const SPEC_TOL_CENTS = 30;
/** Спектральный путь: сосед ±1 полутон с основным тоном громче на столько дБ — наш «пик» лишь его склон. */
const SPEC_NEIGHBOR_DB = 10;
/**
 * Сразу после удара нота ещё «нарастает» в окне анализа (85 мс) — её партиалы выглядят растущими
 * и для следующей атаки. Столько времени после подтверждения партиалы прошлой ноты не учитываем.
 */
const PREV_NOTE_MASK_SEC = 0.4;
/** Спектральный путь: партиал учитывается, если он выше фона на столько дБ. */
const SPEC_PEAK_DB = 10;
/** Спектральный путь: минимальный суммарный рост партиалов ноты, дБ·вес. */
const SPEC_MIN_SCORE = 8;
/** Спектральный путь: сколько кадров подряд должна побеждать одна и та же нота. */
const SPEC_FRAMES = 2;
/** Ниже этой частоты основного тона спектральный путь допускает рост только ×2 (слабый бас микрофона). */
const SPEC_WEAK_F0_HZ = 150;
/** Веса партиалов ×1…×4 в оценке роста. */
const SPEC_WEIGHTS = [1, 1, 0.6, 0.4];
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
  private attack: AttackInfo = { flux: 0, rmsDb: -120, hfRiseDb: 0 };
  private readonly hfDb = new Float32Array(HF_HISTORY).fill(-200);
  private hfPos = 0;
  private attackConfirmed = false;
  private track: number[] = []; // дробные MIDI последних кадров после удара
  private trackRise: number[] = []; // рост партиалов в тех же кадрах, дБ
  private specCand: number | null = null; // спектральный путь: лидер по росту партиалов
  private lastNote: { midi: number; t: number } | null = null;
  private specCount = 0;
  private seen: string[] = []; // диагностика: что видел детектор после удара
  private lastReject = '';
  // Малые спектры последних hop'ов и спектр до текущей атаки — проверка «нота действительно ударена»
  private readonly smallHist: Float32Array[] = [];
  private smallHistPos = 0;
  private readonly preOnsetSmall: Float32Array;
  private hasPreOnset = false;
  // Среднее окно 4096 (85 мс, ~12 Гц/бин) для спектрального пути: полутона в 5-й октаве уже различимы
  private readonly midFft = new FFT(LONG_YIN);
  private readonly midWin = hannWindow(LONG_YIN);
  private readonly midMags = new Float32Array(LONG_YIN / 2 + 1);
  private readonly midHist: Float32Array[] = [];
  private midHistPos = 0;
  private readonly preOnsetMid = new Float32Array(LONG_YIN / 2 + 1);
  // «Фортепианность» удара, открывшего окно проверки
  private sessionPiano = false;
  /** Нота, подтверждённая детектором нот для удара, открывшего окно проверки. */
  private sessionNote: number | null = null;
  private sessionAttack: AttackInfo = { flux: 0, rmsDb: -120, hfRiseDb: 0 };
  private sessionRef: Float32Array | null = null;
  private ignoredAttacks = 0;
  private checkMuteUntil = 0;
  /** Уровни атак недавних ударов, давших засчитанные ноты, дБFS. */
  private strikeLevels: number[] = [];
  /** Пик RMS за текущее окно проверки (до выдачи вердикта), дБFS. */
  private sessionPeakDb = -120;
  /** Вердикт проверки, ждущий подтверждения «это был удар по струне». */
  private pendingCheck: { res: Omit<CheckEvent, 'type' | 'attack'>; deadline: number } | null = null;

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
    for (let i = 0; i < SMALL_HISTORY; i++) this.smallHist.push(new Float32Array(SMALL_FFT / 2 + 1));
    for (let i = 0; i < MID_HISTORY; i++) this.midHist.push(new Float32Array(LONG_YIN / 2 + 1));
    this.preOnsetSmall = new Float32Array(SMALL_FFT / 2 + 1);
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
    this.checkMuteUntil = this.samples / this.sampleRate + SCREEN_TAP_MUTE_SEC;
    this.session.cancel();
    this.pendingCheck = null;
  }

  /** Касание экрана: столько секунд атаки не открывают окно проверки. */
  muteCheck(seconds: number): void {
    this.checkMuteUntil = Math.max(this.checkMuteUntil, this.samples / this.sampleRate + seconds);
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
    if (this.session.isActive || this.pendingCheck) this.sessionPeakDb = Math.max(this.sessionPeakDb, rmsDb);

    this.smallFft.magnitudes(this.smallBuf, this.smallWin, this.smallMags);
    this.smallHist[this.smallHistPos].set(this.smallMags);
    this.smallHistPos = (this.smallHistPos + 1) % SMALL_HISTORY;
    {
      const binHz = this.sampleRate / SMALL_FFT;
      let e = 0;
      for (let k = Math.round(HF_LO_HZ / binHz); k <= Math.min(SMALL_FFT / 2, Math.round(HF_HI_HZ / binHz)); k++) e += this.smallMags[k] * this.smallMags[k];
      this.hfDb[this.hfPos] = 10 * Math.log10(e + 1e-20);
      this.hfPos = (this.hfPos + 1) % HF_HISTORY;
    }
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
    this.copyLast(this.longBuf);
    this.midFft.magnitudes(this.longBuf, this.midWin, this.midMags);
    this.midHist[this.midHistPos].set(this.midMags);
    this.midHistPos = (this.midHistPos + 1) % MID_HISTORY;
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
        if (tp.peaks >= 3 && tp.tuned / tp.peaks >= 0.75) this.sessionPiano = true;
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

  /**
   * Подъём энергии 2–6 кГц: максимум за последние 2 hop'а против медианы за ~40–100 мс до атаки.
   * Удар молоточка — короткий широкополосный «щелчок» и свежие верхние партиалы; отпускание клавиш,
   * демпферы и движение рук дают глухой низкий звук, а звучащий аккорд к этому времени уже без верха.
   */
  private hfRiseDb(): number {
    const at = (back: number) => this.hfDb[(this.hfPos - 1 - back + 2 * HF_HISTORY) % HF_HISTORY];
    const now = Math.max(at(0), at(1));
    const before: number[] = [];
    for (let b = 4; b <= 9; b++) before.push(at(b));
    before.sort((x, y) => x - y);
    return Math.max(0, now - before[before.length >> 1]);
  }

  private onOnset(t: number, flux: number, threshold: number, rmsDb: number, events: AnalyzerEvent[]): void {
    // Дребезг: вторая атака сразу после уже подтверждённой ноты — тот же удар
    if (this.attackConfirmed && t - this.onsetAt < SAME_STRIKE_SEC) return;
    events.push({ type: 'onset', t, flux, threshold, rmsDb });
    const hfRiseDb = this.hfRiseDb();

    // Окно проверки открывает только «настоящий» удар (подъём ВЧ); слабые атаки над звучащим
    // аккордом (отпускание клавиш, демпферы) окно не трогают — ни новых вердиктов, ни закрытия текущего
    const p = this.params;
    const tapMuted = t < this.checkMuteUntil;
    const hfOk = p.checkAttackHfDb <= 0 || hfRiseDb >= p.checkAttackHfDb;
    const strikeLike = !tapMuted && hfOk;
    if (this.expected.length > 0 && !strikeLike) {
      events.push({
        type: 'dropped',
        t,
        reason: tapMuted
          ? 'проверка: сразу после касания экрана (стук по телефону?)'
          : `проверка: атака без подъёма ВЧ (+${hfRiseDb.toFixed(1)} дБ < ${p.checkAttackHfDb}) — не удар`,
        attack: { flux, rmsDb, hfRiseDb },
        seen: '',
      });
    }
    // Если новая атака закрыла предыдущее окно проверки — решаем его судьбу со СТАРЫМИ флагами
    const prev = strikeLike ? this.session.onOnset(t, this.expected, this.hasPrevBig ? this.prevBigMags : null, p.checkMinHits) : null;
    if (prev && !prev.allPassed && prev.notes.every((n) => !n.passed) && t - prev.onsetTime < PRECURSOR_SEC) {
      // Окно открыл щелчок пальца о клавишу, а настоящий удар пришёл следом — вердикт предвестника не нужен
      this.drop(prev.onsetTime, `проверка: предвестник удара (щелчок за ${Math.round((t - prev.onsetTime) * 1000)} мс до удара)`, events, this.sessionAttack);
    } else if (prev) this.emitCheck(prev, events);
    if (this.session.isActive && this.session.startTime === t) {
      this.dropPendingCheck(events); // недоподтверждённый прошлый вердикт — уже не актуален
      this.sessionRef = this.session.reference;
      this.sessionPiano = false;
      this.sessionNote = null;
      this.sessionAttack = { flux, rmsDb, hfRiseDb };
      this.sessionPeakDb = rmsDb;
      events.push({ type: 'checkStart', t });
    }

    if (this.restrikePending && !this.attackConfirmed && t - this.onsetAt < MERGE_ONSET_SEC) {
      // Повторная атака того же удара (дребезг детектора, стук клавиши): подтверждение
      // не начинаем заново — продолжаем с прежним спектром «до удара», только продлеваем окно
      this.onsetAt = t;
      if (flux > this.attack.flux) this.attack = { flux, rmsDb, hfRiseDb: Math.max(hfRiseDb, this.attack.hfRiseDb) };
      this.seen.push('|');
      return;
    }
    if (this.restrikePending && !this.attackConfirmed) {
      // Прошлая атака так и не стала нотой — её перебил новый удар
      this.drop(this.onsetAt, `перебита новой атакой через ${Math.round((t - this.onsetAt) * 1000)} мс${this.lastReject ? '; ' + this.lastReject : ''}`, events);
    }
    this.restrikePending = true;
    this.attackConfirmed = false;
    this.onsetAt = t;
    this.attack = { flux, rmsDb, hfRiseDb };
    // Спектр до удара: детектор отмечает атаку на кадр позже, поэтому берём самый старый из истории (~30 мс назад)
    this.preOnsetSmall.set(this.smallHist[this.smallHistPos]);
    this.preOnsetMid.set(this.midHist[this.midHistPos]);
    this.hasPreOnset = this.hopIndex > 2 * MID_HISTORY + 2;
    this.track = [];
    this.trackRise = [];
    this.specCand = null;
    this.specCount = 0;
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
      this.deliverCheck(res, events);
      return;
    }
    this.pendingCheck = { res, deadline: res.onsetTime + NOTE_AFTER_ONSET_SEC };
  }

  /**
   * «Не засчитано» показываем, только если что-то действительно сыграно. Отпускание клавиш,
   * стук демпферов, движение рук дают слабую атаку над звучащим аккордом: ни одна нота не прошла,
   * у всех «не слышно»/«нет нового удара», и посторонней ноты детектор не услышал — молча пропускаем.
   */
  private deliverCheck(res: Omit<CheckEvent, 'type' | 'attack'>, events: AnalyzerEvent[]): void {
    // «Посторонняя» нота — не одна из ожидаемых и не их подгармоника: по смеси звучащего аккорда
    // YIN легко выдаёт общий «низ» (C2 под C-E-G), а стук даёт ему видимость удара
    const sn = this.sessionNote;
    const foreign =
      sn !== null && !res.notes.some((n) => n.midi === sn || SUBHARMONIC_SEMIS.includes(n.midi - sn));
    const nothingNew =
      !res.allPassed &&
      res.notes.every((n) => !n.passed && (!n.evidence || n.evidence.verdict === 'weak' || n.evidence.verdict === 'no-attack')) &&
      !foreign;
    if (nothingNew) {
      this.drop(res.onsetTime, 'проверка: ни одна ожидаемая нота не ударена и посторонней ноты нет (отпускание клавиш?)', events, this.sessionAttack);
      return;
    }
    const lv = [...this.strikeLevels].sort((a, b) => a - b);
    const levelRef = lv.length
      ? lv[lv.length >> 1] - STRIKE_LEVEL_MARGIN_DB
      : this.noiseSpectrum
        ? this.noiseRmsDb + STRIKE_OVER_NOISE_DB
        : -Infinity;
    if (this.sessionPeakDb < levelRef) {
      this.drop(res.onsetTime, `проверка: пик громкости ${this.sessionPeakDb.toFixed(0)} дБFS < ${levelRef.toFixed(0)} — не удар (касание, стук?)`, events, this.sessionAttack);
      return;
    }
    if (res.notes.some((n) => n.passed)) {
      this.strikeLevels.push(this.sessionPeakDb);
      if (this.strikeLevels.length > STRIKE_HISTORY) this.strikeLevels.shift();
    }
    events.push({ type: 'check', ...res, attack: this.sessionAttack });
  }

  private flushPendingCheck(t: number, events: AnalyzerEvent[]): void {
    const pc = this.pendingCheck;
    if (!pc) return;
    if (this.sessionPiano) {
      this.pendingCheck = null;
      this.deliverCheck(pc.res, events);
    } else if (t > pc.deadline) this.dropPendingCheck(events);
  }

  private dropPendingCheck(events?: AnalyzerEvent[]): void {
    const pc = this.pendingCheck;
    if (!pc) return;
    this.pendingCheck = null;
    if (events) this.drop(pc.res.onsetTime, `проверка: удар не подтверждён (${pc.res.allPassed ? 'был бы ✓' : 'был бы ✗'})`, events, this.sessionAttack);
    else this.ignoredAttacks++;
  }

  /** Максимальный рост партиалов ноты (×1…×4) в малом спектре относительно спектра до атаки, дБ. */
  private noteRiseDb(midi: number): number {
    if (!this.hasPreOnset) return Infinity;
    const f0 = midiToFreq(midi);
    const binHz = this.sampleRate / SMALL_FFT;
    const maxBin = this.smallMags.length - 1;
    let best = -Infinity;
    for (let h = 1; h <= 4; h++) {
      const f = h * f0;
      const k0 = Math.round(f / binHz);
      if (k0 + 1 >= maxBin) break;
      let now = 0, before = 0;
      for (let k = Math.max(1, k0 - 1); k <= k0 + 1; k++) {
        now = Math.max(now, this.smallMags[k]);
        before = Math.max(before, this.preOnsetSmall[k]);
      }
      if (now < 1e-6) continue; // партиала нет — по нему не судим
      best = Math.max(best, 20 * Math.log10(now / Math.max(before, 1e-7)));
    }
    return best;
  }

  /**
   * Спектральный путь: какая клавиша «ударена» — чьи партиалы (×1…×4) сильнее всего выросли
   * в среднем спектре (4096) относительно спектра до атаки. Затухающая предыдущая нота не растёт,
   * поэтому трель и легато не путают детектор. Из нот с почти равным ростом берём нижнюю
   * в октавном ряду (у ноты октавой выше партиалы — подмножество наших).
   */
  private risingNote(): { midi: number; score: number; freq: number } | null {
    if (!this.hasPreOnset) return null;
    const ctx: SpectrumContext = {
      mags: this.midMags,
      noise: null,
      noiseFloor: this.noiseSpectrum ? CALIBRATED_FLOOR : UNCALIBRATED_FLOOR,
      sampleRate: this.sampleRate,
      fftSize: LONG_YIN,
      reference: this.preOnsetMid,
    };
    const tol = Math.min(this.params.toleranceCents, SPEC_TOL_CENTS);
    // Партиалы только что сыгранной ноты: они ещё растут в окне и «подсвечивают» чужих кандидатов
    const prev = this.lastNote && this.onsetAt - this.lastNote.t < PREV_NOTE_MASK_SEC ? this.lastNote.midi : null;
    const prevF0 = prev !== null ? midiToFreq(prev) * Math.pow(2, expectedStretchCents(prev) / 1200) : 0;
    const isPrevPartial = (f: number) => {
      if (prev === null) return false;
      for (let k = 1; k <= 8; k++) if (Math.abs(1200 * Math.log2(f / partialFreq(prevF0, k))) < 45) return true;
      return false;
    };
    const scores = new Map<number, { score: number; freq: number; h1: number }>();
    for (let m = KEY_LOW - 3; m <= KEY_HIGH; m++) {
      if (m === prev) continue; // повтор той же ноты ловит YIN-путь
      const f0 = midiToFreq(m) * Math.pow(2, expectedStretchCents(m) / 1200);
      let score = 0;
      let freq = 0;
      let lowOk = false;
      for (let h = 1; h <= SPEC_WEIGHTS.length; h++) {
        if (isPrevPartial(partialFreq(f0, h))) continue;
        const pk = partialPeak(ctx, partialFreq(f0, h), tol);
        if (pk.snr < SPEC_PEAK_DB || pk.rise === null || pk.rise <= 0) continue;
        score += SPEC_WEIGHTS[h - 1] * Math.min(pk.rise, 20);
        if (h === 1 || (h === 2 && f0 < SPEC_WEAK_F0_HZ)) lowOk = true;
        if (!freq) freq = pk.peakHz / (h * Math.sqrt(1 + 3e-4 * h * h));
      }
      // Нужен рост СОБСТВЕННОГО основного тона, иначе нота «собрана» из партиалов другой
      // (A#5: его ×2 = ×3 у D#5). У басов микрофон телефона почти не слышит ×1 — там достаточно ×2.
      if (score <= 0 || !lowOk) continue;
      scores.set(m, { score, freq, h1: this.peakMag(this.midMags, f0, tol) });
    }
    // Кандидаты по убыванию роста; отбрасываем «склоны»: сосед ±1 с основным тоном намного громче
    const ranked = [...scores.entries()].sort((a, b) => b[1].score - a[1].score);
    let best: number | null = null;
    for (const [m, r] of ranked) {
      if (r.score < SPEC_MIN_SCORE) break;
      // Только что сыгранная нота громче законно — это не «склон»
      const louderNeighbor = [m - 1, m + 1].filter((n) => n !== prev).some((n) => {
        const fn = midiToFreq(n) * Math.pow(2, expectedStretchCents(n) / 1200);
        return this.peakMag(this.midMags, fn, tol) > r.h1 * Math.pow(10, SPEC_NEIGHBOR_DB / 20);
      });
      if (!louderNeighbor) {
        best = m;
        break;
      }
    }
    if (best === null) return null;
    // Защита от «верхних» ошибок: у нижней ноты (квинта, октава, дуодецима, 2 октавы) часть партиалов
    // совпадает с нашими. Если она тоже растёт почти так же — сыграна, скорее всего, она.
    let pick = best;
    for (const [down, share] of [[7, 0.6], [12, 0.75], [19, 0.6], [24, 0.75]] as const) {
      const lower = scores.get(best - down);
      if (lower && lower.score >= share * scores.get(best)!.score) pick = best - down;
    }
    const r = scores.get(pick)!;
    return { midi: pick, score: r.score, freq: r.freq || midiToFreq(pick) };
  }

  /** Максимум спектра в пределах допуска вокруг частоты. */
  private peakMag(mags: Float32Array, freq: number, tolCents: number): number {
    const binHz = this.sampleRate / ((mags.length - 1) * 2);
    const lo = Math.max(1, Math.floor((freq * Math.pow(2, -tolCents / 1200)) / binHz));
    const hi = Math.min(mags.length - 1, Math.ceil((freq * Math.pow(2, tolCents / 1200)) / binHz));
    let m = 0;
    for (let k = lo; k <= hi; k++) if (mags[k] > m) m = mags[k];
    return m;
  }

  /**
   * Подтверждение ноты после удара.
   * Основной путь — YIN: CONFIRM_FRAMES кадров подряд с той же нотой, дрейф ≤ maxDriftCents,
   * отклонение от строя (с растяжкой) ≤ maxDetuneCents, партиалы не затухают.
   * Запасной путь — спектральный (risingNote): когда YIN молчит, показывает затухающую
   * предыдущую ноту или «стянут» смесью двух звучащих нот (трель, легато).
   * Форму огибающей НЕ проверяем: в быстрой игре атака часто срабатывает на щелчке
   * пальца о клавишу за 50–100 мс до звука, и звук потом громче щелчка.
   */
  private confirmNote(pitch: PitchInfo | null, windowSec: number, t: number, events: AnalyzerEvent[]): void {
    if (pitch) {
      this.silentFrames = 0;
      // Звучит что-то другое (например, голос поверх затухающей ноты) — гасим подсветку
      if (this.stableMidi !== null && pitch.midi !== this.stableMidi) {
        if (++this.mismatchFrames >= 5) this.stableMidi = null;
      } else this.mismatchFrames = 0;
    } else if (++this.silentFrames >= 5) this.stableMidi = null;

    if (!this.restrikePending) return;
    if (t - this.onsetAt > NOTE_AFTER_ONSET_SEC) {
      this.restrikePending = false;
      this.drop(this.onsetAt, this.lastReject || (this.seen.some((x) => x !== '·') ? 'мало кадров с высотой' : 'нет устойчивой высоты'), events);
      return;
    }
    // Сразу после удара окно в основном содержит ПРЕДЫДУЩИЙ звук — пропускаем
    if (t - this.onsetAt < Math.min(windowSec, SMALL_FFT / this.sampleRate) / 2) return;

    // Спектральный кандидат — считаем каждый кадр, он нужен, если YIN не справится
    const spec = this.risingNote();
    if (spec && spec.midi === this.specCand) this.specCount++;
    else {
      this.specCand = spec ? spec.midi : null;
      this.specCount = spec ? 1 : 0;
    }

    let yinMidi: number | null = null;
    if (pitch) {
      const res = this.yinStep(pitch, events, t);
      if (res === 'confirmed') return;
      yinMidi = Math.round(freqToMidiFloat(pitch.freq));
    } else {
      this.track = [];
      this.trackRise = [];
      this.seen.push(spec ? `·(${midiToName(spec.midi)})` : '·');
    }

    // YIN не подтвердил. Если спектр уверенно показывает растущую ноту — берём её,
    // кроме случая, когда YIN видит ту же ноту и ещё не набрал кадров (дадим ему шанс).
    if (spec && this.specCount >= SPEC_FRAMES) {
      const yinWillDoIt = yinMidi === spec.midi && this.lastReject === '' && this.track.length < CONFIRM_FRAMES;
      if (!yinWillDoIt) {
        const mf = freqToMidiFloat(spec.freq);
        const cents = Math.round((mf - spec.midi) * 100);
        this.accept({ freq: spec.freq, midi: spec.midi, cents, clarity: 0, source: 'spectrum' }, t, events);
      }
    }
  }

  /** Шаг основного (YIN) пути. */
  private yinStep(pitch: PitchInfo, events: AnalyzerEvent[], t: number): 'confirmed' | 'pending' {
    const p = this.params;
    const mf = freqToMidiFloat(pitch.freq);
    const c = Math.round((mf - Math.round(mf)) * 100);
    this.seen.push(`${midiToName(Math.round(mf))}${c >= 0 ? '+' : ''}${c}`);
    this.track.push(mf);
    this.trackRise.push(this.noteRiseDb(Math.round(mf)));
    if (this.track.length > CONFIRM_FRAMES) {
      this.track.shift();
      this.trackRise.shift();
    }
    if (this.track.length < CONFIRM_FRAMES) return 'pending';

    const midis = this.track.map(Math.round);
    if (!midis.every((m) => m === midis[0])) {
      this.lastReject = 'высота прыгает между нотами';
      return 'pending';
    }
    const drift = (Math.max(...this.track) - Math.min(...this.track)) * 100;
    const mean = this.track.reduce((a, b) => a + b, 0) / this.track.length;
    const detune = (mean - Math.round(mean)) * 100;
    // Отклонение считаем от ожидаемой растяжки регистра, а не от «идеального» строя
    const offTune = detune - expectedStretchCents(midis[0]);
    if (drift > p.maxDriftCents) {
      this.lastReject = `дрейф ${Math.round(drift)} ц > ${p.maxDriftCents}`;
      return 'pending';
    }
    if (Math.abs(offTune) > p.maxDetuneCents) {
      this.lastReject = `мимо строя: ${Math.round(detune)} ц (ожидалось ${Math.round(expectedStretchCents(midis[0]))}±${p.maxDetuneCents})`;
      return 'pending';
    }
    // Нота должна быть ударена ПОСЛЕ атаки: её партиалы не затухают относительно спектра до атаки.
    // Иначе это ещё звучащая предыдущая нота, а атака была щелчком пальца или стуком.
    const rise = Math.max(...this.trackRise);
    if (rise < NOTE_RISE_DB) {
      this.lastReject = `нет роста энергии ${midiToName(midis[0])}: ${rise.toFixed(1)} дБ (затухающая нота?)`;
      return 'pending';
    }
    // YIN видит только что сыгранную ноту, а спектр — другую растущую: в смеси побеждает громкая
    // затухающая нота, поэтому верим спектру (он сам подтвердит свою ноту)
    const recent = this.lastNote && this.onsetAt - this.lastNote.t < PREV_NOTE_MASK_SEC ? this.lastNote.midi : null;
    if (midis[0] === recent && this.specCand !== null && this.specCand !== recent) {
      this.lastReject = `YIN видит звучащую ${midiToName(recent)}, спектр — растущую ${midiToName(this.specCand)}`;
      return 'pending';
    }
    this.accept({ ...pitch, cents: Math.round(detune) }, t, events);
    return 'confirmed';
  }

  private accept(pitch: PitchInfo, t: number, events: AnalyzerEvent[]): void {
    this.restrikePending = false;
    this.attackConfirmed = true;
    this.stableMidi = pitch.midi;
    this.mismatchFrames = 0;
    this.lastNote = { midi: pitch.midi, t: this.onsetAt };
    const sessionStart = this.session.isActive ? this.session.startTime : this.pendingCheck?.res.onsetTime;
    if (sessionStart === this.onsetAt) {
      this.sessionPiano = true;
      this.sessionNote = pitch.midi;
    }
    events.push({ type: 'note', t, pitch, attack: this.attack });
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

