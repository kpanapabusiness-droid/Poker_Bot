"""
Human-like opponents for the simulator: casual players with a style, not fixed rules.

Every decision is a weighted dice roll. A "fish" usually calls, but sometimes folds, sometimes raises,
and now and then does something odd. On top of that each player:
  - gets their own version of their style for the session (every number nudged up or down ~20%),
  - tilts: after a big loss they play looser and more aggressively for a while,
  - thinks in hand categories (air, draw, weak pair, top pair, two pair, set...) like people do,
  - sizes bets from their own habits, with noise, and tends to bet bigger when strong
    (a size tell, as real casual players have),
  - hardly changes how often they call between a small bet and a big one if they're a calling type
    ("inelastic"), while tight players fold much more to big bets.

The styles are starting guesses from what's written about low-stakes player pools. Once the tracker
has enough real Torn hands, set the numbers from real opponents (calibrate_from_tracker below).

    from humans import Human
    p = Human('fish', seed=3)
    p.act(view) -> ('fold' | 'check' | 'call' | 'raise', raise_to)
"""
import random

RANKS = '23456789TJQKA'

# vpip/pfr/three_bet/call_raise: share of all hands (0.35 = top 35%).
# call[...]: chance to continue vs a bet, by hand category, before the bet size is taken into account.
# elastic: how much more they fold as the bet gets bigger (0 = same at any size).
# bet[...]: chance to bet when checked to, by hand category. cbet: as the preflop raiser on the flop.
# raise_strong / raise_bluff: chance to raise a bet with a strong hand / with nothing.
# size: (small, big) bet sizes as a share of the pot; strong hands lean towards big.
STYLES = {
    'rec': dict(vpip=.35, pfr=.12, three_bet=.04, call_raise=.24, limp=.7, open_bb=(2.5, 4.0),
                call=dict(air=.12, draw=.55, weak=.55, top=.85, strong=.96), elastic=.35,
                bet=dict(air=.12, draw=.30, weak=.20, top=.65, strong=.80), cbet=.55,
                raise_strong=.30, raise_bluff=.03, size=(.4, .8), hero_call=.06, mistake=.06),
    'fish': dict(vpip=.50, pfr=.07, three_bet=.02, call_raise=.38, limp=.85, open_bb=(3.0, 5.0),
                 call=dict(air=.20, draw=.70, weak=.75, top=.92, strong=.98), elastic=.15,
                 bet=dict(air=.07, draw=.25, weak=.15, top=.55, strong=.70), cbet=.40,
                 raise_strong=.20, raise_bluff=.02, size=(.3, .6), hero_call=.12, mistake=.08),
    'station': dict(vpip=.60, pfr=.05, three_bet=.015, call_raise=.50, limp=.9, open_bb=(2.0, 3.0),
                    call=dict(air=.28, draw=.82, weak=.88, top=.97, strong=.99), elastic=.05,
                    bet=dict(air=.04, draw=.15, weak=.12, top=.45, strong=.60), cbet=.30,
                    raise_strong=.12, raise_bluff=.01, size=(.3, .5), hero_call=.20, mistake=.06),
    'nit': dict(vpip=.13, pfr=.10, three_bet=.035, call_raise=.07, limp=.2, open_bb=(3.0, 3.5),
                call=dict(air=.03, draw=.30, weak=.28, top=.65, strong=.95), elastic=.60,
                bet=dict(air=.06, draw=.25, weak=.15, top=.70, strong=.85), cbet=.60,
                raise_strong=.35, raise_bluff=.01, size=(.5, .75), hero_call=.02, mistake=.04),
    'tag': dict(vpip=.23, pfr=.18, three_bet=.07, call_raise=.12, limp=.1, open_bb=(2.5, 3.0),
                call=dict(air=.08, draw=.50, weak=.48, top=.80, strong=.97), elastic=.45,
                bet=dict(air=.28, draw=.45, weak=.30, top=.75, strong=.85), cbet=.65,
                raise_strong=.40, raise_bluff=.07, size=(.33, .75), hero_call=.05, mistake=.03),
    'maniac': dict(vpip=.55, pfr=.38, three_bet=.16, call_raise=.30, limp=.15, open_bb=(3.0, 6.0),
                   call=dict(air=.20, draw=.65, weak=.70, top=.90, strong=.98), elastic=.20,
                   bet=dict(air=.50, draw=.70, weak=.55, top=.85, strong=.90), cbet=.80,
                   raise_strong=.55, raise_bluff=.18, size=(.75, 1.3), hero_call=.10, mistake=.07),
}
STYLE_NAMES = tuple(STYLES)


# ── Preflop: hand strength as "top x% of hands" ──

def _chen(r1, r2, suited):
    vals = {'A': 10, 'K': 8, 'Q': 7, 'J': 6, 'T': 5}
    hi, lo = sorted((r1, r2), key=RANKS.index, reverse=True)
    s = vals.get(hi, (RANKS.index(hi) + 2) / 2)
    if hi == lo:
        return max(5, s * 2)
    s += 2 if suited else 0
    gap = RANKS.index(hi) - RANKS.index(lo) - 1
    s -= {0: 0, 1: 1, 2: 2, 3: 4}.get(gap, 5)
    if gap <= 1 and RANKS.index(hi) < RANKS.index('Q'):
        s += 1
    # tie-breaks so the order is strict-ish: higher cards first
    return s + RANKS.index(hi) * 0.01 + RANKS.index(lo) * 0.001


def _build_percentiles():
    hands = []
    for i, a in enumerate(RANKS):
        for b in RANKS[:i + 1]:
            if a == b:
                hands.append(((a, b, False), _chen(a, b, False), 6))
            else:
                hands.append(((a, b, True), _chen(a, b, True), 4))
                hands.append(((a, b, False), _chen(a, b, False), 12))
    hands.sort(key=lambda h: -h[1])
    out, done = {}, 0
    for key, _, combos in hands:
        out[key] = (done + combos / 2) / 1326
        done += combos
    return out


PCT = _build_percentiles()


def preflop_pct(cards):
    """0.0 = AA, 1.0 = the worst hand. 'Top 20%' means preflop_pct < 0.2."""
    a, b = cards[0][0], cards[1][0]
    hi, lo = sorted((a, b), key=RANKS.index, reverse=True)
    return PCT[(hi, lo, cards[0][1] == cards[1][1] and a != b)]


# ── Postflop: what a person thinks they have ──

def categorise(hole, board):
    """Returns (category, has_draw). category: air / draw / weak / top / strong."""
    import holdem
    rank = holdem.hand_rank(hole + board)[0]
    bvals = sorted((RANKS.index(c[0]) for c in board), reverse=True)
    hvals = [RANKS.index(c[0]) for c in hole]
    board_rank = holdem.hand_rank(board)[0] if len(board) >= 5 else None
    suits = [c[1] for c in hole + board]
    fd = any(suits.count(s) == 4 and any(c[1] == s for c in hole) for s in 'CDHS') and len(board) < 5
    allv = sorted(set(RANKS.index(c[0]) for c in hole + board) | ({-1} if any(c[0] == 'A' for c in hole + board) else set()))
    oesd = False
    if len(board) < 5:
        for lo in range(-1, 9):
            run = {lo, lo + 1, lo + 2, lo + 3}
            if run <= set(allv) and any(v in run or (v == 12 and -1 in run) for v in hvals):
                oesd = True
    draw = fd or oesd
    if board_rank is not None and rank == board_rank and rank >= 4:
        return ('air' if not draw else 'draw'), draw  # playing the board
    if rank >= 3:  # trips/set or better
        return 'strong', draw
    if rank == 2:
        paired_board = len(set(bvals)) < len(bvals)
        return ('top' if paired_board else 'strong'), draw  # two pair with a board pair is just one pair
    if rank == 1:
        pair = next(v for v in hvals + bvals if (hvals + bvals).count(v) >= 2)
        if hvals[0] == hvals[1] and pair > bvals[0]:
            return 'top', draw  # overpair
        if pair == bvals[0] and pair in hvals:
            kicker = max(v for v in hvals) if hvals[0] != hvals[1] else pair
            return ('top' if kicker >= 8 or pair >= 10 else 'weak'), draw
        return 'weak', draw
    if draw:
        return 'draw', True
    return 'air', False


class Human:
    """One casual player. kind: a name from STYLES."""

    def __init__(self, kind, seed=0, jitter=0.2):
        self.kind = kind
        self.seed = seed
        self.r = random.Random(f'{kind}-{seed}')
        base = STYLES[kind]
        j = lambda x: x * self.r.uniform(1 - jitter, 1 + jitter)
        self.s = {}
        for k, v in base.items():
            if isinstance(v, dict):
                self.s[k] = {kk: min(0.99, j(vv)) for kk, vv in v.items()}
            elif isinstance(v, tuple):
                self.s[k] = tuple(j(x) for x in v)
            else:
                self.s[k] = min(0.95, j(v)) if v < 1 else j(v)
        self.tilt = 0          # hands of tilt left
        self.recent = []       # last few results in bb
        self.new_hand()

    # ── called by the simulator ──
    def reseed(self, key):
        """Fresh dice for this hand: the same deck and table give the same dice, so two versions of
        the coach are compared on the same human decisions for as long as their play matches."""
        self.r = random.Random(f'{self.kind}-{self.seed}-{key}')

    def new_hand(self):
        self.pf_aggressor = False
        self.acted_street = None
        self.raises_this_street = 0
        self.hand_mood = self.r.gauss(0, 0.08)  # some hands you just feel like playing

    def hand_over(self, result_bb):
        self.recent = (self.recent + [result_bb])[-8:]
        if self.tilt > 0:
            self.tilt -= 1
        if result_bb <= -40 or sum(self.recent) <= -70:
            if self.r.random() < 0.6:
                self.tilt = self.r.randint(8, 30)

    def _p(self, name, sub=None):
        v = self.s[name][sub] if sub else self.s[name]
        if self.tilt:
            if name in ('vpip', 'pfr', 'three_bet', 'call_raise', 'raise_bluff', 'hero_call'):
                v *= 1.5
            elif name in ('bet', 'raise_strong', 'cbet'):
                v *= 1.25
        return max(0.0, min(0.98, v + (self.hand_mood if name in ('vpip', 'call_raise', 'call') else 0)))

    def act(self, v):
        if self.r.random() < self._p('mistake'):
            return self._random_action(v)
        return self._preflop(v) if not v['board'] else self._postflop(v)

    # ── helpers ──
    def _random_action(self, v):
        x = self.r.random()
        if v['to_call'] <= 0:
            return ('check', 0) if x < 0.7 or v['min_raise_to'] is None else ('raise', self._bet_to(v, self.r.choice(self.s['size'])))
        if x < 0.45:
            return ('fold', 0)
        if x < 0.9 or v['min_raise_to'] is None:
            return ('call', 0)
        return ('raise', self._raise_to(v))

    def _bet_to(self, v, frac):
        pot = v['total_pot']
        amt = max(v['bb'], pot * frac * self.r.uniform(0.85, 1.15))
        if self.r.random() < 0.5:  # people like round numbers
            amt = round(amt / v['bb']) * v['bb']
        return v['bets'][0] + amt

    def _raise_to(self, v, mult=None):
        level = v['bets'][0] + v['to_call']
        mult = mult or self.r.choice((2.2, 2.5, 3.0, 3.0, 3.5, 4.0))
        return max(v['min_raise_to'] or 0, level * mult)

    def _fold_or_check(self, v):
        return ('check', 0) if v['to_call'] <= 0 else ('fold', 0)

    # ── preflop ──
    def _preflop(self, v):
        pct = preflop_pct(v['hero_cards'])
        bb = v['bb']
        level = v['bets'][0] + v['to_call']
        can_raise = v['min_raise_to'] is not None
        r = self.r.random
        if level <= bb + 1e-9:  # nobody has raised
            # chips of exactly one big blind in front of others: the big blind (unless that's us) plus limpers
            limpers = sum(1 for b in v['bets'][1:] if abs(b - bb) < 1e-9) - (1 if v['to_call'] > 0 else 0)
            if pct < self._p('pfr') and can_raise:
                self.pf_aggressor = True
                size = self.r.uniform(*self.s['open_bb']) + max(0, limpers)
                return ('raise', round(size) * bb if r() < 0.6 else size * bb)
            if pct < self._p('vpip'):
                if v['to_call'] <= 0:  # big blind with a hand they like: sometimes raise the limpers
                    if can_raise and pct < self._p('pfr') * 1.5 and r() < 0.5:
                        return ('raise', (3 + max(0, limpers)) * bb)
                    return ('check', 0)
                if r() < self._p('limp') or not can_raise:
                    return ('call', 0)
                self.pf_aggressor = True
                return ('raise', round(self.r.uniform(*self.s['open_bb'])) * bb)
            return self._fold_or_check(v)
        raise_bb = level / bb
        if raise_bb <= 6:  # one raise
            if pct < self._p('three_bet') and can_raise:
                self.pf_aggressor = True
                return ('raise', self._raise_to(v, self.r.choice((3.0, 3.0, 3.5, 4.0))))
            width = self._p('call_raise') * (1.15 if raise_bb <= 3 else 0.85 if raise_bb >= 5 else 1.0)
            if pct < width:
                self.pf_aggressor = False
                return ('call', 0)
            return self._fold_or_check(v)
        # a re-raise or more
        if pct < 0.025 + (0.02 if self.tilt else 0):
            return ('raise', v['bets'][0] + v['stacks'][0]) if r() < 0.6 and can_raise else ('call', 0)
        price = v['to_call'] / max(1e-9, v['stacks'][0] + v['bets'][0])
        if pct < self._p('call_raise') * 0.3 * (1.3 if price < 0.15 else 0.8):
            return ('call', 0)
        return self._fold_or_check(v)

    # ── after the flop ──
    def _postflop(self, v):
        cat, draw = categorise(v['hero_cards'], v['board'])
        street = v['street']
        if street == 'river' and cat == 'draw':
            cat = 'air'
        r = self.r.random
        can_raise = v['min_raise_to'] is not None
        if self.acted_street != street:
            self.acted_street, self.raises_this_street = street, 0
        multiway = len(v['in_hand']) - 1
        if v['to_call'] <= 0:
            p = self._p('bet', cat)
            if street == 'flop' and self.pf_aggressor:
                p = max(p, self._p('cbet') * (1.0 if cat != 'air' else 0.8))
            if multiway >= 2 and cat in ('air', 'weak'):
                p *= 0.5
            if can_raise and r() < p:
                small, big = self.s['size']
                lean = {'strong': 0.75, 'top': 0.5, 'weak': 0.3, 'draw': 0.4, 'air': 0.35}[cat]
                frac = big if r() < lean else small
                self.raises_this_street += 1
                return ('raise', self._bet_to(v, frac))
            return ('check', 0)
        # facing a bet
        f = v['to_call'] / max(1e-9, v['total_pot'])  # bet as a share of the pot (the pot includes the bet)
        cont = self._p('call', cat) * max(0.05, 1 - self._p('elastic') * min(2.0, f) * 1.4)
        if street == 'river' and cat == 'air':
            cont = self._p('hero_call')
        if self.raises_this_street >= 1:
            cont *= 0.75  # they raised me back
        if can_raise and self.raises_this_street < 2:
            if cat == 'strong' and r() < self._p('raise_strong'):
                self.raises_this_street += 1
                return ('raise', self._raise_to(v))
            if cat in ('air', 'draw') and street != 'river' and r() < self._p('raise_bluff') * (2 if cat == 'draw' else 1):
                self.raises_this_street += 1
                return ('raise', self._raise_to(v))
        if r() < cont:
            return ('call', 0)
        return ('fold', 0)


def calibrate_from_tracker(players_json, min_hands=40):
    """Average real opponents' numbers from tracker stats (players.json) into a 'torn' style.
    Only players with enough hands count. Returns the style dict, or None if there's too little data."""
    import json
    data = json.load(open(players_json)).get('players', {})
    rows = [p for n, p in data.items() if n != 'Hero' and p.get('hands', 0) >= min_hands]
    if len(rows) < 5:
        return None
    h = sum(p['hands'] for p in rows)
    vpip = sum(p['vpip'] for p in rows) / h
    pfr = sum(p['pfr'] for p in rows) / h
    faced = sum(p.get('facedBet', 0) for p in rows)
    f2b = sum(p.get('foldToBet', 0) for p in rows) / faced if faced else 0.4
    style = {k: (dict(v) if isinstance(v, dict) else v) for k, v in STYLES['rec'].items()}
    style.update(vpip=vpip, pfr=pfr, call_raise=max(0.05, (vpip - pfr) * 0.8))
    scale = (1 - f2b) / (1 - 0.40)
    style['call'] = {k: min(0.99, v * scale) for k, v in style['call'].items()}
    return style
