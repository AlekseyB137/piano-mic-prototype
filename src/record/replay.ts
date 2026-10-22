/**
 * Воспроизведение записи через анализатор (без DOM, без аудио-API) и сверка с правильными ответами
 * сценария. Управляющие сообщения применяются в те же моменты времени анализатора, что и вживую,
 * поэтому при тех же порогах результат совпадает с живым — и можно менять пороги и код и сразу
 * видеть, что стало с каждым шагом.
 */
import { Analyzer } from '../audio/analyzer';
import type { AnalyzerEvent, CheckEvent, DroppedEvent } from '../audio/messages';
import type { AnalyzerParams } from '../audio/params';
import type { RecordingMeta, StepLabel } from './wav';

/** После конца шага ещё столько секунд событий относим к нему (вердикт приходит с задержкой). */
const STEP_TAIL_SEC = 0.4;

export interface StepResult {
  step: StepLabel;
  checks: CheckEvent[];
  dropped: DroppedEvent[];
  ok: boolean;
  /** Коротко: что получилось. */
  got: string;
}

/** Прогнать звук через анализатор. Времена событий — в часах живой записи (t0 + …). */
export function replay(samples: Float32Array, meta: RecordingMeta, params?: Partial<AnalyzerParams>): AnalyzerEvent[] {
  const a = new Analyzer(meta.sampleRate, { bigFft: meta.bigFft });
  a.setParams({ ...meta.params, ...params });
  const controls = [...meta.controls].sort((x, y) => x.t - y.t);
  let ci = 0;
  const out: AnalyzerEvent[] = [];
  const shift = (ev: AnalyzerEvent): AnalyzerEvent => {
    const e = { ...ev } as AnalyzerEvent & { t?: number; onsetTime?: number; decidedAt?: number };
    if (typeof e.t === 'number') e.t += meta.t0;
    if (typeof e.onsetTime === 'number') e.onsetTime += meta.t0;
    if (typeof e.decidedAt === 'number') e.decidedAt += meta.t0;
    return e;
  };
  for (let i = 0; i < samples.length; i += 128) {
    const now = meta.t0 + i / meta.sampleRate;
    while (ci < controls.length && controls[ci].t <= now + 1e-9) {
      const m = controls[ci++].msg;
      if (m.type === 'params') a.setParams({ ...m.params, ...params });
      else if (m.type === 'expected') a.setExpected(m.midis);
      else if (m.type === 'calibrate') a.startCalibration(m.seconds);
      else if (m.type === 'mute') a.muteCheck(m.seconds);
    }
    for (const ev of a.process(samples.subarray(i, i + 128))) if (ev.type !== 'frame') out.push(shift(ev));
  }
  return out;
}

/** Сверить события с правильными ответами шагов. */
export function grade(events: readonly unknown[], steps: StepLabel[]): StepResult[] {
  const checks = events.filter((e): e is CheckEvent => (e as AnalyzerEvent).type === 'check');
  const dropped = events.filter((e): e is DroppedEvent => (e as AnalyzerEvent).type === 'dropped');
  return steps.map((step, i) => {
    const end = Math.max(step.tEnd, step.tStart) + STEP_TAIL_SEC;
    // Следующий шаг начинается раньше «хвоста» — делим по его началу, чтобы событие не попало в два шага
    const until = Math.min(end, steps[i + 1]?.tStart ?? Infinity);
    const inStep = (t: number) => t >= step.tStart && t < until;
    const cs = checks.filter((c) => inStep(c.onsetTime));
    const ds = dropped.filter((d) => inStep(d.t));
    const passes = cs.filter((c) => c.allPassed).length;
    const fails = cs.length - passes;
    let ok: boolean;
    if (step.want === 'pass') ok = passes >= step.times;
    else if (step.want === 'fail') ok = fails >= 1 && passes === 0;
    else ok = cs.length === 0;
    const got = cs.length === 0 ? 'нет вердикта' : `✓${passes} ✗${fails}`;
    return { step, checks: cs, dropped: ds, ok, got };
  });
}
