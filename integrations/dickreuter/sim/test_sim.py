"""Tests for the simulator's table engine, luck-free scoring and human players. Run: python3 test_sim.py"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import holdem  # noqa: E402
import humans  # noqa: E402

passed = failed = 0


def check(name, ok, detail=''):
    global passed, failed
    passed, failed = passed + ok, failed + (not ok)
    print(f"  {'✓' if ok else '✗'} {name} {'' if ok else detail}")


class Shove:
    def act(self, v):
        return ('raise', v['bets'][0] + v['stacks'][0]) if v['min_raise_to'] else ('call', 0)


class Fold:
    def act(self, v):
        return ('check', 0) if v['to_call'] <= 0 else ('fold', 0)


def deck_with(*first):
    return list(first) + [c for c in holdem.DECK if c not in first]


print('\nAll-in before the river is scored by equity')
r, rec = holdem.Table([Shove(), Shove()], bb=2, start_stack=200).play(deck_with('AS', 'AD', 'KS', 'KD'), 0)
share = (rec['result_ev'][0] + 200) / 400
check('AA vs KK preflop: AA gets about 82% of the pot', 0.77 <= share <= 0.87, share)
check('luck-free results still add up to zero', abs(sum(rec['result_ev'])) < 1e-6, rec['result_ev'])
check('the actual result is kept as well', abs(r[0]) == 200)

ev = holdem.all_in_ev([['AS', 'AD'], ['KS', 'KD']], ['2C', '7H', '9D', 'JC'], [100, 100], [0, 1], None)
check('one card to come: exact (KK has 2 outs of 44)', abs(ev[1] - 200 * 2 / 44) < 1e-6, ev)

r, rec = holdem.Table([Fold(), Shove()], bb=2, start_stack=200).play(holdem.DECK[:], 0)
check('no showdown: luck-free result is the actual result', rec['result_ev'] == r, (rec['result_ev'], r))

print('\nSide pots')
won = holdem._award([50, 200, 200], [0, 1, 2], {0: (9,), 1: (5,), 2: (1,)})
check('short stack with the best hand wins only the main pot; next best takes the side pot', won == [150, 300, 0], won)

print('\nHuman players')
h = humans.Human('fish', seed=3)
v = {'n': 6, 'street': 'preflop', 'hero_cards': ['7S', '6S'], 'board': [], 'dealer': 3, 'in_hand': [0, 1, 2, 3, 4, 5],
     'stacks': [198] * 6, 'bets': [0, 0, 0, 0, 1, 2], 'total_pot': 3, 'round_pot': 0, 'to_call': 2, 'min_raise_to': 4,
     'names': {}, 'bb': 2}
seq = []
for _ in range(2):
    h.reseed('deck7'); h.new_hand(); seq.append(h.act(dict(v)))
check('same deck key → same decision (so coach versions face the same humans)', seq[0] == seq[1], seq)
acts = set()
for k in range(300):
    h.reseed(f'k{k}'); h.new_hand(); acts.add(h.act(dict(v))[0])
check('but across hands the same spot gets different decisions (not a fixed rule)', len(acts) >= 2, acts)

print(f'\n{passed} passed, {failed} failed\n')
sys.exit(1 if failed else 0)
