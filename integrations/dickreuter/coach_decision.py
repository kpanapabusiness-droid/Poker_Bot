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
        from poker.scraper.card_reader import read_amount, read_bet, read_text, seat_status  # inside dickreuter (install.py copies it)
    except ImportError:
        from card_reader import read_amount, read_bet, read_text, seat_status
    td = t.table_dict
    img = t.screenshot
    live = set(getattr(t, 'players_in_game', None) or [])
    out = {'names': {}, 'stacks': {}, 'bets': {}, 'away': set()}
    for seat in range(0, n):
        b = _box(td, 'player_funds_area', seat)
        if b:
            v = read_amount(img, b)
            if v is not None:
                out['stacks'][seat] = v
        b = _box(td, 'player_pot_area', seat)
        out['bets'][seat] = (read_bet(img, b) or 0.0) if b else 0.0
        if seat and seat not in live:
            nb = _box(td, 'player_name_area', seat)
            try:
                if nb and seat_status(img, nb) in ('away', 'empty'):
                    out['away'].add(seat)
            except Exception as e:
                log.debug("seat status failed for seat %s: %s", seat, e)
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
    # The Call button's own (rounded) amount, "CALL $1.9M": a second opinion on what we have to call.
    b = _box(td, 'call_value')
    try:
        out['call_btn'] = read_amount(img, (max(0, b[0] - 70), b[1], b[2] + 40, b[3])) if b else None
    except Exception:
        out['call_btn'] = None
    return out


def check_to_call(to_call, call_btn, players, hero_bet):
    """Cross-check what we have to call (from the bets in front of players) against the Call button.
    The button is rounded ("$1.9M"), so small differences are fine; a big one means a bet was misread.
    Returns (to_call, warning or None). The biggest bet is corrected to the button's amount: exactly,
    if the misread is a dropped/extra digit (×10, ×100), else the button's rounded value."""
    if not call_btn or call_btn <= 0 or to_call is None:
        return to_call, None
    if abs(to_call - call_btn) <= 0.12 * call_btn:
        return to_call, None
    # the button read without its K/M ("CALL $1.3M" → 1.3): it agrees with the bets, keep them
    if any(abs(to_call - call_btn * m) <= 0.12 * call_btn * m for m in (1e3, 1e6, 1e9)):
        return to_call, None
    for k in (10, 100, 0.1, 0.01):
        if abs(to_call * k - call_btn) <= 0.06 * call_btn:
            fixed = to_call * k
            break
    else:
        fixed = call_btn
    top = max(players, key=lambda pl: pl['bet'], default=None)
    if top is not None:
        top['bet'] = hero_bet + fixed
    return fixed, f'to call read as {to_call:,.0f} but the Call button says {call_btn:,.0f}: using {fixed:,.0f}'


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


_dealer_by_game = {}


def blinds_dealer(game, board, bb, hero_bet, players, n, chip_dealer, to_call=None):
    """Who has the button, worked out from the blinds: the small blind is the one seat with exactly
    half a big blind in front of it preflop, and the dealer is the occupied seat before it (heads-up
    the dealer *is* the small blind). Fixed for the rest of the hand once found. Falls back to the
    dealer chip the screen reader found (and logs it when the two disagree).

    When the small blind completed (so nobody shows half a big blind) and it's our first look at the
    hand with exactly one big blind in front of us and nothing to call, we're the big blind: the
    dealer is two occupied seats before us. (Torn sometimes shows the D chip where the screen map
    reads the wrong seat, which put a big blind hand down as EP.)"""
    if game in _dealer_by_game:
        return _dealer_by_game[game]
    if board or not bb:
        return chip_dealer
    bets = {0: hero_bet}
    bets.update({pl['seat']: pl['bet'] for pl in players})
    sb = [seat for seat, b in bets.items() if b and abs(b - bb / 2) <= 0.01 * bb]
    taken = {0} | {pl['seat'] for pl in players if (pl['stack'] > 0 and not pl.get('away')) or pl['bet'] > 0 or pl['inHand']}
    ring = sorted(x for x in taken if 0 <= x < n)
    if len(sb) == 1:
        i = ring.index(sb[0]) if sb[0] in ring else None
        if i is None:
            return chip_dealer
        dealer = sb[0] if len(ring) == 2 else ring[i - 1]
    elif (not sb and to_call is not None and to_call <= 0.01 * bb and abs(hero_bet - bb) <= 0.01 * bb
          and max(bets.values()) <= bb * 1.01 and game not in _hand_memory and len(ring) >= 2):
        i = ring.index(0)
        dealer = ring[i - 1] if len(ring) == 2 else ring[i - 2]
    elif hero_bet <= 0 and to_call and to_call > 0 and len(ring) >= 3:
        # The small blind's amount didn't read cleanly (Torn 8 Nov: "$12,5008"), so it's not exactly
        # half a big blind. Nobody after us has acted yet, so going round from our seat, the first
        # seat with chips in front, followed by another (the big blind), is the small blind. (A lone
        # bet before it is someone posting a big blind to sit back in.)
        i = ring.index(0)
        after = ring[i + 1:] + ring[:i]
        first = next((seat for k, seat in enumerate(after[:-1]) if bets.get(seat, 0) > 0 and bets.get(after[k + 1], 0) > 0), None)
        if first is None:
            return chip_dealer
        j = ring.index(first)
        dealer = ring[j - 1]
    else:
        return chip_dealer
    if dealer != chip_dealer:
        log.info("Dealer from the blinds: seat %s (the dealer chip read said seat %s)", dealer, chip_dealer)
    _dealer_by_game[game] = dealer
    if len(_dealer_by_game) > 50:
        for k in list(_dealer_by_game)[:-10]:
            _dealer_by_game.pop(k, None)
    return dealer


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

    read_warnings = []
    players = []
    for op in getattr(t, 'other_players', []) or []:
        seat = int(op.get('abs_position', 0)) + 1
        bet = cr['bets'].get(seat, 0.0) if cr else _num(op.get('pot'))
        players.append({'seat': seat, 'name': names.get(seat, ''), 'stack': stacks.get(seat, _num(op.get('funds'))),
                        'bet': bet, 'inHand': bool(op.get('status') == 1 or op.get('status') is True),
                        'away': bool(cr and seat in cr['away']) or bool(op.get('away'))})

    if cr:
        # what we have to call = the biggest bet in front of anyone, minus ours
        to_call = max([0.0] + [pl['bet'] for pl in players]) - hero_bet
        to_call = max(0.0, min(to_call, stacks.get(0, to_call)))
        if to_call > 0:
            to_call, warn = check_to_call(to_call, cr.get('call_btn'), players, hero_bet)
            if warn:
                log.warning("Read check: %s", warn)
                read_warnings.append(warn)
        pot = cr['pot'] if cr['pot'] is not None else hero_bet + sum(pl['bet'] for pl in players)
    else:
        call_value = getattr(t, 'currentCallValue', None)
        if call_value in (None, ''):
            call_value = getattr(t, 'minCall', 0)
        to_call = 0.0 if getattr(t, 'checkButton', False) else _num(call_value)
        pot = _num(getattr(t, 'totalPotValue', 0))
        if not POT_INCLUDES_CURRENT_BETS:
            pot += hero_bet + sum(pl['bet'] for pl in players)

    dealer = blinds_dealer(game, board, bb, hero_bet, players, n, dealer, to_call)

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
        'readWarnings': read_warnings,
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

    # BET / RAISE: tables with an amount box (mouse_bet_amount) get the exact size typed in;
    # otherwise pick the closest size this table's buttons can make (sizes are "raise to" totals).
    if td is not None and 'mouse_bet_amount' in td:
        return 'Bet exact'
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


def exact_bet(d, state, t=None):
    """How to make the coach's bet like a person would: sometimes a preset button (½ pot, ¾ pot, 3BB,
    pot) if one is close, otherwise type a tidy or untidy number; always between the minimum raise
    and all-in. Returns humanize.bet_plan's dict."""
    try:
        from poker.tools import humanize
    except ImportError:
        import humanize
    already, call, pot, bb = state['heroBet'], state['toCall'], state['pot'], state['bb']
    min_to = _num(getattr(t, 'minBet', 0)) if t is not None else 0
    min_to = min_to or max(already + call * 2, bb)
    hi = state['heroStack'] + already
    td = getattr(t, 'table_dict', None) or {}
    street = 'preflop' if not state.get('board') else 'postflop'
    presets = {}
    after_call = pot + call  # what the pot would be once we've called
    sizes = {'1/2': 0.5, '3/4': 0.75, 'Pot': 1.0}
    for name in (td.get('bet_presets') or {}).get(street, {}):
        if name in sizes:
            presets[name] = already + call + sizes[name] * after_call
        elif name.upper().endswith('BB') and name[:-2].isdigit():
            presets[name] = int(name[:-2]) * bb
    return humanize.bet_plan(d.get('amount', 0), bb, min_to, hi, presets)


# One row per decision, kept on your PC. report.py joins it with the hand results.
LOG_DIR = os.environ.get('POKER_COACH_LOG_DIR') or os.path.join(os.path.expanduser('~'), 'poker', 'logs')
DECISION_FIELDS = ['time', 'game_id', 'street', 'position', 'in_position', 'hero_cards', 'board', 'pot', 'to_call',
                   'hero_stack', 'bb', 'opponents', 'action', 'amount', 'tag', 'equity', 'ev', 'button', 'reason',
                   'hero_bet', 'warnings', 'explain']


def _upgrade_log(path):
    """Older logs were written without some columns: rewrite them once with the current header."""
    with open(path, encoding='utf-8-sig', errors='replace', newline='') as f:
        r = csv.DictReader(f)
        if r.fieldnames == DECISION_FIELDS:
            return
        rows = list(r)
    with open(path + '.tmp', 'w', newline='', encoding='utf-8-sig') as f:
        w = csv.DictWriter(f, fieldnames=DECISION_FIELDS, extrasaction='ignore')
        w.writeheader()
        w.writerows(rows)
    os.replace(path + '.tmp', path)


def log_decision(state, d, button, game_id):
    try:
        os.makedirs(LOG_DIR, exist_ok=True)
        path = os.path.join(LOG_DIR, 'coach_decisions.csv')
        new = not os.path.exists(path)
        if not new:
            _upgrade_log(path)
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
            'hero_bet': state.get('heroBet', ''),
            'warnings': ' | '.join(list(state.get('readWarnings') or []) + list(d.get('warnings') or [])),
            'explain': json.dumps(d.get('explain'), separators=(',', ':')) if d.get('explain') else '',
        }
        with open(path, 'a', newline='', encoding='utf-8-sig' if not os.path.exists(path) else 'utf-8') as f:
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
            self.coach_state = state  # for humanize.think_time
            self.decision = to_button(d, state, t)
            if self.decision == 'Bet exact':
                self.bet_plan = exact_bet(d, state, t)
                self.bet_amount = self.bet_plan['amount']
                log.info("Bet plan: %s", self.bet_plan)
            t.currentBluff = 1 if d.get('tag') in ('BLUFF', 'SEMI-BLUFF') else 0
            log.info("Coach: %s [%s] - %s -> button %s", *(_ascii(v) for v in (d.get('text'), d.get('tag'), d.get('reason'), self.decision)))
            log_decision(state, d, self.decision, getattr(h, 'GameID', ''))
        except Exception as e:  # never stall the bot: use dickreuter's own logic for this one
            log.warning("Coach brain failed (%s); using dickreuter's decision", e)
            self.coach = None
            self.coach_state = None
            super().make_decision(t, h, p, l)
            try:  # still remember the snapshot so later streets know what happened
                remember(state, {'action': {'Fold': 'FOLD', 'Check': 'CHECK', 'Call': 'CALL'}.get(self.decision, 'RAISE'),
                                 'amount': _num(getattr(t, 'minBet', 0))})
            except Exception:
                pass


# ── Acting reliably, and pre-action buttons ──

def _acting(table):
    try:
        return bool(table.gui_signals.ui.auto_act.isChecked())
    except Exception:
        return False


def still_my_turn(table):
    """Take a fresh screenshot: is it (still) our turn?"""
    try:
        table.take_screenshot2()
        if table.crop_from_top_left_corner() is None:
            return False
        td = getattr(table, 'table_dict', {}) or {}
        if 'preaction_button' in td:  # pre-action buttons showing = we've acted, it's someone else's turn
            from poker.tools.screen_operations import is_template_in_search_area
            if is_template_in_search_area(td, table.screenshot, 'preaction_button', 'buttons_search_area'):
                return False
        return bool(table.is_my_turn())
    except Exception as e:
        log.debug("turn check failed: %s", e)
        return False


def check_action_landed(table, mouse, target, options, retries=1):
    """After clicking: if it's still our turn a moment later the click didn't land (lag, a popup over
    the button) - try once more, then leave it to you."""
    import random
    import time
    for attempt in range(retries + 1):
        time.sleep(random.uniform(1.5, 2.5))
        if not still_my_turn(table):
            return True
        if attempt < retries:
            log.warning("Still our turn after clicking %s - trying again", target)
            mouse.mouse_action(target, table.tlc, options)
    log.error("Clicked %s twice and it's still our turn - please act yourself", target)
    return False


def wait_turn_over(table, timeout=90):
    """Advice-only mode: instead of stopping for Enter, wait until you've acted (or the timer ran out)."""
    import time
    end = time.time() + timeout
    while time.time() < end:
        time.sleep(0.7)
        if not still_my_turn(table):
            return
    log.info("Still your turn after %ss - carrying on", timeout)


def preflop_settled(board, bets):
    """False when this can't be a real preflop spot: no board, and no chips in front of anyone.
    The blinds stay in front of their seats until preflop ends, so this means the betting finished
    and the flop is still being dealt face-down (Torn already shows Bet/Check/Fold then)."""
    return bool(board) or any((b or 0) > 0 for b in bets)


_unsettled = {'since': None}


def street_settled(t, max_wait=6.0):
    """Part of dickreuter's "ready" checks (install.py adds it): wait for the next screenshot while the
    flop is being dealt, instead of deciding a "preflop" spot that's really the flop. After max_wait
    seconds it lets the decision through anyway, so a misread can never stall the bot."""
    import time
    try:
        td = getattr(t, 'table_dict', None) or {}
        img = getattr(t, 'screenshot', None)
        if not td.get('coach_reader') or img is None:
            return True
        try:
            from poker.scraper.card_reader import read_bet
        except ImportError:
            from card_reader import read_bet
        bets = [read_bet(img, b) for b in (_box(td, 'player_pot_area', s) for s in range(int(_num(getattr(t, 'total_players', 9), 9)) or 9)) if b]
        if preflop_settled(getattr(t, 'cardsOnTable', None), bets):
            _unsettled['since'] = None
            return True
        now = time.time()
        if _unsettled['since'] is None:
            _unsettled['since'] = now
        if now - _unsettled['since'] > max_wait:
            log.info("No chips in front of anyone preflop for %ss - deciding anyway", max_wait)
            _unsettled['since'] = None
            return True
        log.info("Preflop betting is over and the flop is still being dealt - waiting for it")
        time.sleep(0.4)
        return False
    except Exception as e:
        log.debug("street check failed: %s", e)
        return True


def chen(cards):
    """Bill Chen's preflop score for two cards like ['KD', '9S'] (higher = better; 12+ premium, <4 junk)."""
    vals = {'A': 10, 'K': 8, 'Q': 7, 'J': 6, 'T': 5}
    order = '23456789TJQKA'
    r1, r2 = sorted((c[0].upper() for c in cards), key=order.index, reverse=True)
    s1, s2 = (c[1].upper() for c in cards)
    score = vals.get(r1, order.index(r1) + 2 if r1 not in vals else 0) / (1 if r1 in vals else 2)
    if r1 == r2:
        return max(5, score * 2)
    if s1 == s2:
        score += 2
    gap = order.index(r1) - order.index(r2) - 1
    score -= {0: 0, 1: 1, 2: 2, 3: 4}.get(gap, 5)
    if gap <= 1 and order.index(r1) < order.index('Q'):
        score += 1
    return score


PREACTION = {'chance': 0.3, 'max_chen': 2}  # tick the pre-action Fold on ~30% of junk hands (72o, Q5o, J3o)
_preaction_done = {}


def preaction(table, history, mouse):
    """Not our turn yet. Now and then, with a junk hand preflop, tick the site's pre-action Fold
    (or Check/Fold) the way people do, so the fold happens the moment the action reaches us.
    Decided once per hand. Always returns False (the bot still has nothing to do this loop)."""
    import random
    import time
    try:
        td = getattr(table, 'table_dict', {}) or {}
        game = getattr(history, 'GameID', None)
        if game in _preaction_done or not _acting(table) or 'preaction_button' not in td:
            return False
        cards = [str(c) for c in (getattr(table, 'mycards', None) or [])]
        if len(cards) != 2 or getattr(table, 'cardsOnTable', None):
            return False
        from poker.tools.screen_operations import is_template_in_search_area
        if not is_template_in_search_area(td, table.screenshot, 'preaction_button', 'buttons_search_area'):
            return False
        _preaction_done[game] = True
        if len(_preaction_done) > 50:
            for k in list(_preaction_done)[:-10]:
                _preaction_done.pop(k, None)
        try:
            from poker.tools import humanize
            humanize.observe(mouse.mouse.position())
            if humanize.user_idle_for() < humanize.SETTINGS['user_quiet_s'] * 2:
                _preaction_done.pop(game, None)  # you're using the mouse: maybe later this hand
                return False
        except Exception:
            pass
        if chen(cards) > PREACTION['max_chen'] or random.random() > PREACTION['chance']:
            return False
        # not on the button (might steal) or in the blinds (might check for free)
        if int(_num(getattr(table, 'dealer_position', -1), -1)) == 0:
            return False
        a = td.get('player_pot_area', {}).get('0')
        if a:
            from poker.scraper.card_reader import read_amount
            if read_amount(table.screenshot, (a['x1'], a['y1'], a['x2'], a['y2'])):
                return False
        time.sleep(random.uniform(0.4, 2.5))  # look at the cards first
        log.info("Pre-action: ticking Fold with %s", ' '.join(cards))
        coo = td['mouse_fold']
        tlx, tly = table.tlc
        mouse.take_action(coo['x1'] + tlx, coo['y1'] + tly, coo['x2'] + tlx, coo['y2'] + tly)
        mouse.move_mouse_away_from_buttons()  # and off the button again
    except Exception as e:
        log.warning("pre-action skipped: %s", e)
    return False
