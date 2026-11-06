"""
Compare two simulator runs of the coach deck by deck (paired), which is far more precise than
comparing their overall bb/100: both runs play the same decks, so most of the luck cancels.

    python run_sim.py --hands 1500 --lineup humans --seed 61 --detail before.csv
    POKER_COACH_MODEL='{"depth":{"on":false}}' python run_sim.py --hands 1500 --lineup humans --seed 61 --detail after.csv
    python compare.py before.csv after.csv

Both runs need the same --seed, --hands, --seats, --stack and lineup. A change is only real if it's
bigger than its ± range.
"""
import collections
import csv
import math
import sys


def per_deck(path, bot_prefix='coach'):
    """Coach result per deck (bb, summed over every seat it played that deck from), and seats per deck."""
    total, seats = collections.defaultdict(float), collections.Counter()
    with open(path, newline='') as f:
        for r in csv.DictReader(f):
            if r['bot'].startswith(bot_prefix):
                total[int(r['deck'])] += float(r['result_bb'])
                seats[int(r['deck'])] += 1
    return total, seats


def compare(a_path, b_path, bot_prefix='coach'):
    a, na = per_deck(a_path, bot_prefix)
    b, _ = per_deck(b_path, bot_prefix)
    decks = sorted(set(a) & set(b))
    if len(decks) < 2:
        raise SystemExit('the two runs share fewer than 2 decks: same --seed and --hands?')
    rot = max(1, round(sum(na[d] for d in decks) / len(decks)))
    diff = [(b[d] - a[d]) / rot for d in decks]
    m = sum(diff) / len(diff)
    sd = math.sqrt(sum((x - m) ** 2 for x in diff) / (len(diff) - 1))
    return {'change_bb100': m * 100, 'ci95': 1.96 * sd / math.sqrt(len(diff)) * 100, 'decks': len(decks)}


if __name__ == '__main__':
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    r = compare(sys.argv[1], sys.argv[2])
    verdict = 'better' if r['change_bb100'] > r['ci95'] else 'worse' if r['change_bb100'] < -r['ci95'] else 'no clear difference'
    print(f"change: {r['change_bb100']:+.1f} bb/100 ± {r['ci95']:.1f}  ({r['decks']} decks)  → {verdict}")
