/**
 * Сценарий записи для отладки: пользователь играет ровно то, что сказано, поэтому правильный ответ
 * для каждого шага известен заранее. Шаги собраны по живым проблемам: одиночные ноты по диапазону,
 * повторы, неправильные ноты (сосед, октава, гармоника), игра поверх держащегося баса (отчёт
 * 2026-10-22), аккорды и «не удары» (стук, отпускание аккорда).
 */
export interface ScenarioStep {
  say: string;
  /** Подсказка мелким шрифтом. */
  sub?: string;
  /** Что проверяет анализатор. */
  expect: number[];
  /** Что просим сыграть; null — не играть ноты. */
  play: number[] | null;
  want: 'pass' | 'fail' | 'none';
  times?: number;
  /** Длительность фазы «Играйте», с. */
  sec?: number;
  /** Шаг калибровки тишины. */
  calibrate?: boolean;
}

const N: Record<string, number> = {};
for (const [i, n] of ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'].entries())
  for (let o = 1; o <= 7; o++) N[`${n}${o}`] = 12 * (o + 1) + i;

const name = (ms: number[]) => ms.map((m) => Object.keys(N).find((k) => N[k] === m)).join('+');
const pass = (notes: string[], extra: Partial<ScenarioStep> = {}): ScenarioStep => {
  const m = notes.map((x) => N[x]);
  return { say: `Сыграйте ${name(m)}`, expect: m, play: m, want: 'pass', ...extra };
};
/** Ждём одно, просим сыграть другое — правильный ответ «не засчитано». */
const wrong = (exp: string[], play: string[], sub: string, extra: Partial<ScenarioStep> = {}): ScenarioStep => ({
  say: `Сыграйте ${name(play.map((x) => N[x]))}`,
  sub: `нарочно не то: приложение ждёт ${name(exp.map((x) => N[x]))} (${sub})`,
  expect: exp.map((x) => N[x]),
  play: play.map((x) => N[x]),
  want: 'fail',
  ...extra,
});

export const SCENARIO: ScenarioStep[] = [
  { say: 'Тишина — не играйте', sub: 'настройка под шум комнаты', expect: [], play: null, want: 'none', calibrate: true, sec: 2.5 },

  // Одиночные ноты по диапазону
  ...['C3', 'G3', 'C4', 'E4', 'A4', 'C5', 'D#5', 'E5', 'G5', 'B5'].map((n) => pass([n])),
  pass(['C4'], { say: 'Сыграйте C4 три раза', times: 3, sec: 3.5 }),
  pass(['E5'], { say: 'Сыграйте E5 три раза', times: 3, sec: 3.5 }),

  // Неправильные ноты
  wrong(['C4'], ['D4'], 'соседняя нота'),
  wrong(['E5'], ['D#5'], 'на полтона ниже'),
  wrong(['C4'], ['C5'], 'октава выше'),
  wrong(['C5'], ['C4'], 'октава ниже'),
  wrong(['G4'], ['C3'], 'G4 — гармоника C3'),

  // Поверх держащегося баса (К Элизе)
  pass(['A3'], { say: 'Нажмите A3 и ДЕРЖИТЕ', sub: 'не отпускайте до команды' }),
  pass(['C4'], { sub: 'A3 держите' }),
  pass(['E4'], { sub: 'A3 держите' }),
  pass(['A4'], { sub: 'A3 держите (A4 — октава над басом)' }),
  wrong(['D4'], ['E4'], 'A3 держите'),
  { say: 'Отпустите A3', sub: 'ничего не играйте', expect: [N.D4], play: null, want: 'none' },
  pass(['E3'], { say: 'Нажмите E3 и ДЕРЖИТЕ', sub: 'не отпускайте до команды' }),
  pass(['E4'], { sub: 'E3 держите (E4 — октава над басом)' }),
  pass(['G#4'], { sub: 'E3 держите' }),
  pass(['B4'], { sub: 'E3 держите' }),
  { say: 'Отпустите E3', sub: 'ничего не играйте', expect: [N.E4], play: null, want: 'none' },

  // Аккорды
  pass(['C4', 'E4', 'G4']),
  wrong(['C4', 'E4', 'G4'], ['C4', 'E4'], 'без G4'),
  wrong(['C4', 'E4', 'G4'], ['C4', 'D#4', 'G4'], 'минор вместо мажора'),
  pass(['A3', 'A4']),
  pass(['E3', 'B4']),
  wrong(['C3', 'C4'], ['C3'], 'только нижняя'),
  pass(['C4', 'E4', 'G4'], { say: 'Нажмите C4+E4+G4 и держите', sub: 'отпускать — на следующем шаге' }),
  { say: 'Отпустите аккорд', sub: 'ничего не играйте', expect: [N.D4], play: null, want: 'none' },

  // Не удары
  { say: 'Постучите пальцем по корпусу пианино', sub: 'не по клавишам', expect: [N.C4], play: null, want: 'none' },
];
