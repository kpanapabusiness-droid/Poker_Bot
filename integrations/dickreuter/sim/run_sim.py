"""
Head-to-head simulator: the coach brain vs dickreuter's own decision maker, at a 6-max table.

    python run_sim.py --hands 500 [--lineup coach,dickreuter] [--seed 1] [--dickreuter DIR] [--out results.json]

Both bots run the full dickreuter pipeline (table checks, Monte Carlo, Decision, buttons); only the
decision maker differs. Each deck is played twice with every player moved one seat ("duplicate"), so
both bots get the same cards in the same spots and luck mostly cancels out. Reports bb/100 per bot
with a 95% confidence interval.

Other lineups: coachns (the coach with the river solver off), station (calls everything),
nit (plays only big pairs and AK), random.

Human-like opponents (humans.py, randomised casual players with styles and tilt):
    h-rec, h-fish, h-station, h-nit, h-tag, h-maniac
    --lineup humans   = coachx,h-rec,h-fish,h-tag,h-nit,h-maniac  (a mixed cash table)
coachx / coachxns: the coach without dickreuter (fast tuning; same table conversion and brain).
--rotations N plays each deck N times, moving everyone one seat each time (default: one per seat
when every player is different, else 2).
"""
import argparse
import json
import math
import os
import random
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))
import holdem  # noqa: E402

DEFAULT_DR = os.environ.get('DICKREUTER_DIR', os.path.join(HERE, '..', '..', '..', '..', 'dickreuter', 'poker'))


def translate(button, v, info):
    """dickreuter button → table action."""
    to_call, mr = v['to_call'], v['min_raise_to']
    mine = v['bets'][0]
    pot = v['total_pot']
    if button in ('Fold',):
        return ('fold', 0)
    if button in ('Check', 'Check Deception'):
        return ('check', 0) if to_call <= 0 else ('fold', 0)
    if button in ('Call', 'Call2', 'Call Deception'):
        return ('call', 0)
    if mr is None:
        return ('call', 0)
    if button in ('Bet', 'Bet Bluff'):
        return ('raise', mr)
    if button == 'BetPlus':
        return ('raise', mr + info.get('bet_plus_inc', 1) * v['bb'])
    if button == 'Bet half pot':
        return ('raise', mine + to_call + 0.5 * (pot + to_call))
    if button == 'Bet pot':
        return ('raise', mine + to_call + (pot + to_call))
    if button == 'Bet max':
        return ('raise', mine + v['stacks'][0])
    raise ValueError('unknown button ' + str(button))


class BotPlayer:
    def __init__(self, kind, seat):
        self.kind, self.seat = kind, seat
        self.decisions = 0
        self.seconds = 0.0
        self.errors = 0
        self.actions = {}

    def new_hand(self):
        self.seat.new_hand()
        self.hand_log = []

    def act(self, v):
        t0 = time.time()
        try:
            button, info = self.seat.act(v)
            action = translate(button, v, info)
        except Exception as e:  # a crash in a bot shouldn't stop the run; count it and fold
            self.errors += 1
            if self.errors <= 3:
                print(f'  [{self.kind}] error: {e!r}', file=sys.stderr)
            action = ('check', 0) if v['to_call'] <= 0 else ('fold', 0)
        self.decisions += 1
        self.seconds += time.time() - t0
        key = (v['street'], action[0])
        self.actions[key] = self.actions.get(key, 0) + 1
        coach = (locals().get('info') or {}).get('coach') or {}
        self.hand_log = getattr(self, 'hand_log', [])
        self.hand_log.append(f"{v['street'][0]}:{action[0]}" + (f"/{coach.get('tag')}" if coach.get('tag') else ''))
        return action


class Station:
    kind = 'station'
    def act(self, v): return ('call', 0)


class Nit:
    kind = 'nit'
    def act(self, v):
        c = v['hero_cards']
        strong = c[0][0] == c[1][0] and c[0][0] in 'AKQJT' or {c[0][0], c[1][0]} == {'A', 'K'}
        if not v['board']:
            return ('raise', v['min_raise_to'] or 0) if strong else (('check', 0) if v['to_call'] <= 0 else ('fold', 0))
        return ('call', 0) if strong else (('check', 0) if v['to_call'] <= 0 else ('fold', 0))


class Random:
    kind = 'random'
    def __init__(self, seed): self.r = random.Random(seed)
    def act(self, v):
        x = self.r.random()
        if x < 0.35: return ('fold', 0) if v['to_call'] > 0 else ('check', 0)
        if x < 0.8 or v['min_raise_to'] is None: return ('call', 0)
        return ('raise', v['min_raise_to'])


LINEUPS = {'humans': 'coachx,h-rec,h-fish,h-tag,h-nit,h-maniac',
           'humans-ns': 'coachxns,h-rec,h-fish,h-tag,h-nit,h-maniac'}


HUMAN_STYLES = ['h-rec', 'h-fish', 'h-tag', 'h-nit', 'h-maniac', 'h-station']
# opponents that react to us (7 Nov): --lineup humans2
HUMAN_STYLES2 = ['h-thinker', 'h-adaptive', 'h-bluffer', 'h-rec', 'h-fish', 'h-tag', 'h-nit', 'h-maniac']
PHYSICAL_SEATS = int(os.environ['POKER_COACH_SIM_PHYSICAL']) if os.environ.get('POKER_COACH_SIM_PHYSICAL') else None  # --physical-seats


def human_lineup(coach, seats, styles=None):
    """The coach plus `seats - 1` casual humans, styles cycling (so 9-handed has two recs, two fish...)."""
    styles = styles or HUMAN_STYLES
    return [coach] + [styles[i % len(styles)] for i in range(seats - 1)]


def make(kind, idx, dr_dir, strategy, tracker_dir):
    if kind.startswith('h-'):
        from humans import Human
        return Human(kind[2:], seed=idx)
    if kind in ('coachx', 'coachxns'):
        from coach_direct import CoachDirect
        return CoachDirect(kind, idx, tracker_file=os.path.join(tracker_dir, f'{kind}{idx}.json') if tracker_dir else '',
                           solver=(kind == 'coachx'), physical_seats=PHYSICAL_SEATS)
    if kind in ('coach', 'coachns', 'dickreuter'):
        from dickreuter_seat import DickreuterSeat, setup_dickreuter
        setup_dickreuter(dr_dir)
        if kind in ('coach', 'coachns'):
            import coach_decision as C
            brain = C.Brain(tracker_file=os.path.join(tracker_dir, f'{kind}{idx}.json') if tracker_dir else '',
                            solver=(kind == 'coach'))
            seat = DickreuterSeat(f'coach{idx}', dr_dir, strategy, decision_cls=C.CoachDecision, fast_fold=False, brain=brain)
        else:
            seat = DickreuterSeat(f'dickreuter{idx}', dr_dir, strategy)
        return BotPlayer(kind, seat)
    if kind == 'station':
        return Station()
    if kind == 'nit':
        return Nit()
    if kind == 'random':
        return Random(idx)
    raise ValueError(kind)


def prepared_copy(dr_dir):
    """A temporary copy of dickreuter with install.py applied (the lmfit fix is needed by both bots)."""
    import shutil
    import subprocess
    if 'poker-coach: lmfit 1.3 fix' in open(os.path.join(dr_dir, 'poker', 'decisionmaker', 'curvefitting.py')).read():
        return dr_dir
    tmp = os.path.join(tempfile.mkdtemp(), 'dickreuter')
    shutil.copytree(dr_dir, tmp, ignore=shutil.ignore_patterns('.git', 'website', 'doc', 'notebooks', 'tests', 'log'))
    r = subprocess.run([sys.executable, os.path.join(os.path.dirname(HERE), 'install.py'), tmp], capture_output=True, text=True)
    if r.returncode:
        sys.exit(r.stdout + r.stderr)
    return tmp


def summarise(per_pair, agents, kinds, hands_done, played, seed, lineup, t0, rot=2):
    out = {'decks': hands_done, 'hands_played': played, 'seed': seed, 'lineup': lineup, 'minutes': round((time.time() - t0) / 60, 1), 'bots': {}}
    for k, v in per_pair.items():
        if not v:
            continue
        mean = sum(v) / len(v)  # bb per player per deck (= rot hands)
        sd = math.sqrt(sum((x - mean) ** 2 for x in v) / max(1, len(v) - 1))
        ci = 1.96 * sd / math.sqrt(len(v))
        bots = [a for a in agents if getattr(a, 'kind', '') == k]
        dec = sum(getattr(a, 'decisions', 0) for a in bots)
        out['bots'][k] = {'bb_per_100': round(mean / rot * 100, 1), 'ci95': round(ci / rot * 100, 1),
                          'decisions': dec, 'errors': sum(getattr(a, 'errors', 0) for a in bots),
                          'sec_per_decision': round(sum(getattr(a, 'seconds', 0) for a in bots) / dec, 3) if dec else None,
                          'actions': _merge([getattr(a, 'actions', {}) for a in bots])}
    return out


def _save(out, path, rows, detail):
    """Write results so far (a long run that gets interrupted still leaves its numbers)."""
    if path:
        json.dump(out, open(path + '.tmp', 'w'), indent=2)
        os.replace(path + '.tmp', path)
    if detail and rows:
        import csv
        with open(detail + '.tmp', 'w', newline='') as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0]))
            w.writeheader()
            w.writerows(rows)
        os.replace(detail + '.tmp', detail)


def run(hands, lineup, seed, dr_dir, bb=2.0, stack=200.0, progress=True, learn=True, detail=None, out_path=None, seats=6, rotations=None,
        deck_range=None, luck='ev'):
    """luck='ev': all-in-before-the-river hands are scored by equity (luck removed); 'actual': by who won.
    deck_range=(a, b): play only decks a..b-1 of the seeded sequence (for parallel workers)."""
    from local_server import DEFAULT_STRATEGY
    needs_dr = any(k in ('coach', 'coachns', 'dickreuter') for k in lineup)
    dr_dir = prepared_copy(dr_dir) if needs_dr else dr_dir
    strategy = dict(DEFAULT_STRATEGY, bigBlind=bb, smallBlind=bb / 2, initialFunds=stack, initialFunds2=stack)
    kinds = (lineup * seats)[:seats]
    tracker_dir = tempfile.mkdtemp() if learn else None
    os.environ.setdefault('POKER_COACH_LOG_DIR', tempfile.mkdtemp())
    agents = [make(k, i, dr_dir, strategy, tracker_dir) for i, k in enumerate(kinds)]
    names = [f'{k}{i}' for i, k in enumerate(kinds)]
    # duplicate: the second table moves everyone one seat, so each seat's cards go to the other bot type
    rot = rotations or (seats if len(set(kinds)) == seats or kinds.count(kinds[0]) == 1 else 2)
    seatings = [[(i - r) % seats for i in range(seats)] for r in range(rot)]
    per_pair = {k: [] for k in set(kinds)}
    rows = []
    totals = {k: 0.0 for k in set(kinds)}
    played = 0
    t0 = time.time()
    all_decks = list(holdem.decks(hands, seed))
    lo, hi = deck_range or (0, hands)
    os.environ.setdefault('POKER_COACH_SEED', str(seed))  # brain.js: same spot → same equity samples
    for h in range(lo, hi):
        deck = all_decks[h]
        button = h % seats
        pair = {k: 0.0 for k in set(kinds)}
        for r_i, seating in enumerate(seatings):
            order = [agents[j] for j in seating]
            for j in seating:  # humans: same deck and table → same dice, whichever coach version is playing
                if hasattr(agents[j], 'reseed'):
                    agents[j].reseed(f'{seed}-{h}-{r_i}')
            for pos_, j in enumerate(seating):  # debug dumps only: lets a seat look up other players' real cards
                agents[j]._sim_deal = (deck, pos_, seats)
            table = holdem.Table(order, bb=bb, start_stack=stack, names=[names[j] for j in seating])
            result, rec = table.play(deck, button)
            scored = rec['result_ev'] if luck == 'ev' else result
            for pos, j in enumerate(seating):
                if hasattr(order[pos], 'hand_over'):
                    order[pos].hand_over(result[pos] / bb)  # tilt follows what actually happened
                pair[kinds[j]] += scored[pos] / bb
                totals[kinds[j]] += scored[pos] / bb
                if detail is not None:
                    a = agents[j]
                    agg = _agg_outcomes(getattr(a, 'agg', None), rec, pos)
                    rows.append({'deck': h, 'table': seatings.index(seating), 'bot': kinds[j], 'seat_from_button': (pos - button) % seats,
                                 'cards': ''.join(rec['hole'][pos]), 'result_bb': round(scored[pos] / bb, 3),
                                 'actual_bb': round(result[pos] / bb, 2),
                                 'showdown': rec['showdown'], 'actions': ' '.join(getattr(a, 'hand_log', [])), 'agg': agg})
            played += 1
        for k in pair:
            per_pair[k].append(pair[k] / kinds.count(k))  # bb per player of this type, both tables
        if (h + 1 - lo) % max(1, (hi - lo) // 20) == 0:
            _save(summarise(per_pair, agents, kinds, h + 1 - lo, played, seed, lineup, t0, rot), out_path, rows, detail)
            if progress:
                el = time.time() - t0
                print(f'  {h + 1 - lo}/{hi - lo} decks  {el / 60:.1f} min  ' + '  '.join(
                    f'{k} {sum(v) / len(v) / rot * 100:+.1f}' for k, v in per_pair.items()), flush=True)
    out = summarise(per_pair, agents, kinds, hi - lo, played, seed, lineup, t0, rot)
    _save(out, out_path, rows, detail)
    out['per_pair'] = per_pair
    out['rot'] = rot
    return out


def _agg_outcomes(agg, rec, pos):
    """Pair each of a coach seat's postflop bets/raises with what happened next on that street: 'F' if
    everyone folded, 'C' if someone called or raised. Encoded 'street:tag:fold_est:outcome;...'."""
    if not agg:
        return ''
    acts = rec['actions']
    n = len(rec['hole'])
    out = []
    face = [d for d in agg if d.get('face')]
    agg = [d for d in agg if not d.get('face')]
    for d in face:  # calls/folds facing a bet: predicted equity vs the real showdown against the bettor
        b = (pos + d['bettor']) % n
        mine_r, theirs = holdem.hand_rank(rec['hole'][pos] + rec['board']), holdem.hand_rank(rec['hole'][b] + rec['board'])
        res = 'W' if mine_r > theirs else 'L' if mine_r < theirs else 'T'
        tag = d['tag'] + ('' if d.get('opps', 1) == 1 else '-MW')
        out.append(f"{d['street'][0]}:{tag}:{round(d['eq'] or 0, 3)}/{round(d['need'], 3)}:{res}")
    mine = [k for k, (st, i, act, _) in enumerate(acts) if i == pos and act == 'raise' and st != 'preflop']
    for k, d in zip(mine, agg):
        st = acts[k][0]
        later = [a for a in acts[k + 1:] if a[0] == st and a[1] != pos]
        res = 'C' if any(a[2] in ('call', 'raise') for a in later) else 'F'
        fe = d.get('fold_est')
        out.append(f"{st[0]}:{d['tag']}:{'' if fe is None else round(fe, 3)}:{res}")
    return ';'.join(out)


def _worker(args):
    kw, chunk, detail = args
    kw = dict(kw, deck_range=chunk, progress=False, detail=detail, out_path=None)
    out = run(**kw)
    return out['per_pair'], out['rot'], out['hands_played']


def run_parallel(workers, **kw):
    """Split the decks between `workers` processes (each with its own copies of the players and
    tracker) and combine the results. Detail CSVs are merged into kw['detail']."""
    import multiprocessing as mp
    hands, detail = kw['hands'], kw.get('detail')
    edges = [round(i * hands / workers) for i in range(workers + 1)]
    parts = [(kw, (edges[i], edges[i + 1]), (f'{detail}.part{i}' if detail else None)) for i in range(workers)]
    t0 = time.time()
    with mp.get_context('spawn').Pool(workers) as pool:
        results = pool.map(_worker, parts)
    per_pair, rot, played = {}, results[0][1], 0
    for pp, _, n in results:
        played += n
        for k, v in pp.items():
            per_pair.setdefault(k, []).extend(v)
    if detail:
        import csv
        rows = []
        for _, _, d in parts:
            with open(d, newline='') as f:
                rows.extend(csv.DictReader(f))
            os.remove(d)
        with open(detail, 'w', newline='') as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0]))
            w.writeheader()
            w.writerows(rows)
    out = {'decks': hands, 'hands_played': played, 'minutes': round((time.time() - t0) / 60, 1), 'bots': {}}
    for k, v in per_pair.items():
        mean = sum(v) / len(v)
        sd = math.sqrt(sum((x - mean) ** 2 for x in v) / max(1, len(v) - 1))
        out['bots'][k] = {'bb_per_100': round(mean / rot * 100, 1), 'ci95': round(1.96 * sd / math.sqrt(len(v)) / rot * 100, 1),
                          'decisions': 0, 'errors': 0, 'sec_per_decision': None}
    if kw.get('out_path'):
        json.dump(out, open(kw['out_path'], 'w'), indent=2)
    return out


def _merge(dicts):
    out = {}
    for d in dicts:
        for (street, act), n in d.items():
            out.setdefault(street, {})[act] = out.setdefault(street, {}).get(act, 0) + n
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--hands', type=int, default=200, help='decks (each is played twice)')
    ap.add_argument('--lineup', default='coach,dickreuter')
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--dickreuter', default=DEFAULT_DR)
    ap.add_argument('--out')
    ap.add_argument('--no-learn', action='store_true', help="don't let the coach learn opponents during the run")
    ap.add_argument('--detail', help='write one row per player per hand to this CSV')
    ap.add_argument('--seats', type=int, default=6, help='table size (2-9)')
    ap.add_argument('--rotations', type=int, help='times each deck is played, everyone moving one seat each time')
    ap.add_argument('--stack', type=float, default=100, help='starting stack in big blinds (cash: topped up every hand)')
    ap.add_argument('--physical-seats', type=int, help='coach sees a table this big, the extra seats empty or sitting out')
    ap.add_argument('--workers', type=int, default=1, help='parallel processes (use your CPU core count)')
    ap.add_argument('--luck', choices=('ev', 'actual'), default='ev',
                    help="ev: all-in hands before the river scored by equity (default); actual: by who won")
    o = ap.parse_args()
    global PHYSICAL_SEATS
    PHYSICAL_SEATS = o.physical_seats
    if o.lineup in ('humans', 'humans-ns', 'humans2'):
        lineup = human_lineup('coachxns' if o.lineup == 'humans-ns' else 'coachx', o.seats,
                              HUMAN_STYLES2 if o.lineup == 'humans2' else None)
    elif o.lineup.startswith('vs-'):  # heads-up against one style: --lineup vs-thinker --seats 2
        lineup = ['coachx', 'h-' + o.lineup[3:]]
    else:
        lineup = LINEUPS.get(o.lineup, o.lineup).split(',')
    kw = dict(hands=o.hands, lineup=lineup, seed=o.seed, dr_dir=os.path.abspath(o.dickreuter), learn=not o.no_learn,
              detail=o.detail, out_path=o.out, seats=o.seats, rotations=o.rotations, stack=o.stack * 2.0, luck=o.luck)
    if o.workers > 1:
        os.environ['POKER_COACH_SIM_PHYSICAL'] = str(o.physical_seats or '')
        res = run_parallel(o.workers, **kw)
    else:
        res = run(**kw)
    print()
    for k, b in sorted(res['bots'].items(), key=lambda kv: -kv[1]['bb_per_100']):
        extra = f"  ({b['decisions']} decisions, {b['errors']} errors, {b['sec_per_decision']}s each)" if b.get('decisions') else ''
        print(f"{k:<11} {b['bb_per_100']:+7.1f} bb/100  ± {b['ci95']:.1f}{extra}")
    print(f"\n{res['hands_played']} hands in {res['minutes']} min. A result is only real if it's bigger than its ± range.")


if __name__ == '__main__':
    main()
