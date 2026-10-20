/**
 * Тест импорта своих нот (src/import/musicxml.ts). Запуск: npm run test:import
 * Фикстуры собраны music21 из наших песен (test/fixtures): .musicxml, сжатый .mxl, повторы с вольтами.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DOMParser } from '@xmldom/xmldom';
import { importScoreFile } from '../src/import/musicxml';
import type { Song } from '../src/song/types';

let pass = 0, fail = 0;
function expect(name: string, ok: boolean, detail = '') {
  ok ? pass++ : fail++;
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : '  — ' + detail}`);
}
const parse = (s: string) => new DOMParser().parseFromString(s, 'text/xml') as unknown as Document;
const fx = (f: string) => {
  const b = readFileSync(join(import.meta.dirname, 'fixtures', f));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
const src = JSON.parse(readFileSync(join(import.meta.dirname, '../src/songs/twinkle-2h.json'), 'utf-8')) as Song;
const key = (n: Song['notes'][number]) => `${n.start}|${n.pitch}|${n.dur}|${n.hand}|${n.finger}`;
const want = src.notes.map(key).sort();

for (const f of ['twinkle-2h.musicxml', 'twinkle-2h.mxl']) {
  const { song, warnings } = await importScoreFile(f, fx(f), parse);
  const got = song.notes.map(key).sort();
  const missing = want.filter((x) => !got.includes(x)).slice(0, 3);
  const extra = got.filter((x) => !want.includes(x)).slice(0, 3);
  expect(`${f}: все ${want.length} нот совпали (начало, высота, длительность, рука, палец)`, got.length === want.length && !missing.length, `${got.length} нот; нет: ${missing}; лишние: ${extra}`);
  expect(`${f}: темп ${src.bpm}`, song.bpm === src.bpm, String(song.bpm));
  expect(`${f}: без предупреждений про пальцы`, !warnings.some((w) => w.includes('пальцы')), warnings.join('; '));
}

{
  const { song } = await importScoreFile('repeats.musicxml', fx('repeats.musicxml'), parse);
  const seq = song.notes.map((n) => n.name).join(' ');
  // такты: 1 2 3(вольта 1) | повтор 1 2 4(вольта 2) 5
  const exp = 'C4 D4 E4 F4 G4 A4 C4 D4 E4 F4 B4 C5 D5 E5';
  expect('Повторы и вольты раскрыты в правильном порядке', seq === exp, seq);
  expect('Повторы: время идёт подряд (14 четвертей)', song.notes.every((n, i) => n.start === i), song.notes.map((n) => n.start).join(','));
  expect('Повторы: темп 100 из <metronome>', song.bpm === 100, String(song.bpm));
}

{
  const xml = `<?xml version="1.0"?><score-partwise><part-list/><part id="P1"><measure number="1">
    <attributes><divisions>2</divisions></attributes>
    <note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><tie type="start"/></note>
    <note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><tie type="stop"/></note>
    <note><grace/><pitch><step>D</step><octave>4</octave></pitch></note>
    <note><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration></note>
    <note><chord/><pitch><step>G</step><alter>1</alter><octave>4</octave></pitch><duration>4</duration></note>
  </measure></part></score-partwise>`;
  const buf = new TextEncoder().encode(xml).buffer;
  const { song, warnings } = await importScoreFile('mini.xml', buf, parse);
  const s = song.notes.map((n) => `${n.name}@${n.start}/${n.dur}`).join(' ');
  expect('Лига слита, форшлаг пропущен, аккорд и диез', s === 'C4@0/2 E4@2/2 G#4@2/2', s);
  expect('Без пальцев — оценены и предупреждение; без темпа — 80', warnings.some((w) => w.includes('пальцы')) && song.bpm === 80 && song.notes.every((n) => n.finger >= 1 && n.finger <= 5), warnings.join('; '));
  expect('Название — из имени файла', song.title === 'mini', song.title);
}

for (const [name, data] of [
  ['не XML', 'просто текст'],
  ['не MusicXML', '<?xml version="1.0"?><html/>'],
] as const) {
  let err = '';
  try {
    await importScoreFile('x.xml', new TextEncoder().encode(data).buffer, parse);
  } catch (e) {
    err = (e as Error).message;
  }
  expect(`Ошибка с понятным текстом: ${name}`, err.length > 0, 'ошибки нет');
}

console.log(`\nИтого: ${pass} ✓, ${fail} ✗`);
process.exit(fail ? 1 : 0);
