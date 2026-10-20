import type { Song } from '../song/types';
import ode from './ode-to-joy.json';
import scale from './c-major-scale.json';
import chords from './chords-c-f-g.json';

/** Каталог прототипа: только произведения в общественном достоянии и упражнения. */
export const SONGS: Song[] = [ode, scale, chords] as Song[];
