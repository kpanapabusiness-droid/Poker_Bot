"""
How good are the coach's fold estimates? For each street and bet type: how often it bet, the fold
chance it expected, how often everyone actually folded, and the hands' results.
    python fold_report.py detail.csv
"""
import collections
import csv
import sys


def report(path):
    st = collections.defaultdict(lambda: {'n': 0, 'est': 0.0, 'folds': 0, 'bb': 0.0})
    face = collections.defaultdict(lambda: {'n': 0, 'eq': 0.0, 'need': 0.0, 'won': 0.0})
    for r in csv.DictReader(open(path, newline='')):
        if not r['bot'].startswith('coach') or not r.get('agg'):
            continue
        seen = set()
        for item in r['agg'].split(';'):
            street, tag, fe, res = item.split(':')
            if tag.startswith('FACE-'):
                eq, need = (float(x) for x in fe.split('/'))
                f = face[(street, tag)]
                f['n'] += 1; f['eq'] += eq; f['need'] += need; f['won'] += {'W': 1, 'T': 0.5}.get(res, 0)
                continue
            k = (street, tag)
            s = st[k]
            s['n'] += 1
            s['est'] += float(fe) if fe else 0.0
            s['folds'] += res == 'F'
            if k not in seen:
                s['bb'] += float(r['result_bb'])
                seen.add(k)
    rows = sorted(st.items(), key=lambda kv: (('f', 't', 'r').index(kv[0][0]) if kv[0][0] in 'ftr' else 9, -kv[1]['n']))
    print(f"{'street':<6}{'type':<12}{'bets':>7}{'expected fold':>15}{'actual fold':>13}{'hands bb':>10}")
    for (street, tag), s in rows:
        print(f"{street:<6}{tag:<12}{s['n']:>7}{s['est'] / s['n']:>15.0%}{s['folds'] / s['n']:>13.0%}{s['bb']:>10.0f}")
    print(f"\nFacing a bet: predicted equity vs how often we'd really have won at showdown (vs the bettor, full board)")
    print(f"{'street':<6}{'decision':<12}{'count':>7}{'predicted':>11}{'real':>7}{'price':>8}")
    for (street, tag), f in sorted(face.items()):
        print(f"{street:<6}{tag[5:]:<12}{f['n']:>7}{f['eq'] / f['n']:>11.0%}{f['won'] / f['n']:>7.0%}{f['need'] / f['n']:>8.0%}")


if __name__ == '__main__':
    report(sys.argv[1])
