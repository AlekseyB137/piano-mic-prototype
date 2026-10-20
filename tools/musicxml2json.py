#!/usr/bin/env python3
"""
Конвертер MusicXML → JSON песни для режима «Песня».

Формат на выходе (см. CLAUDE.md, src/song/types.ts):
  {"id", "title", "bpm", "notes": [{"pitch", "name", "start", "dur", "hand", "finger"}]}
  start и dur — в четвертях (долях), hand — "R" | "L", finger — 1..5.

Правила:
  * Фортепианная партитура: верхний нотный стан — правая рука, нижний — левая
    (music21 отдаёт их двумя частями PartStaff). Можно указать --hands R|L|both.
  * Повторы раскрываются, залигованные ноты сливаются, форшлаги пропускаются.
  * Темп — из первой метрономической отметки (в четвертях), иначе --bpm (по умолчанию 80).
  * Аппликатура — из <fingering>. Где её нет, ставится оценка по позиции руки
    (пять соседних белых клавиш), такие ноты помечаются "fingerAuto": true и печатаются
    предупреждения — их нужно проверить вручную.

Запуск (из корня проекта):
  tools/.venv/bin/python tools/musicxml2json.py путь/к/пьесе.mxl -o src/songs/pieza.json \\
      --title "Название" [--measures 1-8] [--bpm 72] [--hands both] [--order 50]
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from music21 import articulations, chord, converter, corpus, note, stream, tempo

NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
WHITE = {0, 2, 4, 5, 7, 9, 11}


def midi_name(m: int) -> str:
    """Имя ноты как в приложении: диезы, октава по научной нотации (C4 = 60)."""
    return f'{NOTE_NAMES[m % 12]}{m // 12 - 1}'


def white_index(m: int) -> int:
    """Номер белой клавиши (для оценки пальцев по позиции); чёрная — как ближайшая белая снизу."""
    octave, pc = divmod(m, 12)
    while pc not in WHITE:
        pc -= 1
    return octave * 7 + sorted(WHITE).index(pc)


def load_score(src: str) -> stream.Score:
    if src.startswith('corpus:'):
        return corpus.parse(src[len('corpus:'):])
    return converter.parse(src)


def fingers_of(el: note.NotRest) -> list[int | None]:
    """Пальцы из <fingering>: для аккорда — по порядку нот аккорда (снизу вверх)."""
    fs = [a.fingerNumber for a in el.articulations if isinstance(a, articulations.Fingering)]
    fs = [int(f) if f is not None and str(f).isdigit() else None for f in fs]
    if isinstance(el, chord.Chord):
        n = len(el.pitches)
        own = [None] * n
        # Пальцы, записанные на самих нотах аккорда, важнее
        for i, sub in enumerate(el.notes):
            sf = [a.fingerNumber for a in sub.articulations if isinstance(a, articulations.Fingering)]
            if sf and str(sf[0]).isdigit():
                own[i] = int(sf[0])
        for i in range(n):
            if own[i] is None and i < len(fs):
                own[i] = fs[i]
        return own
    return [fs[0] if fs else None]


def extract_part(part: stream.Stream, hand: str) -> list[dict]:
    part = part.stripTies(inPlace=False)
    out = []
    for el in part.flatten().notes:
        if el.duration.isGrace or el.quarterLength <= 0:
            continue
        pitches = el.pitches if isinstance(el, chord.Chord) else [el.pitch]
        order = sorted(range(len(pitches)), key=lambda i: pitches[i].midi)
        fs = fingers_of(el)
        for i in order:
            m = int(round(pitches[i].ps))
            f = fs[i] if i < len(fs) else None
            out.append({
                'pitch': m,
                'name': midi_name(m),
                'start': round(float(el.offset), 4),
                'dur': round(float(el.quarterLength), 4),
                'hand': hand,
                'finger': f,
            })
    return out


def auto_fingering(notes: list[dict]) -> int:
    """
    Простая оценка пальцев для нот без аппликатуры: рука стоит в позиции из пяти соседних
    белых клавиш; нота вне позиции переносит её (вверх — на неё ставится палец 1 у правой руки,
    вниз — 5; у левой руки зеркально). Возвращает число оценённых нот.
    """
    count = 0
    for hand in ('R', 'L'):
        seq = sorted((n for n in notes if n['hand'] == hand), key=lambda n: (n['start'], n['pitch']))
        anchor = None  # нижний край позиции: под пальцем 1 у правой руки, под пальцем 5 у левой
        for n in seq:
            w = white_index(n['pitch'])
            if anchor is None:
                anchor = w  # первая нота — на нижнем краю позиции (правая: 1, левая: 5)
            if w < anchor:
                anchor = w if hand == 'R' else w - 4
            elif w > anchor + 4:
                anchor = w - 4 if hand == 'R' else w
            if n['finger'] is None:
                rel = w - anchor  # 0..4 от нижнего края позиции
                n['finger'] = rel + 1 if hand == 'R' else 5 - rel
                n['fingerAuto'] = True
                count += 1
    return count


def detect_bpm(score: stream.Score) -> float | None:
    for mm in score.recurse().getElementsByClass(tempo.MetronomeMark):
        q = mm.getQuarterBPM()
        if q:
            return float(q)
    return None


def convert(src: str, *, measures: tuple[int, int] | None, hands: str, bpm: float | None,
            title: str | None, song_id: str | None, order: int | None) -> tuple[dict, list[str]]:
    warnings: list[str] = []
    score = load_score(src)
    try:
        score = score.expandRepeats()
    except Exception as e:  # noqa: BLE001 — партитуры без повторов или с нестандартными
        warnings.append(f'повторы не раскрыты: {e}')
    parts = list(score.parts)
    if not parts:
        raise SystemExit('в партитуре нет партий')
    if len(parts) > 2:
        warnings.append(f'партий {len(parts)}: взяты первые две (правая и левая рука)')
    roles = [('R', parts[0])] + ([('L', parts[1])] if len(parts) > 1 else [])
    if len(parts) == 1:
        warnings.append('одна партия — все ноты отнесены к правой руке')

    notes: list[dict] = []
    first_offset = None
    for hand, part in roles:
        if hands != 'both' and hand != hands:
            continue
        if measures:
            part = part.measures(measures[0], measures[1])
        ns = extract_part(part, hand)
        notes += ns
    if not notes:
        raise SystemExit('нет нот (проверьте --measures и --hands)')
    # Отсчёт от первой ноты выбранного фрагмента
    first_offset = min(n['start'] for n in notes)
    for n in notes:
        n['start'] = round(n['start'] - first_offset, 4)

    auto = auto_fingering(notes)
    if auto:
        warnings.append(f'аппликатура оценена автоматически для {auto} нот из {len(notes)} '
                        f'(помечены "fingerAuto": true) — проверьте вручную')

    found = detect_bpm(score)
    final_bpm = bpm or found or 80
    if not bpm and not found:
        warnings.append('темп не указан в партитуре — взято 80 (задайте --bpm)')

    md = score.metadata
    t = title or (md.title if md and md.title else None) or Path(src.split(':')[-1]).stem
    sid = song_id or re.sub(r'[^a-z0-9]+', '-', Path(src.split(':')[-1]).stem.lower()).strip('-')
    notes.sort(key=lambda n: (n['start'], n['pitch']))
    song = {'id': sid, 'title': t, 'bpm': round(final_bpm, 2), 'notes': notes}
    if order is not None:
        song['order'] = order
    return song, warnings


def parse_measures(s: str | None) -> tuple[int, int] | None:
    if not s:
        return None
    a, _, b = s.partition('-')
    return int(a), int(b or a)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description='MusicXML → JSON песни (см. CLAUDE.md)')
    ap.add_argument('src', help='файл .musicxml/.mxl/.xml или corpus:<путь> из корпуса music21')
    ap.add_argument('-o', '--out', help='куда записать JSON (по умолчанию — в stdout)')
    ap.add_argument('--title')
    ap.add_argument('--id', dest='song_id')
    ap.add_argument('--bpm', type=float, help='темп в четвертях в минуту (перекрывает партитуру)')
    ap.add_argument('--measures', help='фрагмент: «1-8»')
    ap.add_argument('--hands', choices=['both', 'R', 'L'], default='both')
    ap.add_argument('--order', type=int, help='порядок на экране выбора (меньше — раньше)')
    a = ap.parse_args(argv)
    song, warnings = convert(a.src, measures=parse_measures(a.measures), hands=a.hands, bpm=a.bpm,
                             title=a.title, song_id=a.song_id, order=a.order)
    text = json.dumps(song, ensure_ascii=False, indent=1)
    if a.out:
        Path(a.out).write_text(text + '\n', encoding='utf-8')
        print(f'✓ {a.out}: «{song["title"]}», {len(song["notes"])} нот, ♩ = {song["bpm"]}', file=sys.stderr)
    else:
        print(text)
    for w in warnings:
        print(f'⚠ {w}', file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
