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
  /** Порядок на экране выбора (меньше — раньше), по умолчанию 100. */
  order?: number;
  /**
   * Только для записи по сценарию: на шаге с этим началом анализатор тайно проверяет другие ноты
   * (пользователь играет то, что падает, — правильный ответ «не засчитано»).
   */
  checkAs?: { start: number; midis: number[] }[];
}

/**
 * Общее количество нот в мелодии: каждая нота аккорда и каждой руки считается отдельно.
 * Единый источник — от него же в будущем будет считаться оплата.
 */
export function noteCount(song: Song): number {
  return song.notes.length;
}
