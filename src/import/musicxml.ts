/**
 * Импорт своих нот: MusicXML (.musicxml/.xml или сжатый .mxl) или MIDI (.mid) → песня приложения.
 * Без DOM-зависимостей кроме разбора XML (парсер передаётся снаружи), чтобы работало и в тестах.
 * Правила те же, что у tools/musicxml2json.py:
 *  - одна партия с двумя станами: верхний — правая рука, нижний — левая; две партии — первая правая,
 *    вторая левая;
 *  - повторы (forward/backward) и вольты 1/2 раскрываются; D.C./D.S. — не поддерживаются (предупреждение);
 *  - лиги сливаются, форшлаги пропускаются;
 *  - темп — <sound tempo> или <metronome>, иначе 80;
 *  - пальцы — <fingering>; где их нет — оценка по позиции руки (fingerAuto) и предупреждение.
 */
import type { Song, SongNote } from '../song/types';
import { midiToName } from '../audio/notes';
import { parseMidi } from './midi';
import { autoFingering, checkNoteLimit, hashId, IMPORT_LIMITS, mb, type ImportResult } from './common';

export type { ImportResult } from './common';

export type XmlParser = (text: string) => Document;

/* ---------------- .mxl (zip) ---------------- */

function u16(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8);
}
function u32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

/** Распаковка с пределом: заявленному в архиве размеру не доверяем — считаем байты на ходу. */
async function inflateRaw(data: Uint8Array, limit: number): Promise<Uint8Array> {
  const reader = new Blob([data.slice()]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      throw new Error(`файл .mxl распаковывается больше чем в ${mb(IMPORT_LIMITS.unzippedBytes)} — это не похоже на ноты`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

/** Минимальное чтение zip: центральный каталог → файлы (stored / deflate). */
async function unzip(buf: Uint8Array): Promise<Map<string, Uint8Array>> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (u32(buf, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('файл .mxl повреждён (нет каталога zip)');
  const count = u16(buf, eocd + 10);
  let p = u32(buf, eocd + 16);
  const files = new Map<string, Uint8Array>();
  let budget = IMPORT_LIMITS.unzippedBytes;
  for (let k = 0; k < count; k++) {
    if (u32(buf, p) !== 0x02014b50) break;
    const method = u16(buf, p + 10);
    const csize = u32(buf, p + 20);
    const usize = u32(buf, p + 24);
    if (usize > budget) throw new Error(`файл .mxl распаковывается больше чем в ${mb(IMPORT_LIMITS.unzippedBytes)} — это не похоже на ноты`);
    const nameLen = u16(buf, p + 28);
    const extraLen = u16(buf, p + 30);
    const commentLen = u16(buf, p + 32);
    const local = u32(buf, p + 42);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));
    const lName = u16(buf, local + 26);
    const lExtra = u16(buf, local + 28);
    const start = local + 30 + lName + lExtra;
    const raw = buf.subarray(start, start + csize);
    if (method === 0) files.set(name, raw);
    else if (method === 8) files.set(name, await inflateRaw(raw, budget));
    budget -= files.get(name)?.length ?? 0;
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

/* ---------------- XML-помощники (только базовый DOM: работает и с xmldom) ---------------- */

function kids(el: Element, name?: string): Element[] {
  const out: Element[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (!name || (n as Element).nodeName === name)) out.push(n as Element);
  }
  return out;
}
function kid(el: Element, name: string): Element | null {
  return kids(el, name)[0] ?? null;
}
function text(el: Element | null): string {
  return el?.textContent?.trim() ?? '';
}
function num(el: Element | null, fallback = 0): number {
  const v = Number(text(el));
  return Number.isFinite(v) && text(el) !== '' ? v : fallback;
}
function all(el: Element, name: string): Element[] {
  return Array.from(el.getElementsByTagName(name));
}

const STEP: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
/* ---------------- Повторы ---------------- */

interface MeasureMeta {
  forward: boolean;
  backward: boolean;
  times: number;
  endings: number[] | null;
}

function measureMeta(measures: Element[]): MeasureMeta[] {
  let ending: number[] | null = null;
  return measures.map((m) => {
    const meta: MeasureMeta = { forward: false, backward: false, times: 2, endings: null };
    for (const b of kids(m, 'barline')) {
      const rep = kid(b, 'repeat');
      if (rep?.getAttribute('direction') === 'forward') meta.forward = true;
      if (rep?.getAttribute('direction') === 'backward') {
        meta.backward = true;
        meta.times = Number(rep.getAttribute('times') ?? 2) || 2;
      }
      const e = kid(b, 'ending');
      if (e?.getAttribute('type') === 'start') {
        ending = (e.getAttribute('number') ?? '1').split(/[,\s]+/).map(Number).filter((x) => x > 0);
      }
    }
    meta.endings = ending;
    for (const b of kids(m, 'barline')) {
      const e = kid(b, 'ending');
      const t = e?.getAttribute('type');
      if (t === 'stop' || t === 'discontinue') ending = null;
    }
    return meta;
  });
}

/** Порядок исполнения тактов с раскрытием повторов и вольт. */
function playOrder(meta: MeasureMeta[]): number[] {
  const order: number[] = [];
  let i = 0;
  let start = 0;
  let pass = 1;
  let jumpedTo = -1;
  while (i < meta.length && order.length < meta.length * 10) {
    const m = meta[i];
    if (m.forward && i !== jumpedTo) {
      start = i;
      pass = 1;
    }
    jumpedTo = -1;
    if (m.endings && !m.endings.includes(pass)) {
      i++;
      continue;
    }
    order.push(i);
    if (m.backward && pass < m.times) {
      pass++;
      jumpedTo = start;
      i = start;
      continue;
    }
    if (m.backward) {
      pass = 1;
      start = i + 1;
    }
    i++;
  }
  return order;
}

/* ---------------- Разбор ---------------- */

interface RawNote extends SongNote {
  tieOpen?: boolean;
  fingerAuto?: boolean;
}

function readTempo(root: Element): number | null {
  for (const s of all(root, 'sound')) {
    const t = Number(s.getAttribute('tempo'));
    if (t > 0) return t;
  }
  for (const m of all(root, 'metronome')) {
    const per = num(kid(m, 'per-minute'));
    if (!(per > 0)) continue;
    const unit = text(kid(m, 'beat-unit'));
    const k: Record<string, number> = { whole: 4, half: 2, quarter: 1, eighth: 0.5, '16th': 0.25 };
    let q = per * (k[unit] ?? 1);
    if (kid(m, 'beat-unit-dot')) q *= 1.5;
    return q;
  }
  return null;
}

export function parseMusicXml(doc: Document, fallbackTitle: string): ImportResult {
  const warnings: string[] = [];
  const root = doc.documentElement;
  if (!root || root.nodeName !== 'score-partwise') {
    throw new Error(root?.nodeName === 'score-timewise' ? 'формат score-timewise не поддерживается — сохраните как обычный MusicXML' : 'это не файл MusicXML');
  }
  const parts = kids(root, 'part');
  if (!parts.length) throw new Error('в файле нет партий');
  if (parts.length > 2) warnings.push(`партий ${parts.length}: взяты первые две (правая и левая рука)`);
  const usedParts = parts.slice(0, 2);
  const twoStaves = usedParts.length === 1;
  if (usedParts.length === 1 && !all(usedParts[0], 'staff').some((s) => text(s) === '2')) {
    warnings.push('один нотный стан — все ноты отнесены к правой руке');
  }
  if (all(root, 'sound').some((s) => s.getAttribute('dacapo') || s.getAttribute('dalsegno') || s.getAttribute('tocoda'))) {
    warnings.push('D.C./D.S./Coda не раскрываются — играется только по повторам');
  }

  const measuresByPart = usedParts.map((p) => kids(p, 'measure'));
  const order = playOrder(measureMeta(measuresByPart[0]));

  const notes: RawNote[] = [];
  const divisions = usedParts.map(() => 1);
  const openTies = new Map<string, RawNote>();
  let offset = 0; // в четвертях — начало текущего такта
  for (const mi of order) {
    let measureLen = 0;
    usedParts.forEach((_, pi) => {
      const m = measuresByPart[pi][mi];
      if (!m) return;
      let cursor = 0; // в делениях
      let maxCursor = 0;
      let lastStart = 0;
      for (const el of kids(m)) {
        if (el.nodeName === 'attributes') {
          const d = num(kid(el, 'divisions'));
          if (d > 0) divisions[pi] = d;
        } else if (el.nodeName === 'backup') {
          cursor -= num(kid(el, 'duration'));
        } else if (el.nodeName === 'forward') {
          cursor += num(kid(el, 'duration'));
          maxCursor = Math.max(maxCursor, cursor);
        } else if (el.nodeName === 'note') {
          if (kid(el, 'grace') || kid(el, 'cue')) continue;
          const dur = num(kid(el, 'duration'));
          const isChord = !!kid(el, 'chord');
          const start = isChord ? lastStart : cursor;
          if (!isChord) {
            lastStart = cursor;
            cursor += dur;
            maxCursor = Math.max(maxCursor, cursor);
          }
          if (kid(el, 'rest')) continue;
          const pitch = kid(el, 'pitch');
          if (!pitch) continue; // unpitched и т. п.
          const midi = Math.round(STEP[text(kid(pitch, 'step'))] + num(kid(pitch, 'alter')) + 12 * (num(kid(pitch, 'octave')) + 1));
          if (!Number.isFinite(midi)) continue;
          const staff = num(kid(el, 'staff'), 1);
          const hand: 'L' | 'R' = twoStaves ? (staff >= 2 ? 'L' : 'R') : pi === 0 ? 'R' : 'L';
          const ties = kids(el, 'tie').map((t) => t.getAttribute('type'));
          const fingerEl = all(el, 'fingering')[0] ?? null;
          const finger = num(fingerEl, NaN);
          const div = divisions[pi];
          const startQ = offset + start / div;
          const durQ = dur / div;
          const key = `${hand}:${midi}`;
          const open = openTies.get(key);
          if (ties.includes('stop') && open) {
            open.dur = +(open.dur + durQ).toFixed(4);
            if (!ties.includes('start')) openTies.delete(key);
            continue;
          }
          const n: RawNote = {
            pitch: midi,
            name: midiToName(midi),
            start: +startQ.toFixed(4),
            dur: +durQ.toFixed(4),
            hand,
            finger: Number.isFinite(finger) ? finger : 0,
            tieOpen: ties.includes('start'),
          };
          notes.push(n);
          if (n.tieOpen) openTies.set(key, n);
        }
      }
      measureLen = Math.max(measureLen, maxCursor / divisions[pi]);
    });
    offset += measureLen;
  }
  if (!notes.length) throw new Error('в файле нет нот');
  checkNoteLimit(notes.length);

  const first = Math.min(...notes.map((n) => n.start));
  for (const n of notes) n.start = +(n.start - first).toFixed(4);
  const auto = autoFingering(notes);
  if (auto) warnings.push(`пальцы не указаны у ${auto} нот из ${notes.length} — расставлены приблизительно`);
  const lo = Math.min(...notes.map((n) => n.pitch));
  const hi = Math.max(...notes.map((n) => n.pitch));
  if (hi - lo > 48) warnings.push('диапазон больше 4 октав — клавиши на экране будут мелкими');

  const tempoQ = readTempo(root);
  if (tempoQ === null) warnings.push('темп не указан — взято 80');
  const work = kid(root, 'work');
  const title = text(work ? kid(work, 'work-title') : null) || text(kid(root, 'movement-title')) || fallbackTitle;
  notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  const song: Song = {
    id: `user-${hashId(title + notes.length + notes.slice(0, 20).map((n) => `${n.pitch}@${n.start}`).join())}`,
    title,
    bpm: Math.round(tempoQ ?? 80),
    order: 1000,
    notes: notes.map(({ tieOpen: _t, ...rest }) => rest),
  };
  return { song, warnings };
}

/** Файл нот → песня: распаковывает .mxl, разбирает MusicXML. */
export async function importScoreFile(fileName: string, data: ArrayBuffer, parse: XmlParser): Promise<ImportResult> {
  if (data.byteLength > IMPORT_LIMITS.fileBytes) {
    throw new Error(`файл слишком большой (${mb(data.byteLength)}, допустимо до ${mb(IMPORT_LIMITS.fileBytes)})`);
  }
  const bytes = new Uint8Array(data);
  let xml: string;
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    throw new Error('PDF не поддерживается — нужен MusicXML (.mxl, .musicxml) или MIDI (.mid)'); // «%PDF»
  }
  if (bytes[0] === 0x4d && bytes[1] === 0x54 && bytes[2] === 0x68 && bytes[3] === 0x64) {
    return parseMidi(bytes, fileName.replace(/\.(mid|midi|kar)$/i, '')); // «MThd»
  }
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const files = await unzip(bytes);
    let rootPath: string | null = null;
    const container = files.get('META-INF/container.xml');
    if (container) {
      const c = parse(new TextDecoder().decode(container));
      rootPath = all(c.documentElement, 'rootfile')[0]?.getAttribute('full-path') ?? null;
    }
    if (!rootPath) rootPath = [...files.keys()].find((k) => /\.(xml|musicxml)$/i.test(k) && !k.startsWith('META-INF')) ?? null;
    const raw = rootPath ? files.get(rootPath) : undefined;
    if (!raw) throw new Error('в .mxl не найден файл партитуры');
    xml = new TextDecoder().decode(raw);
  } else {
    xml = new TextDecoder().decode(bytes);
  }
  const doc = parse(xml);
  if (doc.getElementsByTagName('parsererror').length) throw new Error('файл повреждён или это не XML');
  return parseMusicXml(doc, fileName.replace(/\.(mxl|musicxml|xml)$/i, ''));
}
