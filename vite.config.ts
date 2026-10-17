import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// `npm run dev:https` — самоподписанный HTTPS для теста в мобильном браузере по Wi‑Fi.
// Для Telegram нужен настоящий сертификат — используйте туннель (cloudflared) или деплой.
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: mode === 'https' ? [basicSsl()] : [],
  server: {
    host: true,
    allowedHosts: true, // чтобы работали адреса туннелей *.trycloudflare.com / *.ngrok-free.app
  },
  build: {
    target: ['es2020', 'safari14'],
  },
}));
