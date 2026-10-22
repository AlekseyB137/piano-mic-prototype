import type { ScenarioStep } from '../record/scenario-steps';
import type { StepLabel } from '../record/wav';

/** Сколько секунд на «Приготовьтесь» перед каждым шагом. */
const PREP_SEC = 1.2;

export interface ScenarioHooks {
  /** Выставить ожидаемые ноты анализатору. */
  setExpected(midis: number[]): void;
  calibrate(): void;
  /** Текущее время анализатора (по записанному звуку). */
  analyzerNow(): number;
  onFinish(steps: StepLabel[], aborted: boolean): void;
}

/**
 * Экран «Запись по сценарию»: по шагам говорит, что сыграть, и запоминает правильные ответы
 * со временем анализатора. Сам звук пишет main.ts.
 */
export class ScenarioView {
  private timer = 0;
  private raf = 0;
  private labels: StepLabel[] = [];
  private running = false;
  private readonly el: { step: HTMLElement; say: HTMLElement; sub: HTMLElement; phase: HTMLElement; bar: HTMLElement; last: HTMLElement; actions: HTMLElement };

  constructor(
    private readonly root: HTMLElement,
    private readonly steps: ScenarioStep[],
    private readonly hooks: ScenarioHooks,
  ) {
    root.innerHTML = `
      <div class="sc-step"></div>
      <div class="sc-say"></div>
      <div class="sc-sub"></div>
      <div class="sc-phase"></div>
      <div class="sc-track"><div class="sc-bar"></div></div>
      <div class="sc-last"></div>
      <div class="sc-actions"></div>`;
    const q = (c: string) => root.querySelector<HTMLElement>(c)!;
    this.el = { step: q('.sc-step'), say: q('.sc-say'), sub: q('.sc-sub'), phase: q('.sc-phase'), bar: q('.sc-bar'), last: q('.sc-last'), actions: q('.sc-actions') };
  }

  get active(): boolean {
    return this.running;
  }

  start(): void {
    this.labels = [];
    this.running = true;
    this.root.classList.remove('hidden');
    this.setActions([['Остановить', () => this.finish(true)]]);
    this.runStep(0);
  }

  /** Вердикт анализатора — мелко, чтобы видеть, что приложение услышало. */
  showVerdict(text: string, ok: boolean): void {
    this.el.last.textContent = text;
    this.el.last.className = `sc-last ${ok ? 'ok' : 'bad'}`;
  }

  /** Экран после записи: итог и кнопки. */
  showDone(text: string, actions: [string, () => void][]): void {
    this.el.step.textContent = '';
    this.el.say.textContent = 'Запись готова';
    this.el.sub.textContent = text;
    this.el.phase.textContent = '';
    this.el.bar.style.width = '0';
    this.el.last.textContent = '';
    this.setActions(actions);
  }

  /** Прервать (например, остановили аудио). */
  stop(): void {
    this.finish(true);
  }

  hide(): void {
    this.root.classList.add('hidden');
  }

  private setActions(actions: [string, () => void][]): void {
    this.el.actions.replaceChildren(
      ...actions.map(([label, fn], i) => {
        const b = document.createElement('button');
        b.textContent = label;
        if (i === 0) b.className = 'primary';
        b.addEventListener('click', fn);
        return b;
      }),
    );
  }

  private runStep(i: number): void {
    if (!this.running) return;
    if (i >= this.steps.length) return this.finish(false);
    const s = this.steps[i];
    const label: StepLabel = {
      index: i,
      say: s.say,
      expect: s.expect,
      play: s.play,
      want: s.want,
      times: s.times ?? 1,
      tStart: this.hooks.analyzerNow(),
      tEnd: 0,
    };
    this.labels.push(label);
    this.hooks.setExpected(s.expect);
    if (s.calibrate) this.hooks.calibrate();
    this.el.step.textContent = `Шаг ${i + 1} из ${this.steps.length}`;
    this.el.say.textContent = s.say;
    this.el.sub.textContent = s.sub ?? '';
    this.el.last.textContent = '';
    const playSec = s.sec ?? (s.times && s.times > 1 ? 3.5 : 2.6);
    const prep = s.calibrate ? 0 : PREP_SEC;
    const t0 = performance.now();
    const tick = () => {
      const el = (performance.now() - t0) / 1000;
      const inPrep = el < prep;
      this.el.phase.textContent = inPrep ? 'Приготовьтесь…' : s.play ? 'Играйте!' : 'Сейчас';
      this.el.phase.className = `sc-phase ${inPrep ? '' : 'go'}`;
      this.el.bar.style.width = inPrep ? '0' : `${Math.min(100, ((el - prep) / playSec) * 100)}%`;
      if (this.running) this.raf = requestAnimationFrame(tick);
    };
    cancelAnimationFrame(this.raf);
    tick();
    this.timer = window.setTimeout(() => {
      label.tEnd = this.hooks.analyzerNow();
      this.runStep(i + 1);
    }, (prep + playSec) * 1000);
  }

  private finish(aborted: boolean): void {
    if (!this.running) return;
    this.running = false;
    window.clearTimeout(this.timer);
    cancelAnimationFrame(this.raf);
    const last = this.labels[this.labels.length - 1];
    if (last && !last.tEnd) last.tEnd = this.hooks.analyzerNow();
    this.hooks.onFinish(this.labels, aborted);
  }
}
