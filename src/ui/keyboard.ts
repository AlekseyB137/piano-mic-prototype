import { isBlackKey, midiToName, NOTE_NAMES } from '../audio/notes';

export type KeyMark = 'detected' | 'expected' | 'pass' | 'fail';

/** Положение клавиши в долях ширины клавиатуры — по нему падающие ноты встают над своей клавишей. */
export interface KeyGeometry {
  x: number;
  w: number;
  black: boolean;
}

/** Экранная клавиатура на DOM: белые клавиши — равные доли ширины, чёрные — поверх стыков. */
export class Keyboard {
  readonly el: HTMLElement;
  private readonly keys = new Map<number, HTMLElement>();
  private readonly geometry = new Map<number, KeyGeometry>();
  low: number;
  high: number;
  onTap: (midi: number) => void = () => {};

  constructor(container: HTMLElement, low: number, high: number) {
    this.el = container;
    this.low = low;
    this.high = high;
    container.classList.add('keyboard');
    container.addEventListener('pointerdown', (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('.key');
      if (!t?.dataset.midi) return;
      e.preventDefault();
      this.onTap(Number(t.dataset.midi));
    });
    this.build();
  }

  /** Перестроить под другой диапазон (режим «Песня» показывает только окно под песню). */
  setRange(low: number, high: number): void {
    if (low === this.low && high === this.high) return;
    this.low = low;
    this.high = high;
    this.build();
  }

  keyGeometry(midi: number): KeyGeometry | null {
    return this.geometry.get(midi) ?? null;
  }

  private build(): void {
    const { low, high } = this;
    this.el.replaceChildren();
    this.keys.clear();
    this.geometry.clear();
    const whites: number[] = [];
    for (let m = low; m <= high; m++) if (!isBlackKey(m)) whites.push(m);
    const ww = 100 / whites.length;

    let whiteBefore = 0;
    for (let m = low; m <= high; m++) {
      const key = document.createElement('div');
      key.dataset.midi = String(m);
      const label = document.createElement('span');
      label.className = 'label';
      let left: number, width: number;
      if (isBlackKey(m)) {
        key.className = 'key black';
        width = ww * 0.62;
        left = whiteBefore * ww - width / 2;
        label.textContent = midiToName(m).replace(/\d+$/, '');
      } else {
        key.className = 'key white';
        left = whiteBefore * ww;
        width = ww;
        const pc = NOTE_NAMES[m % 12];
        label.textContent = pc === 'C' ? midiToName(m) : pc;
        if (pc === 'C') key.classList.add('c');
        whiteBefore++;
      }
      key.style.left = `${left}%`;
      key.style.width = `${width}%`;
      key.appendChild(label);
      this.el.appendChild(key);
      this.keys.set(m, key);
      this.geometry.set(m, { x: left / 100, w: width / 100, black: isBlackKey(m) });
    }
  }

  mark(midi: number, mark: KeyMark, on = true): void {
    this.keys.get(midi)?.classList.toggle(mark, on);
  }

  clear(mark: KeyMark): void {
    for (const k of this.keys.values()) k.classList.remove(mark);
  }

  /** Оставить метку только на указанных клавишах. */
  setOnly(mark: KeyMark, midis: Iterable<number>): void {
    const s = new Set(midis);
    for (const [m, k] of this.keys) k.classList.toggle(mark, s.has(m));
  }
}
