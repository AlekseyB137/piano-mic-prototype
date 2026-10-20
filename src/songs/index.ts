import type { Song } from '../song/types';
import twinkle from './twinkle.json';
import ode from './ode-to-joy.json';

/** Каталог прототипа: только произведения в общественном достоянии. */
export const SONGS: Song[] = [twinkle, ode] as Song[];
