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
import { SongPlayer } from '../src/song/player';

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

// Мелодия записи целиком: «пользователь» играет ровно то, что падает (держит басы, с небольшим
// разбросом по времени); вживую — как в приложении: окна шагов, тайные проверки, без остановок.
{
  const LAT = 0.12;
  const startAt = 3; // после калибровки
  const player = new SongPlayer(RECORD_SONG, 'tempo', 4, { earlySec: 0.18, lateSec: 0.18, latencySec: LAT }, 1, true);
  player.tick(startAt);
  const spb = player.secPerBeat;
  const len = startAt + (4 + Math.max(...RECORD_SONG.notes.map((n) => n.start + n.dur)) + 2) * spb;
  const sig2 = new Float32Array(Math.floor(len * SR));
  const rr = rand(11);
  for (let i = 0; i < sig2.length; i++) sig2[i] = 0.002 * rr();
  const jit = rand(5);
  for (const n of RECORD_SONG.notes) {
    const t = startAt + (4 + n.start) * spb + LAT + 0.04 * jit();
    // звучит, пока держат (длительность ноты), затухание медленное, как у цифрового пианино
    const f0 = midiToFreq(n.pitch), i0 = Math.floor(t * SR), m = Math.min(sig2.length - i0, Math.floor((n.dur * spb + 0.3) * SR));
    const r2 = rand(n.pitch * 7 + Math.round(n.start * 10));
    const ph = Array.from({ length: 10 }, () => r2() * Math.PI);
    for (let i = 0; i < m; i++) {
      const tt = i / SR;
      let s = 0;
      for (let h = 1; h <= 10; h++) s += ((h === 1 && n.pitch < 60 ? 0.5 : 1) / h) * Math.exp(-tt * 0.5 * (1 + 0.4 * h)) * Math.sin(2 * Math.PI * h * f0 * Math.sqrt(1 + 3e-4 * h * h) * tt + ph[h - 1]);
      sig2[i0 + i] += 0.2 * Math.min(1, tt / 0.003) * (s * 0.5 + (tt < 0.01 ? r2() * 0.3 * (1 - tt / 0.01) : 0));
    }
  }
  const an = new Analyzer(SR);
  const ctl: RecordingMeta['controls'] = [{ t: 0, msg: { type: 'calibrate', seconds: 2 } }];
  an.startCalibration(2);
  const liveEv: AnalyzerEvent[] = [];
  let sent = '';
  for (let i = 0; i < sig2.length; i += 128) {
    const t = an.time;
    if (t >= startAt) player.tick(t);
    const exp = t >= startAt ? player.expected() : [];
    if (exp.join() !== sent) {
      sent = exp.join();
      ctl.push({ t, msg: { type: 'expected', midis: exp } });
      an.setExpected(exp);
    }
    for (const e of an.process(sig2.subarray(i, i + 128))) {
      if (e.type === 'frame') continue;
      liveEv.push(e);
      if (e.type === 'check') player.judge(e.allPassed, e.onsetTime, an.time);
    }
  }
  const labels: StepLabel[] = player.steps.map((st, i) => {
    const w = player.recordWindow(i)!;
    const play = [...new Set(st.notes.map((n) => n.pitch))].sort((a, b) => a - b);
    const expect = player.checkFor(st);
    return { index: i, say: '', expect, play, want: expect.join() === play.join() ? 'pass' : 'fail', times: 1, tStart: w[0], tEnd: w[1] };
  });
  const secret = labels.filter((l) => l.want === 'fail').length;
  expect(`Мелодия записи: ${labels.length} шагов, из них тайных проверок ошибки ${secret}`, labels.length > 40 && secret === 9, `${labels.length}/${secret}`);
  expect('Мелодия записи доиграна без остановок', player.finished);
  const metaS: RecordingMeta = { app: 'piano-mic', version: 1, build: 'test', ua: 'test', sampleRate: SR, bigFft: 8192, params: DEFAULT_PARAMS, t0: 0, controls: ctl, steps: labels, live: liveEv };
  const back2 = decodeWav(encodeWav([toInt16(sig2)], SR, metaS));
  const g2 = grade(replay(back2.samples, back2.meta!), back2.meta!.steps);
  const bad = g2.filter((x) => !x.ok).map((x) => `играли ${x.step.play.map(midiToName).join('+')}, проверка ${x.step.expect.map(midiToName).join('+')}: ${x.got}`);
  // Синтетика ≠ пианино: допускаем пару промахов, но тайные ошибки не должны засчитываться
  const falsePass = g2.filter((x) => x.step.want === 'fail' && x.checks.some((c) => c.allPassed)).length;
  expect('Мелодия записи на синтетике: тайные ошибки не засчитаны', falsePass === 0, bad.join('; '));
  expect('Мелодия записи на синтетике: не больше 3 неверных шагов', bad.length <= 3, bad.join('; '));
  if (bad.length) console.log(`  (неверные шаги на синтетике: ${bad.join('; ')})`);
}

console.log(`\nИтого: ${pass} ✓, ${fail} ✗`);
process.exit(fail ? 1 : 0);
