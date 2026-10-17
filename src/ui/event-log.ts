export type LogKind = 'info' | 'onset' | 'note' | 'pass' | 'fail' | 'error';

interface Entry {
  wall: string;
  audio: string;
  text: string;
  kind: LogKind;
}

const MAX = 20;

function wallTime(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** Лог последних 20 событий распознавания. */
export class EventLog {
  private readonly entries: Entry[] = [];
  private readonly list: HTMLElement;

  constructor(container: HTMLElement) {
    this.list = container;
  }

  add(text: string, kind: LogKind = 'info', audioT?: number): void {
    this.entries.unshift({ wall: wallTime(), audio: audioT !== undefined ? `${audioT.toFixed(3)}s` : '', text, kind });
    if (this.entries.length > MAX) this.entries.length = MAX;
    this.render();
  }

  clear(): void {
    this.entries.length = 0;
    this.render();
  }

  toText(): string {
    return this.entries.map((e) => `${e.wall}${e.audio ? ` [${e.audio}]` : ''} ${e.text}`).join('\n');
  }

  private render(): void {
    this.list.replaceChildren(
      ...this.entries.map((e) => {
        const li = document.createElement('li');
        li.className = `log-${e.kind}`;
        const time = document.createElement('time');
        time.textContent = e.wall;
        if (e.audio) time.title = `время аудио ${e.audio}`;
        li.append(time, document.createTextNode(' ' + e.text));
        return li;
      }),
    );
  }
}
