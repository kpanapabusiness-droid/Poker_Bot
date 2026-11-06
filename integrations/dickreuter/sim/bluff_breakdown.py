"""
Where do the coach's bluff fold estimates go wrong? For postflop bets on one street (default river),
predicted vs actual "everyone folded", broken down by bet size, board texture, position, our hand and
opponent. python bluff_breakdown.py detail.csv [street] [tag]
"""
import collections
import csv
import sys


def rows(path, street='r', tag='BLUFF'):
    for r in csv.DictReader(open(path, newline='')):
        if not r['bot'].startswith('coach') or not r.get('agg'):
            continue
        opp = next((b for b in r['bot'].split() if False), None)
        for item in r['agg'].split(';'):
            if item.count(':') < 3 or '|' not in item:
                continue
            head, *extra = item.split('|')
            st, tg, fe, res = head.split(':')[:4]
            if st != street or (tag and tg != tag) or not fe:
                continue
            size, texture, pos, hand, opps = (extra + [''] * 5)[:5]
            yield {'fe': float(fe), 'fold': res == 'F', 'size': float(size or 0), 'texture': texture, 'pos': pos, 'hand': hand,
                   'opps': opps, 'bb': float(r['result_bb'])}


def table(items, key, title):
    g = collections.defaultdict(list)
    for x in items:
        g[key(x)].append(x)
    print(f"\n{title:<22}{'bets':>6}{'expected':>10}{'actual':>8}{'gap':>7}")
    for k, xs in sorted(g.items(), key=lambda kv: -len(kv[1])):
        e = sum(x['fe'] for x in xs) / len(xs); a = sum(x['fold'] for x in xs) / len(xs)
        print(f"{str(k):<22}{len(xs):>6}{e:>10.0%}{a:>8.0%}{a - e:>+7.0%}")


if __name__ == '__main__':
    files = sys.argv[1].split(',')
    street = sys.argv[2] if len(sys.argv) > 2 else 'r'
    tag = sys.argv[3] if len(sys.argv) > 3 else 'BLUFF'
    items = []
    for f in files:
        name = f.split('_')[-1].replace('.csv', '')
        for x in rows(f, street, tag):
            x['opponent'] = name
            items.append(x)
    if not items:
        sys.exit('no matching bets')
    table(items, lambda x: x['opponent'], 'opponent')
    table(items, lambda x: '<40% pot' if x['size'] < 0.4 else '40-80% pot' if x['size'] < 0.8 else '80%+ pot', 'bet size')
    table(items, lambda x: x['texture'], 'board')
    table(items, lambda x: x['pos'], 'position')
    table(items, lambda x: x['hand'], 'our hand')
