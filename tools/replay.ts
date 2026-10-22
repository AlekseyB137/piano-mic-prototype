/**
 * Разбор записи по сценарию (кнопка «Запись по сценарию» в «Отладке»).
 * Запуск: npm run replay -- путь/к/piano-rec-….wav [--param snrDb=9 ...] [--verbose]
 *
 * Печатает по шагам: что просили сыграть, правильный ответ, вердикт вживую и при повторном прогоне.
 * С --param можно попробовать другие пороги на том же звуке.
 */
import { readFileSync } from 'node:fs';
import { decodeWav } from '../src/record/wav';
import { grade, replay } from '../src/record/replay';
import { midiToName } from '../src/audio/notes';
import type { AnalyzerParams } from '../src/audio/params';
import type { CheckEvent } from '../src/audio/messages';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && !a.includes('='));
if (!file) {
  console.error('Укажите файл: npm run replay -- piano-rec-….wav [--param имя=значение] [--verbose]');
  process.exit(2);
}
const verbose = args.includes('--verbose');
const params: Partial<AnalyzerParams> = {};
for (const a of args.filter((x) => x.includes('='))) {
  const [k, v] = a.replace(/^--param\s*/, '').split('=');
  (params as Record<string, number>)[k] = Number(v);
}

const { samples, meta } = decodeWav(new Uint8Array(readFileSync(file)));
if (!meta) {
  console.error('В файле нет данных сценария — это не запись из приложения.');
  process.exit(2);
}
console.log(`Запись: ${(samples.length / meta.sampleRate).toFixed(1)} с, ${meta.sampleRate} Гц, FFT ${meta.bigFft}, сборка ${meta.build}`);
console.log(`Устройство: ${meta.ua}`);
if (Object.keys(params).length) console.log(`Пороги изменены: ${JSON.stringify(params)}`);

const t0 = performance.now();
const events = replay(samples, meta, params);
console.log(`Прогон: ${((performance.now() - t0) / 1000).toFixed(1)} с\n`);

const live = grade(meta.live, meta.steps);
const now = grade(events, meta.steps);
const notes = (ms: number[] | null) => (ms === null ? '—' : ms.map(midiToName).join('+'));
const WANT = { pass: '✓', fail: '✗', none: 'тишина' } as const;
const verdict = (c: CheckEvent) =>
  c.notes.map((n) => `${midiToName(n.midi)}${n.passed ? '✓' : '✗' + (n.evidence ? n.evidence.verdict : '')}`).join(' ');

for (let i = 0; i < now.length; i++) {
  const r = now[i], l = live[i];
  const s = r.step;
  const mark = r.ok ? '✓' : '✗';
  const changed = r.ok !== l.ok ? (r.ok ? '  ← исправлено' : '  ← СТАЛО ХУЖЕ') : '';
  console.log(
    `${mark} ${String(i + 1).padStart(2)}. ${s.say.padEnd(34)} ждём ${notes(s.expect).padEnd(10)} играли ${notes(s.play).padEnd(10)} нужно ${WANT[s.want].padEnd(6)} | вживую: ${l.got.padEnd(12)} прогон: ${r.got}${changed}`,
  );
  if (verbose || !r.ok) {
    for (const c of r.checks) console.log(`      ${(c.onsetTime - meta.t0).toFixed(2)} с: ${verdict(c)} · ВЧ +${c.attack.hfRiseDb.toFixed(0)} дБ, ${c.attack.rmsDb.toFixed(0)} дБFS`);
    for (const d of r.dropped) console.log(`      ${(d.t - meta.t0).toFixed(2)} с: отброшено — ${d.reason}`);
  }
}
const okNow = now.filter((r) => r.ok).length, okLive = live.filter((r) => r.ok).length;
console.log(`\nИтого: прогон ${okNow}/${now.length} шагов верно, вживую было ${okLive}/${live.length}`);
