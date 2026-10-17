import type { AnalyzerParams } from './params';
import type { NoteEvidence } from './chord-check';
import type { CheckResult } from './check-session';

/** Сообщения main → worklet */
export type WorkletInMessage =
  | { type: 'params'; params: Partial<AnalyzerParams> }
  | { type: 'expected'; midis: number[] }
  | { type: 'calibrate'; seconds: number };

export interface PitchInfo {
  freq: number;
  midi: number;
  cents: number;
  clarity: number;
}

export interface InfoEvent {
  type: 'info';
  sampleRate: number;
  hop: number;
  smallFft: number;
  bigFft: number;
}

export interface FrameEvent {
  type: 'frame';
  t: number;
  rmsDb: number;
  gateOpen: boolean;
  flux: number;
  fluxThreshold: number;
  pitch: PitchInfo | null;
  stableMidi: number | null;
  /** Превью спектра: PREVIEW_BANDS полос, дБFS. */
  spectrum: Float32Array;
  noiseRmsDb: number;
  calibrated: boolean;
  /** Живая оценка ожидаемых нот (только в режиме проверки). */
  live: NoteEvidence[] | null;
  checking: boolean;
  /** Время обработки (мс на секунду звука), если доступен performance.now. */
  loadMsPerSec: number | null;
}

export interface OnsetEvent {
  type: 'onset';
  t: number;
  flux: number;
  threshold: number;
}

export interface NoteEvent {
  type: 'note';
  t: number;
  pitch: PitchInfo;
  /** Нота зафиксирована сразу после атаки (новый удар), а не сменой высоты. */
  afterOnset: boolean;
}

export interface CheckEvent extends CheckResult {
  type: 'check';
}

export interface CalibratedEvent {
  type: 'calibrated';
  rmsDb: number;
  fluxMean: number;
  fluxStd: number;
  onsetDelta: number;
  noisePreview: Float32Array;
}

export type AnalyzerEvent = InfoEvent | FrameEvent | OnsetEvent | NoteEvent | CheckEvent | CalibratedEvent;
