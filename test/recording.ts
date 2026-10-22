/**
 * Тест записи по сценарию: «живой» прогон синтетики с записью управляющих сообщений → WAV с
 * метаданными → чтение → повторный прогон (src/record/replay.ts) даёт те же вердикты и верную оценку шагов.
 * Запуск: npm run test:rec
 */
import { Analyzer } from '../src/audio/analyzer';
import { midiToFreq, midiToName } from '../src/audio/notes';
import type { AnalyzerEvent, WorkletInMessage } from '../src/audio/messages';
import { DEFAULT_PARAMS } from '../src/audio/params';
import { decodeWav, encodeWav, toInt16, type RecordingMeta, type StepLabel } from '../src/record/wav';
import { grade, replay } from '../src/record/replay';
import { RECORD_SONG } from '../src/record/record-song';
import { RecordSession } from '../src/record/session';

let pass = 0, fail = 0;
function expect(name: string, ok: boolean, detail = '') {
  ok ? pass++ : fail++;
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : '  — ' + detail}`);
}

const SR = 48000;
function rand(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
}
function strike(out: Float32Array, at: number, midi: number, seed: number) {
  const f0 = midiToFreq(midi);
  const r = rand(seed);
  const i0 = Math.floor(at * SR);
  const n = Math.min(out.length - i0, Math.floor(1.2 * SR));
  const ph = Array.from({ length: 10 }, () => r() * Math.PI);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let s = 0;
    for (let h = 1; h <= 10; h++) s += (1 / h) * Math.exp(-t * (1.5 + 0.6 * h)) * Math.sin(2 * Math.PI * h * f0 * Math.sqrt(1 + 3e-4 * h * h) * t + ph[h - 1]);
    out[i0 + i] += 0.2 * Math.min(1, t / 0.003) * (s * 0.5 + (t < 0.01 ? r() * 0.3 * (1 - t / 0.01) : 0));
  }
}

// Сценарий: «живой» анализатор уже поработал 1 с до записи (время записи начинается не с нуля)
const pre = 1.0;
const plan: { at: number; msg: WorkletInMessage; label?: Omit<StepLabel, 'index' | 'tStart' | 'tEnd'> & { len: number } }[] = [
  { at: 0, msg: { type: 'calibrate', seconds: 2 }, label: { say: 'Тишина', expect: [], play: null, want: 'none', times: 1, len: 2.6 } },
  { at: 2.6, msg: { type: 'expected', midis: [60] }, label: { say: 'Сыграйте C4', expect: [60], play: [60], want: 'pass', times: 1, len: 2 } },
  { at: 4.6, msg: { type: 'expected', midis: [64] }, label: { say: 'Сыграйте D4', expect: [64], play: [62], want: 'fail', times: 1, len: 2 } },
  { at: 6.6, msg: { type: 'expected', midis: [67] }, label: { say: 'Сыграйте G4', expect: [67], play: [67], want: 'pass', times: 1, len: 2 } },
  { at: 8.6, msg: { type: 'expected', midis: [62] }, label: { say: 'Тишина', expect: [62], play: null, want: 'none', times: 1, len: 1.6 } },
];
const total = 10.4;
const sig = new Float32Array(Math.floor((pre + total) * SR));
const r = rand(3);
for (let i = 0; i < sig.length; i++) sig[i] = 0.002 * r();
strike(sig, pre + 3.0, 60, 1);
strike(sig, pre + 5.0, 62, 2);
strike(sig, pre + 7.0, 67, 3);

// «Живой» прогон: как worklet — сообщение применяется перед блоком и помечается временем анализатора
const live = new Analyzer(SR);
const recStart = Math.round((pre * SR) / 128) * 128;
const controls: RecordingMeta['controls'] = [];
const liveEvents: AnalyzerEvent[] = [];
const steps: StepLabel[] = [];
let pi = 0;
for (let i = 0; i < sig.length; i += 128) {
  const t = live.time;
  const rel = (i - recStart) / SR;
  while (i >= recStart && pi < plan.length && plan[pi].at <= rel + 1e-9) {
    const p = plan[pi++];
    controls.push({ t, msg: p.msg });
    if (p.msg.type === 'calibrate') live.startCalibration(p.msg.seconds);
    if (p.msg.type === 'expected') live.setExpected(p.msg.midis);
    if (p.label) {
      const { len, ...l } = p.label;
      steps.push({ ...l, index: steps.length, tStart: t, tEnd: t + len });
    }
  }
  for (const ev of live.process(sig.subarray(i, i + 128))) if (i >= recStart && ev.type !== 'frame') liveEvents.push(ev);
}
const recorded = sig.subarray(recStart);
const meta: RecordingMeta = {
  app: 'piano-mic', version: 1, build: 'test', ua: 'test', sampleRate: SR, bigFft: 8192,
  params: DEFAULT_PARAMS, t0: recStart / SR, controls, steps, live: JSON.parse(JSON.stringify(liveEvents)),
};
const bytes = encodeWav([toInt16(recorded)], SR, meta);
if (process.env.REC_OUT) (await import('node:fs')).writeFileSync(process.env.REC_OUT, bytes); // образец для tools/replay.ts
const back = decodeWav(bytes);
expect('WAV: длина и частота сохранились', back.sampleRate === SR && back.samples.length === recorded.length);
expect('WAV: метаданные сценария читаются', back.meta !== null && back.meta.steps.length === steps.length && back.meta.controls.length === controls.length);
const maxErr = back.samples.reduce((m, x, i) => Math.max(m, Math.abs(x - recorded[i])), 0);
expect('WAV: звук совпадает до шага 16 бит', maxErr < 1 / 16384, `ошибка ${maxErr}`);

const ev = replay(back.samples, back.meta!);
// Время атаки может сдвинуться на один шаг анализа (~10 мс): у живого анализатора была история до записи
const checks = (es: readonly unknown[]) => (es as AnalyzerEvent[]).flatMap((e) => (e.type === 'check' ? [{ t: e.onsetTime, ok: e.allPassed }] : []));
const a = checks(liveEvents), b = checks(ev);
const same = a.length === b.length && a.every((x, i) => x.ok === b[i].ok && Math.abs(x.t - b[i].t) < 0.025);
expect('Повторный прогон даёт те же вердикты, что вживую (±25 мс)', same, `вживую ${JSON.stringify(a)} / прогон ${JSON.stringify(b)}`);
const g = grade(ev, back.meta!.steps);
expect('Оценка шагов: все 5 верны (✓, ✗ на чужую ноту, тишина без вердикта)', g.every((x) => x.ok), g.map((x) => `${x.step.say}:${x.got}`).join('; '));
const gLive = grade(back.meta!.live, back.meta!.steps);
expect('Оценка по живым событиям из файла совпадает', gLive.every((x, i) => x.ok === g[i].ok));

// Мелодия записи целиком, как в приложении («Ожидание»): «пользователь» нажимает то, что упало,
// когда нота встала на линии (басы держит), шаги с тайной проверкой уходят дальше сами.
{
  const startAt = 3; // после калибровки
  const session = new RecordSession(RECORD_SONG);
  const player = session.player;
  const spb = player.secPerBeat;
  const sig2 = new Float32Array(Math.floor(140 * SR));
  const rr = rand(11);
  for (let i = 0; i < sig2.length; i++) sig2[i] = 0.002 * rr();
  const jit = rand(5);
  const strikeNote = (t: number, pitch: number, durSec: number, seed: number) => {
    const f0 = midiToFreq(pitch), i0 = Math.floor(t * SR), m = Math.min(sig2.length - i0, Math.floor(durSec * SR));
    const r2 = rand(seed);
    const ph = Array.from({ length: 10 }, () => r2() * Math.PI);
    for (let i = 0; i < m; i++) {
      const tt = i / SR;
      let v = 0;
      for (let h = 1; h <= 10; h++) v += ((h === 1 && pitch < 60 ? 0.5 : 1) / h) * Math.exp(-tt * 0.5 * (1 + 0.4 * h)) * Math.sin(2 * Math.PI * h * f0 * Math.sqrt(1 + 3e-4 * h * h) * tt + ph[h - 1]);
      sig2[i0 + i] += 0.2 * Math.min(1, tt / 0.003) * (v * 0.5 + (tt < 0.01 ? r2() * 0.3 * (1 - tt / 0.01) : 0));
    }
  };
  const an = new Analyzer(SR);
  const ctl: RecordingMeta['controls'] = [{ t: 0, msg: { type: 'calibrate', seconds: 2 } }];
  an.startCalibration(2);
  const liveEv: AnalyzerEvent[] = [];
  let sent = '';
  const played = new Set<number>();
  let end = sig2.length;
  for (let i = 0; i < end; i += 128) {
    const t = an.time;
    if (t >= startAt) session.tick(t);
    const cur = player.current;
    // Нота встала на линии — нажимаем (с разбросом реакции 0.25–0.45 с)
    if (cur && player.waiting && !played.has(cur.index)) {
      played.add(cur.index);
      const at = t + 0.35 + 0.1 * jit();
      cur.notes.forEach((n, j) => strikeNote(at + j * 0.01, n.pitch, n.dur * spb + 0.4, n.pitch * 7 + cur.index));
    }
    if (session.finished && end === sig2.length) end = Math.min(sig2.length, i + 1.5 * SR);
    const exp = t >= startAt ? player.expected() : [];
    if (exp.join() !== sent) {
      sent = exp.join();
      ctl.push({ t, msg: { type: 'expected', midis: exp } });
      an.setExpected(exp);
    }
    for (const e of an.process(sig2.subarray(i, i + 128))) {
      if (e.type === 'frame') continue;
      liveEv.push(e);
      if (e.type === 'check') session.onCheck(e.allPassed, e.onsetTime);
    }
  }
  const labels = session.labels((t) => t);
  const secret = labels.filter((l) => l.want === 'fail').length;
  expect(`Мелодия записи («Ожидание»): пройдена до конца, ${labels.length} шагов, тайных проверок ${secret}`, session.finished && labels.length > 40 && secret === 9, `${labels.length}/${secret}, конец: ${session.finished}`);
  const audio = sig2.subarray(0, end);
  const metaS: RecordingMeta = { app: 'piano-mic', version: 1, build: 'test', ua: 'test', sampleRate: SR, bigFft: 8192, params: DEFAULT_PARAMS, t0: 0, controls: ctl, steps: labels, live: liveEv };
  const back2 = decodeWav(encodeWav([toInt16(audio)], SR, metaS));
  const g2 = grade(replay(back2.samples, back2.meta!), back2.meta!.steps);
  const bad = g2.filter((x) => !x.ok).map((x) => `играли ${x.step.play.map(midiToName).join('+')}, проверка ${x.step.expect.map(midiToName).join('+')}: ${x.got}`);
  const falsePass = g2.filter((x) => x.step.want === 'fail' && x.checks.some((c) => c.allPassed)).length;
  expect('Мелодия записи на синтетике: тайные ошибки не засчитаны', falsePass === 0, bad.join('; '));
  expect('Мелодия записи на синтетике: все шаги оценены верно', bad.length === 0, bad.join('; '));
  console.log(`  (запись ${(audio.length / SR).toFixed(0)} с)`);
}

console.log(`\nИтого: ${pass} ✓, ${fail} ✗`);
process.exit(fail ? 1 : 0);
