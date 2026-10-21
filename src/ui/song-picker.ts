import { noteCount, type Song } from '../song/types';

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

/** «Нот: 66» — общее количество нот (основа будущей оплаты). */
function notesText(s: Song): string {
  return `Нот: ${noteCount(s)}`;
}

/** Экран выбора мелодии: плитки вместо выпадающего меню + загрузка своих нот. */
export class SongPicker {
  onPick: (index: number) => void = () => {};
  /** Выбран файл нот для загрузки. */
  onImport: (file: File) => void = () => {};
  /** Удалить свою мелодию (по id). */
  onDelete: (id: string) => void = () => {};
  /** Где хранятся свои ноты: есть ли облако Telegram и какие мелодии не поместились в него. */
  storage: () => { cloud: boolean; localOnly: Set<string> } = () => ({ cloud: false, localOnly: new Set() });
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
      meta.textContent = `${handsText(s)} · ♩\u00a0=\u00a0${s.bpm}`;
      const count = document.createElement('span');
      count.className = 'tile-count';
      count.textContent = notesText(s);
      const res = document.createElement('span');
      res.className = 'tile-best';
      const b = this.best(s.id);
      res.textContent = !b
        ? 'Ещё не играли'
        : b.hits !== undefined && b.total
          ? `Лучший результат: вовремя ${b.hits} из ${b.total}`
          : `Лучший результат: ${b.mistakes === 0 ? 'без ошибок' : `ошибок ${b.mistakes}`}`;
      tile.append(name, meta, count);
      if (s.user) {
        tile.classList.add('user');
        const mine = document.createElement('span');
        mine.className = 'tile-mine';
        const st = this.storage();
        mine.textContent = st.cloud && !st.localOnly.has(s.id) ? 'Мои ноты · на всех ваших устройствах' : 'Мои ноты · только на этом устройстве';
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

    // Загрузка своих нот (MusicXML / MIDI): видны только пользователю; в Telegram — на всех его устройствах
    const add = document.createElement('label');
    add.className = 'tile tile-add';
    const addName = document.createElement('span');
    addName.className = 'tile-name';
    addName.textContent = '＋ Загрузить свои ноты';
    const addMeta = document.createElement('span');
    addMeta.className = 'tile-meta';
    addMeta.textContent = `MusicXML (.mxl, .musicxml) или MIDI (.mid), до 5 МБ и 5000 нот. ${
      this.storage().cloud ? 'Видны только вам, на всех ваших устройствах в Telegram.' : 'Вне Telegram хранятся только на этом устройстве.'
    }`;
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
