/**
 * Облачное хранилище «ключ–значение» пользователя. В Telegram — WebApp.CloudStorage: свои данные
 * у каждого пользователя бота, общие для всех его устройств. Лимиты Telegram (KV_LIMITS) соблюдает
 * вызывающий код (user-data.ts); тестовая реализация их проверяет.
 */
export interface KV {
  get(keys: string[]): Promise<Record<string, string>>;
  set(key: string, value: string): Promise<void>;
  remove(keys: string[]): Promise<void>;
  keys(): Promise<string[]>;
}

/** Лимиты Telegram CloudStorage. */
export const KV_LIMITS = { valueChars: 4096, keys: 1024, keyChars: 128, keyPattern: /^[A-Za-z0-9_-]{1,128}$/ };

type Cb<T> = (error: string | null, result?: T) => void;
export interface TgCloudStorage {
  setItem(key: string, value: string, cb?: Cb<boolean>): void;
  getItems(keys: string[], cb: Cb<Record<string, string>>): void;
  removeItems(keys: string[], cb?: Cb<boolean>): void;
  getKeys(cb: Cb<string[]>): void;
}

const promisify = <T>(f: (cb: Cb<T>) => void) =>
  new Promise<T>((resolve, reject) => f((err, res) => (err ? reject(new Error(err)) : resolve(res as T))));

/** Адаптер WebApp.CloudStorage (Bot API 6.9+). */
export function telegramKV(cs: TgCloudStorage): KV {
  return {
    async get(keys) {
      const out: Record<string, string> = {};
      for (let i = 0; i < keys.length; i += 50) {
        Object.assign(out, await promisify<Record<string, string>>((cb) => cs.getItems(keys.slice(i, i + 50), cb)));
      }
      return out;
    },
    set: (key, value) => promisify<boolean>((cb) => cs.setItem(key, value, cb)).then(() => undefined),
    async remove(keys) {
      for (let i = 0; i < keys.length; i += 50) await promisify<boolean>((cb) => cs.removeItems(keys.slice(i, i + 50), cb));
    },
    keys: () => promisify<string[]>((cb) => cs.getKeys(cb)),
  };
}

/** CloudStorage, если приложение открыто в Telegram с поддержкой (6.9+), иначе null. */
export function telegramCloud(): KV | null {
  const tg = (window as unknown as { Telegram?: { WebApp?: { platform: string; initData: string; isVersionAtLeast(v: string): boolean; CloudStorage?: TgCloudStorage } } }).Telegram?.WebApp;
  if (!tg || (tg.platform === 'unknown' && !tg.initData)) return null;
  if (!tg.isVersionAtLeast('6.9') || !tg.CloudStorage) return null;
  return telegramKV(tg.CloudStorage);
}
