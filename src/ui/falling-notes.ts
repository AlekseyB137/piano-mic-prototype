import type { PlayMode, SongPlayer } from '../song/player';
import type { KeyGeometry } from './keyboard';

/**
 * Сколько секунд видно над линией удара (как в Synthesia — скорость по времени, а не по долям:
 * на медленном темпе короткие ноты становятся крупнее).
 */
const LOOKAHEAD_SEC = 2.6;
/** Промежуток не больше этой доли длины ноты — иначе короткая нота (шестнадцатая) исчезает. */
const GAP_MAX_SHARE = 0.35;
/** Ниже этой высоты промежутка номер пальца не помещается под нотой — рисуем его на ноте. */
const FINGER_MIN_GAP = 12;
/**
 * Зазор между нотами по вертикали (как в Synthesia), доля доли; в нём под каждой нотой — номер пальца.
 * Нижний край ноты по-прежнему приходит к линии ровно в свою долю — укорачивается верх.
 */
const GAP_BEATS = 0.28;
const GAP_MIN_PX = 16;
const GAP_MAX_PX = 26;
/** Длительность анимации «нота уходит в клавишу», с. */
const SINK_SEC = 0.32;

const easeOut = (p: number) => 1 - (1 - p) * (1 - p);
const easeIn = (p: number) => p * p;

export type FlashKind = 'pass' | 'fail' | 'early';

interface Flash {
  kind: FlashKind;
  until: number;
}

function css(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
}

/**
 * Падающие ноты над клавиатурой. Ноты встают ровно над своими клавишами (геометрия берётся
 * у клавиатуры), линия удара — нижний край холста. На ноте — буква звука, под ней палец.
 * Несыгранная нота — оранжевая (левая рука — синяя), сыгранная — зелёная и «уходит в клавишу».
 */
export class FallingNotes {
  private readonly flashes = new Map<number, Flash>();
  /** Анимация «ушла в клавишу»: индекс шага → момент попадания. */
  private readonly sinks = new Map<number, number>();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly geometry: (midi: number) => KeyGeometry | null,
  ) {}

  flash(midis: number[], kind: FlashKind, now: number, sec = 0.5): void {
    for (const m of midis) this.flashes.set(m, { kind, until: now + sec });
  }

  /** Шаг сыгран — запустить анимацию «нота уходит в клавишу». */
  sink(stepIndex: number, now: number): void {
    this.sinks.set(stepIndex, now);
  }

  reset(): void {
    this.sinks.clear();
    this.flashes.clear();
  }

  draw(player: SongPlayer, now: number, mode: PlayMode = 'wait'): void {
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth, H = c.clientHeight;
    if (!W || !H) return;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);

    const lookBeats = LOOKAHEAD_SEC / player.secPerBeat;
    const ppb = H / lookBeats; // пикселей на долю
    const hitY = H - 2;
    const gapBase = Math.max(GAP_MIN_PX, Math.min(GAP_MAX_PX, ppb * GAP_BEATS));
    const gapOf = (dur: number) => Math.min(gapBase, dur * ppb * GAP_MAX_SHARE);
    // Место под нотой: промежуток ноты, идущей вплотную ниже на той же клавише (иначе — свободно)
    const below = new Map<string, number>();
    for (const st of player.steps) for (const nn of st.notes) below.set(`${nn.pitch}@${Math.round((nn.start + nn.dur) * 1000)}`, gapOf(nn.dur));
    const spaceUnder = (n: { pitch: number; start: number }) => below.get(`${n.pitch}@${Math.round(n.start * 1000)}`) ?? gapBase;

    // Сетка долей — помогает почувствовать ритм
    g.strokeStyle = css('--border', '#2c313c');
    g.lineWidth = 1;
    for (let b = Math.ceil(player.displayBeat); b < player.displayBeat + lookBeats + 1; b++) {
      const y = hitY - (b - player.displayBeat) * ppb;
      g.globalAlpha = b % 4 === 0 ? 0.9 : 0.35;
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(W, y);
      g.stroke();
    }
    g.globalAlpha = 1;

    const colR = css('--note-r', '#ffa94d');
    const colL = css('--note-l', '#4ea8ff');
    const colPass = css('--success', '#3ccf7e');
    const colFail = css('--danger', '#ff5c5c');
    const colText = '#0b0d12';

    for (const step of player.steps) {
      // Сыгранный шаг виден только во время анимации «ухода в клавишу»
      let sinkP = -1;
      // Запись: не сыгранный шаг просто проезжает за линию
      if (step.state === 'done' && !step.missed) {
        const at = this.sinks.get(step.index);
        if (at === undefined || now - at > SINK_SEC) continue;
        sinkP = Math.max(0, (now - at) / SINK_SEC);
      }
      for (const n of step.notes) {
        const geo = this.geometry(n.pitch);
        if (!geo) continue;
        const bottom = hitY - (n.start - player.displayBeat) * ppb;
        const top = bottom - n.dur * ppb + gapOf(n.dur);
        if (sinkP < 0 && (bottom < -4 || top > H)) continue;
        const pad = geo.w * W * (geo.black ? 0.04 : 0.1);
        const x = geo.x * W + pad;
        const w = geo.w * W - 2 * pad;
        let yTop = Math.max(top, -10);
        let yBot = Math.min(bottom, hitY);
        let alpha = 1;
        let fill = n.hand === 'L' ? colL : colR;

        if (sinkP >= 0) {
          // Нота съезжает к линии (если сыграна заранее) и «проваливается» в клавишу
          const h0 = Math.max(4, yBot - yTop);
          const b = yBot + (hitY - yBot) * easeOut(Math.min(1, sinkP / 0.35));
          const h = h0 * (1 - easeIn(sinkP));
          yBot = b;
          yTop = b - h;
          fill = colPass;
          alpha = 1 - 0.5 * sinkP;
          // Вспышка у клавиши
          g.globalAlpha = (1 - sinkP) * 0.8;
          g.fillStyle = colPass;
          g.fillRect(x - 2, hitY - 6, w + 4, 8);
        }
        if (yBot - yTop < 2) continue;

        const fl = step.state === 'current' ? this.flashes.get(n.pitch) : undefined;
        const flashing = fl !== undefined && fl.until > now;
        if (flashing && fl.kind === 'fail') fill = colFail;
        if (flashing && fl.kind === 'early') {
          fill = css('--warn', '#ffc94d');
          // Подсказка над нотой: нажатие услышано, но нота ещё не на линии
          g.globalAlpha = 1;
          g.fillStyle = css('--warn', '#ffc94d');
          g.textAlign = 'center';
          g.textBaseline = 'bottom';
          g.font = `800 13px -apple-system, system-ui, sans-serif`;
          g.fillText('рано', x + w / 2, Math.max(14, yTop - 3));
        }

        g.globalAlpha = alpha;
        g.fillStyle = fill;
        roundRect(g, x, yTop, w, yBot - yTop, 5);
        g.fill();
        if (step.state === 'current') {
          // Текущий шаг: белая рамка, при ожидании — пульсирует
          const pulse = player.waiting ? 0.55 + 0.45 * Math.sin(now * 8) : 1;
          g.globalAlpha = pulse;
          g.strokeStyle = '#ffffff';
          g.lineWidth = 2.5;
          roundRect(g, x, yTop, w, yBot - yTop, 5);
          g.stroke();
        }
        g.globalAlpha = alpha;

        // На ноте — буква звука (без октавы); палец — под нотой, а если там нет места — на ноте
        const h = yBot - yTop;
        const cx = x + w / 2;
        const letter = n.name.replace(/-?\d+$/, '');
        const space = spaceUnder(n);
        const fingerOnNote = space < FINGER_MIN_GAP;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        if (h > 10 && w > 12) {
          g.fillStyle = colText;
          g.font = `800 ${Math.min(22, w * (fingerOnNote ? 0.3 : 0.55), h * 0.6)}px -apple-system, system-ui, sans-serif`;
          g.fillText(fingerOnNote && sinkP < 0 ? `${letter} ${n.finger}` : letter, cx, yTop + h / 2);
        }
        // Под нотой, в зазоре, — номер пальца (у ноты на линии место занято клавиатурой:
        // её палец показывает сама клавиша)
        const fy = bottom + space / 2;
        if (!fingerOnNote && sinkP < 0 && fy + 7 < hitY && fy > 0) {
          g.globalAlpha = 1;
          g.fillStyle = fill;
          g.font = `800 ${Math.min(15, space * 0.75)}px -apple-system, system-ui, sans-serif`;
          g.fillText(String(n.finger), cx, fy);
        }
        g.globalAlpha = 1;
      }
    }

    // Линия удара
    g.fillStyle = player.waiting ? css('--warn', '#ffc94d') : css('--text-dim', '#8b92a1');
    g.fillRect(0, hitY - 1, W, 3);

    // «В такт»: отсчёт вступления 4-3-2-1 (метроном звуком нельзя — его услышит микрофон)
    // Отсчёт — по настоящему времени песни (beat), а не по позиции отрисовки
    if (mode === 'tempo' && player.beat < 0 && player.beat > -player.leadInBeats) {
      const n = Math.ceil(-player.beat);
      const frac = -player.beat - (n - 1); // 1 → 0 в течение доли
      g.globalAlpha = 0.25 + 0.6 * frac;
      g.fillStyle = css('--text', '#e8eaef');
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.font = `800 ${Math.min(H * 0.45, 120)}px -apple-system, system-ui, sans-serif`;
      g.fillText(String(n), W / 2, H * 0.5);
      g.globalAlpha = 1;
    }
  }
}
