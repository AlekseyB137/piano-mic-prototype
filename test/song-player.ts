/**
 * Тест логики режима ожидания (SongPlayer) — без аудио и DOM.
 * Запуск: npm run test:song
 */
import { SongPlayer } from '../src/song/player';
import { SONGS } from '../src/songs';
import type { Song } from '../src/song/types';

let pass = 0, fail = 0;
function expect(name: string, ok: boolean, detail = '') {
  ok ? pass++ : fail++;
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : '  — ' + detail}`);
}

const song: Song = {
  id: 't',
  title: 't',
  bpm: 60, // 1 доля = 1 с
  notes: [
    { pitch: 60, name: 'C4', start: 0, dur: 1, hand: 'R', finger: 1 },
    { pitch: 62, name: 'D4', start: 1, dur: 1, hand: 'R', finger: 2 },
    { pitch: 48, name: 'C3', start: 2, dur: 2, hand: 'L', finger: 5 },
    { pitch: 52, name: 'E3', start: 2, dur: 2, hand: 'L', finger: 3 },
  ],
};

{
  const p = new SongPlayer(song, 'wait', 2);
  expect('Шаги: одиночные ноты и аккорд сгруппированы', p.steps.length === 3 && p.steps[2].notes.length === 2);
  expect('Вступление: старт на −2 доли, ждём C4', p.beat === -2 && p.expected().join() === '60');
  p.advance(1.5);
  expect('Ноты едут, пока не дошли до линии', !p.waiting && Math.abs(p.beat + 0.5) < 1e-9, `beat=${p.beat}`);
  p.advance(5);
  expect('Время останавливается на несыгранной ноте', p.waiting && p.beat === 0, `beat=${p.beat}`);
  p.result(false);
  expect('Ошибка: остаёмся на той же ноте, ошибка посчитана', p.expected().join() === '60' && p.mistakes === 1 && p.waiting);
  p.result(true);
  expect('Засчитано: следующая нота D4, время снова идёт', p.expected().join() === '62' && !p.waiting && p.hits === 1);
  p.advance(0.4);
  p.result(true); // D4 сыграна заранее, ещё не долетев до линии
  expect('Ноту можно сыграть заранее — ждём аккорд', p.expected().join() === '48,52' && p.beat < 1);
  p.advance(10);
  expect('Аккорд ждёт на линии', p.waiting && p.beat === 2);
  p.result(true);
  expect('Песня закончена', p.finished && p.expected().length === 0);
  const t = p.elapsedSec;
  p.advance(1);
  expect('После конца время игры не растёт, ноты уезжают', p.elapsedSec === t && p.beat > 2);
  p.restart();
  expect('Сначала: всё сброшено', p.beat === -2 && p.hits === 0 && p.mistakes === 0 && p.expected().join() === '60');
}

// «В такт»: 60 bpm, вступление 2 доли → доля шага k (start=k) наступает в t0 + 2 + k с
{
  const p = new SongPlayer(song, 'tempo', 2, { earlySec: 0.18, lateSec: 0.18, latencySec: 0 });
  p.tick(100); // старт аудиочасов
  expect('В такт: первая доля через 2 с', p.stepTime(p.current!) === 102);
  p.tick(101.9);
  expect('В такт: время идёт', Math.abs(p.beat + 0.1) < 1e-9 && !p.waiting, `beat=${p.beat}`);
  expect('В такт: удар на 250 мс раньше — «рано», но нота принята', p.judge(true, 101.75, 101.8) === 'early' && p.expected().join() === '62' && p.earlies === 1 && p.hits === 0 && p.mistakes === 0);
  p.tick(103.1);
  expect('В такт: на экране нота не уходит за линию, пока не сыграна', p.displayBeat <= 1 + 1e-9 && p.beat > 1, `display=${p.displayBeat} beat=${p.beat}`);
  expect('В такт: удар в окно (+50 мс) — вовремя', p.judge(true, 103.05, 103.1) === 'hit' && p.expected().join() === '48,52' && p.hits === 1);
  expect('В такт: неправильная нота — ошибка, нота остаётся', p.judge(false, 103.9, 103.95) === 'wrong' && p.expected().join() === '48,52' && p.mistakes === 1);
  p.tick(104.5); // окно аккорда (доля 104) закрылось в 104.18
  expect('В такт: окно прошло — игра стоит и ждёт аккорд', p.waiting && p.expected().join() === '48,52' && Math.abs(p.beat - 2.18) < 1e-9, `beat=${p.beat}`);
  p.tick(106);
  expect('В такт: ждёт сколько угодно, позиция не двигается', p.waiting && Math.abs(p.beat - 2.18) < 1e-9);
  expect('В такт: на экране ожидаемый аккорд стоит на линии', Math.abs(p.displayBeat - 2) < 1e-9, `display=${p.displayBeat}`);
  expect('В такт: аккорд после остановки — «поздно», песня закончена', p.judge(true, 106.0, 106.1) === 'late' && p.lates === 1 && p.finished);
  p.tick(110);
  expect('В такт: время игры без пауз', Math.abs(p.elapsedSec - 2) < 1e-6, `elapsed=${p.elapsedSec}`);
  p.restart();
  expect('В такт: сначала — часы сброшены', p.stepTime(p.current!) === null && p.lates === 0 && p.earlies === 0 && !p.waiting);
}

// Поправка на задержку: удар через 120 мс после доли — ровно вовремя
{
  const p = new SongPlayer(song, 'tempo', 2, { earlySec: 0.18, lateSec: 0.18, latencySec: 0.12 });
  p.tick(100);
  expect('Задержка: удар +120 мс после доли — отклонение 0', p.judge(true, 102.12, 102.2) === 'hit' && Math.abs(p.lastOffsetSec ?? 1) < 1e-9);
  p.tick(103.25); // без поправки окно D4 закрылось бы в 103.18, с поправкой — в 103.30
  expect('Задержка: окно сдвинуто — в 103.25 ещё не ждём', !p.waiting);
  expect('Задержка: +250 мс после доли = +130 мс с поправкой — вовремя', p.judge(true, 103.25, 103.3) === 'hit');
  const q = new SongPlayer(song, 'tempo', 0, { earlySec: 0.18, lateSec: 0.18, latencySec: 0 });
  q.tick(0);
  [0.13, 1.12, 2.14].forEach((t, i) => q.judge(true, t, t + 0.05) && i);
  expect('Подсказка задержки: меньше 5 шагов — нет', q.suggestLatencyShift() === null);
}
{
  const notes = Array.from({ length: 8 }, (_, i) => ({ pitch: 60, name: 'C4', start: i, dur: 1, hand: 'R' as const, finger: 1 }));
  const q = new SongPlayer({ id: 'q', title: 'q', bpm: 60, notes }, 'tempo', 0, { earlySec: 0.18, lateSec: 0.18, latencySec: 0 });
  q.tick(0);
  [0.13, 1.12, 2.15, 3.1, 4.14, 5.13, 6.12, 7.6].forEach((t) => {
    q.tick(t);
    q.judge(true, t, t + 0.05);
  });
  const sh = q.suggestLatencyShift();
  expect('Подсказка задержки: медиана ≈ +130 мс (одно долгое ожидание не в счёт)', sh !== null && Math.abs(sh - 0.13) < 0.006, `shift=${sh}`);
}

{
  const notes = Array.from({ length: 10 }, (_, i) => ({ pitch: 60 + (i % 2) * 2, name: 'x', start: i, dur: 1, hand: 'R' as const, finger: 1 }));
  const p = new SongPlayer({ id: 'c', title: 'c', bpm: 90, notes }, 'tempo', 0, { earlySec: 0.18, lateSec: 0.18, latencySec: 0 });
  p.tick(0);
  // Человек опоздал на первую ноту на 0.3 с, дальше играет ровно в темп от своего удара
  const spb = 60 / 90;
  const js: string[] = [];
  for (let i = 0; i < 10; i++) {
    const t = 0.3 + i * spb;
    p.tick(t - 0.001);
    js.push(p.judge(true, t, t + 0.06));
    p.tick(t + 0.06);
  }
  expect('В такт: ровная игра после опоздания — «поздно» только один раз', js.filter((j) => j === 'late').length === 1 && js.slice(1).every((j) => j === 'hit'), js.join(' '));
}

for (const s of SONGS) {
  const bad = s.notes.filter((n) => !(n.finger >= 1 && n.finger <= 5) || !(n.dur > 0) || (n.hand !== 'L' && n.hand !== 'R'));
  const overlapsInStep = new SongPlayer(s).steps.some((st) => new Set(st.notes.map((n) => n.pitch)).size !== st.notes.length);
  expect(`Песня «${s.title}»: ${s.notes.length} нот, данные корректны`, bad.length === 0 && !overlapsInStep && s.bpm > 0);
}

console.log(`\nИтого: ${pass} ✓, ${fail} ✗`);
process.exit(fail ? 1 : 0);
