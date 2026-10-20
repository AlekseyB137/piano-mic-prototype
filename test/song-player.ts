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
  const p = new SongPlayer(song, 2);
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

for (const s of SONGS) {
  const bad = s.notes.filter((n) => !(n.finger >= 1 && n.finger <= 5) || !(n.dur > 0) || (n.hand !== 'L' && n.hand !== 'R'));
  const overlapsInStep = new SongPlayer(s).steps.some((st) => new Set(st.notes.map((n) => n.pitch)).size !== st.notes.length);
  expect(`Песня «${s.title}»: ${s.notes.length} нот, данные корректны`, bad.length === 0 && !overlapsInStep && s.bpm > 0);
}

console.log(`\nИтого: ${pass} ✓, ${fail} ✗`);
process.exit(fail ? 1 : 0);
