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

    def __init__(self, script=None, node=None, tracker_file=None, solver=True):
        here = os.path.dirname(os.path.abspath(__file__))
        self.tracker_file = tracker_file
        self.solver = solver
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
        tracker = self.tracker_file if self.tracker_file is not None else (
            os.environ.get('POKER_COACH_TRACKER') or os.path.join(os.path.expanduser('~'), 'poker', 'local-db', 'players.json'))
        args = [self.node, self.script, '--serve'] + (['--tracker', tracker] if tracker else []) + ([] if self.solver else ['--no-solver'])
        self.proc = subprocess.Popen(args, stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, text=True, bufsize=1)
        atexit.register(self.close)

    def ask(self, table):
        return self.request(table)['decision']

    def request(self, msg):
        with self._lock:
            self._start()
            self.proc.stdin.write(json.dumps(msg) + '\n')
            self.proc.stdin.flush()
            line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError('brain.js exited')
        reply = json.loads(line)
        if not reply.get('ok'):
            raise RuntimeError(reply.get('error'))
        return reply

    def close(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()


def _find_brain(start):
    for p in (os.path.join(start, 'brain.js'),
              os.path.join(start, '..', '..', '..', 'poker_bot', 'integrations', 'dickreuter', 'brain.js')):
        if os.path.exists(p):
            return os.path.abspath(p)
    return os.path.join(start, 'brain.js')


# Snapshots of the current hand, one per decision: {game_id: [snapshot, ...]}
_hand_memory = {}


def _big_blind(t, p):
    try:
        bb = float(p.selected_strategy['bigBlind'])  # dickreuter keeps the blinds in the strategy
        if bb > 0:
            return bb
    except Exception:
        pass
    return _num(getattr(t, 'bigBlind', 0)) or 1.0


# ── Reading the other seats (names, stacks) ──
# dickreuter only reads your own stack during play, and its name reading is switched off. We read
# both ourselves from the areas you marked in the table setup ("player_name_area",
# "player_funds_area"). Names are read once per seat per hand; stacks every decision.
_name_cache = {}  # (game_id, seat) -> name
_tess = None


def _ocr_text(img):
    """Name OCR: tesseract with no character whitelist (dickreuter's own reader only allows digits)."""
    global _tess
    try:
        from tesserocr import PyTessBaseAPI, PSM, OEM
        from poker.tools.screen_operations import tesserpath, prepareImage
    except Exception:
        return ''
    if _tess is None:
        _tess = PyTessBaseAPI(path=tesserpath, psm=PSM.SINGLE_LINE, oem=OEM.LSTM_ONLY)
    best = ''
    for img2 in (prepareImage(img, binarize=True), prepareImage(img, binarize=True, threshold=125), prepareImage(img, binarize=False)):
        _tess.SetImage(img2)
        txt = ''.join(ch for ch in _tess.GetUTF8Text().strip() if ch.isalnum() or ch in '_.-')
        if len(txt) > len(best):
            best = txt
    return best


def _box(td, key, seat=None):
    a = td.get(key)
    if a is None:
        return None
    if seat is not None:
        a = a.get(str(seat)) if isinstance(a, dict) else None
    return (a['x1'], a['y1'], a['x2'], a['y2']) if a and 'x1' in a else None


def coach_read(t, game_id, n):
    """Tables marked "coach_reader": read names, stacks, bets and the pot ourselves (greyscale
    OCR that copes with "$1,419,983" and "$2K"), instead of dickreuter's digits-only reader."""
    try:
        from poker.scraper.card_reader import read_amount, read_text  # inside dickreuter (install.py copies it)
    except ImportError:
        from card_reader import read_amount, read_text
    td = t.table_dict
    img = t.screenshot
    live = set(getattr(t, 'players_in_game', None) or [])
    out = {'names': {}, 'stacks': {}, 'bets': {}}
    for seat in range(0, n):
        b = _box(td, 'player_funds_area', seat)
        if b:
            v = read_amount(img, b)
            if v is not None:
                out['stacks'][seat] = v
        b = _box(td, 'player_pot_area', seat)
        out['bets'][seat] = (read_amount(img, b) or 0.0) if b else 0.0
        if seat and seat in live:
            key = (game_id, seat)
            if key not in _name_cache:
                b = _box(td, 'player_name_area', seat)
                nm = read_text(img, b).strip('_.-') if b else ''
                if nm:
                    _name_cache[key] = nm
            out['names'][seat] = _name_cache.get(key, '')
    b = _box(td, 'total_pot_area')
    out['pot'] = read_amount(img, b) if b else None
    return out


def read_seats(t, game_id, n):
    """Returns ({seat: name}, {seat: stack}) for seats 1..n-1, from whatever this table can give."""
    names, stacks = {}, {}
    td = getattr(t, 'table_dict', None) or {}
    override_names = getattr(t, 'coach_player_names', None)  # the simulator (and tests) set these directly
    funds = getattr(t, 'player_funds', None)
    for seat in range(1, n):
        if override_names is not None:
            names[seat] = override_names.get(seat, '')
        elif isinstance(td.get('player_name_area'), dict) and str(seat) in td['player_name_area']:
            key = (game_id, seat)
            if key not in _name_cache:
                try:
                    a = td['player_name_area'][str(seat)]
                    _name_cache[key] = _ocr_text(t.screenshot.crop((a['x1'], a['y1'], a['x2'], a['y2'])))
                except Exception as e:
                    log.debug("name OCR failed for seat %s: %s", seat, e)
                    _name_cache[key] = ''
            names[seat] = _name_cache[key]
        stack = None
        if isinstance(funds, (list, tuple)) and len(funds) > seat and funds[seat] not in ('', None):
            stack = _num(funds[seat], None)
        elif isinstance(td.get('player_funds_area'), dict) and str(seat) in td['player_funds_area'] and hasattr(t, 'screenshot'):
            try:
                from poker.tools.screen_operations import ocr
                stack = _num(ocr(t.screenshot, 'player_funds_area', td, str(seat), fast=True), None)
            except Exception as e:
                log.debug("stack OCR failed for seat %s: %s", seat, e)
        if stack is not None and stack >= 0:
            stacks[seat] = stack
    if len(_name_cache) > 200:
        for k in list(_name_cache)[:-60]:
            _name_cache.pop(k, None)
    return names, stacks


def _hero_bet(t, h, p, n, dealer, street, bb):
    """Our chips in front of us this street. dickreuter only reads them after our first action."""
    if h is not None and getattr(h, 'round_number', 0) == 0:
        if street != 'preflop':
            return 0.0
        k = (0 - dealer) % n
        if n == 2:
            return bb / 2 if k == 0 else bb
        return bb / 2 if k == 1 else bb if k == 2 else 0.0
    v = getattr(t, 'bot_pot', None)
    if v is None and hasattr(t, 'get_bot_pot') and p is not None:
        try:
            t.get_bot_pot(p)
            v = getattr(t, 'bot_pot', 0)
        except Exception:
            v = 0
    return _num(v)


def table_to_state(t, h=None, p=None):
    """dickreuter TableScreenBased (+ History, strategy) → the JSON brain.js expects."""
    board = [str(c) for c in (getattr(t, 'cardsOnTable', None) or [])]
    street = STREETS.get(len(board), 'river')
    n = int(_num(getattr(t, 'total_players', 6), 6)) or 6
    bb = _big_blind(t, p)
    dealer = int(_num(getattr(t, 'dealer_position', 0), 0)) % n
    game = getattr(h, 'GameID', None) if h is not None else None
    td = getattr(t, 'table_dict', None) or {}
    cr = coach_read(t, game, n) if td.get('coach_reader') and getattr(t, 'screenshot', None) is not None else None
    hero_bet = cr['bets'].get(0, 0.0) if cr else _hero_bet(t, h, p, n, dealer, street, bb)
    if cr:
        names, stacks = cr['names'], cr['stacks']
    else:
        names, stacks = read_seats(t, game, n)

    players = []
    for op in getattr(t, 'other_players', []) or []:
        seat = int(op.get('abs_position', 0)) + 1
        bet = cr['bets'].get(seat, 0.0) if cr else _num(op.get('pot'))
        players.append({'seat': seat, 'name': names.get(seat, ''), 'stack': stacks.get(seat, _num(op.get('funds'))),
                        'bet': bet, 'inHand': bool(op.get('status') == 1 or op.get('status') is True)})

    if cr:
        # what we have to call = the biggest bet in front of anyone, minus ours
        to_call = max([0.0] + [pl['bet'] for pl in players]) - hero_bet
        to_call = max(0.0, min(to_call, stacks.get(0, to_call)))
        pot = cr['pot'] if cr['pot'] is not None else hero_bet + sum(pl['bet'] for pl in players)
    else:
        call_value = getattr(t, 'currentCallValue', None)
        if call_value in (None, ''):
            call_value = getattr(t, 'minCall', 0)
        to_call = 0.0 if getattr(t, 'checkButton', False) else _num(call_value)
        pot = _num(getattr(t, 'totalPotValue', 0))
        if not POT_INCLUDES_CURRENT_BETS:
            pot += hero_bet + sum(pl['bet'] for pl in players)

    snaps = _hand_memory.get(game, [])
    if len(_hand_memory) > 20:  # only the current hand matters
        for k in list(_hand_memory)[:-5]:
            _hand_memory.pop(k, None)
    return {
        'gameId': game, 'heroCards': [str(c) for c in (getattr(t, 'mycards', None) or [])],
        'board': board, 'pot': pot, 'toCall': to_call,
        'heroStack': (cr['stacks'].get(0) if cr and cr['stacks'].get(0) is not None else _num(getattr(t, 'myFunds', 0))),
        'heroBet': hero_bet, 'bb': bb, 'nSeats': n, 'dealer': dealer,
        'players': players, 'history': [dict(s) for s in snaps],
    }


def remember(state, d):
    """Store this decision's snapshot (with what we did) for the rest of the hand."""
    snap = {'street': STREETS.get(len(state['board']), 'river'), 'heroBet': state['heroBet'],
            'bets': {str(pl['seat']): pl['bet'] for pl in state['players']},
            'live': [pl['seat'] for pl in state['players'] if pl['inHand']],
            'hero': {'action': d.get('action'), 'amount': d.get('amount', 0)} if d else None}
    _hand_memory.setdefault(state['gameId'], []).append(snap)


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


def _ascii(v):
    """The Windows console can't print every character; keep log lines plain."""
    return str(v).replace('\u2014', '-').replace('\u2192', '->').encode('ascii', 'replace').decode('ascii')


class CoachDecision(Decision):
    """Drop-in replacement for dickreuter's Decision: same constructor, same attributes."""

    def make_decision(self, t, h, p, l):
        try:
            state = table_to_state(t, h, p)
            if len(state['heroCards']) != 2:
                raise ValueError('hero cards not read')
            d = (getattr(t, 'coach_brain', None) or Brain.get()).ask(state)
            remember(state, d)
            self.coach = d
            self.decision = to_button(d, state, t)
            t.currentBluff = 1 if d.get('tag') in ('BLUFF', 'SEMI-BLUFF') else 0
            log.info("Coach: %s [%s] - %s -> button %s", *(_ascii(v) for v in (d.get('text'), d.get('tag'), d.get('reason'), self.decision)))
            log_decision(state, d, self.decision, getattr(h, 'GameID', ''))
        except Exception as e:  # never stall the bot: use dickreuter's own logic for this one
            log.warning("Coach brain failed (%s); using dickreuter's decision", e)
            self.coach = None
            super().make_decision(t, h, p, l)
            try:  # still remember the snapshot so later streets know what happened
                remember(state, {'action': {'Fold': 'FOLD', 'Check': 'CHECK', 'Call': 'CALL'}.get(self.decision, 'RAISE'),
                                 'amount': _num(getattr(t, 'minBet', 0))})
            except Exception:
                pass
