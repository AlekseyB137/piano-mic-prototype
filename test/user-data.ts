/**
 * Тест синхронизации данных пользователя между устройствами (src/storage/user-data.ts).
 * Запуск: npm run test:sync. Облако — в памяти, с лимитами Telegram CloudStorage (нарушение = ошибка).
 */
import { KV_LIMITS, type KV } from '../src/storage/kv';
import { packSong, UserData, type LocalStore } from '../src/storage/user-data';
import type { Song } from '../src/song/types';

let pass = 0, fail = 0;
function expect(name: string, ok: boolean, detail = '') {
  ok ? pass++ : fail++;
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : '  — ' + detail}`);
}

class MemoryKV implements KV {
  data = new Map<string, string>();
  async get(keys: string[]) {
    const o: Record<string, string> = {};
    for (const k of keys) if (this.data.has(k)) o[k] = this.data.get(k)!;
    return o;
  }
  async set(k: string, v: string) {
    if (!KV_LIMITS.keyPattern.test(k)) throw new Error(`недопустимый ключ ${k}`);
    if (v.length > KV_LIMITS.valueChars) throw new Error(`значение ${k} длиннее ${KV_LIMITS.valueChars}: ${v.length}`);
    if (!this.data.has(k) && this.data.size >= KV_LIMITS.keys) throw new Error('KEYS_TOO_MANY');
    this.data.set(k, v);
  }
  async remove(keys: string[]) {
    for (const k of keys) this.data.delete(k);
  }
  async keys() {
    return [...this.data.keys()];
  }
}
class MemoryLocal implements LocalStore {
  m = new Map<string, string>();
  get(k: string) {
    return this.m.get(k) ?? null;
  }
  set(k: string, v: string) {
    this.m.set(k, v);
  }
}

const defaults = { tempo: 1, playMode: 'tempo' as const, songId: 'twinkle' };
const song = (id: string, n: number): Song => ({
  id,
  title: `Песня ${id}`,
  bpm: 90,
  order: 1000,
  notes: Array.from({ length: n }, (_, i) => ({ pitch: 48 + (i % 36), name: '', start: i * 0.5, dur: 0.5, hand: i % 3 ? 'R' : 'L', finger: (i % 5) + 1 })),
});
const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const named = (s: Song): Song => ({ ...s, notes: s.notes.map((n) => ({ ...n, name: `${names[n.pitch % 12]}${Math.floor(n.pitch / 12) - 1}` })) });
const same = (a: Song, b: Song) => packSong(a) === packSong(b);

let clock = 1000;
const now = () => ++clock;
const cloud = new MemoryKV();
const devA = () => new UserData(localA, cloud, defaults, now);
const devB = () => new UserData(localB, cloud, defaults, now);
const localA = new MemoryLocal();
const localB = new MemoryLocal();

// 1. Мелодия с устройства A появляется на B
{
  const A = devA();
  const r = await A.addSong(named(song('user-a1', 66)));
  const B = devB();
  await B.sync();
  expect('Добавил на A — появилась на B (ноты совпали)', r.cloud && B.songs.length === 1 && same(B.songs[0], named(song('user-a1', 66))), JSON.stringify(r));
}

// 2. Большая мелодия (5000 нот) режется на куски ≤ 4096 и собирается без потерь
{
  const A = devA();
  const big = named(song('user-big', 5000));
  const r = await A.addSong(big);
  const B = devB();
  await B.sync();
  const got = B.songs.find((s) => s.id === 'user-big');
  const chunks = [...cloud.data.keys()].filter((k) => k.startsWith('v1_s_user-big_')).length;
  expect(`5000 нот: в облаке кусками (${chunks} ключей), на B — без потерь`, r.cloud && !!got && same(got, big) && chunks > 2, JSON.stringify(r));
}

// 3. Удаление на B доходит до A, и A не «воскрешает» мелодию из своей локальной копии
{
  const B = devB();
  await B.deleteSong('user-a1');
  const A = devA(); // A ещё держит её локально
  expect('До сверки A держит удалённую мелодию локально', A.songs.some((s) => s.id === 'user-a1'));
  await A.sync();
  const B2 = devB();
  await B2.sync();
  expect('Удалил на B — исчезла на A и не вернулась в облако', !A.songs.some((s) => s.id === 'user-a1') && !B2.songs.some((s) => s.id === 'user-a1') && ![...cloud.data.keys()].some((k) => k.startsWith('v1_s_user-a1_')));
}

// 4. Лучшие результаты: побеждает лучший, независимо от порядка
{
  const A = devA();
  const B = devB();
  A.setBest('twinkle:tempo', { mistakes: 2, seconds: 40, hits: 30, total: 42 });
  B.setBest('twinkle:tempo', { mistakes: 5, seconds: 45, hits: 35, total: 42 });
  B.setBest('ode:wait', { mistakes: 1, seconds: 30 });
  await A.flush();
  await B.flush();
  await A.sync();
  await B.sync();
  expect('Лучший результат объединён: 35 вовремя на обоих', A.best['twinkle:tempo']?.hits === 35 && B.best['twinkle:tempo']?.hits === 35, JSON.stringify([A.best, B.best]));
  expect('Результат с B («Ожидание») появился на A', A.best['ode:wait']?.mistakes === 1);
}

// 5. Настройки: побеждает более позднее изменение
{
  const A = devA();
  const B = devB();
  A.setPrefs({ tempo: 0.5 });
  B.setPrefs({ tempo: 0.75, playMode: 'wait' }); // позже
  await A.flush();
  await B.flush();
  await A.sync();
  expect('Настройки: на A — более поздние с B (75%, Ожидание)', A.prefs.tempo === 0.75 && A.prefs.playMode === 'wait', JSON.stringify(A.prefs));
}

// 6. Облако заполнено — мелодия остаётся на устройстве; когда место есть — уезжает при сверке
{
  const keysNow = cloud.data.size;
  for (let i = 0; cloud.data.size < KV_LIMITS.keys - 10; i++) await cloud.set(`junk_${i}`, 'x');
  const A = devA();
  const r = await A.addSong(named(song('user-full', 3000)));
  expect('Облако полно — сохранено только на устройстве, с предупреждением', !r.cloud && !!r.warning && A.localOnly.has('user-full'), JSON.stringify(r));
  for (const k of [...cloud.data.keys()].filter((k) => k.startsWith('junk_'))) cloud.data.delete(k);
  await A.sync();
  const B = devB();
  await B.sync();
  expect('Место освободилось — при сверке мелодия уехала в облако и появилась на B', !A.localOnly.has('user-full') && B.songs.some((s) => s.id === 'user-full'), `keys ${keysNow}`);
}

// 7. Старые локальные мелодии (до синхронизации) при первой сверке уезжают в облако
{
  const cloud2 = new MemoryKV();
  const oldLocal = new MemoryLocal();
  oldLocal.set('pianoMic.userSongs', JSON.stringify([named(song('user-old', 40))]));
  const A = new UserData(oldLocal, cloud2, defaults, now);
  await A.sync();
  const B = new UserData(new MemoryLocal(), cloud2, defaults, now);
  await B.sync();
  expect('Мелодии, загруженные до синхронизации, переехали в облако', B.songs.some((s) => s.id === 'user-old'));
}

// 8. Вне Telegram (облака нет) — всё работает локально, без ошибок
{
  const A = new UserData(new MemoryLocal(), null, defaults, now);
  const r = await A.addSong(named(song('user-x', 10)));
  await A.sync();
  A.setBest('x:tempo', { mistakes: 0, seconds: 10, hits: 10, total: 10 });
  A.setPrefs({ tempo: 0.5 });
  expect('Без облака: локально, без ошибок', !r.cloud && A.songs.length === 1 && A.syncError === '');
}

console.log(`\nИтого: ${pass} ✓, ${fail} ✗`);
process.exit(fail ? 1 : 0);
