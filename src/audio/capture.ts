import workletUrl from './analyzer.worklet.ts?worker&url';
import type { AnalyzerEvent, WorkletInMessage } from './messages';

export type MicErrorKind = 'insecure' | 'unsupported' | 'denied' | 'notfound' | 'busy' | 'worklet' | 'other';

export class MicError extends Error {
  constructor(readonly kind: MicErrorKind, message: string) {
    super(message);
  }
}

export interface CaptureInfo {
  sampleRate: number;
  baseLatency: number | null;
  outputLatency: number | null;
  trackLabel: string;
  trackSettings: MediaTrackSettings;
  requested: MediaTrackConstraints;
}

export interface CaptureOptions {
  bigFft: number;
}

/** Микрофон без обработки: эхо-, шумоподавление и АРУ портят спектр и атаки. */
const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 1,
};

/**
 * Захват микрофона → AudioWorklet с анализатором.
 * start() ОБЯЗАТЕЛЬНО вызывать прямо из обработчика нажатия (iOS требует жест
 * для AudioContext и getUserMedia).
 */
export class AudioCapture {
  ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private sink: GainNode | null = null;
  private stream: MediaStream | null = null;

  onEvent: (ev: AnalyzerEvent) => void = () => {};
  onStateChange: (state: string) => void = () => {};
  onTrackEnded: () => void = () => {};

  get running(): boolean {
    return this.ctx !== null;
  }

  async start(opts: CaptureOptions): Promise<CaptureInfo> {
    if (!window.isSecureContext) {
      throw new MicError('insecure', 'Страница открыта не по HTTPS — браузер не даёт доступ к микрофону. Откройте https:// адрес или localhost.');
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new MicError('unsupported', 'Этот браузер/WebView не поддерживает доступ к микрофону (mediaDevices.getUserMedia недоступен).');
    }
    const AC: typeof AudioContext | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) throw new MicError('unsupported', 'Web Audio API недоступен.');

    // Создаём и «будим» контекст синхронно, пока жест пользователя ещё активен
    const ctx = new AC({ latencyHint: 'interactive' });
    this.ctx = ctx;
    const resumed = ctx.resume().catch(() => undefined);
    ctx.onstatechange = () => this.onStateChange(ctx.state);

    try {
      if (!ctx.audioWorklet) {
        throw new MicError('worklet', 'AudioWorklet не поддерживается (нужен iOS 14.5+ / современный Android WebView).');
      }

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS, video: false });
      } catch (e) {
        throw toMicError(e);
      }
      this.stream = stream;

      try {
        await ctx.audioWorklet.addModule(workletUrl);
      } catch (e) {
        throw new MicError('worklet', `Не удалось загрузить AudioWorklet: ${errText(e)}`);
      }
      await resumed;

      const track = stream.getAudioTracks()[0];
      track.onended = () => this.onTrackEnded();

      this.source = ctx.createMediaStreamSource(stream);
      this.node = new AudioWorkletNode(ctx, 'piano-analyzer', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit',
        processorOptions: { bigFft: opts.bigFft },
      });
      this.node.port.onmessage = (e: MessageEvent<AnalyzerEvent>) => this.onEvent(e.data);
      // Некоторые браузеры (Safari) не «крутят» граф, не подключённый к выходу.
      // Подключаем через нулевое усиление — звук в динамик не идёт.
      this.sink = ctx.createGain();
      this.sink.gain.value = 0;
      this.source.connect(this.node);
      this.node.connect(this.sink);
      this.sink.connect(ctx.destination);

      return {
        sampleRate: ctx.sampleRate,
        baseLatency: typeof ctx.baseLatency === 'number' ? ctx.baseLatency : null,
        outputLatency: typeof ctx.outputLatency === 'number' ? ctx.outputLatency : null,
        trackLabel: track.label,
        trackSettings: track.getSettings(),
        requested: AUDIO_CONSTRAINTS,
      };
    } catch (e) {
      await this.stop();
      throw e;
    }
  }

  post(msg: WorkletInMessage): void {
    this.node?.port.postMessage(msg);
  }

  async resume(): Promise<void> {
    if (this.ctx && this.ctx.state !== 'running') await this.ctx.resume();
  }

  async stop(): Promise<void> {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.source?.disconnect();
    this.node?.disconnect();
    this.sink?.disconnect();
    if (this.node) this.node.port.onmessage = null;
    const ctx = this.ctx;
    this.stream = null;
    this.source = null;
    this.node = null;
    this.sink = null;
    this.ctx = null;
    if (ctx) {
      ctx.onstatechange = null;
      await ctx.close().catch(() => undefined);
    }
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

function toMicError(e: unknown): MicError {
  const name = e instanceof Error ? e.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new MicError(
        'denied',
        'Доступ к микрофону запрещён. Разрешите микрофон: в Telegram — Настройки телефона → Telegram → Микрофон (iOS) или Приложения → Telegram → Разрешения (Android); в браузере — значок замка в адресной строке. Затем нажмите «Старт» ещё раз.',
      );
    case 'NotFoundError':
    case 'OverconstrainedError':
      return new MicError('notfound', 'Микрофон не найден.');
    case 'NotReadableError':
    case 'AbortError':
      return new MicError('busy', 'Микрофон занят другим приложением или недоступен. Закройте другие приложения, использующие микрофон.');
    default:
      return new MicError('other', `Ошибка доступа к микрофону: ${errText(e)}`);
  }
}
