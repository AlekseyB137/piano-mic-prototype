import type { AnalyzerParams } from './params';
import type { NoteEvidence } from './chord-check';
import type { CheckResult } from './check-session';

/** Сообщения main → worklet */
export type WorkletInMessage =
  | { type: 'params'; params: Partial<AnalyzerParams> }
  | { type: 'expected'; midis: number[] }
  | { type: 'calibrate'; seconds: number }
  /** Касание экрана: столько секунд атаки не открывают проверку (стук пальца по телефону). */
  | { type: 'mute'; seconds: number };

export interface PitchInfo {
  freq: number;
  midi: number;
  cents: number;
  clarity: number;
  /** 'spectrum' — нота найдена по росту партиалов (YIN не справился), частота и центы приблизительны. */
  source?: 'yin' | 'spectrum';
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
  /** Сколько атак отброшено как «не фортепиано» (голос, стук, шум). */
  ignoredAttacks: number;
  /** Время обработки (мс на секунду звука), если доступен performance.now. */
  loadMsPerSec: number | null;
}

export interface OnsetEvent {
  type: 'onset';
  t: number;
  flux: number;
  threshold: number;
  /** Уровень сигнала в момент атаки, дБFS. */
  rmsDb: number;
}

export interface AttackInfo {
  flux: number;
  rmsDb: number;
  /** Подъём энергии в полосе 2–6 кГц при атаке, дБ: у удара молоточка большой, у отпускания клавиш — нет. */
  hfRiseDb: number;
}

/** Подтверждённая нота: удар + устойчивая высота в строе. */
export interface NoteEvent {
  type: 'note';
  t: number;
  pitch: PitchInfo;
  attack: AttackInfo;
}

/** Атака, не ставшая нотой — для диагностики (в отчёт, не в видимый лог). */
export interface DroppedEvent {
  type: 'dropped';
  t: number;
  reason: string;
  attack: AttackInfo;
  /** Что видел детектор высоты после удара, по кадрам: «B5+14», «·» — нет высоты. */
  seen: string;
}

export interface CheckEvent extends CheckResult {
  type: 'check';
  attack: AttackInfo;
}

export interface CalibratedEvent {
  type: 'calibrated';
  rmsDb: number;
  fluxMean: number;
  fluxStd: number;
  onsetDelta: number;
  noisePreview: Float32Array;
}

/** Открыто окно проверки (похоже на удар): UI сбрасывает прошлый результат и ждёт вердикта. */
export interface CheckStartEvent {
  type: 'checkStart';
  t: number;
}

export type AnalyzerEvent = InfoEvent | FrameEvent | OnsetEvent | NoteEvent | CheckEvent | CalibratedEvent | DroppedEvent | CheckStartEvent;
