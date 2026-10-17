/** Минимальные типы Telegram.WebApp — только то, что нужно прототипу. */
interface TelegramWebApp {
  initData: string;
  platform: string;
  version: string;
  isFullscreen?: boolean;
  isVersionAtLeast(version: string): boolean;
  ready(): void;
  expand(): void;
  disableVerticalSwipes?(): void;
  requestFullscreen?(): void;
  lockOrientation?(): void;
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
  onEvent(event: string, cb: (...args: unknown[]) => void): void;
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

export interface TelegramEnv {
  inTelegram: boolean;
  platform: string;
  version: string;
  /** Какие вызовы API реально выполнены (для отладочной панели). */
  applied: string[];
}

const MOBILE = new Set(['ios', 'android', 'android_x']);

/**
 * Инициализация Mini App. Вне Telegram скрипт тоже создаёт window.Telegram.WebApp,
 * но с platform = 'unknown' и пустым initData — тогда ничего не вызываем.
 */
export function initTelegram(log: (msg: string) => void): TelegramEnv {
  const tg = window.Telegram?.WebApp;
  const env: TelegramEnv = { inTelegram: false, platform: 'browser', version: '-', applied: [] };
  if (!tg || (tg.platform === 'unknown' && !tg.initData)) return env;

  env.inTelegram = true;
  env.platform = tg.platform;
  env.version = tg.version;

  const call = (name: string, minVersion: string, fn: (() => void) | undefined) => {
    if (!fn) return;
    if (!tg.isVersionAtLeast(minVersion)) {
      env.applied.push(`${name}: нужен ${minVersion}+`);
      return;
    }
    try {
      fn();
      env.applied.push(name);
    } catch (e) {
      env.applied.push(`${name}: ошибка`);
      log(`Telegram ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  call('ready', '6.0', () => tg.ready());
  call('expand', '6.0', () => tg.expand());
  call('setHeaderColor', '6.1', tg.setHeaderColor && (() => tg.setHeaderColor!('#0f1115')));
  call('setBackgroundColor', '6.1', tg.setBackgroundColor && (() => tg.setBackgroundColor!('#0f1115')));
  call('disableVerticalSwipes', '7.7', tg.disableVerticalSwipes && (() => tg.disableVerticalSwipes!()));

  if (MOBILE.has(tg.platform)) {
    call('requestFullscreen', '8.0', tg.requestFullscreen && (() => tg.requestFullscreen!()));
    try {
      tg.onEvent('fullscreenFailed', (e) => log(`Telegram fullscreenFailed: ${JSON.stringify(e)}`));
    } catch {
      /* старые клиенты */
    }
    // lockOrientation фиксирует ТЕКУЩУЮ ориентацию — вызываем, когда телефон уже горизонтально
    if (tg.lockOrientation && tg.isVersionAtLeast('8.0')) {
      const tryLock = () => {
        if (window.innerWidth <= window.innerHeight) return false;
        try {
          tg.lockOrientation!();
          env.applied.push('lockOrientation');
          log('Telegram: ориентация зафиксирована (горизонтально)');
        } catch (e) {
          log(`Telegram lockOrientation: ${e instanceof Error ? e.message : String(e)}`);
        }
        return true;
      };
      if (!tryLock()) {
        const onResize = () => {
          if (tryLock()) window.removeEventListener('resize', onResize);
        };
        window.addEventListener('resize', onResize);
      }
    }
  }
  return env;
}
