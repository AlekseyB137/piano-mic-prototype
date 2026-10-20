/**
 * Стенд на синтетике: прогоняет Analyzer по искусственным ударам «фортепиано».
 * Запуск: npx tsx test/synth-bench.ts
 * Синтетика ≠ живой инструмент: стенд ловит логические ошибки и регрессии,
 * но не заменяет проверку с настоящим пианино и микрофоном телефона.
 */
import { Analyzer } from '../src/audio/analyzer';
import { midiToFreq, midiToName } from '../src/audio/notes';
import type { AnalyzerEvent, CheckEvent, NoteEvent } from '../src/audio/messages';

const SR = 48000;
const B = 3e-4;

function rand(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
}

/** Удар: партиалы h·f0·√(1+B h²), амплитуда ~1/h, верх затухает быстрее; короткий шумовой «стук» молоточка. */
function strike(out: Float32Array, at: number, midi: number, gain = 0.2, dur = 1.2, seed = 1, h1Gain?: number) {
  const f0 = midiToFreq(midi) * Math.pow(2, (midi > 64 ? (midi - 64) * 0.8 : 0) / 1200);
  const r = rand(seed);
  const i0 = Math.floor(at * SR);
  const n = Math.min(out.length - i0, Math.floor(dur * SR));
  const phases = Array.from({ length: 12 }, () => r() * Math.PI);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const atk = Math.min(1, t / 0.003);
    let s = 0;
    for (let h = 1; h <= 12; h++) {
      const f = h * f0 * Math.sqrt(1 + B * h * h);
      if (f > SR / 2.2) break;
      // у басов основной тон слабее 2-й гармоники — как у реальных струн и маленьких микрофонов
      const a = (1 / h) * (h === 1 ? h1Gain ?? (midi < 48 ? 0.4 : 1) : 1);
      s += a * Math.exp(-t * (1.5 + 0.6 * h)) * Math.sin(2 * Math.PI * f * t + phases[h - 1]);
    }
    const thump = t < 0.01 ? r() * 0.3 * (1 - t / 0.01) : 0;
    out[i0 + i] += gain * atk * (s * 0.5 + thump);
  }
}

function render(seconds: number, events: { at: number; midis: number[]; gain?: number; h1?: number }[], noise = 0.002) {
  const out = new Float32Array(Math.floor(seconds * SR));
  const r = rand(99);
  for (let i = 0; i < out.length; i++) out[i] = noise * r();
  events.forEach((e, k) => e.midis.forEach((m, j) => strike(out, e.at + j * 0.01, m, e.gain ?? 0.2, 1.2, k * 31 + j, e.h1)));
  return out;
}

function run(signal: Float32Array, setup?: (a: Analyzer) => void, calibrate = true): AnalyzerEvent[] {
  const a = new Analyzer(SR);
  setup?.(a);
  const evs: AnalyzerEvent[] = [];
  const pad = new Float32Array(Math.floor(2.3 * SR));
  const r = rand(7);
  for (let i = 0; i < pad.length; i++) pad[i] = 0.002 * r();
  if (calibrate) a.startCalibration(2);
  for (const sig of [pad, signal]) for (let i = 0; i < sig.length; i += 128) evs.push(...a.process(sig.subarray(i, i + 128)));
  return evs.filter((e) => e.type !== 'frame');
}

let pass = 0, fail = 0, known = 0;
function expect(name: string, ok: boolean, detail = '') {
  ok ? pass++ : fail++;
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : '  — ' + detail}`);
}
/** Известное ограничение: печатаем результат, но стенд не валим. Если вдруг прошло — повод перевести в expect. */
function knownLimit(name: string, ok: boolean, detail = '') {
  if (!ok) known++;
  console.log(`${ok ? '✓' : '⚠'} [известное ограничение] ${name}${ok ? '' : '  — ' + detail}`);
}

// 1. Свободный режим: одиночные ноты C2..B5
const freeMiss: string[] = [];
for (let m = 36; m <= 83; m++) {
  const ev = run(render(1.2, [{ at: 0.2, midis: [m] }]));
  const notes = ev.filter((e): e is NoteEvent => e.type === 'note');
  const got = notes.map((n) => midiToName(n.pitch.midi)).join(',');
  if (notes.length !== 1 || notes[0].pitch.midi !== m) freeMiss.push(`${midiToName(m)}→[${got || '—'}]`);
}
expect(`Свободный режим: 48 одиночных нот C2–B5`, freeMiss.length === 0, freeMiss.join(' '));

// 2. Свободный режим: быстрые повторы одной ноты (8 ударов, 150 мс)
{
  const ev = run(render(2, Array.from({ length: 8 }, (_, i) => ({ at: 0.2 + i * 0.15, midis: [60] }))));
  const n = ev.filter((e) => e.type === 'note').length;
  expect('Быстрые повторы C4 ×8 по 150 мс', n === 8, `распознано ${n}`);
}

// 3. Режим проверки
type Case = { name: string; expect: number[]; play: number[]; want: boolean; gain?: number; h1?: number };
const cases: Case[] = [
  { name: 'C4 → C4', expect: [60], play: [60], want: true },
  { name: 'C4 → C#4 (сосед)', expect: [60], play: [61], want: false },
  { name: 'C4 → C5 (октава выше)', expect: [60], play: [72], want: false },
  { name: 'C5 → C4 (октава ниже)', expect: [72], play: [60], want: false },
  { name: 'G4 → C3 (G4 = 3-я гармоника C3)', expect: [67], play: [48], want: false },
  { name: 'C-E-G → C-E-G', expect: [60, 64, 67], play: [60, 64, 67], want: true },
  { name: 'C-E-G → C-E (без G)', expect: [60, 64, 67], play: [60, 64], want: false },
  { name: 'C-E-G → C-Eb-G (минор)', expect: [60, 64, 67], play: [60, 63, 67], want: false },
  { name: 'C3+C4 → C3+C4 (октава)', expect: [48, 60], play: [48, 60], want: true },
  { name: 'C3+C4 → только C3', expect: [48, 60], play: [48], want: false },
  { name: 'C4+C5 → C4+C5', expect: [60, 72], play: [60, 72], want: true },
  { name: 'C4+C5 → только C4', expect: [60, 72], play: [60], want: false },
  // Микрофон iPhone почти не слышит основной тон ~130 Гц (живой отчёт 2026-10-20: «только C3» засчитывалось за C3+C4)
  { name: 'C3+C4 → C3+C4, слабый основной тон (iPhone)', expect: [48, 60], play: [48, 60], want: true, h1: 0.2 },
  { name: 'C3+C4 → только C3, слабый основной тон (iPhone)', expect: [48, 60], play: [48], want: false, h1: 0.2 },
  { name: 'C3+C4 → C3+B3, слабый основной тон (iPhone, живой отчёт)', expect: [48, 60], play: [48, 59], want: false, h1: 0.2 },
  { name: 'C3+C4 → C3+B3', expect: [48, 60], play: [48, 59], want: false },
  { name: 'C2+C4 → C2+C4', expect: [36, 60], play: [36, 60], want: true },
  { name: 'C2+C4 → только C2', expect: [36, 60], play: [36], want: false },
  { name: 'A2 → A2 (бас)', expect: [45], play: [45], want: true },
  { name: 'B5 → B5 (верх)', expect: [83], play: [83], want: true },
  { name: 'F3-A3-C4 → F3-A3-C4', expect: [53, 57, 60], play: [53, 57, 60], want: true },
  { name: 'C4 тихо (−20 дБ) → C4', expect: [60], play: [60], want: true, gain: 0.02 },
];
for (const c of cases) {
  const ev = run(render(1.2, [{ at: 0.2, midis: c.play, gain: c.gain, h1: c.h1 }]), (a) => a.setExpected(c.expect));
  const checks = ev.filter((e): e is CheckEvent => e.type === 'check');
  const got = checks.length ? checks[0].allPassed : null;
  const detail = checks.length
    ? checks[0].notes.map((n) => `${midiToName(n.midi)}:${n.passed ? 'ok' : n.evidence?.verdict ?? '?'}`).join(' ') + ` (${checks[0].latencyMs} мс)`
    : 'вердикта нет: ' + ev.filter((e) => e.type === 'dropped').map((e) => (e as { reason: string }).reason).join('; ');
  expect(`Проверка ${c.name}: ждём ${c.want ? '✓' : '✗'}`, got === c.want, detail);
}

// 2б. Трели (с реального iPhone, отчёты 2026-10-19): предыдущая нота ещё звучит,
// атака часто срабатывает на щелчке пальца о клавишу за ~80 мс до удара молоточка.
function keyClick(out: Float32Array, at: number, gain = 0.03, seed = 5) {
  const r = rand(seed);
  const i0 = Math.floor(at * SR);
  for (let i = 0; i < 300 && i0 + i < out.length; i++) out[i0 + i] += gain * r() * Math.exp(-i / 60);
}
function trill(lo: number, hi: number, n: number, stepSec: number, opts: { click?: boolean; hiGain?: number; echo?: boolean } = {}) {
  const sig = render(0.6 + n * stepSec + 0.6, []);
  const want: number[] = [];
  for (let k = 0; k < n; k++) {
    const m = k % 2 ? lo : hi;
    const at = 0.4 + k * stepSec;
    if (opts.click) keyClick(sig, at - 0.08, 0.03, 11 + k);
    if (opts.echo) keyClick(sig, at + 0.1, 0.08, 71 + k); // лишняя атака того же удара через 100 мс
    strike(sig, at, m, m === hi ? 0.2 * (opts.hiGain ?? 1) : 0.2, 1.2, 50 + k);
    want.push(m);
  }
  return { sig, want };
}
for (const [name, t] of [
  ['Трель B5/A#5 ×10 по 300 мс', trill(82, 83, 10, 0.3)],
  ['Трель B5/A#5 ×10 по 300 мс, щелчок пальца за 80 мс', trill(82, 83, 10, 0.3, { click: true })],
  ['Трель B5/A#5 ×10 по 300 мс, B5 тише на 4 дБ', trill(82, 83, 10, 0.3, { hiGain: 0.63 })],
  ['Трель E5/D#5 ×10 по 230 мс', trill(75, 76, 10, 0.23)],
  ['Трель E5/D#5 ×12 по 170 мс', trill(75, 76, 12, 0.17)],
  ['Трель B5/A#5 ×12 по 170 мс', trill(82, 83, 12, 0.17)],
  ['Трель E5/D#5 ×10 по 300 мс, лишняя атака через 100 мс после удара', trill(75, 76, 10, 0.3, { echo: true })],
] as const) {
  const ev = run(t.sig);
  const got = ev.filter((e): e is NoteEvent => e.type === 'note').map((e) => e.pitch.midi);
  const ok = got.length === t.want.length && got.every((m, i) => m === t.want[i]);
  if (!ok && process.env.DBG) for (const e of ev) if (e.type === 'dropped') console.log('   ', e.t.toFixed(3), e.reason, '|', e.seen);
  expect(name, ok, `сыграно ${t.want.map(midiToName).join(' ')}; распознано ${got.map(midiToName).join(' ') || '—'}`);
}

// 2в. Известные ограничения трелей: очень быстрая трель с тихой верхней нотой.
// Повторный тихий удар по ещё звучащей ноте в смеси с громкой соседней не виден ни YIN, ни спектру.
// (Лишние ноты после трели здесь частично — артефакт модели: каждый удар = новый генератор, они бьются.)
for (const [name, t] of [
  ['Трель E5/D#5 ×12 по 170 мс, E5 тише на 3 дБ', trill(75, 76, 12, 0.17, { hiGain: 0.71 })],
  ['Трель E5/D#5 ×12 по 170 мс, E5 тише на 6 дБ', trill(75, 76, 12, 0.17, { hiGain: 0.5 })],
] as const) {
  const got = run(t.sig).filter((e): e is NoteEvent => e.type === 'note').map((e) => e.pitch.midi);
  const ok = got.length === t.want.length && got.every((m, i) => m === t.want[i]);
  knownLimit(name, ok, `распознано ${got.map(midiToName).join(' ')}`);
}

// 3б. Режим проверки на живом iPhone (2026-10-20): слабые атаки через 0.5–1 с после аккорда
// (отпускание клавиш, демпферы) давали ложное «не засчитано». Должны молча пропускаться,
// а неправильно сыгранный аккорд — по-прежнему давать ✗.
{
  const sig = render(3, [{ at: 0.2, midis: [60, 64, 67] }]);
  keyClick(sig, 1.1, 0.03, 3); // стук при отпускании клавиш
  keyClick(sig, 2.0, 0.02, 4);
  const ev = run(sig, (a) => a.setExpected([60, 64, 67]));
  const checks = ev.filter((e): e is CheckEvent => e.type === 'check');
  expect('Проверка C-E-G: аккорд + стук при отпускании — один вердикт ✓, без ложных ✗', checks.length === 1 && checks[0].allPassed,
    checks.map((c) => (c.allPassed ? '✓' : '✗') + '@' + (c.onsetTime - 2.3).toFixed(2)).join(' '));
}
{
  // Щелчок пальца о клавишу за 160 мс до удара (живой отчёт): только один вердикт ✓
  const sig = render(1.6, [{ at: 0.36, midis: [60, 64, 67] }]);
  keyClick(sig, 0.2, 0.05, 8);
  const ev = run(sig, (a) => a.setExpected([60, 64, 67]));
  const checks = ev.filter((e): e is CheckEvent => e.type === 'check');
  expect('Проверка C-E-G: щелчок пальца за 160 мс до аккорда — один вердикт ✓', checks.length === 1 && checks[0].allPassed,
    checks.map((c) => (c.allPassed ? '✓' : '✗') + '@' + (c.onsetTime - 2.3).toFixed(2)).join(' ') || 'вердикта нет');
}
// Живой отчёт 2026-10-20: C5-E5-G5 ×3, затем C5+G5 без E5 — E5 «засчитывалась» по остатку звучания
for (const [label, chord, missing] of [
  ['C5-E5-G5, потом без E5', [72, 76, 79], 76],
  ['C4-E4-G4, потом без E4', [60, 64, 67], 64],
  ['C3-E3-G3, потом без E3', [48, 52, 55], 52],
] as const) {
  const sig = render(5, []);
  const at = [0.3, 1.8, 3.3];
  at.forEach((t, k) => chord.forEach((m, j) => strike(sig, t + j * 0.01, m, 0.2, 4, 200 + k * 7 + j)));
  // 4-й удар — без средней ноты; прошлые аккорды ещё звучат (цифровое пианино, долгое затухание)
  const sig2 = new Float32Array(Math.floor(6.5 * SR));
  sig2.set(sig);
  chord.filter((m) => m !== missing).forEach((m, j) => strike(sig2, 4.8 + j * 0.01, m, 0.2, 1.5, 300 + j));
  const ev = run(sig2, (a) => a.setExpected([...chord]));
  const checks = ev.filter((e): e is CheckEvent => e.type === 'check');
  const verdicts = checks.map((c) => (c.allPassed ? '✓' : '✗')).join('');
  expect(`Проверка ${label}: ждём ✓✓✓✗`, verdicts === '✓✓✓✗',
    checks.map((c) => (c.allPassed ? '✓' : '✗') + '@' + (c.onsetTime - 2.3).toFixed(2) + '[' + c.notes.map((n) => midiToName(n.midi) + ':' + (n.passed ? 'ok' : n.evidence?.verdict)).join(',') + ']').join(' '));
}
{
  // Живой отчёт 2026-10-20 (3 серии 3+1): несыгранная E5 «звучала» на 9–11 дБ при 25–35 дБ у C5/G5
  // и дважды засчитывалась. Моделируем «призрак» E5 на −24 дБ, растущий вместе с ударом.
  const sig = render(1.6, [{ at: 0.3, midis: [72, 79] }]);
  strike(sig, 0.3, 76, 0.2 * 0.063, 1.5, 77);
  const ev = run(sig, (a) => a.setExpected([72, 76, 79]));
  const checks = ev.filter((e): e is CheckEvent => e.type === 'check');
  expect('Проверка C5-E5-G5 → C5+G5 и «призрак» E5 на −24 дБ: ждём ✗', checks.length === 1 && !checks[0].allPassed,
    checks.map((c) => c.notes.map((n) => midiToName(n.midi) + ':' + (n.passed ? 'ok' : n.evidence?.verdict) + ' ' + n.evidence?.score.toFixed(0)).join(',')).join(' ') || 'вердикта нет');
}
{
  // Живой отчёт 2026-10-20: атака сработала на стуке клавиши (тихо) за ~50 мс до звука аккорда
  // без E5 — проверка громкости в момент атаки отбросила удар, вердикта не было
  const sig = render(5.2, [0.3, 1.3, 2.3].map((at) => ({ at, midis: [72, 76, 79] })));
  keyClick(sig, 3.25, 0.01, 31);
  [72, 79].forEach((m, j) => strike(sig, 3.3 + j * 0.01, m, 0.2, 1.5, 400 + j));
  const ev = run(sig, (a) => a.setExpected([72, 76, 79]));
  const verdicts = ev.filter((e): e is CheckEvent => e.type === 'check').map((c) => (c.allPassed ? '✓' : '✗')).join('');
  expect('Проверка C5-E5-G5 ×3, затем стук клавиши + аккорд без E5 — ✓✓✓✗', verdicts === '✓✓✓✗', verdicts || 'вердиктов нет');
}
{
  // Живой отчёт: тихие щелчки (касания экрана, −58…−68 дБFS) с подъёмом ВЧ давали ложные ✗
  const sig = render(5, [0.3, 1.3, 2.3].map((at) => ({ at, midis: [72, 76, 79] })));
  [3.3, 3.7, 4.1].forEach((t, k) => keyClick(sig, t, 0.004, 20 + k));
  const ev = run(sig, (a) => a.setExpected([72, 76, 79]));
  const verdicts = ev.filter((e): e is CheckEvent => e.type === 'check').map((c) => (c.allPassed ? '✓' : '✗')).join('');
  expect('Проверка C5-E5-G5 ×3, затем тихие щелчки — только ✓✓✓', verdicts === '✓✓✓', verdicts);
}
for (const c of [
  { name: 'C-E-G → D-F-A (весь аккорд не тот)', expect: [60, 64, 67], play: [62, 65, 69] },
  { name: 'C4 → D4 (не та нота)', expect: [60], play: [62] },
]) {
  const ev = run(render(1.2, [{ at: 0.2, midis: c.play }]), (a) => a.setExpected(c.expect));
  const checks = ev.filter((e): e is CheckEvent => e.type === 'check');
  expect(`Проверка ${c.name}: ждём ✗`, checks.length === 1 && !checks[0].allPassed,
    checks.length ? checks.map((x) => (x.allPassed ? '✓' : '✗')).join(' ') : 'вердикта нет: ' + ev.filter((e) => e.type === 'dropped').map((e) => (e as { reason: string }).reason).join('; '));
}

// 4. Затухающая нота не засчитывается повторно; новый удар той же ноты — засчитывается
{
  const ev = run(render(2.5, [{ at: 0.2, midis: [60] }, { at: 1.4, midis: [60] }]), (a) => a.setExpected([60]));
  const ok = ev.filter((e): e is CheckEvent => e.type === 'check' && e.allPassed).length;
  expect('Повторный удар C4 через 1.2 с (нота ещё звучит)', ok === 2, `засчитано ${ok} из 2`);
}

// 4б. Живой отчёт 2026-10-20 (Twinkle, «F F E E»): повтор той же ноты через ~0.65 с поверх её звучания
for (const [label, m] of [['E4', 64], ['F4', 65], ['C4', 60]] as const) {
  const ev = run(render(2.2, [{ at: 0.2, midis: [m] }, { at: 0.85, midis: [m] }, { at: 1.5, midis: [m] }]), (a) => a.setExpected([m]));
  const ok = ev.filter((e): e is CheckEvent => e.type === 'check' && e.allPassed).length;
  expect(`Повтор ${label} ×3 через 0.65 с (нота ещё звучит)`, ok === 3, `засчитано ${ok} из 3`);
}

// 5. Тишина и шум: ни одного события
{
  const ev = run(render(3, [], 0.004), (a) => a.setExpected([60]));
  const n = ev.filter((e) => e.type === 'note' || e.type === 'check').length;
  expect('3 с шума — нет ложных нот', n === 0, `${n} ложных событий`);
}

// 6. Нагрузка
{
  const sig = render(10, Array.from({ length: 20 }, (_, i) => ({ at: i * 0.5, midis: [60, 64, 67] })));
  const a = new Analyzer(SR);
  a.setExpected([60, 64, 67]);
  const t0 = performance.now();
  for (let i = 0; i < sig.length; i += 128) a.process(sig.subarray(i, i + 128));
  const ms = performance.now() - t0;
  expect(`Нагрузка: 10 с звука за ${ms.toFixed(0)} мс (${((ms / 10000) * 100).toFixed(1)}% реального времени, на ПК)`, ms < 2000);
}

console.log(`\nИтого: ${pass} ✓, ${fail} ✗${known ? `, ${known} ⚠ известных ограничений` : ''}`);
process.exit(fail ? 1 : 0);
