import './style.css';
import { initTelegram, type TelegramEnv } from './telegram';
import { checkForUpdate } from './update-check';
import { AudioCapture, MicError, type CaptureInfo } from './audio/capture';
import { DEFAULT_PARAMS, type AnalyzerParams } from './audio/params';
import type { AnalyzerEvent, FrameEvent, InfoEvent } from './audio/messages';
import { KEY_HIGH, KEY_LOW, midiToFreq, midiToName } from './audio/notes';
import { Keyboard } from './ui/keyboard';
import { Readout, VERDICT_TEXT, type Mode } from './ui/readout';
import { DebugPanel } from './ui/debug-panel';
import { EventLog } from './ui/event-log';
import { FallingNotes } from './ui/falling-notes';
import { DEFAULT_WINDOW, SongPlayer, type PlayMode } from './song/player';
import { SONGS } from './songs';
import { SongPicker, type BestResult } from './ui/song-picker';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

// --- Сохранение настроек между запусками (только удобство; без storage тоже работает) ---
const LS_PARAMS = 'pianoMic.params';
/** Увеличивать при смене значений по умолчанию — старые сохранённые пороги сбросятся. */
const PARAMS_VERSION = 5;
const LS_FFT = 'pianoMic.fft';
const LS_SONG = 'pianoMic.song';
const LS_BEST = 'pianoMic.best';
const LS_PLAY_MODE = 'pianoMic.playMode';
const LS_LATENCY = 'pianoMic.latency';
function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? { ...fallback, ...JSON.parse(v) } : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, v: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* приватный режим и т. п. */
  }
}

// --- Состояние ---
const stored = load<{ v: number; params: AnalyzerParams }>(LS_PARAMS, { v: 0, params: DEFAULT_PARAMS });
let params: AnalyzerParams = stored.v === PARAMS_VERSION ? { ...DEFAULT_PARAMS, ...stored.params } : { ...DEFAULT_PARAMS };
let fftSize = load(LS_FFT, { n: 8192 }).n;
let mode: Mode = 'free';
const expected = new Set<number>();
let latestFrame: FrameEvent | null = null;
let workletInfo: InfoEvent | null = null;
let captureInfo: CaptureInfo | null = null;
let calibration: { rmsDb: number; onsetDelta: number } | null = null;
let lastCheckLatency: number | null = null;
let ctxState = '—';
let ignoredAttacks = 0;
// Режим «Песня»
let songIdx = Math.max(0, SONGS.findIndex((s) => s.id === load(LS_SONG, { id: SONGS[0].id }).id));
let playMode: PlayMode = load<{ m: PlayMode }>(LS_PLAY_MODE, { m: 'tempo' }).m;
/** Поправка ритма на задержку цепочки, мс (подстраивается кнопкой на экране «Готово!»). */
let latencyMs = load<{ ms: number }>(LS_LATENCY, { ms: DEFAULT_WINDOW.latencySec * 1000 }).ms;
const makePlayer = () => new SongPlayer(SONGS[songIdx], playMode, 4, { ...DEFAULT_WINDOW, latencySec: latencyMs / 1000 });
let player = makePlayer();
/** Аудиовремя = время анализатора + clockOffset (из событий 'clock' worklet'а). */
let clockOffset: number | null = null;
let songDoneShown = false;
let lastSentExpected = '';
let lastAudioT: number | null = null;
/** Отброшенные атаки — только для отчёта, в видимый лог не попадают. */
const dropped: string[] = [];
const DROPPED_MAX = 60;

// --- UI ---
const log = new EventLog($('#log'));
const keyboard = new Keyboard($('#keyboard'), KEY_LOW, KEY_HIGH);
const readout = new Readout($('#readout'));
const debug = new DebugPanel($('#debug'), params, fftSize);
const btnStart = $<HTMLButtonElement>('#btn-start');
const btnCalib = $<HTMLButtonElement>('#btn-calib');
const btnDebug = $<HTMLButtonElement>('#btn-debug');
const statusDot = $('#status-dot');
const appEl = $('#app');
const songCanvas = $<HTMLCanvasElement>('#song-canvas');
const songStatus = $('#song-status');
const songDone = $('#song-done');
const falling = new FallingNotes(songCanvas, (m) => keyboard.keyGeometry(m));
const bestResults = load<Record<string, BestResult>>(LS_BEST, {});
const picker = new SongPicker($('#song-picker'), SONGS, (id) => bestResults[`${id}:${playMode}`] ?? null);
const message = $('#message');

const tgEnv: TelegramEnv = initTelegram((m) => log.add(m, 'info'));
log.add(`Сборка ${__BUILD_ID__}`);
log.add(tgEnv.inTelegram ? `Telegram ${tgEnv.platform} v${tgEnv.version}` : 'Запущено вне Telegram (браузер)');

const capture = new AudioCapture();

function showMessage(text: string, kind: 'error' | 'info' = 'error', action?: { label: string; run: () => void }): void {
  message.className = `message ${kind === 'info' ? 'info' : ''}`;
  const span = document.createElement('span');
  span.textContent = text;
  const nodes: Node[] = [span];
  if (action) {
    const b = document.createElement('button');
    b.className = 'small';
    b.textContent = action.label;
    b.addEventListener('click', action.run);
    nodes.push(b);
  }
  const close = document.createElement('button');
  close.className = 'small';
  close.textContent = '×';
  close.addEventListener('click', hideMessage);
  nodes.push(close);
  message.replaceChildren(...nodes);
}
function hideMessage(): void {
  message.className = 'message hidden';
}

// --- Отладочная информация ---
function ms(sec: number | null | undefined): string {
  return typeof sec === 'number' ? `${(sec * 1000).toFixed(1)} мс` : 'н/д';
}

function infoRows(): [string, string][] {
  const rows: [string, string][] = [];
  rows.push(['Сборка', __BUILD_ID__]);
  rows.push(['Среда', tgEnv.inTelegram ? `Telegram ${tgEnv.platform} ${tgEnv.version}` : 'браузер']);
  if (tgEnv.applied.length) rows.push(['TG API', tgEnv.applied.join(', ')]);
  rows.push(['Аудио', ctxState]);
  if (captureInfo) {
    rows.push(['sampleRate', `${captureInfo.sampleRate} Гц`]);
    rows.push(['baseLatency', ms(captureInfo.baseLatency)]);
    rows.push(['outputLatency', ms(captureInfo.outputLatency)]);
    rows.push(['Микрофон', captureInfo.trackLabel || '—']);
    const s = captureInfo.trackSettings as MediaTrackSettings & { latency?: number };
    const fmt = (k: keyof MediaTrackConstraints & keyof MediaTrackSettings) =>
      `${String(s[k] ?? 'н/д')} (запрошено ${String(captureInfo!.requested[k])})`;
    rows.push(['echoCancellation', fmt('echoCancellation')]);
    rows.push(['noiseSuppression', fmt('noiseSuppression')]);
    rows.push(['autoGainControl', fmt('autoGainControl')]);
    rows.push(['channelCount', String(s.channelCount ?? 'н/д')]);
    rows.push(['settings.sampleRate', String(s.sampleRate ?? 'н/д')]);
    rows.push(['settings.latency', ms(s.latency)]);
  }
  if (workletInfo) {
    const sr = workletInfo.sampleRate;
    rows.push(['Буфер', `блок 128, hop ${workletInfo.hop} (${ms(workletInfo.hop / sr)})`]);
    rows.push(['FFT', `атака/высота ${workletInfo.smallFft} (${ms(workletInfo.smallFft / sr)}), проверка ${workletInfo.bigFft} (${ms(workletInfo.bigFft / sr)}, ${(sr / workletInfo.bigFft).toFixed(1)} Гц/бин)`]);
    // Центр окна отстаёт от «сейчас» на половину окна + до одного hop ожидания
    const inLat = (captureInfo?.trackSettings as { latency?: number } | undefined)?.latency ?? 0;
    const onsetLat = (128 + workletInfo.hop * 2 + workletInfo.smallFft / 2) / sr + inLat;
    rows.push(['Задержка (оценка)', `атака ≈ ${ms(onsetLat)}${inLat ? '' : ' + вход (н/д)'}; проверка: ${lastCheckLatency !== null ? `${lastCheckLatency} мс после удара (посл.)` : 'измеряется'}`]);
  }
  rows.push(['Поправка ритма', `${latencyMs} мс («В такт»)`]);
  rows.push(['Отброшено атак', `${ignoredAttacks} (голос, стук, шум)`]);
  rows.push(['Шум', calibration ? `${calibration.rmsDb.toFixed(1)} дБFS, порог атаки ${calibration.onsetDelta}` : 'не откалиброван']);
  rows.push(['Пороги', `гейт +${params.gateDb} дБ, SNR ${params.snrDb} дБ, атака ${params.onsetDelta}+${params.onsetMultiplier}×мед.`]);
  return rows;
}

function refreshInfo(): void {
  debug.setInfo(infoRows());
}

function reportText(): string {
  const lines = [
    `Piano mic prototype — отчёт ${new Date().toISOString()}`,
    `UA: ${navigator.userAgent}`,
    ...infoRows().map(([k, v]) => `${k}: ${v}`),
    `Параметры: ${JSON.stringify(params)}`,
    `Режим: ${mode}${expected.size ? `, ожидаем ${[...expected].map(midiToName).join(' ')}` : ''}`,
    '',
    `Отброшенные атаки (новые сверху, ${dropped.length}):`,
    ...dropped,
    '',
    `Лог (новые сверху, ${log.size} событий):`,
    log.toText(),
  ];
  return lines.join('\n');
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Фолбэк для WebView без Clipboard API
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

// --- Параметры ---
function setParams(p: Partial<AnalyzerParams>): void {
  params = { ...params, ...p };
  save(LS_PARAMS, { v: PARAMS_VERSION, params });
  capture.post({ type: 'params', params: p });
  refreshInfo();
}

debug.onParam = setParams;
debug.onResetParams = () => {
  const keepDelta = calibration ? { onsetDelta: calibration.onsetDelta } : {};
  params = { ...DEFAULT_PARAMS, ...keepDelta };
  save(LS_PARAMS, { v: PARAMS_VERSION, params });
  debug.setParams(params);
  capture.post({ type: 'params', params });
  refreshInfo();
};
debug.onFftSize = (n) => {
  fftSize = n;
  save(LS_FFT, { n });
  if (capture.running) showMessage('Новый размер FFT применится после «Стоп» → «Старт».', 'info');
};
debug.onShare = async () => {
  const text = reportText();
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Piano mic — отчёт', text });
      return;
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return; // пользователь закрыл меню
    }
  }
  const ok = await copyText(text);
  showMessage(ok ? 'Меню «Поделиться» недоступно — отчёт скопирован в буфер обмена.' : 'Не удалось поделиться или скопировать — выделите лог вручную.', 'info');
};
debug.onCopy = async () => {
  const ok = await copyText(reportText());
  showMessage(ok ? 'Отчёт скопирован в буфер обмена.' : 'Не удалось скопировать — выделите лог вручную.', 'info');
};

// --- Режимы и ожидаемые ноты ---
function currentExpected(): number[] {
  if (mode === 'check') return [...expected].sort((a, b) => a - b);
  if (mode === 'song') return picker.visible ? [] : player.expected();
  return [];
}

/** Отправить ожидаемые ноты анализатору; force — даже если не изменились (после Старт). */
function sendExpected(force = false): void {
  const midis = currentExpected();
  const key = `${mode}:${midis.join(',')}`;
  if (!force && key === lastSentExpected) return;
  lastSentExpected = key;
  capture.post({ type: 'expected', midis });
  readout.setExpected(midis);
  keyboard.setOnly('expected', midis);
  keyboard.clear('pass');
  keyboard.clear('fail');
  debug.markers = midis.map((m) => midiToFreq(m));
}

/** Окно клавиатуры под диапазон песни: целые октавы, не меньше двух. */
function songKeyRange(): { low: number; high: number } {
  const r = player.range();
  const low = 12 * Math.floor(r.low / 12);
  let high = 12 * Math.floor(r.high / 12) + 11;
  if (high - low + 1 < 24) high += 12;
  return { low, high };
}

function setMode(m: Mode): void {
  mode = m;
  document.querySelectorAll<HTMLButtonElement>('#mode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
  appEl.classList.toggle('song-mode', m === 'song');
  readout.setMode(m);
  keyboard.clear('detected');
  if (m === 'song') {
    const r = songKeyRange();
    keyboard.setRange(r.low, r.high);
    // Пока песня не начата — сразу экран выбора
    if (player.hits === 0 && player.mistakes === 0) picker.show(songIdx);
  } else {
    keyboard.setRange(KEY_LOW, KEY_HIGH);
    picker.hide();
  }
  lastAudioT = null;
  sendExpected();
  updateSongStatus();
}

// --- Песня ---
function newPlayer(): void {
  player = makePlayer();
  falling.reset();
  songDoneShown = false;
}

picker.onPick = (i) => {
  songIdx = i;
  save(LS_SONG, { id: SONGS[songIdx].id });
  newPlayer();
  picker.hide();
  songDone.classList.add('hidden');
  const r = songKeyRange();
  keyboard.setRange(r.low, r.high);
  lastAudioT = null;
  sendExpected();
  updateSongStatus();
};
function chooseSong(): void {
  songDone.classList.add('hidden');
  picker.show(songIdx);
  sendExpected();
  updateSongStatus();
}
$('#song-choose').addEventListener('click', chooseSong);
function restartSong(): void {
  newPlayer(); // заново, чтобы подхватить новую поправку ритма
  songDoneShown = false;
  songDone.classList.add('hidden');
  lastAudioT = null;
  sendExpected();
  updateSongStatus();
}
$('#song-restart').addEventListener('click', restartSong);

// Ожидание | В такт
const playModeButtons = document.querySelectorAll<HTMLButtonElement>('#song-play-mode button');
function showPlayMode(): void {
  playModeButtons.forEach((b) => b.classList.toggle('active', b.dataset.play === playMode));
}
playModeButtons.forEach((b) =>
  b.addEventListener('click', () => {
    playMode = b.dataset.play as PlayMode;
    save(LS_PLAY_MODE, { m: playMode });
    showPlayMode();
    newPlayer();
    restartSong();
  }),
);
showPlayMode();

function fmtTime(sec: number): string {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function updateSongStatus(): void {
  if (mode !== 'song') return;
  const cur = player.current;
  let text: string;
  if (picker.visible) text = '';
  else if (!capture.running) text = 'Нажмите «Старт», затем «Тишина 2 с»';
  else if (!cur) text = 'Готово!';
  else text = '';
  let counters = `${text ? ' · ' : ''}✓ ${player.hits} · ✗ ${player.mistakes}`;
  if (playMode === 'tempo') {
    counters += ` · поздно ${player.lates}`;
    const o = player.lastOffsetSec;
    if (o !== null) counters += ` · последняя ${o >= 0 ? '+' : '−'}${Math.abs(Math.round(o * 1000))} мс`;
  }
  const hands = new Set(player.song.notes.map((n) => n.hand));
  const legend =
    hands.size > 1 && !picker.visible
      ? ' · <span class="hand-dot r"></span>правая <span class="hand-dot l"></span>левая'
      : '';
  songStatus.innerHTML = text + counters + legend;
}

function showSongDone(): void {
  const total = player.steps.length;
  songDone.replaceChildren();
  const title = document.createElement('strong');
  title.textContent = 'Готово!';
  const stats = document.createElement('div');
  stats.textContent =
    playMode === 'tempo'
      ? `Вовремя: ${player.hits} из ${total} · поздно: ${player.lates} · ошибок: ${player.mistakes}${timingSummary()}`
      : `Нот/аккордов: ${total} · ошибок: ${player.mistakes} · время: ${fmtTime(player.elapsedSec)}`;
  const again = document.createElement('button');
  again.className = 'primary';
  again.textContent = 'Ещё раз';
  again.addEventListener('click', restartSong);
  const choose = document.createElement('button');
  choose.textContent = 'Выбор мелодии';
  choose.addEventListener('click', chooseSong);
  const row = document.createElement('div');
  row.className = 'row';
  row.append(again, choose);
  // Лучший результат: «В такт» — больше вовремя, потом меньше ошибок; «Ожидание» — меньше ошибок, потом быстрее
  const id = `${SONGS[songIdx].id}:${playMode}`;
  const prev = bestResults[id];
  const cur: BestResult = { mistakes: player.mistakes, seconds: Math.round(player.elapsedSec), hits: player.hits, total };
  const isBest =
    !prev ||
    (playMode === 'tempo'
      ? (cur.hits ?? 0) > (prev.hits ?? 0) || ((cur.hits ?? 0) === (prev.hits ?? 0) && cur.mistakes < prev.mistakes)
      : cur.mistakes < prev.mistakes || (cur.mistakes === prev.mistakes && cur.seconds < prev.seconds));
  if (isBest) {
    bestResults[id] = cur;
    save(LS_BEST, bestResults);
  }
  const best = document.createElement('div');
  best.className = 'tile-best';
  best.textContent = isBest && prev ? 'Новый лучший результат!' : '';
  songDone.append(title, stats, best);
  // Подстройка поправки ритма: среднее (медиана) отклонение заметно не ноль
  const shift = playMode === 'tempo' ? player.suggestLatencyShift() : null;
  if (shift !== null && Math.abs(shift) > 0.025) {
    const ms = Math.round(shift * 1000);
    const lat = document.createElement('div');
    lat.textContent = `Обычно вы играете на ${ms >= 0 ? '+' : '−'}${Math.abs(ms)} мс от доли. Если играли ровно, это задержка телефона/пианино.`;
    const fix = document.createElement('button');
    fix.textContent = 'Учесть задержку';
    fix.addEventListener('click', () => {
      latencyMs = Math.max(0, Math.min(400, latencyMs + ms));
      save(LS_LATENCY, { ms: latencyMs });
      lat.textContent = `Поправка ритма теперь ${latencyMs} мс — нажмите «Ещё раз».`;
      fix.remove();
      log.add(`Поправка ритма: ${latencyMs} мс`);
      refreshInfo();
    });
    row.append(fix);
    songDone.append(lat);
  }
  songDone.append(row);
  songDone.classList.remove('hidden');
}

/** Среднее отклонение попаданий: помогает понять, не нужна ли поправка на задержку. */
function timingSummary(): string {
  const o = player.steps.filter((s) => !s.late).map((s) => s.offsetSec).filter((x): x is number => x !== null);
  if (!o.length) return '';
  const mean = (o.reduce((a, b) => a + b, 0) / o.length) * 1000;
  return ` · в среднем ${mean >= 0 ? '+' : '−'}${Math.abs(Math.round(mean))} мс`;
}

const JUDGE_TEXT = { hit: 'вовремя', early: 'рано', late: 'поздно (игра ждала)', wrong: 'не та нота', ignored: '' } as const;

/** Шаг сыгран: нота «уходит в клавишу», клавиша вспыхивает зелёным. */
function songStepDone(stepIndex: number, midis: number[], now: number): void {
  falling.sink(stepIndex, now);
  for (const m of midis) keyboard.mark(m, 'pass', true);
  window.setTimeout(() => {
    if (mode === 'song') for (const m of midis) keyboard.mark(m, 'pass', false);
  }, 320);
}

/** Вердикт анализатора в режиме «Песня». onsetTime — время атаки в часах анализатора. */
function onSongCheck(allPassed: boolean, notes: { midi: number; passed: boolean }[], onsetTime: number): void {
  const now = capture.ctx?.currentTime ?? 0;
  const step = player.current;
  if (playMode === 'tempo') {
    if (clockOffset === null) return; // часы ещё не привязаны — оценить ритм нельзя
    const j = player.judge(allPassed, onsetTime + clockOffset, now);
    if (j === 'ignored') return;
    const off = player.lastOffsetSec;
    log.add(`В такт: ${JUDGE_TEXT[j]}${j === 'hit' && off !== null ? ` (${off >= 0 ? '+' : '−'}${Math.abs(Math.round(off * 1000))} мс)` : ''}`, j === 'hit' ? 'pass' : 'fail');
    if (j === 'hit' || j === 'late') {
      if (step) songStepDone(step.index, notes.map((n) => n.midi), now);
      sendExpected();
    } else {
      falling.flash(notes.filter((n) => !n.passed || j !== 'wrong').map((n) => n.midi), 'fail', now, 0.4);
    }
    updateSongStatus();
    return;
  }
  if (allPassed) {
    if (step) songStepDone(step.index, notes.map((n) => n.midi), now);
    player.result(true);
    sendExpected();
  } else {
    falling.flash(notes.filter((n) => !n.passed).map((n) => n.midi), 'fail', now, 0.6);
    player.result(false);
    for (const n of notes) keyboard.mark(n.midi, 'fail', !n.passed);
    // Красная подсветка — короткая вспышка, нота остаётся ждать
    window.setTimeout(() => {
      if (mode === 'song') keyboard.clear('fail');
    }, 700);
  }
  updateSongStatus();
}

$('#mode').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-mode]');
  if (b) setMode(b.dataset.mode as Mode);
});

keyboard.onTap = (midi) => {
  if (mode === 'song') return;
  if (mode !== 'check') {
    log.add(`Тап: ${midiToName(midi)} (${midiToFreq(midi).toFixed(1)} Гц) — включите «Проверку», чтобы выбрать ноты`);
    return;
  }
  if (expected.has(midi)) expected.delete(midi);
  else expected.add(midi);
  sendExpected();
};
readout.onClear = () => {
  expected.clear();
  sendExpected();
};

// Любое касание экрана — стук по телефону рядом с микрофоном: ненадолго не открываем проверку
document.addEventListener('pointerdown', () => capture.post({ type: 'mute', seconds: 0.6 }), { capture: true });

$('#btn-log-clear').addEventListener('click', () => {
  log.clear();
  dropped.length = 0;
});

btnDebug.addEventListener('click', () => {
  const collapsed = debug.root.classList.toggle('collapsed');
  btnDebug.classList.toggle('active', !collapsed);
  if (!collapsed) refreshInfo();
});

// --- События анализатора ---
function attackText(a: { flux: number; rmsDb: number; hfRiseDb: number }): string {
  return `атака ${a.flux.toFixed(3)}, ${a.rmsDb.toFixed(0)} дБFS, ВЧ +${a.hfRiseDb.toFixed(0)} дБ`;
}

function onEvent(ev: AnalyzerEvent): void {
  switch (ev.type) {
    case 'info':
      workletInfo = ev;
      refreshInfo();
      break;
    case 'frame':
      latestFrame = ev;
      ignoredAttacks = ev.ignoredAttacks;
      debug.pushFrame(ev);
      break;
    case 'onset':
      // Сырая атака ещё не нота (может быть голос или стук) — только метка на графике
      debug.markOnset();
      break;
    case 'note':
      if (mode === 'free') {
        const p = ev.pitch;
        const how =
          p.source === 'spectrum'
            ? 'по спектру'
            : `${p.freq.toFixed(1)} Гц ${p.cents >= 0 ? '+' : ''}${p.cents} ц, ув. ${p.clarity.toFixed(2)}`;
        log.add(
          `${midiToName(p.midi)} ${how} · ${attackText(ev.attack)}`,
          'note',
          ev.t,
        );
      }
      break;
    case 'check': {
      lastCheckLatency = ev.latencyMs;
      if (mode === 'song') onSongCheck(ev.allPassed, ev.notes, ev.onsetTime);
      else {
        readout.setResult(ev);
        for (const n of ev.notes) {
          keyboard.mark(n.midi, 'pass', n.passed);
          keyboard.mark(n.midi, 'fail', !n.passed);
        }
      }
      const parts = ev.notes.map((n) => {
        const why = !n.passed && n.evidence ? ` (${VERDICT_TEXT[n.evidence.verdict]})` : '';
        const score = n.evidence ? ` ${n.evidence.score.toFixed(0)}дБ` : '';
        return `${midiToName(n.midi)}${n.passed ? '✓' : '✗'}${why}${score}`;
      });
      log.add(
        `${ev.allPassed ? 'Засчитано' : 'Не засчитано'}: ${parts.join(' ')} · ${ev.latencyMs} мс · ${attackText(ev.attack)}`,
        ev.allPassed ? 'pass' : 'fail',
        ev.onsetTime,
      );
      if (!debug.root.classList.contains('collapsed')) refreshInfo();
      break;
    }
    case 'clock':
      clockOffset = ev.audioTime - ev.analyzerTime;
      break;
    case 'checkStart':
      // Новый удар: прошлый результат больше не актуален, чтобы старая подсветка не путала
      keyboard.clear('pass');
      keyboard.clear('fail');
      readout.onCheckStart();
      break;
    case 'dropped':
      dropped.unshift(
        `[${ev.t.toFixed(3)}s] ${ev.reason} · ${attackText(ev.attack)}${ev.seen ? ` · видел: ${ev.seen}` : ''}`,
      );
      if (dropped.length > DROPPED_MAX) dropped.length = DROPPED_MAX;
      break;
    case 'calibrated':
      calibration = { rmsDb: ev.rmsDb, onsetDelta: ev.onsetDelta };
      params = { ...params, onsetDelta: ev.onsetDelta };
      save(LS_PARAMS, { v: PARAMS_VERSION, params });
      debug.setParams(params);
      debug.noisePreview = ev.noisePreview;
      btnCalib.disabled = false;
      btnCalib.textContent = 'Тишина 2 с';
      log.add(`Калибровка: фон ${ev.rmsDb.toFixed(1)} дБFS, поток ${ev.fluxMean.toFixed(4)}±${ev.fluxStd.toFixed(4)} → порог атаки ${ev.onsetDelta}`);
      refreshInfo();
      break;
  }
}

capture.onEvent = onEvent;
capture.onStateChange = (state) => {
  ctxState = state;
  statusDot.className = `dot ${state}`;
  log.add(`AudioContext: ${state}`);
  refreshInfo();
  // iOS приостанавливает аудио при сворачивании/звонке — возобновить можно только жестом
  if (state !== 'running' && state !== 'closed' && capture.running) {
    showMessage('Аудио приостановлено системой.', 'info', {
      label: 'Возобновить',
      run: () => {
        capture.resume().then(hideMessage, (e) => log.add(`resume: ${String(e)}`, 'error'));
      },
    });
  } else if (state === 'running') {
    hideMessage();
  }
};
capture.onTrackEnded = () => {
  log.add('Трек микрофона завершён (система отобрала микрофон?)', 'error');
  showMessage('Микрофон отключён системой. Нажмите «Стоп», затем «Старт».');
};

// --- Старт / стоп ---
btnStart.addEventListener('click', async () => {
  if (capture.running) {
    await capture.stop();
    btnStart.textContent = 'Старт';
    btnStart.classList.remove('stop');
    btnCalib.disabled = true;
    ctxState = 'остановлено';
    statusDot.className = 'dot';
    latestFrame = null;
    keyboard.clear('detected');
    log.add('Стоп');
    refreshInfo();
    updateSongStatus();
    return;
  }
  hideMessage();
  btnStart.disabled = true;
  try {
    // Важно: start() вызывается синхронно из обработчика нажатия (требование iOS)
    captureInfo = await capture.start({ bigFft: fftSize });
    ctxState = capture.ctx?.state ?? '—';
    statusDot.className = `dot ${ctxState}`;
    capture.post({ type: 'params', params });
    sendExpected(true);
    lastAudioT = null;
    clockOffset = null;
    updateSongStatus();
    btnStart.textContent = 'Стоп';
    btnStart.classList.add('stop');
    btnCalib.disabled = false;
    const s = captureInfo.trackSettings;
    log.add(
      `Микрофон: ${captureInfo.sampleRate} Гц, EC=${String(s.echoCancellation)}, NS=${String(s.noiseSuppression)}, AGC=${String(s.autoGainControl)}`,
    );
    if (s.echoCancellation || s.noiseSuppression || s.autoGainControl) {
      log.add('Внимание: часть обработки звука не отключилась — распознавание может ухудшиться', 'error');
    }
    if (!calibration) showMessage('Совет: нажмите «Тишина 2 с» и помолчите — пороги подстроятся под вашу комнату.', 'info');
    refreshInfo();
  } catch (e) {
    const text = e instanceof MicError ? e.message : `Не удалось запустить аудио: ${e instanceof Error ? e.message : String(e)}`;
    showMessage(text);
    log.add(text, 'error');
  } finally {
    btnStart.disabled = false;
  }
});

btnCalib.addEventListener('click', () => {
  if (!capture.running) return;
  hideMessage();
  capture.post({ type: 'calibrate', seconds: 2 });
  btnCalib.disabled = true;
  const t0 = performance.now();
  const tick = () => {
    if (!btnCalib.disabled) return;
    const left = Math.max(0, 2 - (performance.now() - t0) / 1000);
    btnCalib.textContent = left > 0 ? `Тихо… ${left.toFixed(1)}` : 'Считаю…';
    requestAnimationFrame(tick);
  };
  tick();
  log.add('Калибровка шума: 2 с тишины');
});

// --- Отрисовка (rAF, только последний кадр) ---
let drawnFrame: FrameEvent | null = null;
function render(): void {
  if (mode === 'song' && !picker.visible) {
    // Единственный источник времени — AudioContext.currentTime; без звука песня стоит
    const ctx = capture.ctx;
    const t = ctx && ctx.state === 'running' ? ctx.currentTime : null;
    if (t !== null) {
      if (playMode === 'tempo') {
        const wasLeadIn = player.beat < 0;
        const wasWaiting = player.waiting;
        player.tick(t);
        if (wasLeadIn !== player.beat < 0 || wasWaiting !== player.waiting) updateSongStatus();
      } else {
        const wasWaiting = player.waiting;
        if (lastAudioT !== null) player.advance(Math.min(0.1, t - lastAudioT));
        if (wasWaiting !== player.waiting) updateSongStatus();
      }
      lastAudioT = t;
      if (player.finished && !songDoneShown) {
        songDoneShown = true;
        showSongDone();
      }
    } else lastAudioT = null;
    falling.draw(player, t ?? performance.now() / 1000, playMode);
  }
  // Экраны выбора и «Готово!» — клавиатура не нужна и закрывает кнопки
  appEl.classList.toggle('song-overlay', mode === 'song' && (picker.visible || !songDone.classList.contains('hidden')));
  const f = latestFrame;
  if (f && f !== drawnFrame) {
    drawnFrame = f;
    if (mode !== 'song') readout.updateFrame(f);
    if (mode === 'free') keyboard.setOnly('detected', f.stableMidi !== null ? [f.stableMidi] : []);
    debug.draw(f, params.gateDb);
  }
  requestAnimationFrame(render);
}
requestAnimationFrame(render);

setMode('free');
refreshInfo();
void checkForUpdate(__BUILD_ID__, () => !capture.running, (m) => log.add(m, 'info'));
