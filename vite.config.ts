import { defineConfig } from 'vite';
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
export default defineConfig(({ mode }) => ({
  base: './',
  define: { __BUILD_ID__: JSON.stringify(buildId()) },
  plugins: mode === 'https' ? [basicSsl()] : [],
  server: {
    host: true,
    allowedHosts: true, // чтобы работали адреса туннелей *.trycloudflare.com / *.ngrok-free.app
  },
  build: {
    target: ['es2020', 'safari14'],
  },
}));
