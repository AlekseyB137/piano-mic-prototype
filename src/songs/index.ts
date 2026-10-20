import type { Song } from '../song/types';
import twinkle from './twinkle.json';
import twinkle2h from './twinkle-2h.json';
import ode from './ode-to-joy.json';

/** Каталог прототипа: только произведения в общественном достоянии. */
export const SONGS: Song[] = [twinkle, twinkle2h, ode] as Song[];
