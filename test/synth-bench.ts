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
function strike(out: Float32Array, at: number, midi: number, gain = 0.2, dur = 1.2, seed = 1) {
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
      const a = (1 / h) * (midi < 48 && h === 1 ? 0.4 : 1);
      s += a * Math.exp(-t * (1.5 + 0.6 * h)) * Math.sin(2 * Math.PI * f * t + phases[h - 1]);
    }
    const thump = t < 0.01 ? r() * 0.3 * (1 - t / 0.01) : 0;
    out[i0 + i] += gain * atk * (s * 0.5 + thump);
  }
}

function render(seconds: number, events: { at: number; midis: number[]; gain?: number }[], noise = 0.002) {
  const out = new Float32Array(Math.floor(seconds * SR));
  const r = rand(99);
  for (let i = 0; i < out.length; i++) out[i] = noise * r();
  events.forEach((e, k) => e.midis.forEach((m, j) => strike(out, e.at + j * 0.01, m, e.gain ?? 0.2, 1.2, k * 31 + j)));
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

let pass = 0, fail = 0;
function expect(name: string, ok: boolean, detail = '') {
  ok ? pass++ : fail++;
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : '  — ' + detail}`);
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
type Case = { name: string; expect: number[]; play: number[]; want: boolean; gain?: number };
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
  { name: 'C2+C4 → C2+C4', expect: [36, 60], play: [36, 60], want: true },
  { name: 'C2+C4 → только C2', expect: [36, 60], play: [36], want: false },
  { name: 'A2 → A2 (бас)', expect: [45], play: [45], want: true },
  { name: 'B5 → B5 (верх)', expect: [83], play: [83], want: true },
  { name: 'F3-A3-C4 → F3-A3-C4', expect: [53, 57, 60], play: [53, 57, 60], want: true },
  { name: 'C4 тихо (−20 дБ) → C4', expect: [60], play: [60], want: true, gain: 0.02 },
];
for (const c of cases) {
  const ev = run(render(1.2, [{ at: 0.2, midis: c.play, gain: c.gain }]), (a) => a.setExpected(c.expect));
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
  ['Трель E5/D#5 ×10 по 300 мс, лишняя атака через 100 мс после удара', trill(75, 76, 10, 0.3, { echo: true })],
] as const) {
  const ev = run(t.sig);
  const got = ev.filter((e): e is NoteEvent => e.type === 'note').map((e) => e.pitch.midi);
  const ok = got.length === t.want.length && got.every((m, i) => m === t.want[i]);
  if (!ok && process.env.DBG) for (const e of ev) if (e.type === 'dropped') console.log('   ', e.t.toFixed(3), e.reason, '|', e.seen);
  expect(name, ok, `сыграно ${t.want.map(midiToName).join(' ')}; распознано ${got.map(midiToName).join(' ') || '—'}`);
}

// 4. Затухающая нота не засчитывается повторно; новый удар той же ноты — засчитывается
{
  const ev = run(render(2.5, [{ at: 0.2, midis: [60] }, { at: 1.4, midis: [60] }]), (a) => a.setExpected([60]));
  const ok = ev.filter((e): e is CheckEvent => e.type === 'check' && e.allPassed).length;
  expect('Повторный удар C4 через 1.2 с (нота ещё звучит)', ok === 2, `засчитано ${ok} из 2`);
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

console.log(`\nИтого: ${pass} ✓, ${fail} ✗`);
process.exit(fail ? 1 : 0);
