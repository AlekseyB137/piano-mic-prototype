/**
 * Формат песни — тот же, что будет на выходе офлайн-конвертера MusicXML → JSON (см. CLAUDE.md).
 * start и dur — в долях (четвертях), темп задаёт bpm.
 */
export interface SongNote {
  pitch: number;
  name: string;
  start: number;
  dur: number;
  hand: 'L' | 'R';
  finger: number;
}

export interface Song {
  id: string;
  title: string;
  bpm: number;
  notes: SongNote[];
}
