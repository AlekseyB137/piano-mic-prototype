import type { Song } from '../song/types';

export interface BestResult {
  mistakes: number;
  seconds: number;
  /** «В такт»: сколько шагов сыграно вовремя и сколько их всего. */
  hits?: number;
  total?: number;
}

function handsText(s: Song): string {
  const h = new Set(s.notes.map((n) => n.hand));
  if (h.size === 2) return 'Обе руки';
  return h.has('L') ? 'Левая рука' : 'Правая рука';
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/** «30 нот» или «4 аккорда» — по тому, чего в песне больше. */
function stepsText(s: Song): string {
  const byStart = new Map<number, number>();
  for (const n of s.notes) {
    const k = Math.round(n.start * 1000);
    byStart.set(k, (byStart.get(k) ?? 0) + 1);
  }
  const steps = byStart.size;
  const chords = [...byStart.values()].filter((c) => c > 1).length;
  return chords * 2 > steps
    ? `${steps} ${plural(steps, 'аккорд', 'аккорда', 'аккордов')}`
    : `${steps} ${plural(steps, 'нота', 'ноты', 'нот')}`;
}

/** Экран выбора мелодии: плитки вместо выпадающего меню. */
export class SongPicker {
  onPick: (index: number) => void = () => {};

  constructor(
    private readonly root: HTMLElement,
    private readonly songs: Song[],
    private readonly best: (id: string) => BestResult | null,
  ) {}

  get visible(): boolean {
    return !this.root.classList.contains('hidden');
  }

  show(currentIndex: number): void {
    const title = document.createElement('div');
    title.className = 'picker-title';
    title.textContent = 'Выбор мелодии';
    const grid = document.createElement('div');
    grid.className = 'picker-grid';
    this.songs.forEach((s, i) => {
      const tile = document.createElement('button');
      tile.className = 'tile' + (i === currentIndex ? ' current' : '');
      const name = document.createElement('span');
      name.className = 'tile-name';
      name.textContent = s.title;
      const meta = document.createElement('span');
      meta.className = 'tile-meta';
      meta.textContent = `${handsText(s)} · ${stepsText(s)} · ♩\u00a0=\u00a0${s.bpm}`;
      const res = document.createElement('span');
      res.className = 'tile-best';
      const b = this.best(s.id);
      res.textContent = !b
        ? 'Ещё не играли'
        : b.hits !== undefined && b.total
          ? `Лучший результат: вовремя ${b.hits} из ${b.total}`
          : `Лучший результат: ${b.mistakes === 0 ? 'без ошибок' : `ошибок ${b.mistakes}`}`;
      tile.append(name, meta, res);
      tile.addEventListener('click', () => this.onPick(i));
      grid.appendChild(tile);
    });
    this.root.replaceChildren(title, grid);
    this.root.classList.remove('hidden');
  }

  hide(): void {
    this.root.classList.add('hidden');
  }
}
