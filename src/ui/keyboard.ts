import { isBlackKey, midiToName, NOTE_NAMES } from '../audio/notes';

export type KeyMark = 'detected' | 'expected' | 'pass' | 'fail';

/** Экранная клавиатура на DOM: белые клавиши — равные доли ширины, чёрные — поверх стыков. */
export class Keyboard {
  readonly el: HTMLElement;
  private readonly keys = new Map<number, HTMLElement>();
  onTap: (midi: number) => void = () => {};

  constructor(container: HTMLElement, readonly low: number, readonly high: number) {
    this.el = container;
    container.classList.add('keyboard');
    const whites: number[] = [];
    for (let m = low; m <= high; m++) if (!isBlackKey(m)) whites.push(m);
    const ww = 100 / whites.length;

    let whiteBefore = 0;
    for (let m = low; m <= high; m++) {
      const key = document.createElement('div');
      key.dataset.midi = String(m);
      const label = document.createElement('span');
      label.className = 'label';
      if (isBlackKey(m)) {
        key.className = 'key black';
        const bw = ww * 0.62;
        key.style.left = `${whiteBefore * ww - bw / 2}%`;
        key.style.width = `${bw}%`;
        label.textContent = midiToName(m).replace(/\d+$/, '');
      } else {
        key.className = 'key white';
        key.style.left = `${whiteBefore * ww}%`;
        key.style.width = `${ww}%`;
        const pc = NOTE_NAMES[m % 12];
        label.textContent = pc === 'C' ? midiToName(m) : pc;
        if (pc === 'C') key.classList.add('c');
        whiteBefore++;
      }
      key.appendChild(label);
      container.appendChild(key);
      this.keys.set(m, key);
    }

    container.addEventListener('pointerdown', (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('.key');
      if (!t?.dataset.midi) return;
      e.preventDefault();
      this.onTap(Number(t.dataset.midi));
    });
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
