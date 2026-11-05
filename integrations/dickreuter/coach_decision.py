"""
coach_decision.py — swaps dickreuter/poker's decision maker for this project's strategy layer.

dickreuter's Decision class decides from equity thresholds in a strategy sheet. CoachDecision keeps
everything dickreuter needs (the GUI fields, logging, the mouse button names) but asks brain.js
(strategy.js + opponent ranges) what to do. If the brain fails for any reason, it falls back to
dickreuter's original logic for that decision, so the bot never stalls.

install.py copies this file to poker/decisionmaker/coach_decision.py inside a dickreuter checkout
and points main.py at it. Set POKER_COACH_BRAIN to the path of brain.js if your checkouts aren't
side by side.
"""
import atexit
import csv
import datetime
import json
import logging
import math
import os
import shutil
import subprocess
import threading

try:  # inside a dickreuter checkout
    from poker.decisionmaker.decisionmaker import Decision
except ImportError:  # standalone (tests)
    Decision = object

log = logging.getLogger(__name__)
log.setLevel(logging.INFO)  # dickreuter sets the root logger to WARNING, which would hide the Coach lines

STREETS = {0: 'preflop', 3: 'flop', 4: 'turn', 5: 'river'}

# Does the scraped "total pot" already include the bets in front of players this street?
# PokerStars / GGPoker / PartyPoker show a total that does. Set to False for a table that doesn't.
POT_INCLUDES_CURRENT_BETS = os.environ.get('POKER_COACH_POT_INCLUDES_BETS', '1') != '0'


def _num(x, default=0.0):
    try:
        v = float(x)
        return v if v == v and v < 9_000_000 else default  # NaN, and dickreuter's 9999999 "unknown"
    except (TypeError, ValueError):
        return default


class Brain:
    """One long-lived `node brain.js --serve` process; one JSON line per decision."""
    _instance = None
    _lock = threading.Lock()

    def __init__(self, script=None, node=None):
        here = os.path.dirname(os.path.abspath(__file__))
        self.script = script or os.environ.get('POKER_COACH_BRAIN') or _find_brain(here)
        self.node = node or os.environ.get('POKER_COACH_NODE') or shutil.which('node') or 'node'
        self.proc = None

    @classmethod
    def get(cls):
        with cls._lock:
            if cls._instance is None:
                cls._instance = Brain()
            return cls._instance

    def _start(self):
        if self.proc and self.proc.poll() is None:
            return
        self.proc = subprocess.Popen([self.node, self.script, '--serve'], stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, text=True, bufsize=1)
        atexit.register(self.close)

    def ask(self, table):
        with self._lock:
            self._start()
            self.proc.stdin.write(json.dumps(table) + '\n')
            self.proc.stdin.flush()
            line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError('brain.js exited')
        reply = json.loads(line)
        if not reply.get('ok'):
            raise RuntimeError(reply.get('error'))
        return reply['decision']

    def close(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()


def _find_brain(start):
    for p in (os.path.join(start, 'brain.js'),
              os.path.join(start, '..', '..', '..', 'poker_bot', 'integrations', 'dickreuter', 'brain.js')):
        if os.path.exists(p):
            return os.path.abspath(p)
    return os.path.join(start, 'brain.js')


# What we saw on earlier streets of the current hand: {game_id: {street: {seat: bet}}}
_hand_memory = {}


def _big_blind(t, p):
    try:
        bb = float(p.selected_strategy['bigBlind'])  # dickreuter keeps the blinds in the strategy
        if bb > 0:
            return bb
    except Exception:
        pass
    return _num(getattr(t, 'bigBlind', 0)) or 1.0


def table_to_state(t, h=None, p=None):
    """dickreuter TableScreenBased (+ History, strategy) → the JSON brain.js expects."""
    board = [str(c) for c in (getattr(t, 'cardsOnTable', None) or [])]
    street = STREETS.get(len(board), 'river')
    n = int(_num(getattr(t, 'total_players', 6), 6)) or 6
    bb = _big_blind(t, p)
    hero_bet = _num(getattr(t, 'bot_pot', 0))

    players = []
    for op in getattr(t, 'other_players', []) or []:
        seat = int(op.get('abs_position', 0)) + 1
        players.append({'seat': seat, 'stack': _num(op.get('funds')), 'bet': _num(op.get('pot')),
                        'inHand': bool(op.get('status') == 1 or op.get('status') is True)})

    to_call = 0.0 if getattr(t, 'checkButton', False) else _num(getattr(t, 'minCall', getattr(t, 'currentCallValue', 0)))
    pot = _num(getattr(t, 'totalPotValue', 0))
    if not POT_INCLUDES_CURRENT_BETS:
        pot += hero_bet + sum(p['bet'] for p in players)

    game = getattr(h, 'GameID', None) if h is not None else None
    mem = _hand_memory.setdefault(game, {})
    if len(_hand_memory) > 20:  # only the current hand matters
        for k in list(_hand_memory)[:-5]:
            _hand_memory.pop(k, None)
    mem[street] = {str(p['seat']): p['bet'] for p in players}
    mem[street]['0'] = hero_bet
    history = [{'street': s, 'bets': mem[s]} for s in ('preflop', 'flop', 'turn', 'river') if s in mem and s != street]

    dealer = getattr(t, 'dealer_position', 0)
    return {
        'heroCards': [str(c) for c in (getattr(t, 'mycards', None) or [])],
        'board': board, 'pot': pot, 'toCall': to_call, 'heroStack': _num(getattr(t, 'myFunds', 0)),
        'heroBet': hero_bet, 'bb': bb, 'nSeats': n, 'dealer': int(_num(dealer, 0)) % n,
        'players': players, 'history': history,
    }


def to_button(d, state, t=None):
    """strategy.js decision → the button name dickreuter's MouseMoverTableBased.mouse_action expects."""
    action = d['action']
    can_check = state['toCall'] <= 0
    if action == 'FOLD':
        return 'Check' if can_check else 'Fold'
    if action == 'CHECK':
        return 'Check' if can_check else 'Fold'
    if action == 'CALL':
        return 'Call'
    if action == 'ALL-IN' and d.get('amount', 0) <= state['heroBet'] + state['toCall'] + 1e-9:
        return 'Call'  # an all-in that is just a call
    td = getattr(t, 'table_dict', None) if t is not None else None
    has_all_in = td is None or 'mouse_all_in' in td
    if action == 'ALL-IN':
        return 'Bet max' if has_all_in else 'Bet pot'

    # BET / RAISE: pick the closest size this table's buttons can make (sizes are "raise to" totals).
    target = float(d.get('amount', 0))
    pot, call, already = state['pot'], state['toCall'], state['heroBet']
    min_to = _num(getattr(t, 'minBet', 0)) if t is not None else 0
    min_to = min_to or max(already + call * 2, state['bb'])
    choices = {
        'Bet': min_to,
        'Bet half pot': already + call + 0.5 * (pot + call),
        'Bet pot': already + call + (pot + call),
    }
    if has_all_in:
        choices['Bet max'] = state['heroStack'] + already
    return min(choices, key=lambda k: abs(math.log(max(choices[k], 1e-6) / max(target, 1e-6))))


# One row per decision, kept on your PC. report.py joins it with the hand results.
LOG_DIR = os.environ.get('POKER_COACH_LOG_DIR') or os.path.join(os.path.expanduser('~'), 'poker', 'logs')
DECISION_FIELDS = ['time', 'game_id', 'street', 'position', 'in_position', 'hero_cards', 'board', 'pot', 'to_call',
                   'hero_stack', 'bb', 'opponents', 'action', 'amount', 'tag', 'equity', 'ev', 'button', 'reason']


def log_decision(state, d, button, game_id):
    try:
        os.makedirs(LOG_DIR, exist_ok=True)
        path = os.path.join(LOG_DIR, 'coach_decisions.csv')
        new = not os.path.exists(path)
        opts = d.get('options') or []
        best = next((o for o in opts if o.get('action') == d.get('action') and o.get('amount') == d.get('amount')), None) \
            or next((o for o in opts if o.get('action') == d.get('action')), {})
        row = {
            'time': datetime.datetime.now().isoformat(timespec='seconds'), 'game_id': game_id,
            'street': STREETS.get(len(state['board']), 'river'), 'position': d.get('position'),
            'in_position': d.get('inPosition'), 'hero_cards': ' '.join(state['heroCards']),
            'board': ' '.join(state['board']), 'pot': state['pot'], 'to_call': state['toCall'],
            'hero_stack': state['heroStack'], 'bb': state['bb'],
            'opponents': sum(1 for p in state['players'] if p['inHand']), 'action': d.get('action'),
            'amount': d.get('amount'), 'tag': d.get('tag'),
            'equity': round(d['equity'], 4) if isinstance(d.get('equity'), (int, float)) else '',
            'ev': best.get('ev', ''), 'button': button, 'reason': d.get('reason'),
        }
        with open(path, 'a', newline='', encoding='utf-8') as f:
            w = csv.DictWriter(f, fieldnames=DECISION_FIELDS)
            if new:
                w.writeheader()
            w.writerow(row)
    except Exception as e:  # logging must never stop the bot
        log.warning("couldn't write the decision log: %s", e)


class CoachDecision(Decision):
    """Drop-in replacement for dickreuter's Decision: same constructor, same attributes."""

    def make_decision(self, t, h, p, l):
        try:
            state = table_to_state(t, h, p)
            if len(state['heroCards']) != 2:
                raise ValueError('hero cards not read')
            d = Brain.get().ask(state)
            self.coach = d
            self.decision = to_button(d, state, t)
            t.currentBluff = 1 if d.get('tag') in ('BLUFF', 'SEMI-BLUFF') else 0
            log.info("Coach: %s [%s] — %s → button %s", d.get('text'), d.get('tag'), d.get('reason'), self.decision)
            log_decision(state, d, self.decision, getattr(h, 'GameID', ''))
        except Exception as e:  # never stall the bot: use dickreuter's own logic for this one
            log.warning("Coach brain failed (%s); using dickreuter's decision", e)
            self.coach = None
            super().make_decision(t, h, p, l)
