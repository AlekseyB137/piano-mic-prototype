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
  if (h.size === 2) return 'Обе руки: слева — левой, справа — правой';
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
  // Только аккорды — «N аккордов»; иначе считаем все ноты (двумя руками: мелодия + бас)
  const n = s.notes.length;
  return chords === steps
    ? `${steps} ${plural(steps, 'аккорд', 'аккорда', 'аккордов')}`
    : `${n} ${plural(n, 'нота', 'ноты', 'нот')}`;
}

/** Экран выбора мелодии: плитки вместо выпадающего меню + загрузка своих нот. */
export class SongPicker {
  onPick: (index: number) => void = () => {};
  /** Выбран файл нот для загрузки. */
  onImport: (file: File) => void = () => {};
  /** Удалить свою мелодию (по id). */
  onDelete: (id: string) => void = () => {};
  private note = '';
  private noteKind: 'info' | 'error' = 'info';

  constructor(
    private readonly root: HTMLElement,
    private readonly songs: () => (Song & { user?: boolean })[],
    private readonly best: (id: string) => BestResult | null,
  ) {}

  /** Сообщение на экране выбора (итог загрузки, ошибка разбора). */
  setNote(text: string, kind: 'info' | 'error' = 'info'): void {
    this.note = text;
    this.noteKind = kind;
  }

  get visible(): boolean {
    return !this.root.classList.contains('hidden');
  }

  show(currentIndex: number): void {
    const title = document.createElement('div');
    title.className = 'picker-title';
    title.textContent = 'Выбор мелодии';
    const grid = document.createElement('div');
    grid.className = 'picker-grid';
    this.songs().forEach((s, i) => {
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
      tile.append(name, meta);
      if (s.user) {
        tile.classList.add('user');
        const mine = document.createElement('span');
        mine.className = 'tile-mine';
        mine.textContent = 'Мои ноты · только на этом телефоне';
        const del = document.createElement('span');
        del.className = 'tile-del';
        del.setAttribute('role', 'button');
        del.textContent = '✕';
        del.title = 'Удалить';
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          this.onDelete(s.id);
        });
        tile.append(mine, del);
      }
      tile.append(res);
      tile.addEventListener('click', () => this.onPick(i));
      grid.appendChild(tile);
    });

    // Загрузка своих нот (MusicXML): файл разбирается и хранится только на этом телефоне
    const add = document.createElement('label');
    add.className = 'tile tile-add';
    const addName = document.createElement('span');
    addName.className = 'tile-name';
    addName.textContent = '＋ Загрузить свои ноты';
    const addMeta = document.createElement('span');
    addMeta.className = 'tile-meta';
    addMeta.textContent = 'MusicXML (.mxl, .musicxml) — экспорт из MuseScore и других редакторов. Хранится только на этом телефоне.';
    const input = document.createElement('input');
    input.type = 'file'; // без accept: iOS иначе может не дать выбрать .mxl
    input.hidden = true;
    input.addEventListener('change', () => {
      const f = input.files?.[0];
      if (f) this.onImport(f);
      input.value = '';
    });
    add.append(addName, addMeta, input);
    grid.appendChild(add);

    const nodes: Node[] = [title];
    if (this.note) {
      const msg = document.createElement('div');
      msg.className = `picker-note ${this.noteKind}`;
      msg.textContent = this.note;
      nodes.push(msg);
    }
    nodes.push(grid);
    this.root.replaceChildren(...nodes);
    this.root.classList.remove('hidden');
  }

  hide(): void {
    this.root.classList.add('hidden');
  }
}
