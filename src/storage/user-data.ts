/**
 * Данные пользователя, общие для всех его устройств: свои мелодии, лучшие результаты, настройки
 * (темп, режим, последняя мелодия). Локальная копия (localStorage) — для мгновенного старта и работы
 * без сети; облако (Telegram CloudStorage) — источник правды для синхронизации.
 *
 * НЕ синхронизируются (зависят от устройства): поправка ритма, пороги распознавания, калибровка шума —
 * их хранит main.ts отдельно.
 *
 * Правила слияния:
 *  - мелодии: объединение по id; удаление помечается в облачном индексе (deleted), чтобы другое устройство
 *    не «воскресило» мелодию из своей локальной копии;
 *  - лучшие результаты: по каждому ключу побеждает лучший (коммутативно, порядок синхронизации не важен);
 *  - настройки: побеждает более позднее изменение (updatedAt).
 *  - лимиты Telegram: значение ≤ 4096 символов (мелодии и большие записи режутся на куски), ≤ 1024 ключа;
 *    если места нет — мелодия остаётся только на устройстве (localOnly) с предупреждением.
 */
import type { Song } from '../song/types';
import { KV_LIMITS, type KV } from './kv';

export interface BestResult {
  mistakes: number;
  seconds: number;
  hits?: number;
  total?: number;
}

export interface Prefs {
  tempo: number;
  playMode: 'wait' | 'tempo';
  songId: string;
  updatedAt: number;
}

export interface LocalStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

const L = {
  songs: 'pianoMic.userSongs',
  best: 'pianoMic.best',
  prefs: 'pianoMic.prefs',
  deleted: 'pianoMic.deleted',
  localOnly: 'pianoMic.localOnly',
};
const C = { index: 'v1_index', best: 'v1_best', prefs: 'v1_prefs', song: (id: string) => `v1_s_${id}` };
/** Кусок значения (с запасом до 4096). */
const CHUNK = 4000;
/** Сколько ключей оставляем в запасе (индекс, результаты, настройки и их рост). */
const KEY_RESERVE = 16;
/** Сколько последних удалений помнить в индексе. */
const MAX_TOMBSTONES = 200;

interface CloudIndex {
  songs: string[];
  deleted: string[];
}

/** Компактная запись мелодии: ноты кортежами [высота, начало, длительность, рука 0/1, палец]. */
interface Packed {
  i: string;
  t: string;
  b: number;
  n: [number, number, number, 0 | 1, number][];
}

export function packSong(s: Song): string {
  const p: Packed = { i: s.id, t: s.title, b: s.bpm, n: s.notes.map((n) => [n.pitch, n.start, n.dur, n.hand === 'L' ? 1 : 0, n.finger]) };
  return JSON.stringify(p);
}

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export function unpackSong(text: string): Song {
  const p = JSON.parse(text) as Packed;
  return {
    id: p.i,
    title: p.t,
    bpm: p.b,
    order: 1000,
    notes: p.n.map(([pitch, start, dur, h, finger]) => ({
      pitch,
      name: `${NAMES[pitch % 12]}${Math.floor(pitch / 12) - 1}`,
      start,
      dur,
      hand: h ? 'L' : 'R',
      finger,
    })),
  };
}

/** Лучше ли результат a, чем b: больше «вовремя», затем меньше ошибок, затем быстрее. */
export function isBetter(a: BestResult, b: BestResult): boolean {
  if (a.hits !== undefined || b.hits !== undefined) {
    if ((a.hits ?? 0) !== (b.hits ?? 0)) return (a.hits ?? 0) > (b.hits ?? 0);
  }
  if (a.mistakes !== b.mistakes) return a.mistakes < b.mistakes;
  return a.seconds < b.seconds;
}

function mergeBest(x: Record<string, BestResult>, y: Record<string, BestResult>): Record<string, BestResult> {
  const out = { ...x };
  for (const [k, v] of Object.entries(y)) if (!out[k] || isBetter(v, out[k])) out[k] = v;
  return out;
}

/* ---------- значения больше 4096 символов: куски name_0..name_{n-1} + счётчик name_n ---------- */

const chunkKeys = (name: string, n: number) => Array.from({ length: n }, (_, i) => `${name}_${i}`);

async function readBlob(kv: KV, name: string): Promise<string | null> {
  const head = await kv.get([`${name}_n`]);
  const n = Number(head[`${name}_n`]);
  if (!(n > 0)) return null;
  const parts = await kv.get(chunkKeys(name, n));
  const keys = chunkKeys(name, n);
  if (keys.some((k) => parts[k] === undefined)) return null; // запись не дописана
  return keys.map((k) => parts[k]).join('');
}

/** Куски пишутся до счётчика: прерванная запись не оставит «полуживого» значения. */
async function writeBlob(kv: KV, name: string, text: string): Promise<void> {
  const n = Math.max(1, Math.ceil(text.length / CHUNK));
  const old = Number((await kv.get([`${name}_n`]))[`${name}_n`]) || 0;
  for (let i = 0; i < n; i++) await kv.set(`${name}_${i}`, text.slice(i * CHUNK, (i + 1) * CHUNK));
  await kv.set(`${name}_n`, String(n));
  if (old > n) await kv.remove(chunkKeys(name, old).slice(n));
}

async function removeBlob(kv: KV, name: string): Promise<void> {
  const n = Number((await kv.get([`${name}_n`]))[`${name}_n`]) || 0;
  await kv.remove([`${name}_n`, ...chunkKeys(name, n)]);
}

const blobKeyCount = (text: string) => Math.max(1, Math.ceil(text.length / CHUNK)) + 1;

export interface AddResult {
  /** Мелодия сохранена в облако (доступна на других устройствах). */
  cloud: boolean;
  warning?: string;
}

export class UserData {
  songs: Song[] = [];
  best: Record<string, BestResult> = {};
  prefs: Prefs;
  /** Мелодии, которые не поместились в облако и есть только на этом устройстве. */
  localOnly = new Set<string>();
  /** Последняя ошибка синхронизации (для отображения), пусто — всё хорошо. */
  syncError = '';
  onChange: () => void = () => {};
  private deleted = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly local: LocalStore,
    readonly cloud: KV | null,
    defaults: Omit<Prefs, 'updatedAt'>,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.prefs = { ...defaults, updatedAt: 0 };
    this.loadLocal();
  }

  private json<T>(key: string, fallback: T): T {
    try {
      const v = this.local.get(key);
      return v ? (JSON.parse(v) as T) : fallback;
    } catch {
      return fallback;
    }
  }

  private loadLocal(): void {
    const songs = this.json<Song[]>(L.songs, []);
    this.songs = Array.isArray(songs) ? songs.filter((s) => s && Array.isArray(s.notes)) : [];
    this.best = this.json<Record<string, BestResult>>(L.best, {});
    this.prefs = { ...this.prefs, ...this.json<Partial<Prefs>>(L.prefs, {}) };
    this.deleted = new Set(this.json<string[]>(L.deleted, []));
    this.localOnly = new Set(this.json<string[]>(L.localOnly, []));
  }

  /** Сохранить локально. false — не хватило места в localStorage. */
  private saveLocal(): boolean {
    try {
      this.local.set(L.songs, JSON.stringify(this.songs));
      this.local.set(L.best, JSON.stringify(this.best));
      this.local.set(L.prefs, JSON.stringify(this.prefs));
      this.local.set(L.deleted, JSON.stringify([...this.deleted].slice(-MAX_TOMBSTONES)));
      this.local.set(L.localOnly, JSON.stringify([...this.localOnly]));
      return true;
    } catch {
      return false;
    }
  }

  /** Облачные операции — строго по очереди (CloudStorage не транзакционен). */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async readIndex(kv: KV): Promise<CloudIndex> {
    const t = await readBlob(kv, C.index);
    const idx = t ? (JSON.parse(t) as CloudIndex) : { songs: [], deleted: [] };
    return { songs: idx.songs ?? [], deleted: idx.deleted ?? [] };
  }

  private writeIndex(kv: KV, idx: CloudIndex): Promise<void> {
    return writeBlob(kv, C.index, JSON.stringify({ songs: idx.songs, deleted: idx.deleted.slice(-MAX_TOMBSTONES) }));
  }

  /** Есть ли в облаке место ещё на needKeys ключей. */
  private async hasRoom(kv: KV, needKeys: number): Promise<boolean> {
    return (await kv.keys()).length + needKeys <= KV_LIMITS.keys - KEY_RESERVE;
  }

  /** Полная сверка с облаком (при запуске и по запросу). */
  sync(): Promise<void> {
    const kv = this.cloud;
    if (!kv) return Promise.resolve();
    return this.enqueue(async () => {
      try {
        const idx = await this.readIndex(kv);
        for (const id of idx.deleted) this.deleted.add(id);
        const before = this.songs.length;
        this.songs = this.songs.filter((s) => !this.deleted.has(s.id));
        let changed = this.songs.length !== before;

        // Скачать мелодии, которых здесь нет
        const have = new Set(this.songs.map((s) => s.id));
        for (const id of idx.songs) {
          if (have.has(id) || this.deleted.has(id)) continue;
          const t = await readBlob(kv, C.song(id));
          if (t) {
            this.songs.push(unpackSong(t));
            changed = true;
          }
        }
        // Загрузить в облако местные, которых там нет
        const inCloud = new Set(idx.songs);
        let indexChanged = idx.deleted.some((id) => !this.deleted.has(id)) || [...this.deleted].some((id) => !idx.deleted.includes(id));
        for (const s of this.songs) {
          if (inCloud.has(s.id)) {
            this.localOnly.delete(s.id);
            continue;
          }
          const text = packSong(s);
          if (await this.hasRoom(kv, blobKeyCount(text))) {
            await writeBlob(kv, C.song(s.id), text);
            idx.songs.push(s.id);
            this.localOnly.delete(s.id);
            indexChanged = true;
          } else this.localOnly.add(s.id);
        }
        idx.songs = idx.songs.filter((id) => !this.deleted.has(id));
        idx.deleted = [...new Set([...idx.deleted, ...this.deleted])];
        if (indexChanged) await this.writeIndex(kv, idx);

        // Лучшие результаты: лучший побеждает
        const cb = await readBlob(kv, C.best);
        const cloudBest = cb ? (JSON.parse(cb) as Record<string, BestResult>) : {};
        const merged = mergeBest(cloudBest, this.best);
        if (JSON.stringify(merged) !== JSON.stringify(cloudBest)) await writeBlob(kv, C.best, JSON.stringify(merged));
        if (JSON.stringify(merged) !== JSON.stringify(this.best)) changed = true;
        this.best = merged;

        // Настройки: побеждает более позднее изменение
        const cp = await readBlob(kv, C.prefs);
        const cloudPrefs = cp ? (JSON.parse(cp) as Prefs) : null;
        if (cloudPrefs && cloudPrefs.updatedAt > this.prefs.updatedAt) {
          this.prefs = { ...this.prefs, ...cloudPrefs };
          changed = true;
        } else if (!cloudPrefs || cloudPrefs.updatedAt < this.prefs.updatedAt) {
          if (this.prefs.updatedAt > 0) await writeBlob(kv, C.prefs, JSON.stringify(this.prefs));
        }

        this.syncError = '';
        this.saveLocal();
        if (changed) this.onChange();
      } catch (e) {
        this.syncError = e instanceof Error ? e.message : String(e);
      }
    });
  }

  /** Добавить (или заменить) свою мелодию. */
  async addSong(song: Song): Promise<AddResult> {
    this.deleted.delete(song.id);
    this.songs = [...this.songs.filter((s) => s.id !== song.id), song];
    const localOk = this.saveLocal();
    const kv = this.cloud;
    const localWarn = localOk ? undefined : 'на телефоне не хватило места — мелодия доступна до закрытия приложения';
    if (!kv) return { cloud: false, warning: localWarn };
    return this.enqueue(async () => {
      try {
        const text = packSong(song);
        const idx = await this.readIndex(kv);
        const exists = idx.songs.includes(song.id);
        if (!exists && !(await this.hasRoom(kv, blobKeyCount(text)))) {
          this.localOnly.add(song.id);
          this.saveLocal();
          return { cloud: false, warning: 'облако Telegram заполнено — мелодия сохранена только на этом устройстве' };
        }
        await writeBlob(kv, C.song(song.id), text);
        if (!exists) idx.songs.push(song.id);
        idx.deleted = idx.deleted.filter((id) => id !== song.id);
        await this.writeIndex(kv, idx);
        this.localOnly.delete(song.id);
        this.saveLocal();
        return { cloud: true, warning: localWarn };
      } catch (e) {
        this.localOnly.add(song.id);
        this.saveLocal();
        return { cloud: false, warning: `не удалось сохранить в облако (${e instanceof Error ? e.message : e}) — пока только на этом устройстве` };
      }
    });
  }

  /** Удалить свою мелодию на всех устройствах. */
  async deleteSong(id: string): Promise<void> {
    this.songs = this.songs.filter((s) => s.id !== id);
    this.deleted.add(id);
    this.localOnly.delete(id);
    for (const k of Object.keys(this.best)) if (k.startsWith(`${id}:`)) delete this.best[k];
    this.saveLocal();
    const kv = this.cloud;
    if (!kv) return;
    await this.enqueue(async () => {
      try {
        await removeBlob(kv, C.song(id));
        const idx = await this.readIndex(kv);
        idx.songs = idx.songs.filter((x) => x !== id);
        if (!idx.deleted.includes(id)) idx.deleted.push(id);
        await this.writeIndex(kv, idx);
      } catch (e) {
        this.syncError = e instanceof Error ? e.message : String(e);
      }
    });
  }

  /** Записать результат; true — это новый лучший. */
  setBest(key: string, r: BestResult): boolean {
    const prev = this.best[key];
    if (prev && !isBetter(r, prev)) return false;
    this.best = { ...this.best, [key]: r };
    this.saveLocal();
    const kv = this.cloud;
    if (kv) {
      void this.enqueue(async () => {
        try {
          const cb = await readBlob(kv, C.best);
          const merged = mergeBest(cb ? (JSON.parse(cb) as Record<string, BestResult>) : {}, this.best);
          await writeBlob(kv, C.best, JSON.stringify(merged));
        } catch (e) {
          this.syncError = e instanceof Error ? e.message : String(e);
        }
      });
    }
    return true;
  }

  setPrefs(patch: Partial<Omit<Prefs, 'updatedAt'>>): void {
    this.prefs = { ...this.prefs, ...patch, updatedAt: this.now() };
    this.saveLocal();
    const kv = this.cloud;
    if (kv) {
      const snapshot = this.prefs;
      void this.enqueue(async () => {
        try {
          await writeBlob(kv, C.prefs, JSON.stringify(snapshot));
        } catch (e) {
          this.syncError = e instanceof Error ? e.message : String(e);
        }
      });
    }
  }

  /** Дождаться завершения облачных операций (для тестов и перед закрытием). */
  flush(): Promise<void> {
    return this.queue.then(() => undefined);
  }
}
