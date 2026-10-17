export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/** Диапазон экранной клавиатуры прототипа: C2–B5. */
export const KEY_LOW = 36;
export const KEY_HIGH = 83;

export function midiToFreq(midi: number, a4 = 440): number {
  return a4 * Math.pow(2, (midi - 69) / 12);
}

export function freqToMidiFloat(freq: number, a4 = 440): number {
  return 69 + 12 * Math.log2(freq / a4);
}

export function midiToName(midi: number): string {
  return NOTE_NAMES[((midi % 12) + 12) % 12] + String(Math.floor(midi / 12) - 1);
}

export function isBlackKey(midi: number): boolean {
  const pc = ((midi % 12) + 12) % 12;
  return pc === 1 || pc === 3 || pc === 6 || pc === 8 || pc === 10;
}

/**
 * Ожидаемая «растяжка» настройки фортепиано (кривая Рейлсбека), центы.
 * Из-за негармоничности струн настройщики завышают верх и чуть занижают низ:
 * в 5-й октаве типично +10…+20 ц. Грубая линейная модель — для допуска, не для точности.
 */
export function expectedStretchCents(midi: number): number {
  if (midi > 64) return (midi - 64) * 0.8;
  if (midi < 40) return (midi - 40) * 0.5;
  return 0;
}

/** Разница в центах между двумя частотами. */
export function centsBetween(f: number, ref: number): number {
  return 1200 * Math.log2(f / ref);
}
