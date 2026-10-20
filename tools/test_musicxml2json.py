"""
Тест конвертера MusicXML → JSON. Запуск: npm run test:convert
Собирает MusicXML из песни src/songs/twinkle-2h.json (два стана, аппликатура, темп),
конвертирует обратно и сравнивает ноты; плюс лиги, аккорды с пальцами, автоаппликатура.
"""
import json
import sys
import tempfile
from pathlib import Path

from music21 import articulations, chord, layout, meter, note, stream, tempo, tie

sys.path.insert(0, str(Path(__file__).parent))
from musicxml2json import convert  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
ok = fail = 0


def expect(name, cond, detail=''):
    global ok, fail
    if cond:
        ok += 1
    else:
        fail += 1
    print(('✓ ' if cond else '✗ ') + name + ('' if cond else f'  — {detail}'))


def to_score(song: dict) -> stream.Score:
    sc = stream.Score()
    for hand in ('R', 'L'):
        ps = stream.PartStaff()
        ps.append(meter.TimeSignature('4/4'))
        if hand == 'R':
            ps.append(tempo.MetronomeMark(number=song['bpm']))
        by_start: dict[float, list[dict]] = {}
        for n in song['notes']:
            if n['hand'] == hand:
                by_start.setdefault(n['start'], []).append(n)
        t = 0.0
        for start in sorted(by_start):
            if start > t:
                ps.append(note.Rest(quarterLength=start - t))
            grp = sorted(by_start[start], key=lambda n: n['pitch'])
            if len(grp) == 1:
                el = note.Note(grp[0]['pitch'], quarterLength=grp[0]['dur'])
                el.articulations.append(articulations.Fingering(grp[0]['finger']))
            else:
                el = chord.Chord([g['pitch'] for g in grp], quarterLength=grp[0]['dur'])
                for g in grp:
                    el.articulations.append(articulations.Fingering(g['finger']))
            ps.append(el)
            t = start + grp[0]['dur']
        sc.insert(0, ps)
    sc.insert(0, layout.StaffGroup(list(sc.parts), symbol='brace'))
    return sc


def main():
    tmp = Path(tempfile.mkdtemp(prefix='mx2json-'))

    # 1. Туда-обратно: Twinkle двумя руками
    src = json.loads((ROOT / 'src/songs/twinkle-2h.json').read_text(encoding='utf-8'))
    p = tmp / 'twinkle2h.musicxml'
    to_score(src).write('musicxml', fp=str(p))
    song, warns = convert(str(p), measures=None, hands='both', bpm=None, title='T', song_id='t', order=None)
    key = lambda n: (n['start'], n['pitch'], n['dur'], n['hand'], n['finger'])
    a = sorted(map(key, src['notes']))
    b = sorted(map(key, song['notes']))
    expect('Twinkle 2 руки: все ноты совпали (высота, начало, длительность, рука, палец)', a == b,
           f'{len(a)} vs {len(b)}; первые различия: {[x for x in a if x not in b][:3]} / {[x for x in b if x not in a][:3]}')
    expect('Twinkle 2 руки: темп из партитуры', song['bpm'] == src['bpm'], song['bpm'])
    expect('Twinkle 2 руки: без предупреждений об аппликатуре', not any('аппликатура' in w for w in warns), warns)

    # 2. Фрагмент по тактам: такты 2–3 (доли 4..11 исходной), отсчёт с нуля
    song2, _ = convert(str(p), measures=(2, 3), hands='R', bpm=None, title=None, song_id=None, order=None)
    exp2 = sorted((n['start'] - 4, n['pitch']) for n in src['notes'] if n['hand'] == 'R' and 4 <= n['start'] < 12)
    got2 = sorted((n['start'], n['pitch']) for n in song2['notes'])
    expect('Фрагмент --measures 2-3 --hands R', exp2 == got2, f'{exp2[:4]} vs {got2[:4]}')

    # 3. Лиги, аккорд с пальцами, ноты без пальцев
    sc = stream.Score()
    r = stream.PartStaff()
    n1 = note.Note('C4', quarterLength=1)
    n1.tie = tie.Tie('start')
    n1.articulations.append(articulations.Fingering(1))
    n2 = note.Note('C4', quarterLength=1)
    n2.tie = tie.Tie('stop')
    ch = chord.Chord(['E4', 'G4'], quarterLength=2)
    ch.articulations += [articulations.Fingering(3), articulations.Fingering(5)]
    r.append([n1, n2, ch, note.Note('D4', quarterLength=1), note.Note('A4', quarterLength=1)])
    l = stream.PartStaff()
    l.append([note.Note('C3', quarterLength=2), note.Note('G2', quarterLength=2), note.Note('F2', quarterLength=2)])
    sc.insert(0, r)
    sc.insert(0, l)
    p3 = tmp / 'mini.musicxml'
    sc.write('musicxml', fp=str(p3))
    s3, w3 = convert(str(p3), measures=None, hands='both', bpm=72, title=None, song_id=None, order=5)
    R = [n for n in s3['notes'] if n['hand'] == 'R']
    c4 = [n for n in R if n['pitch'] == 60]
    expect('Лига: две залигованные C4 слились в одну длиной 2', len(c4) == 1 and c4[0]['dur'] == 2, c4)
    eg = {n['pitch']: n['finger'] for n in R if n['start'] == 2}
    expect('Аккорд: пальцы по нотам (E4→3, G4→5)', eg == {64: 3, 67: 5}, eg)
    autoR = {n['pitch']: n['finger'] for n in R if n.get('fingerAuto')}
    expect('Автоаппликатура правой руки помечена (D4, A4)', set(autoR) == {62, 69}, autoR)
    L = sorted((n['start'], n['pitch'], n['finger']) for n in s3['notes'] if n['hand'] == 'L')
    expect('Автоаппликатура левой руки: первая (нижняя) нота позиции — палец 5', L[0][2] == 5, L)
    expect('Автоаппликатура левой руки: пальцы 1..5 и помечены',
           all(1 <= f <= 5 for _, _, f in L) and all(n.get('fingerAuto') for n in s3['notes'] if n['hand'] == 'L'), L)
    expect('Предупреждение про автоаппликатуру и заданный темп', any('аппликатура' in w for w in w3) and s3['bpm'] == 72, w3)
    expect('Поле order записано', s3.get('order') == 5)

    print(f'\nИтого: {ok} ✓, {fail} ✗')
    sys.exit(1 if fail else 0)


if __name__ == '__main__':
    main()
