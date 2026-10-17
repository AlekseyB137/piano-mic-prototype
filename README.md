# Piano Mic Prototype

Прототип распознавания нот пианино с микрофона телефона — для Telegram Mini App и мобильного браузера.
Цель — проверить, насколько надёжно распознаётся звук внутри Telegram на iPhone и Android.

## Структура

```
src/
  main.ts                 — сборка UI и аудио
  telegram.ts             — ready / expand / disableVerticalSwipes / requestFullscreen / lockOrientation
  audio/                  — без DOM, переносится в основное приложение как есть
    analyzer.ts           — конвейер: кольцевой буфер, hop 512, все детекторы → события
    analyzer.worklet.ts   — AudioWorkletProcessor-обёртка над Analyzer
    capture.ts            — getUserMedia (EC/NS/AGC выкл.) + AudioContext + ошибки
    fft.ts                — radix-2 FFT, окно Ханна
    pitch-yin.ts          — YIN через FFT (свободный режим, монофония)
    onset.ts              — детектор атаки по spectral flux
    chord-check.ts        — проверка ожидаемых нот по гармоникам ×1..×4 + октавная защита
    check-session.ts      — окно оценки после удара → «засчитано / нет»
    noise.ts              — калибровка шума («Тишина 2 с»)
    params.ts, messages.ts, notes.ts
  ui/                     — клавиатура C3–B5, панели, лог
```

## 1. Запуск локально

Нужен Node.js 20+.

```bash
npm install
npm run dev          # http://localhost:5173 — микрофон работает на localhost в десктопном браузере
npm run build        # проверка типов + сборка в dist/
```

### Открыть на телефоне

Микрофон в браузере доступен только по HTTPS (или на localhost).

**Вариант А — мобильный браузер в той же Wi‑Fi сети (самоподписанный сертификат):**
```bash
npm run dev:https    # покажет адрес вида https://192.168.1.23:5173
```
Откройте адрес на телефоне и подтвердите предупреждение о сертификате
(Safari: «Подробнее → посетить сайт»; Chrome: «Дополнительные → перейти»).
⚠️ Внутри Telegram такой сертификат не примется — используйте вариант Б.

**Вариант Б — туннель с настоящим сертификатом (подходит и для Telegram):**
```bash
brew install cloudflared            # один раз (или скачайте бинарник с github.com/cloudflare/cloudflared)
npm run dev                         # в одном терминале
cloudflared tunnel --url http://localhost:5173   # в другом
```
cloudflared напечатает `https://<случайное-имя>.trycloudflare.com` — это и есть адрес для телефона и для BotFather
(временный, меняется при каждом запуске). Аналог: `ngrok http 5173`.

## 2. Деплой на GitHub Pages (бесплатно, постоянный HTTPS-адрес)

Workflow уже лежит в `.github/workflows/deploy.yml`.

1. Создайте пустой репозиторий на GitHub, например `piano-mic`.
2. Запушьте проект:
   ```bash
   git init && git add . && git commit -m "Piano mic prototype"
   git branch -M main
   git remote add origin https://github.com/<user>/piano-mic.git
   git push -u origin main
   ```
3. На GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
4. Вкладка **Actions** — дождитесь зелёной галочки (≈1 мин).
5. Адрес: `https://<user>.github.io/piano-mic/`. Каждый push в `main` выкатывает новую версию.

`vite.config.ts` использует `base: './'`, поэтому сборка работает в подпапке без доп. настройки.

## 3. Бот и Mini App в @BotFather

1. Откройте [@BotFather](https://t.me/BotFather) → `/newbot` → имя → username (должен заканчиваться на `bot`).
2. Привяжите Mini App:
   - `/newapp` → выберите бота → название, описание, картинка 640×360 (обязательна), GIF можно пропустить (`/empty`)
     → **URL**: ваш адрес (`https://<user>.github.io/piano-mic/`) → короткое имя, например `test`.
   - Получите ссылку вида `https://t.me/<bot_username>/test` — по ней приложение открывается у любого пользователя.
3. Кнопка в меню чата (удобно для тестов):
   `/mybots` → бот → **Bot Settings → Menu Button → Configure menu button** → тот же URL и текст «Пианино».
4. Чтобы сменить URL (например, на новый адрес туннеля): `/myapps` → приложение → **Edit Web App URL**.

Telegram кэширует страницу: после деплоя закройте Mini App полностью и откройте заново
(на Android можно потянуть меню «⋮ → Reload page»).

## Как читать отладку

* **Сигнал**: уровень RMS (серая черта — фон, жёлтая — порог гейта), график потока (синий), порога (жёлтый), атак (красные).
* **Спектр**: синие полосы — сигнал, серая линия — профиль шума, жёлтые — ожидаемые ноты, зелёная — найденная высота.
* **Фишки нот в режиме проверки**: `1:22 2:18 3:· 4:9*` — SNR (дБ) по гармоникам; `*` — гармоника общая с другой нотой аккорда.
* **Скопировать отчёт и лог** — текст с устройством, настройками трека, параметрами и последними 20 событиями.
