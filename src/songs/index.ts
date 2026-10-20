import type { Song } from '../song/types';

/**
 * Каталог собирается сам из всех src/songs/*.json (их пишет tools/musicxml2json.py или руками).
 * Порядок на экране выбора — по полю order (меньше — раньше), затем по названию.
 * Только произведения в общественном достоянии.
 */
const files = import.meta.glob<Song & { order?: number }>('./*.json', { eager: true, import: 'default' });

export const SONGS: Song[] = Object.values(files).sort(
  (a, b) => (a.order ?? 100) - (b.order ?? 100) || a.title.localeCompare(b.title, 'ru'),
);
