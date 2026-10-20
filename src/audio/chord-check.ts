import { midiToFreq } from './notes';

export interface ChordCheckParams {
  snrDb: number;
  /** Допуск отклонения пика от ожидаемой частоты, центы. */
  toleranceCents: number;
  minHarmonics: number;
  octaveMarginDb: number;
  riseDb: number;
  /** Аккорд: нота тише самой громкой ноты аккорда больше чем на столько дБ — не засчитываем (0 — выкл.). */
  chordBalanceDb: number;
  /** Октавный аккорд: чётный партиал нижней ноты должен быть выше соседних на столько дБ (0 — выкл.). */
  octaveChordDb: number;
}

export interface SpectrumContext {
  mags: Float32Array;
  /** Профиль шума по бинам (после калибровки) или null. */
  noise: Float32Array | null;
  /** Нижняя граница шума (линейная амплитуда), если профиля нет или он слишком тихий. */
  noiseFloor: number;
  sampleRate: number;
  fftSize: number;
  /** Спектр непосредственно перед атакой — для проверки «нового удара». */
  reference: Float32Array | null;
}

export interface HarmonicEvidence {
  h: number;
  freq: number;
  snrDb: number;
  /** Рост относительно спектра до удара, дБ (null если нет опорного спектра). */
  riseDb: number | null;
  /** Гармоника совпадает с гармоникой другой ожидаемой ноты — не доказывает эту ноту. */
  shared: boolean;
}

export type NoteVerdict = 'ok' | 'weak' | 'octave-up' | 'octave-down' | 'no-attack' | 'faint';

export interface NoteEvidence {
  midi: number;
  harmonics: HarmonicEvidence[];
  /** Средний положительный SNR собственных гармоник — для сравнения и отладки. */
  score: number;
  /** Энергия «подложки» — ноты, чьи гармоники содержат f0 (f0/2, f0/3, f0/4), дБ над шумом. */
  subDb: number | null;
  passed: boolean;
  verdict: NoteVerdict;
}

const HARMONICS = [1, 2, 3, 4];
/** Коэффициент негармоничности струны (типичный порядок для среднего регистра). */
const INHARMONICITY = 3e-4;
/** Локальный фон: медиана бинов на расстоянии BG_NEAR..BG_FAR от пика (вне главного лепестка окна). */
const BG_NEAR = 4;
const BG_FAR = 12;
const SHARE_TOLERANCE_CENTS = 45;
const OTHER_HARMONICS = 8;
/** Ниже этого телефонный микрофон почти глух — такие частоты не проверяем. */
const MIN_SUB_HZ = 40;
const SUBHARMONICS = [
  { semis: 12, ratios: [1 / 2, 3 / 2], need: 1 },
  { semis: 19, ratios: [1 / 3, 2 / 3, 4 / 3], need: 2 },
  { semis: 24, ratios: [1 / 4, 3 / 4, 5 / 4], need: 2 },
];

/** Частота h-й гармоники с учётом негармоничности: f_h = h·f0·√(1 + B·h²). */
export function partialFreq(f0: number, h: number): number {
  return h * f0 * Math.sqrt(1 + INHARMONICITY * h * h);
}

function binRange(freq: number, binHz: number, maxBin: number, cents: number): [number, number] {
  const k0 = Math.round(freq / binHz);
  let lo = Math.floor((freq * Math.pow(2, -cents / 1200)) / binHz);
  let hi = Math.ceil((freq * Math.pow(2, cents / 1200)) / binHz);
  lo = Math.max(1, Math.min(lo, k0 - 1));
  hi = Math.min(maxBin, Math.max(hi, k0 + 1));
  return [lo, hi];
}

function peakAround(arr: Float32Array, lo: number, hi: number): [number, number] {
  let best = 0, bin = lo;
  for (let k = lo; k <= hi; k++) if (arr[k] > best) { best = arr[k]; bin = k; }
  return [best, bin];
}

/** Частота «объясняется» гармониками других ожидаемых нот? */
function explainedByOthers(freq: number, others: number[]): boolean {
  for (const f0 of others) {
    for (let k = 1; k <= OTHER_HARMONICS; k++) {
      if (Math.abs(1200 * Math.log2(freq / partialFreq(f0, k))) < SHARE_TOLERANCE_CENTS) return true;
    }
  }
  return false;
}

const bgBuf = new Float32Array(2 * (BG_FAR - BG_NEAR + 1));

/** Медиана спектра вокруг бина, без главного лепестка — оценка широкополосного фона (стук, шум, голос). */
function localBackground(mags: Float32Array, bin: number): number {
  let n = 0;
  for (let d = BG_NEAR; d <= BG_FAR; d++) {
    if (bin - d >= 1) bgBuf[n++] = mags[bin - d];
    if (bin + d < mags.length) bgBuf[n++] = mags[bin + d];
  }
  if (n === 0) return 0;
  const b = bgBuf.subarray(0, n).sort();
  return b[n >> 1];
}

/**
 * SNR гармоники на частоте freq.
 * Засчитываем только НАСТОЯЩИЙ пик: локальный максимум, чья уточнённая
 * (параболой по лог-амплитудам) частота лежит в пределах допуска.
 * Иначе в окно попадает склон соседнего пика — и C#4 «засчитывается» как C4.
 * Опора для SNR — максимум из профиля шума комнаты и локального фона спектра.
 */
function snrAt(ctx: SpectrumContext, freq: number, tolCents: number): { snr: number; rise: number | null; peakHz: number } {
  const binHz = ctx.sampleRate / ctx.fftSize;
  const mags = ctx.mags;
  const maxBin = mags.length - 2;
  if (freq / binHz >= maxBin - 1) return { snr: -Infinity, rise: null, peakHz: freq };
  const [lo, hi] = binRange(freq, binHz, maxBin, tolCents);
  const [peak, bin] = peakAround(mags, lo, hi);

  let isPeak = peak > 0 && mags[bin] >= mags[bin - 1] && mags[bin] >= mags[bin + 1];
  let peakHz = freq;
  if (isPeak) {
    const a = Math.log(mags[bin - 1] + 1e-12), b = Math.log(mags[bin] + 1e-12), c = Math.log(mags[bin + 1] + 1e-12);
    const denom = a - 2 * b + c;
    const shift = denom < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) : 0;
    peakHz = (bin + shift) * binHz;
    const cents = 1200 * Math.log2(peakHz / freq);
    isPeak = Math.abs(cents) <= tolCents;
  }

  const ref = Math.max(ctx.noise ? ctx.noise[bin] : 0, localBackground(mags, bin), ctx.noiseFloor);
  let snr = 20 * Math.log10((peak + 1e-12) / ref);
  if (!isPeak) snr = Math.min(snr, 0); // нет пика — нет гармоники
  let rise: number | null = null;
  if (ctx.reference) {
    const [refPeak] = peakAround(ctx.reference, lo, hi);
    rise = 20 * Math.log10((peak + 1e-12) / Math.max(refPeak, ctx.noiseFloor));
  }
  return { snr, rise, peakHz };
}

/**
 * Проверка набора ожидаемых нот по спектру.
 *
 * Идея: каждая нота пианино — серия партиалов f0, 2f0, 3f0, 4f0…
 * 1) Ищем пик рядом с каждой гармоникой и сравниваем с профилем шума (SNR).
 * 2) Гармоники, совпадающие с гармониками других нот аккорда, помечаем как «общие»:
 *    они не доказывают именно эту ноту (например, 3-я гармоника C4 = 2-я гармоника G4).
 * 3) Октава выше (n+12) имеет только чётные гармоники n, поэтому требуем энергию
 *    на «собственных» нечётных гармониках (1 и 3).
 * 4) Октава ниже (n−12) даёт энергию на f0/2 и 1.5·f0. Если там сильный пик,
 *    сравнимый с основным тоном — подозреваем, что сыграли ноту октавой ниже.
 * 5) Если задан опорный спектр до удара — требуем рост энергии (защита от
 *    затухающей ноты, особенно при педали).
 */
export function evaluateNotes(ctx: SpectrumContext, expected: number[], p: ChordCheckParams): NoteEvidence[] {
  const set = new Set(expected);
  const notes = expected.map((midi): NoteEvidence => {
    const f0 = midiToFreq(midi);
    const others = expected.filter((m) => m !== midi).map((m) => midiToFreq(m));

    const harmonics: HarmonicEvidence[] = HARMONICS.map((h) => {
      const freq = partialFreq(f0, h);
      const { snr, rise } = snrAt(ctx, freq, p.toleranceCents);
      return { h, freq, snrDb: snr, riseDb: rise, shared: explainedByOthers(freq, others) };
    });

    const own = harmonics.filter((x) => !x.shared && Number.isFinite(x.snrDb));
    const strongOwn = own.filter((x) => x.snrDb >= p.snrDb);
    const h1 = harmonics[0];

    // Наличие ноты
    let present: boolean;
    if (own.length === 0) present = h1.snrDb >= p.snrDb;
    else present = strongOwn.length >= Math.min(p.minHarmonics, own.length);
    // Основной тон совпадает с k-й гармоникой ожидаемой НИЖНЕЙ ноты (C4 над C3, G4 над C3…):
    // нижняя нота сама даёт энергию на этой частоте. Требуем, чтобы её партиалы, кратные k,
    // были заметно громче соседних — иначе верхнюю ноту не играли (живой/стендовый случай:
    // Twinkle двумя руками, C3+G4 → сыграна только C3, а G4 «слышна»).
    if (present && h1.shared) present = harmonicBoostOk(ctx, midi, set, p);

    // Защита: октава выше
    let octaveUp = false;
    if (!set.has(midi + 12)) {
      const ownOdd = own.filter((x) => x.h % 2 === 1);
      if (ownOdd.length > 0) {
        const bestOdd = Math.max(...ownOdd.map((x) => x.snrDb));
        octaveUp = bestOdd < p.snrDb;
      }
    }

    // Защита: f0 — лишь гармоника более низкой ноты (f0/2 — октава ниже, f0/3 — дуодецима ниже, f0/4 — 2 октавы).
    // Например, у G2 (и у голоса на G2) 3-я гармоника = D4. Такая нижняя нота даёт энергию
    // на «своих» частотах f0·j/k, которых у самой ноты нет.
    let subDb: number | null = null;
    let octaveDown = false;
    for (const sh of SUBHARMONICS) {
      if (set.has(midi - sh.semis)) continue;
      const vals = sh.ratios
        .map((r) => f0 * r)
        .filter((f) => f >= MIN_SUB_HZ && !explainedByOthers(f, others))
        .map((f) => snrAt(ctx, f, p.toleranceCents).snr)
        .filter((v) => Number.isFinite(v))
        .sort((a, b) => b - a);
      if (vals.length < sh.need) continue;
      // Для f0/3 и f0/4 нужны ДВЕ сильные частоты — одна могла совпасть случайно
      const v = vals[sh.need - 1];
      subDb = subDb === null ? v : Math.max(subDb, v);
      if (v >= p.snrDb && v >= h1.snrDb - p.octaveMarginDb) octaveDown = true;
    }

    // Новый удар (аккорд): должны вырасти минимум ДВА сильных партиала (если их столько есть).
    // Один «растущий» партиал даёт и остаток прошлого аккорда, подсвеченный шумом удара
    // соседних нот (живой отчёт: E5 без удара засчитывалась на 10–11 дБ).
    let rising = true;
    if (ctx.reference && p.riseDb > 0) {
      const pool = strongOwn.length > 0 ? strongOwn : harmonics.filter((x) => x.snrDb >= p.snrDb);
      const risen = pool.filter((x) => x.riseDb !== null && x.riseDb >= p.riseDb).length;
      // Для одиночной ноты хватит одного: повтор той же ноты (E E, F F) поверх её же звучания
      // даёт рост в случайной фазе, и требование двух партиалов теряло настоящие удары
      const need = expected.length > 1 ? 2 : 1;
      rising = risen >= Math.min(need, pool.length) && risen > 0;
    }

    const positive = own.length ? own : harmonics;
    const score = positive.reduce((s, x) => s + Math.max(0, Number.isFinite(x.snrDb) ? x.snrDb : 0), 0) / positive.length;

    let verdict: NoteVerdict = 'ok';
    if (!present) verdict = 'weak';
    else if (octaveUp) verdict = 'octave-up';
    else if (octaveDown) verdict = 'octave-down';
    else if (!rising) verdict = 'no-attack';

    return { midi, harmonics, score, subDb, passed: verdict === 'ok', verdict };
  });

  // Баланс аккорда: несыгранная нота даёт слабый «призрак» (остаток прошлого аккорда, резонанс
  // цифрового пианино) на ~10 дБ над шумом — абсолютный порог он проходит, но на 17–22 дБ тише
  // остальных нот. У настоящих аккордов разброс между нотами в живых отчётах ≤ ~10 дБ.
  if (p.chordBalanceDb > 0 && notes.length > 1) {
    const loudest = Math.max(...notes.filter((n) => n.passed).map((n) => n.score));
    for (const n of notes) {
      if (n.passed && n.score < loudest - p.chordBalanceDb) {
        n.passed = false;
        n.verdict = 'faint';
      }
    }
  }
  return notes;
}

/** Амплитуда наибольшего бина в пределах допуска вокруг freq (0 — вне спектра). */
function peakAmp(ctx: SpectrumContext, freq: number, tolCents: number): number {
  const binHz = ctx.sampleRate / ctx.fftSize;
  const maxBin = ctx.mags.length - 2;
  if (freq / binHz >= maxBin - 1) return 0;
  const [lo, hi] = binRange(freq, binHz, maxBin, tolCents);
  return peakAround(ctx.mags, lo, hi)[0];
}

/**
 * Аккорд, где верхняя нота — гармоника нижней (k = fH / fL ≈ 2…8: октава, дуодецима, две октавы…).
 * Все партиалы верхней ноты совпадают с партиалами нижней, кратными k. Если верхнюю сыграли, эти
 * партиалы нижней заметно громче соседних (h ± 1). Сравниваем по нескольким и берём медиану.
 * Для k = 2 и 4 не используем ×1 и ×2 нижней: микрофон телефона почти не слышит ~100–150 Гц
 * (×2 тогда кажется усиленным), а ×2 и без верхней ноты на ~3.5 дБ громче ×3.
 * Нет такой нижней ноты в аккорде или нет данных для сравнения — проверку не применяем.
 */
function harmonicBoostOk(ctx: SpectrumContext, midi: number, set: Set<number>, p: ChordCheckParams): boolean {
  if (p.octaveChordDb <= 0) return true;
  const fH = midiToFreq(midi);
  for (const low of [...set].sort((a, b) => a - b)) {
    if (low >= midi) continue;
    const fL = midiToFreq(low);
    const k = Math.round(fH / fL);
    if (k < 2 || k > 8 || Math.abs(1200 * Math.log2(fH / (k * fL))) > 30) continue;
    const centers = k === 2 ? [4, 6, 8] : k === 4 ? [4, 8] : [k, 2 * k, 3 * k].filter((h) => h <= 16);
    const ratios: number[] = [];
    for (const h of centers) {
      const center = peakAmp(ctx, partialFreq(fL, h), p.toleranceCents);
      const sides = [h - 1, h + 1].map((s) => peakAmp(ctx, partialFreq(fL, s), p.toleranceCents)).filter((a) => a > 0);
      if (center <= 0 || sides.length < 2) continue;
      const ref = Math.max(Math.sqrt(sides[0] * sides[1]), ctx.noiseFloor);
      ratios.push(20 * Math.log10(center / ref));
    }
    if (ratios.length === 0) continue;
    ratios.sort((a, b) => a - b);
    const median = ratios.length % 2 ? ratios[ratios.length >> 1] : 0.5 * (ratios[ratios.length / 2 - 1] + ratios[ratios.length / 2]);
    return median >= p.octaveChordDb;
  }
  return true;
}

/** SNR, рост относительно ctx.reference и уточнённая частота настоящего пика у freq. */
export function partialPeak(ctx: SpectrumContext, freq: number, tolCents: number): { snr: number; rise: number | null; peakHz: number } {
  return snrAt(ctx, freq, tolCents);
}

/** SNR (дБ) настоящего пика у частоты freq — для проверок вне аккорда. */
export function partialSnrDb(ctx: SpectrumContext, freq: number, tolCents: number): number {
  return snrAt(ctx, freq, tolCents).snr;
}

export interface TunedPeaks {
  /** Сколько заметных НОВЫХ пиков (выросли относительно спектра до удара). */
  peaks: number;
  /** Из них лежат близко к нотам равномерного строя. */
  tuned: number;
}

/**
 * «Фортепианность» звука без знания нот: у струн все нижние партиалы
 * (×1, ×2, ×4 и почти ×3) попадают в ноты строя, а голос и шумы — куда угодно.
 * Считаем только пики, выросшие после удара (нужен ctx.reference).
 */
export function countTunedPeaks(
  ctx: SpectrumContext,
  opts: { fMin: number; fMax: number; promDb: number; riseDb: number; tolCents: number; maxPeaks: number },
): TunedPeaks {
  const mags = ctx.mags;
  const binHz = ctx.sampleRate / ctx.fftSize;
  const kLo = Math.max(2, Math.floor(opts.fMin / binHz));
  const kHi = Math.min(mags.length - 3, Math.ceil(opts.fMax / binHz));
  const found: { mag: number; dev: number }[] = [];
  for (let k = kLo; k <= kHi; k++) {
    const m = mags[k];
    if (!(m > mags[k - 1] && m >= mags[k + 1])) continue;
    const ref = Math.max(ctx.noise ? ctx.noise[k] : 0, localBackground(mags, k), ctx.noiseFloor);
    if (20 * Math.log10(m / ref) < opts.promDb) continue;
    if (ctx.reference) {
      const before = Math.max(ctx.reference[k - 1], ctx.reference[k], ctx.reference[k + 1], ctx.noiseFloor);
      if (20 * Math.log10(m / before) < opts.riseDb) continue;
    }
    const a = Math.log(mags[k - 1] + 1e-12), b = Math.log(m + 1e-12), c = Math.log(mags[k + 1] + 1e-12);
    const denom = a - 2 * b + c;
    const shift = denom < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) : 0;
    const semis = 12 * Math.log2(((k + shift) * binHz) / 440);
    found.push({ mag: m, dev: 100 * (semis - Math.round(semis)) });
  }
  found.sort((x, y) => y.mag - x.mag);
  const top = found.slice(0, opts.maxPeaks);
  return { peaks: top.length, tuned: top.filter((x) => Math.abs(x.dev) <= opts.tolCents).length };
}
