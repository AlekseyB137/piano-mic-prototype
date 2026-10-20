/** Общее для импорта MusicXML и MIDI. */
import type { Song, SongNote } from '../song/types';

export interface ImportResult {
  song: Song;
  warnings: string[];
}

const WHITE = [0, 2, 4, 5, 7, 9, 11];

function whiteIndex(m: number): number {
  const oct = Math.floor(m / 12);
  let pc = m % 12;
  while (!WHITE.includes(pc)) pc--;
  return oct * 7 + WHITE.indexOf(pc);
}

/** Оценка пальцев по позиции руки — как в tools/musicxml2json.py. Пальцы вне 1..5 считаются не заданными. */
export function autoFingering(notes: (SongNote & { fingerAuto?: boolean })[]): number {
  let count = 0;
  for (const hand of ['R', 'L'] as const) {
    const seq = notes.filter((n) => n.hand === hand).sort((a, b) => a.start - b.start || a.pitch - b.pitch);
    let anchor: number | null = null;
    for (const n of seq) {
      const w = whiteIndex(n.pitch);
      if (anchor === null || w < anchor) anchor = w;
      else if (w > anchor + 4) anchor = w - 4;
      if (!(n.finger >= 1 && n.finger <= 5)) {
        const rel = w - anchor;
        n.finger = hand === 'R' ? rel + 1 : 5 - rel;
        n.fingerAuto = true;
        count++;
      }
    }
  }
  return count;
}

export function hashId(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

