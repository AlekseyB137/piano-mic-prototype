/**
 * Тест импорта своих нот (src/import/musicxml.ts). Запуск: npm run test:import
 * Фикстуры собраны music21 из наших песен (test/fixtures): .musicxml, сжатый .mxl, повторы с вольтами.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DOMParser } from '@xmldom/xmldom';
import { importScoreFile } from '../src/import/musicxml';
import { IMPORT_LIMITS } from '../src/import/common';
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

// MIDI: Twinkle двумя руками (music21, формат 1: дорожка темпа + две руки)
{
  const { song, warnings } = await importScoreFile('twinkle-2h.mid', fx('twinkle-2h.mid'), parse);
  const k = (n: Song['notes'][number]) => `${n.start}|${n.pitch}|${n.dur}|${n.hand}`;
  const w = src.notes.map(k).sort();
  const g = song.notes.map(k).sort();
  expect('MIDI: все 66 нот совпали (начало, высота, длительность, рука)', JSON.stringify(w) === JSON.stringify(g), `${g.length} нот; нет: ${w.filter((x) => !g.includes(x)).slice(0, 3)}`);
  expect('MIDI: темп 80', song.bpm === 80, String(song.bpm));
  expect('MIDI: пальцы расставлены, предупреждение про аппликатуру', song.notes.every((n) => n.finger >= 1 && n.finger <= 5) && warnings.some((x) => x.includes('аппликатуры')), warnings.join('; '));
}

// MIDI: одна дорожка, running status, аккорд с разбросом 5 тиков, руки по высоте
{
  const vlq = (v: number) => {
    const out = [v & 0x7f];
    while ((v >>= 7)) out.unshift((v & 0x7f) | 0x80);
    return out;
  };
  const ppq = 480;
  const NAME = [...new TextEncoder().encode('Тест')];
  const ev: number[] = [
    ...vlq(0), 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20, // 500000 мкс = 120 bpm
    ...vlq(0), 0xff, 0x03, ...vlq(NAME.length), ...NAME, // имя дорожки (длина — в байтах UTF-8)
    ...vlq(0), 0x90, 48, 80, // C3
    ...vlq(5), 64, 80, // E4, running status, +5 тиков
    ...vlq(ppq - 5), 48, 0, // C3 off (velocity 0)
    ...vlq(0), 0x80, 64, 0, // E4 off
    ...vlq(0), 0x99, 38, 100, ...vlq(0), 0x89, 38, 0, // ударные — пропустить
    ...vlq(0), 0x90, 67, 90, ...vlq(ppq * 2), 0x80, 67, 0, // G4 половинная
    ...vlq(0), 0xff, 0x2f, 0x00,
  ];
  const hdr = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, ppq >> 8, ppq & 0xff];
  const trk = [0x4d, 0x54, 0x72, 0x6b, (ev.length >>> 24) & 0xff, (ev.length >>> 16) & 0xff, (ev.length >>> 8) & 0xff, ev.length & 0xff, ...ev];
  const { song, warnings } = await importScoreFile('one.mid', new Uint8Array([...hdr, ...trk]).buffer, parse);
  const s = song.notes.map((n) => `${n.name}${n.hand}@${n.start}/${n.dur}`).join(' ');
  expect('MIDI одна дорожка: аккорд склеен, руки по высоте, ударные пропущены', s === 'C3L@0/1 E4R@0/1 G4R@1/2', s);
  expect('MIDI одна дорожка: темп 120, название из дорожки', song.bpm === 120 && song.title === 'Тест', `${song.bpm} ${song.title}`);
  expect('MIDI одна дорожка: предупреждение про разделение рук', warnings.some((w) => w.includes('по высоте')), warnings.join('; '));
}

for (const [name, data] of [
  ['не XML', 'просто текст'],
  ['не MusicXML', '<?xml version="1.0"?><html/>'],
  ['PDF', '%PDF-1.7 ...'],
] as const) {
  let err = '';
  try {
    await importScoreFile('x.xml', new TextEncoder().encode(data).buffer, parse);
  } catch (e) {
    err = (e as Error).message;
  }
  expect(`Ошибка с понятным текстом: ${name}`, err.length > 0, 'ошибки нет');
}

// Ограничения
const errOf = async (name: string, data: ArrayBuffer) => {
  try {
    await importScoreFile(name, data, parse);
    return '';
  } catch (e) {
    return (e as Error).message;
  }
};
{
  const big = new Uint8Array(IMPORT_LIMITS.fileBytes + 1).buffer;
  const e = await errOf('big.mxl', big);
  expect('Файл больше 5 МБ — отказ с размером', e.includes('слишком большой') && e.includes('5.0 МБ'), e);
}
{
  // .mxl, где в оглавлении заявлено 30 МБ после распаковки (zip-бомба)
  const b = new Uint8Array(fx('twinkle-2h.mxl').slice(0));
  const v = new DataView(b.buffer);
  for (let i = b.length - 22; i >= 0; i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      const cd = v.getUint32(i + 16, true);
      v.setUint32(cd + 24, 30 * 1024 * 1024, true);
      break;
    }
  }
  const e = await errOf('bomb.mxl', b.buffer);
  expect('.mxl с заявленными 30 МБ после распаковки — отказ', e.includes('распаковывается'), e);
}
{
  // .mxl лжёт в оглавлении (1 КБ), а распаковывается в 25 МБ — должен прерваться по счётчику
  const e = await errOf('bomb-lying.mxl', fx('bomb-lying.mxl'));
  expect('.mxl, лгущий о размере, — распаковка прервана', e.includes('распаковывается'), e);
}
{
  const notes = Array.from({ length: IMPORT_LIMITS.notes + 1 }, () => '<note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration></note>').join('');
  const xml = `<?xml version="1.0"?><score-partwise><part-list/><part id="P1"><measure number="1"><attributes><divisions>1</divisions></attributes>${notes}</measure></part></score-partwise>`;
  const e = await errOf('many.xml', new TextEncoder().encode(xml).buffer);
  expect('Больше 5000 нот — отказ с числом нот', e.includes('слишком много нот') && e.includes(String(IMPORT_LIMITS.notes + 1)), e);
}

console.log(`\nИтого: ${pass} ✓, ${fail} ✗`);
process.exit(fail ? 1 : 0);
