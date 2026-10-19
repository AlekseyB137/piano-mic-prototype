/**
 * AudioWorkletProcessor — тонкая обёртка над Analyzer.
 * Работает в аудиопотоке (отдельно от UI), отправляет события через port.
 */
import { Analyzer } from './analyzer';
import type { AnalyzerEvent, WorkletInMessage } from './messages';

// Глобальные объекты AudioWorkletGlobalScope (в стандартных lib TypeScript их нет)
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}
declare function registerProcessor(name: string, ctor: new (options: { processorOptions?: { bigFft?: number } }) => AudioWorkletProcessor): void;

class PianoAnalyzerProcessor extends AudioWorkletProcessor {
  private readonly analyzer: Analyzer;

  constructor(options: { processorOptions?: { bigFft?: number } }) {
    super(options);
    this.analyzer = new Analyzer(sampleRate, { bigFft: options.processorOptions?.bigFft });
    this.port.onmessage = (e: MessageEvent<WorkletInMessage>) => this.onMessage(e.data);
    this.port.postMessage(this.analyzer.info());
  }

  private onMessage(msg: WorkletInMessage): void {
    switch (msg.type) {
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
      const events = this.analyzer.process(ch);
      for (const ev of events) this.send(ev);
    }
    return true; // держим процессор живым, даже если на входе тишина
  }

  private send(ev: AnalyzerEvent): void {
    if (ev.type === 'frame') this.port.postMessage(ev, [ev.spectrum.buffer as ArrayBuffer]);
    else this.port.postMessage(ev);
  }
}

registerProcessor('piano-analyzer', PianoAnalyzerProcessor);
