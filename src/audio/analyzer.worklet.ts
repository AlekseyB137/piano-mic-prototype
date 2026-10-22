/**
 * AudioWorkletProcessor — тонкая обёртка над Analyzer.
 * Работает в аудиопотоке (отдельно от UI), отправляет события через port.
 */
import { Analyzer } from './analyzer';
import type { AnalyzerEvent, WorkletInMessage } from './messages';

// Глобальные объекты AudioWorkletGlobalScope (в стандартных lib TypeScript их нет)
declare const sampleRate: number;
/** Время начала текущего блока по часам AudioContext. */
declare const currentTime: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}
declare function registerProcessor(name: string, ctor: new (options: { processorOptions?: { bigFft?: number } }) => AudioWorkletProcessor): void;

/** Звук для записи отправляем кусками по ~85 мс (48 кГц). */
const REC_BLOCK = 4096;

class PianoAnalyzerProcessor extends AudioWorkletProcessor {
  private readonly analyzer: Analyzer;
  private nextClockAt = 0;
  private rec: Float32Array | null = null;
  private recLen = 0;
  private recT0 = 0;

  constructor(options: { processorOptions?: { bigFft?: number } }) {
    super(options);
    this.analyzer = new Analyzer(sampleRate, { bigFft: options.processorOptions?.bigFft });
    this.port.onmessage = (e: MessageEvent<WorkletInMessage>) => this.onMessage(e.data);
    this.port.postMessage(this.analyzer.info());
  }

  private onMessage(msg: WorkletInMessage): void {
    // Во время записи каждое сообщение помечаем временем анализатора: оно применится перед следующим блоком
    if (this.rec && msg.type !== 'record') this.port.postMessage({ type: 'recControl', t: this.analyzer.time, msg } satisfies AnalyzerEvent);
    switch (msg.type) {
      case 'record':
        if (msg.on) {
          this.rec = new Float32Array(REC_BLOCK);
          this.recLen = 0;
        } else {
          this.flushRec();
          this.rec = null;
        }
        break;
      case 'params':
        this.analyzer.setParams(msg.params);
        break;
      case 'expected':
        this.analyzer.setExpected(msg.midis);
        break;
      case 'calibrate':
        this.analyzer.startCalibration(msg.seconds);
        break;
      case 'mute':
        this.analyzer.muteCheck(msg.seconds);
        break;
    }
  }

  process(inputs: Float32Array[][]): boolean {
    const ch = inputs[0]?.[0];
    if (ch && ch.length) {
      // Раз в 2 с — привязка часов анализатора к AudioContext.currentTime (для оценки ритма)
      if (this.analyzer.time >= this.nextClockAt) {
        this.port.postMessage({ type: 'clock', audioTime: currentTime, analyzerTime: this.analyzer.time } satisfies AnalyzerEvent);
        this.nextClockAt = this.analyzer.time + 2;
      }
      if (this.rec) {
        if (this.recLen === 0) this.recT0 = this.analyzer.time;
        for (let i = 0; i < ch.length; i++) {
          this.rec[this.recLen++] = ch[i];
          if (this.recLen === REC_BLOCK) {
            this.flushRec();
            if (i + 1 < ch.length) this.recT0 = this.analyzer.time + (i + 1) / sampleRate;
          }
        }
      }
      const events = this.analyzer.process(ch);
      for (const ev of events) this.send(ev);
    }
    return true; // держим процессор живым, даже если на входе тишина
  }

  private flushRec(): void {
    if (!this.rec || this.recLen === 0) return;
    const samples = this.rec.slice(0, this.recLen);
    this.port.postMessage({ type: 'recAudio', t0: this.recT0, samples } satisfies AnalyzerEvent, [samples.buffer]);
    this.recLen = 0;
  }

  private send(ev: AnalyzerEvent): void {
    if (ev.type === 'frame') this.port.postMessage(ev, [ev.spectrum.buffer as ArrayBuffer]);
    else this.port.postMessage(ev);
  }
}

registerProcessor('piano-analyzer', PianoAnalyzerProcessor);
