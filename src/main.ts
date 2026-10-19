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

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

// --- Сохранение настроек между запусками (только удобство; без storage тоже работает) ---
const LS_PARAMS = 'pianoMic.params';
/** Увеличивать при смене значений по умолчанию — старые сохранённые пороги сбросятся. */
const PARAMS_VERSION = 4;
const LS_FFT = 'pianoMic.fft';
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
function sendExpected(): void {
  const midis = mode === 'check' ? [...expected].sort((a, b) => a - b) : [];
  capture.post({ type: 'expected', midis });
  readout.setExpected(midis);
  keyboard.setOnly('expected', midis);
  keyboard.clear('pass');
  keyboard.clear('fail');
  debug.markers = midis.map((m) => midiToFreq(m));
}

function setMode(m: Mode): void {
  mode = m;
  document.querySelectorAll<HTMLButtonElement>('#mode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
  readout.setMode(m);
  keyboard.clear('detected');
  sendExpected();
}

$('#mode').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-mode]');
  if (b) setMode(b.dataset.mode as Mode);
});

keyboard.onTap = (midi) => {
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
      readout.setResult(ev);
      lastCheckLatency = ev.latencyMs;
      for (const n of ev.notes) {
        keyboard.mark(n.midi, 'pass', n.passed);
        keyboard.mark(n.midi, 'fail', !n.passed);
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
    sendExpected();
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
  const f = latestFrame;
  if (f && f !== drawnFrame) {
    drawnFrame = f;
    readout.updateFrame(f);
    if (mode === 'free') keyboard.setOnly('detected', f.stableMidi !== null ? [f.stableMidi] : []);
    debug.draw(f, params.gateDb);
  }
  requestAnimationFrame(render);
}
requestAnimationFrame(render);

setMode('free');
refreshInfo();
void checkForUpdate(__BUILD_ID__, () => !capture.running, (m) => log.add(m, 'info'));
