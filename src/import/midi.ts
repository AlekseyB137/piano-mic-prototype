/**
 * Импорт MIDI (.mid, форматы 0 и 1) → песня приложения. Без зависимостей.
 *  - Руки: две дорожки с нотами — выше по среднему звучанию правая; одна дорожка с двумя каналами —
 *    по каналам; иначе ноты от C4 — правая, ниже — левая (с предупреждением).
 *  - Темп — первый Set Tempo; если меняется — предупреждение (доли остаются верными, темп постоянный).
 *  - Живая запись: почти одновременные ноты склеиваются в аккорд, начала — по сетке 1/32 доли.
 *  - Пальцев в MIDI нет — всегда оценка по позиции руки (как для MusicXML без <fingering>).
 *  - Канал 10 (ударные) пропускается.
 */
import type { Song, SongNote } from '../song/types';
import { midiToName } from '../audio/notes';
import { autoFingering, checkNoteLimit, hashId, type ImportResult } from './common';

/** Начала нот ближе этого (в долях) — один аккорд (живая запись не бывает идеально одновременной). */
const CHORD_EPS_BEATS = 0.06;
/** Сетка выравнивания начал и длительностей, доли. */
const GRID = 1 / 32;

interface MidiNote {
  pitch: number;
  startTick: number;
  endTick: number;
  channel: number;
  track: number;
}

class Reader {
  p = 0;
  constructor(readonly b: Uint8Array) {}
  u8(): number {
    if (this.p >= this.b.length) throw new Error('файл MIDI обрывается');
    return this.b[this.p++];
  }
  u16(): number {
    return (this.u8() << 8) | this.u8();
  }
  u32(): number {
    return ((this.u8() << 24) | (this.u8() << 16) | (this.u8() << 8) | this.u8()) >>> 0;
  }
  vlq(): number {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      const c = this.u8();
      v = (v << 7) | (c & 0x7f);
      if (!(c & 0x80)) return v;
    }
    return v;
  }
  str(n: number): string {
    const s = new TextDecoder().decode(this.b.subarray(this.p, this.p + n));
    this.p += n;
    return s;
  }
}

export function parseMidi(bytes: Uint8Array, fallbackTitle: string): ImportResult {
  const warnings: string[] = [];
  const r = new Reader(bytes);
  if (r.str(4) !== 'MThd') throw new Error('это не файл MIDI');
  const hlen = r.u32();
  const format = r.u16();
  const ntracks = r.u16();
  const division = r.u16();
  r.p = 8 + hlen;
  if (division & 0x8000) throw new Error('MIDI с SMPTE-временем не поддерживается');
  if (format === 2) throw new Error('MIDI формата 2 не поддерживается');
  const ppq = division;

  const notes: MidiNote[] = [];
  const tempos: number[] = [];
  let title = '';
  for (let t = 0; t < ntracks && r.p < bytes.length; t++) {
    if (r.str(4) !== 'MTrk') throw new Error('файл MIDI повреждён (нет дорожки)');
    const len = r.u32();
    const end = r.p + len;
    let tick = 0;
    let status = 0;
    const open = new Map<string, number[]>(); // канал:нота → стек начал
    while (r.p < end) {
      tick += r.vlq();
      let b = r.u8();
      if (b === 0xff) {
        const type = r.u8();
        const l = r.vlq();
        if (type === 0x51 && l === 3) tempos.push((r.u8() << 16) | (r.u8() << 8) | r.u8());
        else if (type === 0x03 && !title) title = r.str(l).trim();
        else r.p += l;
        continue;
      }
      if (b === 0xf0 || b === 0xf7) {
        r.p += r.vlq();
        continue;
      }
      if (b & 0x80) status = b;
      else r.p--; // running status: байт — первый параметр
      b = status;
      const kind = b & 0xf0;
      const ch = b & 0x0f;
      const d1 = r.u8();
      const d2 = kind === 0xc0 || kind === 0xd0 ? 0 : r.u8();
      if (kind === 0x90 && d2 > 0) {
        const k = `${ch}:${d1}`;
        open.set(k, [...(open.get(k) ?? []), tick]);
      } else if (kind === 0x80 || (kind === 0x90 && d2 === 0)) {
        const k = `${ch}:${d1}`;
        const st = open.get(k);
        if (st?.length) {
          const s = st.shift()!;
          if (ch !== 9) notes.push({ pitch: d1, startTick: s, endTick: Math.max(tick, s + 1), channel: ch, track: t });
        }
      }
    }
    r.p = end;
  }
  if (!notes.length) throw new Error('в файле MIDI нет нот');
  checkNoteLimit(notes.length);

  // Темп
  const uniq = [...new Set(tempos)];
  if (uniq.length > 1) warnings.push('темп в файле меняется — взят первый');
  const bpm = tempos.length ? Math.round(60_000_000 / tempos[0]) : 120;
  if (!tempos.length) warnings.push('темп не указан — взято 120 (стандарт MIDI)');

  // Руки
  const byTrack = new Map<number, MidiNote[]>();
  for (const n of notes) byTrack.set(n.track, [...(byTrack.get(n.track) ?? []), n]);
  const byChannel = new Map<number, MidiNote[]>();
  for (const n of notes) byChannel.set(n.channel, [...(byChannel.get(n.channel) ?? []), n]);
  const avg = (xs: MidiNote[]) => xs.reduce((s, n) => s + n.pitch, 0) / xs.length;
  let handOf: (n: MidiNote) => 'L' | 'R';
  const groups = byTrack.size >= 2 ? byTrack : byChannel.size >= 2 ? byChannel : null;
  if (groups) {
    const ranked = [...groups.entries()].sort((a, b) => avg(b[1]) - avg(a[1]));
    if (ranked.length > 2) warnings.push(`голосов (дорожек/каналов) ${ranked.length}: верхний — правая рука, остальные — левая`);
    const right = ranked[0][0];
    const key = byTrack.size >= 2 ? 'track' : 'channel';
    handOf = (n) => (n[key] === right ? 'R' : 'L');
  } else {
    warnings.push('одна дорожка — руки разделены по высоте: от C4 правая, ниже левая');
    handOf = (n) => (n.pitch >= 60 ? 'R' : 'L');
  }

  // В доли, по сетке; почти одновременные начала — один аккорд
  const snap = (x: number) => Math.round(x / GRID) * GRID;
  const sorted = [...notes].sort((a, b) => a.startTick - b.startTick);
  const out: SongNote[] = [];
  let clusterStart = -Infinity;
  let clusterBeat = 0;
  for (const n of sorted) {
    const s = n.startTick / ppq;
    if (s - clusterStart > CHORD_EPS_BEATS) {
      clusterStart = s;
      clusterBeat = snap(s);
    }
    const dur = Math.max(GRID, snap((n.endTick - n.startTick) / ppq));
    out.push({ pitch: n.pitch, name: midiToName(n.pitch), start: +clusterBeat.toFixed(4), dur: +dur.toFixed(4), hand: handOf(n), finger: 0 });
  }
  // Повторное нажатие той же клавиши в одном аккорде (дребезг записи) — убираем
  const seen = new Set<string>();
  const dedup = out.filter((n) => {
    const k = `${n.start}|${n.pitch}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const first = Math.min(...dedup.map((n) => n.start));
  for (const n of dedup) n.start = +(n.start - first).toFixed(4);
  dedup.sort((a, b) => a.start - b.start || a.pitch - b.pitch);

  autoFingering(dedup);
  warnings.push('в MIDI нет аппликатуры — пальцы расставлены приблизительно');
  if (Math.max(...dedup.map((n) => n.pitch)) - Math.min(...dedup.map((n) => n.pitch)) > 48) {
    warnings.push('диапазон больше 4 октав — клавиши на экране будут мелкими');
  }
  const name = title && !/^(track|piano|untitled)/i.test(title) ? title : fallbackTitle;
  const song: Song = {
    id: `user-${hashId(name + dedup.length + dedup.slice(0, 20).map((n) => `${n.pitch}@${n.start}`).join())}`,
    title: name,
    bpm,
    order: 1000,
    notes: dedup,
  };
  return { song, warnings };
}
