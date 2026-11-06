"""
No-limit hold'em table for the simulator: blinds, betting, min-raises, all-ins, side pots, showdown.
Seats act through a callback with a "view" shaped like what dickreuter reads off the screen.
"""
import itertools
import random

RANKS = '23456789TJQKA'
SUITS = 'CDHS'
DECK = [r + s for r in RANKS for s in SUITS]


def hand_rank(cards):
    """Best 5-card rank of 5-7 cards (bigger is better). Cards like 'AS', 'TD'."""
    best = None
    for combo in itertools.combinations(cards, 5):
        r = _rank5(combo)
        if best is None or r > best:
            best = r
    return best


def _rank5(c):
    vals = sorted((RANKS.index(x[0]) for x in c), reverse=True)
    flush = len({x[1] for x in c}) == 1
    uniq = sorted(set(vals), reverse=True)
    straight_high = None
    if len(uniq) == 5:
        if uniq[0] - uniq[4] == 4:
            straight_high = uniq[0]
        elif uniq == [12, 3, 2, 1, 0]:
            straight_high = 3
    counts = sorted(((vals.count(v), v) for v in uniq), reverse=True)
    if straight_high is not None and flush:
        return (8, straight_high)
    if counts[0][0] == 4:
        return (7, counts[0][1], counts[1][1])
    if counts[0][0] == 3 and counts[1][0] == 2:
        return (6, counts[0][1], counts[1][1])
    if flush:
        return (5, *vals)
    if straight_high is not None:
        return (4, straight_high)
    if counts[0][0] == 3:
        return (3, counts[0][1], *[v for _, v in counts[1:]])
    if counts[0][0] == 2 and counts[1][0] == 2:
        return (2, counts[0][1], counts[1][1], counts[2][1])
    if counts[0][0] == 2:
        return (1, counts[0][1], *[v for _, v in counts[1:]])
    return (0, *vals)


class Table:
    """
    players: list of objects with .act(view) -> (action, amount) where action is one of
    'fold', 'check', 'call', 'raise' (amount = total "raise to" for this street).
    """

    def __init__(self, players, bb=2.0, start_stack=200.0, names=None):
        self.players = players
        self.n = len(players)
        self.bb, self.sb = bb, bb / 2
        self.start_stack = start_stack
        self.names = names or ['P%d' % i for i in range(self.n)]

    def play(self, deck, button, on_action=None):
        """Play one hand with this deck order. Returns per-seat net result and a hand record."""
        n = self.n
        stacks = [self.start_stack] * n
        hole = [[deck[2 * i], deck[2 * i + 1]] for i in range(n)]
        board_cards = deck[2 * n:2 * n + 5]
        committed = [0.0] * n  # whole hand
        street_put = [0.0] * n
        folded = [False] * n
        allin = [False] * n
        board = []
        record = {'button': button, 'hole': hole, 'board': board_cards, 'actions': []}
        for p in self.players:
            if hasattr(p, 'new_hand'):
                p.new_hand()

        def put(i, amt):
            amt = min(amt, stacks[i])
            stacks[i] -= amt
            street_put[i] += amt
            committed[i] += amt
            if stacks[i] <= 1e-9:
                stacks[i] = 0.0
                allin[i] = True

        sb_seat = (button + 1) % n if n > 2 else button
        bb_seat = (button + 2) % n if n > 2 else (button + 1) % n
        put(sb_seat, self.sb)
        put(bb_seat, self.bb)

        known_when_closed = None  # board cards seen when betting stopped for good (all-in before the river)
        prev_nboard = 0
        for street, nboard in (('preflop', 0), ('flop', 3), ('turn', 4), ('river', 5)):
            board[:] = board_cards[:nboard]
            if street != 'preflop':
                street_put = [0.0] * n
            live = [i for i in range(n) if not folded[i]]
            if len(live) == 1:
                break
            can_act = [i for i in live if not allin[i]]
            if not can_act or (len(can_act) == 1 and street_put[can_act[0]] >= max(street_put) - 1e-9):
                if known_when_closed is None and street != 'preflop':
                    known_when_closed = prev_nboard
                prev_nboard = nboard
                continue  # nobody left to bet against: just deal the cards
            prev_nboard = nboard
            level = max(street_put)
            last_raise = self.bb
            idx = (bb_seat + 1) % n if street == 'preflop' else (button + 1) % n
            acted = set()
            while True:
                need = [x for x in range(n) if not folded[x] and not allin[x] and (x not in acted or street_put[x] < level - 1e-9)]
                if not need or sum(1 for x in range(n) if not folded[x]) == 1:
                    break
                others_can_act = [x for x in range(n) if not folded[x] and not allin[x]]
                if len(others_can_act) == 1 and street_put[others_can_act[0]] >= level - 1e-9:
                    break
                i = next((idx + k) % n for k in range(n) if (idx + k) % n in need)
                idx = (i + 1) % n
                to_call = max(0.0, level - street_put[i])
                can_raise = stacks[i] > to_call + 1e-9 and i not in acted
                min_raise_to = min(level + max(last_raise, self.bb), street_put[i] + stacks[i]) if can_raise else None
                v = self._view(i, button, hole, board, stacks, street_put, committed, folded, to_call, min_raise_to, street)
                action, amount = self.players[i].act(v)
                if action == 'fold' and to_call <= 0:
                    action = 'check'
                if action == 'raise' and not can_raise:
                    action = 'call' if to_call > 0 else 'check'
                if action == 'call' and to_call <= 0:
                    action = 'check'
                if action == 'fold':
                    folded[i] = True
                elif action == 'call':
                    put(i, to_call)
                elif action == 'raise':
                    target = max(float(amount), min_raise_to)
                    target = min(target, street_put[i] + stacks[i])
                    raise_by = target - level
                    put(i, target - street_put[i])
                    if raise_by >= last_raise - 1e-9:
                        last_raise = raise_by
                        acted = {i}  # a full raise reopens the betting
                    if street_put[i] > level:
                        level = street_put[i]
                acted.add(i)
                record['actions'].append((street, i, action, round(street_put[i], 4)))
                if on_action:
                    on_action(street, i, action, street_put[i])

        # showdown / award
        live = [i for i in range(n) if not folded[i]]
        result = [-committed[i] for i in range(n)]
        if len(live) == 1:
            result[live[0]] += sum(committed)
            record['showdown'] = False
            record['result_ev'] = list(result)
        else:
            for i, won in enumerate(_award(committed, live, {i: hand_rank(hole[i] + board_cards) for i in live})):
                result[i] += won
            record['showdown'] = True
            record['result_ev'] = list(result)
            if known_when_closed is not None and known_when_closed < 5:
                # Everyone left was all-in before the river: score each player by their share of the
                # pot over every way the rest of the board could have come (luck-free result).
                ev = all_in_ev(hole, board_cards[:known_when_closed], committed, live, deck)
                record['result_ev'] = [-committed[i] + ev[i] for i in range(n)]
                record['allin_at'] = known_when_closed
        record['result'] = result
        return result, record

    def _view(self, i, button, hole, board, stacks, street_put, committed, folded, to_call, min_raise_to, street):
        n = self.n
        rel = lambda seat: (seat - i) % n  # 0 = this player, 1 = next to their left
        ordered = [(i + k) % n for k in range(n)]
        total = sum(committed)
        return {
            'n': n, 'street': street, 'hero_cards': hole[i], 'board': list(board),
            'dealer': rel(button),
            'in_hand': [rel(s) for s in ordered if not folded[s]],
            'stacks': [stacks[s] for s in ordered],
            'bets': [street_put[s] for s in ordered],
            'total_pot': total, 'round_pot': total - sum(street_put),
            'to_call': to_call, 'min_raise_to': min_raise_to,
            'names': {k: self.names[ordered[k]] for k in range(1, n)},
            'bb': self.bb,
        }


def _award(committed, live, ranks):
    """Chips each seat wins at showdown (main pot and side pots), given each live seat's hand rank."""
    won = [0.0] * len(committed)
    levels = sorted(set(c for c in committed if c > 0))
    prev = 0.0
    for lv in levels:
        pot = sum(min(c, lv) - min(c, prev) for c in committed)
        eligible = [i for i in live if committed[i] >= lv - 1e-9]
        if pot <= 0:
            prev = lv
            continue
        if not eligible:  # only folded players put this much: give it back to the live players
            eligible = live
        best = max(ranks[i] for i in eligible)
        winners = [i for i in eligible if ranks[i] == best]
        for w in winners:
            won[w] += pot / len(winners)
        prev = lv
    return won


def all_in_ev(hole, known, committed, live, deck, samples=300):
    """Expected chips won by each seat when the rest of the board is still to come. Exact for one or
    two cards to come, otherwise `samples` random run-outs (seeded by the cards, so repeatable)."""
    used = set(known) | {c for i in live for c in hole[i]}
    rest = [c for c in DECK if c not in used]
    need = 5 - len(known)
    if need <= 2:
        boards = [list(x) for x in itertools.combinations(rest, need)]
    else:
        r = random.Random(''.join(sorted(used)))
        boards = [r.sample(rest, need) for _ in range(samples)]
    total = [0.0] * len(committed)
    for extra in boards:
        b = list(known) + extra
        won = _award(committed, live, {i: hand_rank(hole[i] + b) for i in live})
        for i in range(len(total)):
            total[i] += won[i]
    return [t / len(boards) for t in total]


def decks(count, seed=0):
    rng = random.Random(seed)
    for _ in range(count):
        d = DECK[:]
        rng.shuffle(d)
        yield d
