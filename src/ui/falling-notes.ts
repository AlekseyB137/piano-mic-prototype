import type { PlayMode, SongPlayer } from '../song/player';
import type { KeyGeometry } from './keyboard';

/** Сколько долей видно над линией удара. */
const LOOKAHEAD_BEATS = 4;
/** Зазор между соседними нотами по вертикали, px — чтобы повторы одной ноты читались раздельно. */
const NOTE_GAP = 3;

interface Flash {
  kind: 'pass' | 'fail';
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
 * у клавиатуры), линия удара — нижний край холста. На ноте: палец (крупно), нота и рука.
 */
export class FallingNotes {
  private readonly flashes = new Map<number, Flash>();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly geometry: (midi: number) => KeyGeometry | null,
  ) {}

  flash(midis: number[], kind: 'pass' | 'fail', now: number, sec = 0.5): void {
    for (const m of midis) this.flashes.set(m, { kind, until: now + sec });
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

    const ppb = H / LOOKAHEAD_BEATS; // пикселей на долю
    const hitY = H - 2;

    // Сетка долей — помогает почувствовать ритм
    g.strokeStyle = css('--border', '#2c313c');
    g.lineWidth = 1;
    for (let b = Math.ceil(player.beat); b < player.beat + LOOKAHEAD_BEATS + 1; b++) {
      const y = hitY - (b - player.beat) * ppb;
      g.globalAlpha = b % 4 === 0 ? 0.9 : 0.35;
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(W, y);
      g.stroke();
    }
    g.globalAlpha = 1;

    const colR = css('--hand-r', '#4ea8ff');
    const colL = css('--hand-l', '#ffa94d');
    const colPass = css('--success', '#3ccf7e');
    const colFail = css('--danger', '#ff5c5c');
    const colText = '#0b0d12';

    for (const step of player.steps) {
      for (const n of step.notes) {
        const geo = this.geometry(n.pitch);
        if (!geo) continue;
        const bottom = hitY - (n.start - player.beat) * ppb;
        const top = bottom - n.dur * ppb + NOTE_GAP;
        if (bottom < -4 || top > H) continue;
        const pad = geo.w * W * (geo.black ? 0.04 : 0.1);
        const x = geo.x * W + pad;
        const w = geo.w * W - 2 * pad;
        const yTop = Math.max(top, -10);
        const yBot = Math.min(bottom, hitY);
        if (yBot - yTop < 2) continue;

        let fill = n.hand === 'L' ? colL : colR;
        let alpha = 1;
        if (step.state === 'done') {
          fill = step.late ? css('--warn', '#ffc94d') : colPass; // «поздно» — оранжевым
          alpha = 0.35;
        }
        const fl = step.state === 'current' ? this.flashes.get(n.pitch) : undefined;
        if (fl && fl.until > now) fill = fl.kind === 'fail' ? colFail : colPass;

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

        // Подписи: палец крупно, под ним нота и рука; на короткой ноте — всё в одну строку
        const h = yBot - yTop;
        if (h > 14 && w > 14) {
          g.fillStyle = colText;
          g.textAlign = 'center';
          g.textBaseline = 'middle';
          const cx = x + w / 2;
          const hand = n.hand === 'L' ? 'Л' : 'П';
          const fs = Math.min(22, w * 0.6, h * 0.5);
          if (h > fs + 18) {
            g.font = `700 ${fs}px -apple-system, system-ui, sans-serif`;
            g.fillText(String(n.finger), cx, yBot - h / 2 - 6);
            g.font = `600 ${Math.min(11, w * 0.3)}px -apple-system, system-ui, sans-serif`;
            g.fillText(`${n.name} ${hand}`, cx, yBot - 9);
          } else {
            const fs1 = Math.min(14, h * 0.6, w * 0.24);
            g.font = `700 ${fs1}px -apple-system, system-ui, sans-serif`;
            g.fillText(`${n.finger} ${n.name}${hand}`, cx, yBot - h / 2);
          }
        }
        g.globalAlpha = 1;
      }
    }

    // Линия удара
    g.fillStyle = player.waiting ? css('--warn', '#ffc94d') : css('--text-dim', '#8b92a1');
    g.fillRect(0, hitY - 1, W, 3);

    // «В такт»: отсчёт вступления 4-3-2-1 (метроном звуком нельзя — его услышит микрофон)
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
