/**
 * Логика записи для отладки, без DOM: мелодия RECORD_SONG в режиме «Ожидание» — нота стоит на линии,
 * пока её не сыграют (решение пользователя: «почему ноты не ждут?»). Шаг с тайной проверкой ошибки
 * (Song.checkAs) сам по себе не засчитается, поэтому он уходит дальше после вердикта «✗» или
 * через SECRET_WAIT_SEC ожидания на линии (молчание — тоже верный ответ).
 * Окно каждого шага — от момента, когда он стал текущим, до момента, когда его сыграли/пропустили.
 */
import { SongPlayer } from '../song/player';
import type { Song } from '../song/types';
import type { StepLabel } from './wav';

/** Сколько ждать на линии шаг с тайной проверкой, если вердикта нет, с. */
export const SECRET_WAIT_SEC = 3;

export type RecordCheck = 'pass' | 'wrong' | 'skip' | 'ignored';

export class RecordSession {
  readonly player: SongPlayer;
  /** Окна шагов в аудиовремени. */
  private readonly windows: { start: number; end: number | null }[] = [];
  private waitingSince: number | null = null;
  private lastT: number | null = null;

  constructor(readonly song: Song) {
    this.player = new SongPlayer(song, 'wait', 4);
  }

  get finished(): boolean {
    return this.player.finished;
  }

  private isSecret(i: number): boolean {
    const s = this.player.steps[i];
    return !!s && this.player.checkFor(s).join() !== [...new Set(s.notes.map((n) => n.pitch))].sort((a, b) => a - b).join();
  }

  /** Каждый кадр: время идёт, нота встаёт на линии и ждёт. t — аудиовремя. */
  tick(t: number): void {
    if (this.lastT !== null) this.player.advance(Math.min(0.1, t - this.lastT));
    this.lastT = t;
    this.open(t);
    const cur = this.player.current;
    if (cur && this.player.waiting) {
      this.waitingSince ??= t;
      if (this.isSecret(cur.index) && t - this.waitingSince > SECRET_WAIT_SEC) this.close(t, () => this.player.skip());
    } else this.waitingSince = null;
  }

  /** Вердикт анализатора; onset — аудиовремя атаки. */
  onCheck(passed: boolean, onset: number): RecordCheck {
    // Граница окон — чуть после атаки: сама атака относится к этому шагу
    const t = onset + 0.02;
    const cur = this.player.current;
    if (!cur) return 'ignored';
    if (passed) {
      this.close(t, () => this.player.result(true));
      return 'pass';
    }
    this.player.result(false);
    if (this.isSecret(cur.index)) {
      this.close(t, () => this.player.skip()); // «✗» на тайной проверке — верный ответ, дальше
      return 'skip';
    }
    return 'wrong';
  }

  /** Правильные ответы по завершённым шагам; toAnalyzer — перевод аудиовремени во время анализатора. */
  labels(toAnalyzer: (t: number) => number): StepLabel[] {
    return this.windows.flatMap((w, i) => {
      if (!w || w.end === null) return [];
      const s = this.player.steps[i];
      const play = [...new Set(s.notes.map((n) => n.pitch))].sort((a, b) => a - b);
      const expect = this.player.checkFor(s);
      return [
        {
          index: i,
          say: play.join('+'),
          expect,
          play,
          want: expect.join() === play.join() ? 'pass' : 'fail',
          times: 1,
          tStart: toAnalyzer(w.start),
          tEnd: toAnalyzer(w.end),
        } satisfies StepLabel,
      ];
    });
  }

  private open(t: number): void {
    const cur = this.player.current;
    if (cur && !this.windows[cur.index]) this.windows[cur.index] = { start: t, end: null };
  }

  private close(t: number, act: () => void): void {
    const cur = this.player.current;
    if (cur && this.windows[cur.index]) this.windows[cur.index].end = t;
    act();
    this.waitingSince = null;
    this.open(t);
  }
}
