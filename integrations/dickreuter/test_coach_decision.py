"""Tests for the dickreuter bridge. Run: python3 integrations/dickreuter/test_coach_decision.py"""
import os
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace as NS

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
LOGS = tempfile.mkdtemp()
os.environ['POKER_COACH_LOG_DIR'] = LOGS
os.environ['POKER_COACH_TRACKER'] = os.path.join(LOGS, 'players.json')
import coach_decision as C  # noqa: E402

passed = failed = 0


def check(name, ok, detail=''):
    global passed, failed
    passed, failed = passed + ok, failed + (not ok)
    print(f"  {'✓' if ok else '✗'} {name} {'' if ok else detail}")


def table(cards, board=(), dealer=0, pot=3.0, call=2.0, funds=200.0, bets=None, live=None, check_btn=False, min_bet=4.0, all_in=True):
    bets = bets or {}
    live = live if live is not None else [1, 2, 3, 4, 5]
    return NS(mycards=list(cards), cardsOnTable=list(board), total_players=6, bigBlind=2.0, dealer_position=dealer,
              totalPotValue=pot, minCall=call, checkButton=check_btn, myFunds=funds, minBet=min_bet,
              table_dict={'mouse_all_in': {}} if all_in else {},
              other_players=[{'abs_position': i, 'funds': 200.0, 'pot': bets.get(i + 1, 0.0), 'status': 1 if i + 1 in live else 0}
                             for i in range(5)])


def decide(t, game=1):
    h = NS(GameID=game)
    d = C.CoachDecision()
    d.make_decision(t, h, None, None)
    return d


print('\nState conversion')
s = C.table_to_state(table(['AS', 'KD'], bets={4: 1.0, 5: 2.0}), NS(GameID=99))
check('cards, blinds and seats come through', s['heroCards'] == ['AS', 'KD'] and s['players'][3]['bet'] == 1.0 and s['nSeats'] == 6)
check("dickreuter's 9999999 'unknown' becomes 0", C._num(9999999.0) == 0 and C._num('') == 0)
check('check button means nothing to call', C.table_to_state(table(['AS', 'KD'], check_btn=True))['toCall'] == 0)

print('\nDecisions through brain.js (dealer=3 → hero under the gun)')
d = decide(table(['AS', 'AD'], dealer=3, bets={4: 1.0, 5: 2.0}))
check('AA UTG raises', d.decision in ('Bet', 'Bet half pot', 'Bet pot'), d.decision)
check('coach output kept for logging', d.coach and d.coach['action'] == 'RAISE')
d = decide(table(['7S', '2D'], dealer=3, bets={4: 1.0, 5: 2.0}))
check('72o UTG folds', d.decision == 'Fold', d.decision)
d = decide(table(['TS', '3H'], dealer=4, call=0.0, check_btn=True, pot=8, bets={5: 2.0, 4: 2.0, 1: 2.0, 2: 2.0}))
check('BB with trash in a limped pot checks, never folds', d.decision == 'Check', d.decision)

print('\nPostflop, with history carried across streets')
pre = table(['AH', 'KH'], dealer=0, call=4.0, pot=9, bets={1: 1.0, 2: 6.0}, live=[2])
decide(pre, game=7)
flop = table(['AH', 'KH'], board=['QH', '7H', '2H'], dealer=0, call=0.0, check_btn=True, pot=24, live=[2])
d = decide(flop, game=7)
check('nut flush checked to on the button bets', d.decision.startswith('Bet'), d.decision)
check('villain range narrowed from the preflop call', d.coach['ranges'][0]['combos'] < 1326, d.coach['ranges'])

print('\nButton mapping')
st = {'toCall': 10.0, 'pot': 30.0, 'heroBet': 0.0, 'heroStack': 500.0, 'bb': 2.0}
check('all-in that only calls → Call', C.to_button({'action': 'ALL-IN', 'amount': 10}, st) == 'Call')
check('real all-in → Bet max', C.to_button({'action': 'ALL-IN', 'amount': 500}, st) == 'Bet max')
check('no all-in button on this table → Bet pot', C.to_button({'action': 'ALL-IN', 'amount': 500}, st, NS(table_dict={}, minBet=20)) == 'Bet pot')
check('raise to 35 → half-pot button (35)', C.to_button({'action': 'RAISE', 'amount': 35}, st, NS(table_dict={'mouse_all_in': 1}, minBet=20)) == 'Bet half pot')
check('raise to 60 → pot button (60)', C.to_button({'action': 'RAISE', 'amount': 60}, st, NS(table_dict={'mouse_all_in': 1}, minBet=20)) == 'Bet pot')

print('\nFallback')


class Base:
    def make_decision(self, t, h, p, l):
        self.decision = 'Fold'


CD = type('CD', (C.CoachDecision, Base), {})
d = CD()
d.make_decision(table([], dealer=0), NS(GameID=3), None, None)
check("unreadable cards → dickreuter's own decision", d.decision == 'Fold' and d.coach is None)

print('\nNames and stacks')
tn = table(['AS', 'KD'])
tn.coach_player_names = {1: 'Ann', 2: 'Bob', 3: 'Cy', 4: 'Di', 5: 'Ed'}
tn.player_funds = [200.0, 150.0, 90.5, '', 300.0, 12.0]
st = C.table_to_state(tn, NS(GameID=55))
check('names reach the brain', [pl['name'] for pl in st['players']] == ['Ann', 'Bob', 'Cy', 'Di', 'Ed'], st['players'])
check('stacks read for every seat; unreadable ones fall back', [pl['stack'] for pl in st['players']] == [150.0, 90.5, 200.0, 300.0, 12.0], st['players'])
st2 = C.table_to_state(table(['AS', 'KD'], dealer=4), NS(GameID=56, round_number=0))
check('our big blind counted as our chips before we act', st2['heroBet'] == 2.0, st2['heroBet'])

print('\nBlinds from the strategy')
st = C.table_to_state(table(['AS', 'KD']), None, NS(selected_strategy={'bigBlind': 50}))
check("big blind comes from dickreuter's strategy", st['bb'] == 50)

print('\nDecision log and report')
import csv
rows = list(csv.DictReader(open(os.path.join(LOGS, 'coach_decisions.csv'), encoding='utf-8')))
check('every coach decision is logged', len(rows) >= 4 and rows[0]['action'] == 'RAISE' and rows[0]['hero_cards'] == 'AS AD', rows[:1])
import sqlite3, json as _json
db = os.path.join(LOGS, 'db'); os.makedirs(db)
con = sqlite3.connect(os.path.join(db, 'pokerbot.sqlite'))
con.execute("CREATE TABLE games (id INTEGER PRIMARY KEY, game_id TEXT, ts TEXT, strategy TEXT, funds_change REAL, outcome TEXT, stage TEXT, data TEXT)")
con.execute("INSERT INTO games(game_id, ts, strategy, funds_change, outcome, stage, data) VALUES ('1','2026-11-06T09:00','Default',6,'Won','PreFlop','{}')")
con.execute("INSERT INTO games(game_id, ts, strategy, funds_change, outcome, stage, data) VALUES ('7','2026-11-06T09:01','Default',-2,'Lost','Flop','{}')")
con.commit(); con.close()
r = subprocess.run([sys.executable, os.path.join(HERE, 'report.py'), '--data', db, '--logs', LOGS], capture_output=True, text=True,
                   env={**os.environ, 'PYTHONIOENCODING': 'utf-8'})
check('report runs', r.returncode == 0 and 'Hands: 2' in r.stdout and 'bb/100' in r.stdout, r.stdout + r.stderr)
check('report writes hands.csv with positions', 'LJ' in open(os.path.join(LOGS, 'hands.csv'), encoding='utf-8').read())

print('\nInstaller')
dr = os.environ.get('DICKREUTER_DIR', os.path.join(HERE, '..', '..', '..', 'dickreuter', 'poker'))
if os.path.exists(os.path.join(dr, 'poker', 'main.py')):
    tmp = tempfile.mkdtemp()
    try:
        for rel in ('poker/main.py', 'poker/tools/strategy_handler.py', 'poker/decisionmaker/decisionmaker.py', 'poker/decisionmaker/curvefitting.py', 'poker/tools/screen_operations.py', 'poker/tools/mouse_mover.py', 'poker/config.ini'):
            os.makedirs(os.path.dirname(os.path.join(tmp, rel)), exist_ok=True)
            shutil.copy(os.path.join(dr, rel), os.path.join(tmp, rel))
        for _ in range(2):  # twice: must be idempotent
            r = subprocess.run([sys.executable, os.path.join(HERE, 'install.py'), tmp], capture_output=True, text=True)
        main = open(os.path.join(tmp, 'poker', 'main.py')).read()
        sh = open(os.path.join(tmp, 'poker', 'tools', 'strategy_handler.py')).read()
        check('installer runs twice cleanly', r.returncode == 0, r.stderr)
        check('main.py uses CoachDecision once', main.count('d = CoachDecision(') == 1)
        cf = open(os.path.join(tmp, 'poker', 'decisionmaker', 'curvefitting.py')).read()
        so = open(os.path.join(tmp, 'poker', 'tools', 'screen_operations.py')).read()
        mm = open(os.path.join(tmp, 'poker', 'tools', 'mouse_mover.py')).read()
        check('"$416,500" reads as 416500, not 416.5', "replace(',', '.')" not in so and "replace(',', '')" in so)
        check('screenshots cover every monitor, clicks shifted to match', 'ImageGrab.grab()' not in so and so.count('all_screens=True') >= 1 and '_screen_origin()' in mm)
        check('lmfit crash fixed', 'poker-coach: lmfit 1.3 fix' in cf)
        check('fast fold off and screenshot server off', "poker-coach: fast fold off" in main and 'poker-coach: screenshot web server' in main and 't2.start()' not in main)
        check('collusion forced off', "['collusion'] = 0" in sh and "['collusion'] = 1" not in sh)
        cfg = open(os.path.join(tmp, 'poker', 'config.ini')).read() if os.path.exists(os.path.join(tmp, 'poker', 'config.ini')) else 'db = http://127.0.0.1:7778/'
        check('config.ini points at the local database', 'db = http://127.0.0.1:7778/' in cfg and 'dickreuter.com' not in cfg)
        check('coach_decision.py copied in', os.path.exists(os.path.join(tmp, 'poker', 'decisionmaker', 'coach_decision.py')))
    finally:
        shutil.rmtree(tmp)
else:
    print(f'  (skipped: no dickreuter checkout at {dr}; set DICKREUTER_DIR)')

C.Brain.get().close()
print(f'\n{passed} passed, {failed} failed\n')
sys.exit(1 if failed else 0)
