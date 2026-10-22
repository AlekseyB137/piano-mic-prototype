/**
 * Запись для отладки распознавания: WAV (16 бит, моно) + свой блок «pmjs» с JSON —
 * сценарий (что пользователя просили сыграть), управляющие сообщения анализатору с точным временем
 * и события, которые анализатор выдал вживую. Обычные плееры блок «pmjs» пропускают.
 * Без DOM: тот же код читает файл в tools/replay.ts.
 */
import type { WorkletInMessage } from '../audio/messages';
import type { AnalyzerParams } from '../audio/params';

/** Что пользователя просили сделать на шаге сценария и какой ответ правильный. */
export interface StepLabel {
  index: number;
  /** Текст инструкции («Сыграйте C4»). */
  say: string;
  /** Ноты, которые проверяет анализатор. */
  expect: number[];
  /** Ноты, которые просили сыграть (null — ничего не играть: стук, отпускание). */
  play: number[] | null;
  /** Правильный вердикт: засчитать, не засчитать или промолчать. */
  want: 'pass' | 'fail' | 'none';
  /** Сколько раз сыграть. */
  times: number;
  /** Время анализатора: начало шага (инструкция показана) и конец. */
  tStart: number;
  tEnd: number;
}

export interface RecordingMeta {
  app: 'piano-mic';
  version: 1;
  build: string;
  ua: string;
  sampleRate: number;
  bigFft: number;
  /** Пороги анализатора на момент начала записи. */
  params: AnalyzerParams;
  /** Время анализатора первого записанного сэмпла. */
  t0: number;
  controls: { t: number; msg: WorkletInMessage }[];
  steps: StepLabel[];
  /** События анализатора вживую (без кадров). */
  live: unknown[];
}

const META_ID = 'pmjs';

function writeStr(v: DataView, at: number, s: string): void {
  for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
}

/** Собрать WAV из кусков 16-битного звука и метаданных. */
export function encodeWav(chunks: Int16Array[], sampleRate: number, meta: RecordingMeta): Uint8Array {
  const samples = chunks.reduce((n, c) => n + c.length, 0);
  const json = new TextEncoder().encode(JSON.stringify(meta));
  const jsonPad = json.length % 2;
  const dataBytes = samples * 2;
  const total = 12 + (8 + 16) + (8 + dataBytes) + (8 + json.length + jsonPad);
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  writeStr(v, 0, 'RIFF');
  v.setUint32(4, total - 8, true);
  writeStr(v, 8, 'WAVE');
  writeStr(v, 12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // моно
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  writeStr(v, 36, 'data');
  v.setUint32(40, dataBytes, true);
  let at = 44;
  for (const c of chunks) {
    out.set(new Uint8Array(c.buffer, c.byteOffset, c.byteLength), at); // WAV — little-endian, как и все наши устройства
    at += c.byteLength;
  }
  writeStr(v, at, META_ID);
  v.setUint32(at + 4, json.length, true);
  out.set(json, at + 8);
  return out;
}

/** Прочитать WAV: звук в Float32 (−1…1) и метаданные (null — файл не из приложения). */
export function decodeWav(bytes: Uint8Array): { sampleRate: number; samples: Float32Array; meta: RecordingMeta | null } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const str = (at: number) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  if (str(0) !== 'RIFF' || str(8) !== 'WAVE') throw new Error('не WAV-файл');
  let sampleRate = 0, bits = 0, channels = 0;
  let samples: Float32Array | null = null;
  let meta: RecordingMeta | null = null;
  for (let at = 12; at + 8 <= bytes.length; ) {
    const id = str(at);
    const len = v.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'fmt ') {
      channels = v.getUint16(body + 2, true);
      sampleRate = v.getUint32(body + 4, true);
      bits = v.getUint16(body + 14, true);
    } else if (id === 'data') {
      if (bits !== 16) throw new Error(`поддерживается только 16 бит, в файле ${bits}`);
      const n = Math.floor(len / 2 / channels);
      samples = new Float32Array(n);
      for (let i = 0; i < n; i++) samples[i] = v.getInt16(body + i * 2 * channels, true) / 32768;
    } else if (id === META_ID) {
      meta = JSON.parse(new TextDecoder().decode(bytes.subarray(body, body + len))) as RecordingMeta;
    }
    at = body + len + (len % 2);
  }
  if (!samples || !sampleRate) throw new Error('в WAV нет звука');
  return { sampleRate, samples, meta };
}

/** Float32 (−1…1) → 16 бит. */
export function toInt16(f: Float32Array): Int16Array {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const x = Math.max(-1, Math.min(1, f[i]));
    out[i] = x < 0 ? x * 32768 : x * 32767;
  }
  return out;
}
