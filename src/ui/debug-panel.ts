import type { AnalyzerParams } from '../audio/params';
import type { FrameEvent } from '../audio/messages';
import { PREVIEW_FMAX, PREVIEW_FMIN } from '../audio/analyzer';

interface SliderDef {
  key: keyof AnalyzerParams;
  label: string;
  min: number;
  max: number;
  step: number;
}

const SLIDERS: SliderDef[] = [
  { key: 'gateDb', label: 'Сигнал над шумом, дБ', min: 0, max: 40, step: 1 },
  { key: 'minClarity', label: 'Мин. уверенность высоты', min: 0.5, max: 0.99, step: 0.01 },
  { key: 'yinThreshold', label: 'Порог YIN', min: 0.05, max: 0.4, step: 0.01 },
  { key: 'onsetDelta', label: 'Атака: абс. порог потока', min: 0.002, max: 0.3, step: 0.001 },
  { key: 'onsetMultiplier', label: 'Атака: × медиана', min: 0.5, max: 5, step: 0.1 },
  { key: 'onsetMinIntervalMs', label: 'Атака: мин. интервал, мс', min: 20, max: 300, step: 5 },
  { key: 'maxDriftCents', label: 'Нота: макс. дрейф после удара, центы', min: 3, max: 50, step: 1 },
  { key: 'maxDetuneCents', label: 'Нота: макс. отклонение от строя (с растяжкой), центы', min: 10, max: 50, step: 1 },
  { key: 'snrDb', label: 'Проверка: гармоника над шумом, дБ', min: 3, max: 40, step: 1 },
  { key: 'toleranceCents', label: 'Проверка: допуск частоты, центы', min: 10, max: 60, step: 1 },
  { key: 'minHarmonics', label: 'Проверка: мин. гармоник', min: 1, max: 4, step: 1 },
  { key: 'riseDb', label: 'Проверка: рост после удара, дБ (0 — выкл.)', min: 0, max: 12, step: 0.5 },
  { key: 'octaveMarginDb', label: 'Проверка: запас «октава ниже», дБ', min: 0, max: 20, step: 1 },
  { key: 'chordBalanceDb', label: 'Проверка: нота аккорда тише громкой, дБ (0 — выкл.)', min: 0, max: 30, step: 1 },
  { key: 'octaveChordDb', label: 'Проверка: октавный аккорд (C3+C4), дБ', min: 0, max: 15, step: 1 },
  { key: 'checkAttackHfDb', label: 'Проверка: подъём 2–6 кГц у удара, дБ', min: 0, max: 30, step: 1 },
  { key: 'checkWindowMs', label: 'Проверка: окно после удара, мс', min: 100, max: 1000, step: 10 },
  { key: 'checkMinHits', label: 'Проверка: кадров подряд', min: 1, max: 6, step: 1 },
];

const FLUX_HISTORY = 240;

function css(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function fitCanvas(c: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(c.clientWidth * dpr);
  const h = Math.round(c.clientHeight * dpr);
  if (w === 0 || h === 0) return null;
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  const g = c.getContext('2d');
  g?.setTransform(dpr, 0, 0, dpr, 0, 0);
  return g;
}

/** Сворачиваемая отладочная панель: уровни, спектр, параметры, пороги. */
export class DebugPanel {
  readonly root: HTMLElement;
  private readonly level: HTMLCanvasElement;
  private readonly flux: HTMLCanvasElement;
  private readonly spectrum: HTMLCanvasElement;
  private readonly liveText: HTMLElement;
  private readonly infoTable: HTMLElement;
  private readonly inputs = new Map<keyof AnalyzerParams, { input: HTMLInputElement; out: HTMLElement }>();
  private readonly fluxHist = new Float32Array(FLUX_HISTORY);
  private readonly thrHist = new Float32Array(FLUX_HISTORY);
  private readonly onsetHist = new Uint8Array(FLUX_HISTORY);
  private histPos = 0;
  private pendingOnset = false;
  noisePreview: Float32Array | null = null;
  markers: number[] = [];

  onParam: (p: Partial<AnalyzerParams>) => void = () => {};
  onResetParams: () => void = () => {};
  onFftSize: (n: number) => void = () => {};
  onCopy: () => void = () => {};
  onShare: () => void = () => {};
  /** Запись звука по сценарию (для разбора распознавания). */
  onRecord: () => void = () => {};

  constructor(root: HTMLElement, params: AnalyzerParams, fftSize: number) {
    this.root = root;
    root.innerHTML = `
      <section>
        <h3>Сигнал</h3>
        <canvas class="meter level"></canvas>
        <canvas class="meter flux"></canvas>
        <div class="live mono"></div>
      </section>
      <section>
        <h3>Спектр <small>40 Гц – 6 кГц, лог. шкала</small></h3>
        <canvas class="spectrum"></canvas>
      </section>
      <section>
        <h3>Устройство</h3>
        <dl class="info mono"></dl>
        <div class="buttons">
          <button class="small share">Поделиться отчётом</button>
          <button class="small copy">Скопировать</button>
          <button class="small record">Запись по сценарию</button>
        </div>
      </section>
      <section>
        <h3>Пороги</h3>
        <label class="row">Большое FFT
          <select class="fft"><option value="8192">8192 (точнее)</option><option value="4096">4096 (быстрее)</option></select>
        </label>
        <p class="hint">Размер FFT применяется после Стоп → Старт.</p>
        <div class="sliders"></div>
        <button class="small reset">Сбросить пороги</button>
      </section>`;
    this.level = root.querySelector('.level')!;
    this.flux = root.querySelector('.flux')!;
    this.spectrum = root.querySelector('.spectrum')!;
    this.liveText = root.querySelector('.live')!;
    this.infoTable = root.querySelector('.info')!;
    root.querySelector('.copy')!.addEventListener('click', () => this.onCopy());
    root.querySelector('.share')!.addEventListener('click', () => this.onShare());
    root.querySelector('.record')!.addEventListener('click', () => this.onRecord());
    root.querySelector('.reset')!.addEventListener('click', () => this.onResetParams());
    const sel = root.querySelector<HTMLSelectElement>('.fft')!;
    sel.value = String(fftSize);
    sel.addEventListener('change', () => this.onFftSize(Number(sel.value)));

    const box = root.querySelector('.sliders')!;
    for (const d of SLIDERS) {
      const row = document.createElement('label');
      row.className = 'slider';
      const name = document.createElement('span');
      name.textContent = d.label;
      const out = document.createElement('output');
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(d.min);
      input.max = String(d.max);
      input.step = String(d.step);
      input.addEventListener('input', () => {
        out.textContent = input.value;
        this.onParam({ [d.key]: Number(input.value) });
      });
      row.append(name, out, input);
      box.append(row);
      this.inputs.set(d.key, { input, out });
    }
    this.setParams(params);
  }

  setParams(p: AnalyzerParams): void {
    for (const [k, { input, out }] of this.inputs) {
      input.value = String(p[k]);
      out.textContent = String(p[k]);
    }
  }

  setInfo(rows: [string, string][]): void {
    this.infoTable.replaceChildren(
      ...rows.flatMap(([k, v]) => {
        const dt = document.createElement('dt');
        dt.textContent = k;
        const dd = document.createElement('dd');
        dd.textContent = v;
        return [dt, dd];
      }),
    );
  }

  markOnset(): void {
    this.pendingOnset = true;
  }

  /** Накопить историю потока (на каждый кадр, даже если панель свёрнута). */
  pushFrame(f: FrameEvent): void {
    this.fluxHist[this.histPos] = f.flux;
    this.thrHist[this.histPos] = f.fluxThreshold;
    this.onsetHist[this.histPos] = this.pendingOnset ? 1 : 0;
    this.pendingOnset = false;
    this.histPos = (this.histPos + 1) % FLUX_HISTORY;
  }

  draw(f: FrameEvent, gateDb: number): void {
    if (this.root.classList.contains('collapsed')) return;
    this.liveText.textContent =
      `RMS ${f.rmsDb.toFixed(1)} дБ · фон ${f.noiseRmsDb.toFixed(1)} дБ${f.calibrated ? '' : ' (не откалибровано)'}\n` +
      `поток ${f.flux.toFixed(3)} / порог ${f.fluxThreshold.toFixed(3)} · гейт ${f.gateOpen ? 'открыт' : 'закрыт'}\n` +
      `высота ${f.pitch ? `${f.pitch.freq.toFixed(1)} Гц` : '—'} · атак отброшено (не фортепиано): ${f.ignoredAttacks}` +
      (f.loadMsPerSec !== null ? `\nнагрузка анализа ${f.loadMsPerSec.toFixed(0)} мс/с` : '');
    this.drawLevel(f, gateDb);
    this.drawFlux();
    this.drawSpectrum(f);
  }

  private drawLevel(f: FrameEvent, gateDb: number): void {
    const g = fitCanvas(this.level);
    if (!g) return;
    const w = this.level.clientWidth, h = this.level.clientHeight;
    const x = (db: number) => (Math.max(-100, Math.min(0, db)) / 100 + 1) * w;
    g.fillStyle = css('--surface-2', '#222');
    g.fillRect(0, 0, w, h);
    g.fillStyle = f.gateOpen ? css('--accent', '#4af') : css('--muted', '#666');
    g.fillRect(0, 0, x(f.rmsDb), h);
    g.fillStyle = css('--text-dim', '#999');
    g.fillRect(x(f.noiseRmsDb) - 1, 0, 2, h);
    g.fillStyle = css('--warn', '#fc4');
    g.fillRect(x(f.noiseRmsDb + gateDb) - 1, 0, 2, h);
    g.fillStyle = css('--text', '#eee');
    g.font = '11px ui-monospace, monospace';
    g.fillText(`${f.rmsDb.toFixed(0)} дБFS`, 4, h - 5);
  }

  private drawFlux(): void {
    const g = fitCanvas(this.flux);
    if (!g) return;
    const w = this.flux.clientWidth, h = this.flux.clientHeight;
    g.fillStyle = css('--surface-2', '#222');
    g.fillRect(0, 0, w, h);
    let max = 0.05;
    for (let i = 0; i < FLUX_HISTORY; i++) max = Math.max(max, this.fluxHist[i], this.thrHist[i]);
    const xs = w / (FLUX_HISTORY - 1);
    const y = (v: number) => h - (v / max) * (h - 4) - 2;
    g.strokeStyle = css('--danger', '#f55');
    g.lineWidth = 1;
    for (let i = 0; i < FLUX_HISTORY; i++) {
      if (!this.onsetHist[(this.histPos + i) % FLUX_HISTORY]) continue;
      g.beginPath();
      g.moveTo(i * xs, 0);
      g.lineTo(i * xs, h);
      g.stroke();
    }
    const line = (arr: Float32Array, color: string) => {
      g.strokeStyle = color;
      g.lineWidth = 1.5;
      g.beginPath();
      for (let i = 0; i < FLUX_HISTORY; i++) {
        const v = arr[(this.histPos + i) % FLUX_HISTORY];
        if (i === 0) g.moveTo(0, y(v));
        else g.lineTo(i * xs, y(v));
      }
      g.stroke();
    };
    line(this.thrHist, css('--warn', '#fc4'));
    line(this.fluxHist, css('--accent', '#4af'));
    g.fillStyle = css('--text-dim', '#999');
    g.font = '11px ui-monospace, monospace';
    g.fillText('поток / порог / атаки', 4, 12);
  }

  private drawSpectrum(f: FrameEvent): void {
    const g = fitCanvas(this.spectrum);
    if (!g) return;
    const w = this.spectrum.clientWidth, h = this.spectrum.clientHeight;
    const n = f.spectrum.length;
    const yOf = (db: number) => h - ((Math.max(-110, Math.min(-10, db)) + 110) / 100) * h;
    const xOf = (hz: number) => (Math.log(hz / PREVIEW_FMIN) / Math.log(PREVIEW_FMAX / PREVIEW_FMIN)) * w;
    g.fillStyle = css('--surface-2', '#222');
    g.fillRect(0, 0, w, h);

    // Октавные метки C
    g.fillStyle = css('--text-dim', '#999');
    g.font = '10px ui-monospace, monospace';
    for (let oct = 1; oct <= 8; oct++) {
      const hz = 440 * Math.pow(2, (12 * (oct + 1) - 69) / 12);
      if (hz < PREVIEW_FMIN || hz > PREVIEW_FMAX) continue;
      const x = xOf(hz);
      g.fillRect(x, 0, 1, h);
      g.fillText(`C${oct}`, x + 2, 10);
    }

    const bw = w / n;
    g.fillStyle = css('--accent', '#4af');
    for (let i = 0; i < n; i++) {
      const y = yOf(f.spectrum[i]);
      g.fillRect(i * bw, y, Math.max(1, bw - 0.5), h - y);
    }
    if (this.noisePreview) {
      g.strokeStyle = css('--text-dim', '#999');
      g.lineWidth = 1;
      g.beginPath();
      for (let i = 0; i < n; i++) {
        const y = yOf(this.noisePreview[i]);
        if (i === 0) g.moveTo(0, y);
        else g.lineTo((i + 0.5) * bw, y);
      }
      g.stroke();
    }
    g.fillStyle = css('--warn', '#fc4');
    for (const hz of this.markers) g.fillRect(xOf(hz) - 1, 0, 2, h);
    if (f.pitch) {
      g.fillStyle = css('--success', '#4d8');
      g.fillRect(xOf(f.pitch.freq) - 1, 0, 2, h);
    }
  }
}
