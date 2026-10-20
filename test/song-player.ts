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
  const p = new SongPlayer(song, 'tempo', 2);
  p.tick(100); // старт аудиочасов
  expect('В такт: первая доля через 2 с', p.stepTime(p.current!) === 102);
  p.tick(101.9);
  expect('В такт: время идёт без остановки', Math.abs(p.beat + 0.1) < 1e-9 && !p.waiting, `beat=${p.beat}`);
  expect('В такт: удар на 250 мс раньше — «рано», нота остаётся', p.judge(true, 101.75) === 'early' && p.expected().join() === '60' && p.mistakes === 1);
  expect('В такт: удар в окно (+50 мс) — засчитан', p.judge(true, 102.05) === 'hit' && p.expected().join() === '62' && Math.abs((p.lastOffsetSec ?? 0) - 0.05) < 1e-9);
  expect('В такт: неправильная нота — ошибка, нота остаётся', p.judge(false, 103.0) === 'wrong' && p.expected().join() === '62');
  expect('В такт: пока идёт разбор удара, пропуск не ставится', p.tick(103.25, true).length === 0 && p.expected().join() === '62');
  const missed = p.tick(103.25); // окно D4 (доля 103) закрылось в 103.18
  expect('В такт: окно прошло — нота пропущена, ждём аккорд', missed.length === 1 && missed[0].state === 'missed' && p.misses === 1 && p.expected().join() === '48,52');
  expect('В такт: аккорд вовремя (−100 мс)', p.judge(true, 103.9) === 'hit' && p.finished);
  p.tick(110);
  expect('В такт: итог — 2 попадания, 1 пропуск, время до последнего удара 1.9 с', p.hits === 2 && p.misses === 1 && Math.abs(p.elapsedSec - 1.9) < 1e-6, `elapsed=${p.elapsedSec}`);
  p.restart();
  expect('В такт: сначала — часы сброшены', p.stepTime(p.current!) === null && p.misses === 0);
}

for (const s of SONGS) {
  const bad = s.notes.filter((n) => !(n.finger >= 1 && n.finger <= 5) || !(n.dur > 0) || (n.hand !== 'L' && n.hand !== 'R'));
  const overlapsInStep = new SongPlayer(s).steps.some((st) => new Set(st.notes.map((n) => n.pitch)).size !== st.notes.length);
  expect(`Песня «${s.title}»: ${s.notes.length} нот, данные корректны`, bad.length === 0 && !overlapsInStep && s.bpm > 0);
}

console.log(`\nИтого: ${pass} ✓, ${fail} ✗`);
process.exit(fail ? 1 : 0);
