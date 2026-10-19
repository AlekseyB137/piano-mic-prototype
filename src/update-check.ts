/**
 * Самообновление. GitHub Pages отдаёт страницу с max-age=600, и WebView Telegram до 10 минут
 * открывает старую версию. При запуске запрашиваем index.html в обход кэша и сравниваем номер сборки;
 * если на сервере новее — перезагружаемся на адрес с ?v=<сборка> (хэш с данными Telegram сохраняется).
 */
export async function checkForUpdate(current: string, canReload: () => boolean, log: (m: string) => void): Promise<void> {
  if (current.startsWith('dev')) return;
  try {
    const url = new URL('./index.html', location.href);
    url.searchParams.set('nocache', String(Date.now()));
    const res = await fetch(url.toString(), { cache: 'no-store' });
    if (!res.ok) return;
    const latest = (await res.text()).match(/<meta name="build-id" content="([^"]+)"/)?.[1];
    if (!latest || latest === current) return;

    // Защита от бесконечной перезагрузки, если кэш не сдаётся
    const key = 'pianoMic.reloadedFor';
    let tried = '';
    try {
      tried = sessionStorage.getItem(key) ?? '';
    } catch {
      /* storage недоступен */
    }
    if (tried === latest || !canReload()) {
      log(`На сервере новая сборка ${latest} — закройте и откройте приложение заново`);
      return;
    }
    try {
      sessionStorage.setItem(key, latest);
    } catch {
      /* storage недоступен */
    }
    const next = new URL(location.href);
    next.searchParams.set('v', latest.split(' ')[0]);
    location.replace(next.toString());
  } catch {
    /* нет сети — работаем на текущей версии */
  }
}
