import { defineConfig, type Plugin } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { execSync } from 'node:child_process';

// Номер сборки в отчёте: видно, не открыл ли Telegram старую версию из кэша
function buildId(): string {
  let hash = 'dev';
  try {
    hash = execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    /* не git-репозиторий */
  }
  return `${hash} ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

// `npm run dev:https` — самоподписанный HTTPS для теста в мобильном браузере по Wi‑Fi.
// Для Telegram нужен настоящий сертификат — используйте туннель (cloudflared) или деплой.
const BUILD_ID = buildId();

// Номер сборки ещё и в <meta> страницы: по нему приложение узнаёт, что на сервере новая версия
const buildIdMeta = {
  name: 'build-id-meta',
  transformIndexHtml: (html: string) => html.replace('</head>', `  <meta name="build-id" content="${BUILD_ID}" />\n  </head>`),
};

/**
 * Стили встраиваются прямо в index.html. Отдельный .css однажды не загрузился в WebView Telegram —
 * приложение работало, но без вёрстки. Стилей ~8 КБ, отдельный запрос не нужен.
 */
const inlineCss: Plugin = {
  name: 'inline-css',
  apply: 'build',
  enforce: 'post',
  generateBundle(_options, bundle) {
    const html = Object.values(bundle).find((f) => f.type === 'asset' && f.fileName.endsWith('.html'));
    if (!html || html.type !== 'asset') return;
    for (const [name, file] of Object.entries(bundle)) {
      if (file.type !== 'asset' || !name.endsWith('.css')) continue;
      const base = name.split('/').pop()!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const link = new RegExp(`<link[^>]*href="[^"]*${base}"[^>]*>`);
      const src = String(html.source);
      if (!link.test(src)) continue;
      html.source = src.replace(link, () => `<style>${String(file.source)}</style>`);
      delete bundle[name];
    }
  },
};

export default defineConfig(({ mode }) => ({
  base: './',
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  plugins: [buildIdMeta, inlineCss, ...(mode === 'https' ? [basicSsl()] : [])],
  server: {
    host: true,
    allowedHosts: true, // чтобы работали адреса туннелей *.trycloudflare.com / *.ngrok-free.app
  },
  build: {
    target: ['es2020', 'safari14'],
  },
}));
