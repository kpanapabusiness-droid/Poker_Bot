"""
The coach as a simulator seat, without dickreuter: builds the same table object the real bot hands
to CoachDecision (seats, stacks, chips in front, dealer, names) and asks the same brain.js through
coach_decision.py, so the table-to-brain conversion, dealer-from-blinds and hand memory are the code
that runs at the real table. Only dickreuter's own screen/Monte Carlo steps are skipped.

Use it for fast tuning runs (lineup kind "coachx", or "coachxns" with the river solver off). The full
dickreuter pipeline (kind "coach") is still the final check on your PC.
"""
import itertools
import os
import sys
from types import SimpleNamespace as NS

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import coach_decision as C  # noqa: E402

_ids = itertools.count(1)


class CoachDirect:
    def __init__(self, kind, idx, tracker_file='', solver=True, physical_seats=None):
        self.kind = kind
        self.idx = idx
        self.brain = C.Brain(tracker_file=tracker_file, solver=solver)
        self.decisions = self.errors = 0
        self.seconds = 0.0
        self.actions = {}
        self.hand_log = []
        self.game = None
        # Seat the hand at a bigger table with empty / sitting-out seats (like Torn), so the
        # seat logic (who's dealt in, positions, blinds) is tested too. None = no extra seats.
        self.physical = physical_seats
        self.rng = __import__('random').Random(f'{kind}{idx}')
        self.layout = None

    def new_hand(self):
        self.game = f'{self.kind}{self.idx}-{next(_ids)}'
        self.hand_log = []
        self.agg = []  # our bets/raises this hand: street, tag, estimated fold chance (outcome added by run_sim)
        self.layout = None

    def _embed(self, v):
        """Put the n players of the simulated hand into `physical` seats, the extra seats empty or
        sitting out with chips (marked away). Fixed for the whole hand."""
        n, P = v['n'], self.physical
        if not P or P <= n:
            return v, {}
        if self.layout is None:
            extra = sorted(self.rng.sample(range(1, P), P - n))
            real = [s for s in range(P) if s not in extra]           # physical seats of view seats 0..n-1
            away = {s: self.rng.random() < 0.6 for s in extra}        # sitting out with chips, else empty
            self.layout = (real, away)
        real, away = self.layout
        stacks, bets = [0.0] * P, [0.0] * P
        for k in range(n):
            stacks[real[k]], bets[real[k]] = v['stacks'][k], v['bets'][k]
        for s, sitting in away.items():
            stacks[s] = 150.0 * v['bb'] if sitting else 0.0
        w = dict(v, n=P, stacks=stacks, bets=bets, dealer=real[v['dealer']],
                 in_hand=[real[k] for k in v['in_hand']],
                 names={real[k]: nm for k, nm in v['names'].items()})
        return w, {s for s in away}

    def act(self, v):
        import time
        t0 = time.time()
        try:
            action = self._decide(v)
        except Exception as e:
            self.errors += 1
            if self.errors <= 3:
                print(f'  [{self.kind}] error: {e!r}', file=sys.stderr)
            action = ('check', 0) if v['to_call'] <= 0 else ('fold', 0)
        self.decisions += 1
        self.seconds += time.time() - t0
        key = (v['street'], action[0])
        self.actions[key] = self.actions.get(key, 0) + 1
        return action

    def _decide(self, v):
        bettor = max(range(1, v['n']), key=lambda k: v['bets'][k]) if v['to_call'] > 0 else None
        street0 = v['street']
        v, away = self._embed(v)
        n = v['n']
        t = NS(mycards=list(v['hero_cards']), cardsOnTable=list(v['board']), total_players=n,
               dealer_position=v['dealer'], totalPotValue=v['total_pot'], currentCallValue=v['to_call'],
               minCall=v['to_call'], checkButton=v['to_call'] <= 0, myFunds=v['stacks'][0],
               minBet=v['min_raise_to'] or 0, bot_pot=v['bets'][0],
               table_dict={'mouse_all_in': {}, 'mouse_bet_amount': {}},
               coach_player_names=v['names'], player_funds=list(v['stacks']),
               other_players=[{'abs_position': k - 1, 'funds': v['stacks'][k], 'pot': v['bets'][k],
                               'status': 1 if k in v['in_hand'] else 0, 'away': k in away} for k in range(1, n)])
        h = NS(GameID=self.game, round_number=1)
        p = NS(selected_strategy={'bigBlind': v['bb']})
        state = C.table_to_state(t, h, p)
        if getattr(self, 'tournament', None):  # tournament mode: format, payouts, everyone's chips behind
            state['format'] = 'tournament'
            if self.tournament.get('payouts'):
                state['payouts'] = self.tournament['payouts']
                sb = {'Hero': v['stacks'][0]}
                for k, nm in v['names'].items():
                    sb[nm] = v['stacks'][k]
                state['stacksBehind'] = sb
        dump = os.environ.get('POKER_COACH_DUMP')
        if dump and street0 == 'river' and bettor is not None:
            state['debugRanges'] = True
        d = self.brain.ask(state)
        if dump and street0 == 'river' and bettor is not None and d.get('action') == 'FOLD' and len(v['in_hand']) == 2:
            import json
            with open(dump, 'a') as f:
                deck, pos, n = getattr(self, '_sim_deal', (None, 0, 0))
                real = deck[2 * ((pos + bettor) % n): 2 * ((pos + bettor) % n) + 2] if deck else None
                f.write(json.dumps({'state': state, 'decision': {k: d.get(k) for k in ('action', 'equity', 'reason', 'ranges')},
                                    'game': self.game, 'bettor_rel': bettor, 'bettor_cards': real,
                                    'bettor_name': v['names'].get(bettor) if False else None}) + '\n')
        C.remember(state, d)
        self.last = d
        a = d.get('action')
        self.hand_log.append(f"{v['street'][0]}:{a}" + (f"/{d.get('tag')}" if d.get('tag') else ''))
        if bettor is not None and v['board'] and a in ('CALL', 'FOLD', 'CHECK', 'RAISE', 'ALL-IN'):
            need = v['to_call'] / (v['total_pot'] + v['to_call'])
            self.agg.append({'street': street0, 'tag': 'FACE-' + ('FOLD' if a in ('FOLD', 'CHECK') else 'CALL' if a == 'CALL' else 'RAISE'),
                             'eq': d.get('equity'), 'need': need, 'bettor': bettor, 'face': True, 'opps': len(v['in_hand']) - 1})
        if a in ('BET', 'RAISE', 'ALL-IN') and v['board']:
            self.agg.append({'street': v['street'], 'tag': d.get('tag') or a, 'fold_est': d.get('foldEst'),
                             'pot': v['total_pot'], 'add': (d.get('amount') or 0) - v['bets'][0]})
        if a in ('FOLD', 'CHECK'):
            return ('check', 0) if v['to_call'] <= 0 else ('fold', 0)
        if a == 'CALL':
            return ('call', 0)
        if a == 'ALL-IN':
            return ('raise', v['bets'][0] + v['stacks'][0]) if v['min_raise_to'] is not None else ('call', 0)
        if v['min_raise_to'] is None:
            return ('call', 0)
        return ('raise', float(d.get('amount') or v['min_raise_to']))
