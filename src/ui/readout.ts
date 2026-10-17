import { midiToName } from '../audio/notes';
import type { NoteEvidence, NoteVerdict } from '../audio/chord-check';
import type { CheckEvent, FrameEvent } from '../audio/messages';

export type Mode = 'free' | 'check';

const VERDICT_TEXT: Record<NoteVerdict, string> = {
  ok: 'есть',
  weak: 'не слышно',
  'octave-up': 'октава выше?',
  'octave-down': 'нота ниже?',
  'no-attack': 'нет нового удара',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function harmonicsText(ev: NoteEvidence): string {
  return ev.harmonics
    .map((h) => {
      const v = Number.isFinite(h.snrDb) ? Math.round(h.snrDb).toString() : '·';
      return `${h.h}:${v}${h.shared ? '*' : ''}`;
    })
    .join(' ');
}

/** Центральная панель: распознанная нота (свободный режим) или ожидаемые ноты (проверка). */
export class Readout {
  private mode: Mode = 'free';
  private readonly free: HTMLElement;
  private readonly check: HTMLElement;
  private readonly noteBig: HTMLElement;
  private readonly noteMeta: HTMLElement;
  private readonly centsNeedle: HTMLElement;
  private readonly chips: HTMLElement;
  private readonly status: HTMLElement;
  private readonly chipEls = new Map<number, { root: HTMLElement; state: HTMLElement; detail: HTMLElement }>();
  private result: CheckEvent | null = null;
  onClear: () => void = () => {};

  constructor(root: HTMLElement) {
    this.free = el('div', 'readout-free');
    this.noteBig = el('div', 'note-big', '—');
    this.noteMeta = el('div', 'note-meta', 'Нажмите «Старт» и сыграйте ноту');
    const cents = el('div', 'cents-bar');
    cents.append(el('span', 'cents-zero'));
    this.centsNeedle = el('span', 'cents-needle');
    cents.append(this.centsNeedle);
    const scale = el('div', 'cents-scale');
    scale.append(el('span', '', '−50'), el('span', '', '0'), el('span', '', '+50'));
    this.free.append(this.noteBig, this.noteMeta, cents, scale);

    this.check = el('div', 'readout-check hidden');
    const head = el('div', 'check-head');
    head.append(el('span', '', 'Тапните клавиши (нота или аккорд), затем сыграйте на пианино.'));
    const clear = el('button', 'small', 'Очистить');
    clear.addEventListener('click', () => this.onClear());
    head.append(clear);
    this.chips = el('div', 'chips');
    this.status = el('div', 'check-status', 'Ноты не выбраны');
    this.check.append(head, this.chips, this.status);

    root.append(this.free, this.check);
  }

  setMode(mode: Mode): void {
    this.mode = mode;
    this.free.classList.toggle('hidden', mode !== 'free');
    this.check.classList.toggle('hidden', mode !== 'check');
  }

  updateFrame(f: FrameEvent): void {
    if (this.mode === 'free') this.updateFree(f);
    else this.updateLive(f);
  }

  private updateFree(f: FrameEvent): void {
    // Показываем только подтверждённую ноту — голос и шум на экран не попадают
    const midi = f.stableMidi;
    this.noteBig.textContent = midi === null ? '—' : midiToName(midi);
    if (midi !== null && f.pitch && f.pitch.midi === midi) {
      const c = f.pitch.cents;
      this.noteMeta.textContent = `${f.pitch.freq.toFixed(1)} Гц · ${c >= 0 ? '+' : ''}${c} ц · уверенность ${f.pitch.clarity.toFixed(2)}`;
      this.centsNeedle.style.left = `${50 + Math.max(-50, Math.min(50, c))}%`;
      this.centsNeedle.classList.remove('hidden');
    } else {
      this.noteMeta.textContent = midi !== null ? midiToName(midi) : 'Сыграйте ноту';
      this.centsNeedle.classList.add('hidden');
    }
  }

  setExpected(midis: number[]): void {
    this.result = null;
    this.chipEls.clear();
    this.chips.replaceChildren(
      ...midis.map((m) => {
        const root = el('div', 'chip');
        const name = el('span', 'chip-name', midiToName(m));
        const state = el('span', 'chip-state', '…');
        const detail = el('span', 'chip-detail', '');
        root.append(name, state, detail);
        this.chipEls.set(m, { root, state, detail });
        return root;
      }),
    );
    this.status.textContent = midis.length ? 'Ждём удар…' : 'Ноты не выбраны';
    this.status.className = 'check-status';
  }

  private updateLive(f: FrameEvent): void {
    if (!f.live) return;
    for (const ev of f.live) {
      const c = this.chipEls.get(ev.midi);
      if (!c) continue;
      c.detail.textContent = harmonicsText(ev);
      c.root.classList.toggle('live-ok', ev.passed);
    }
  }

  setResult(res: CheckEvent): void {
    this.result = res;
    for (const n of res.notes) {
      const c = this.chipEls.get(n.midi);
      if (!c) continue;
      c.root.classList.toggle('pass', n.passed);
      c.root.classList.toggle('fail', !n.passed);
      c.state.textContent = n.passed ? '✓' : `✗ ${n.evidence ? VERDICT_TEXT[n.evidence.verdict] : ''}`;
    }
    this.status.textContent = res.allPassed
      ? `Засчитано (${res.latencyMs} мс после удара)`
      : `Не засчитано: ${res.notes.filter((n) => !n.passed).map((n) => midiToName(n.midi)).join(', ')}`;
    this.status.className = `check-status ${res.allPassed ? 'pass' : 'fail'}`;
  }

  get lastResult(): CheckEvent | null {
    return this.result;
  }
}

export { VERDICT_TEXT };
