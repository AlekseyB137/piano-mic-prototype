/** Все настраиваемые пороги анализатора. Значения по умолчанию — стартовая точка для экспериментов. */
export interface AnalyzerParams {
  /** На сколько дБ RMS должен превышать фон, чтобы вообще анализировать сигнал. */
  gateDb: number;
  /** Порог YIN (меньше — строже). */
  yinThreshold: number;
  /** Минимальная уверенность высоты для показа ноты в свободном режиме. */
  minClarity: number;
  /** Атака: множитель медианы потока. */
  onsetMultiplier: number;
  /** Атака: абсолютный порог потока (обновляется калибровкой). */
  onsetDelta: number;
  /** Атака: минимальный интервал между ударами, мс. */
  onsetMinIntervalMs: number;
  /** Проверка: гармоника должна быть выше шума на столько дБ. */
  snrDb: number;
  /** Проверка: допуск частоты пика, центы (больше — для расстроенного пианино). */
  toleranceCents: number;
  /** Проверка: минимум «собственных» гармоник выше порога. */
  minHarmonics: number;
  /** Проверка: рост гармоники относительно спектра до удара, дБ (0 — выключено). */
  riseDb: number;
  /** Проверка: запас для защиты от ноты на октаву ниже, дБ. */
  octaveMarginDb: number;
  /** Проверка: длительность окна оценки после атаки, мс. */
  checkWindowMs: number;
  /** Проверка: сколько кадров подряд нота должна проходить проверку. */
  checkMinHits: number;
}

export const DEFAULT_PARAMS: AnalyzerParams = {
  gateDb: 12,
  yinThreshold: 0.15,
  minClarity: 0.8,
  onsetMultiplier: 1.5,
  onsetDelta: 0.03,
  onsetMinIntervalMs: 70,
  snrDb: 15,
  toleranceCents: 40,
  minHarmonics: 2,
  riseDb: 3,
  octaveMarginDb: 6,
  checkWindowMs: 350,
  checkMinHits: 2,
};
