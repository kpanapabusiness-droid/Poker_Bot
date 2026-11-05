"""
End-to-end test: dickreuter's own client code (MongoManager, StrategyHandler, UpdateChecker,
GameLogger) talking to local_server.py, after install.py has pointed it there.

Needs a dickreuter checkout (DICKREUTER_DIR, default ../dickreuter/poker next to this repo) and
dickreuter's light dependencies (pandas, pillow, requests, fastapi, openpyxl). Skips otherwise.
Run: python3 integrations/dickreuter/test_local_server.py
"""
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
DR = os.environ.get('DICKREUTER_DIR', os.path.join(HERE, '..', '..', '..', 'dickreuter', 'poker'))

CLIENT = r'''
import io, json, sys, types
from types import SimpleNamespace as NS
from PIL import Image
import pandas as pd
ok = fail = 0
def check(name, cond, detail=''):
    global ok, fail
    ok, fail = ok + bool(cond), fail + (not cond)
    print(('  ✓ ' if cond else '  ✗ ') + name + ('' if cond else ' ' + str(detail)))

from poker.tools.helper import get_config, COMPUTER_NAME
check('config points at the local database', get_config().config.get('main', 'db') == 'http://127.0.0.1:%PORT%/')

from poker.tools.update_checker import UpdateChecker
u = UpdateChecker()
u.check_update(6.0)   # dickreuter exits here if the server reports a newer version
check("update check passes (bot won't refuse to start)", True)
url, backup = u.get_preflop_sheet_url()
check("preflop sheet loads from the local copy", len(pd.read_excel(url, sheet_name=None, engine='openpyxl')) > 0, url)

from poker.tools.strategy_handler import StrategyHandler
s = StrategyHandler()
check('Default strategy is listed', 'Default' in s.get_playable_strategy_list())
s.read_strategy('Default')
check('Default strategy loads with collusion off', s.selected_strategy['Strategy'] == 'Default' and s.selected_strategy['collusion'] == 0)
st = dict(s.selected_strategy); st['Strategy'] = 'Friends 1/2'; st['bigBlind'] = 2; st['smallBlind'] = 1
check('save a new strategy', s.save_strategy(st))
s.read_strategy('Friends 1/2')
check('read it back', s.selected_strategy['bigBlind'] == 2)
st['bigBlind'] = 4
check('update it', s.update_strategy(dict(st)) and (s.read_strategy('Friends 1/2') and s.selected_strategy['bigBlind'] == 4))
s.read_strategy('Does not exist')
check('unknown strategy falls back to Default', s.selected_strategy['Strategy'] == 'Default')

from poker.tools.mongo_manager import MongoManager
m = MongoManager()
check('new blank table', bool(m.create_new_table('PokerNow test')))
check('duplicate name refused', not m.create_new_table('PokerNow test'))
check('table is listed', 'PokerNow test' in m.get_available_tables(COMPUTER_NAME))
check('you own it (so the editor lets you edit)', m.get_table_owner('PokerNow test') == COMPUTER_NAME)
m.save_coordinates('PokerNow test', 'buttons_search_area', {'x1': 1, 'y1': 2, 'x2': 30, 'y2': 40})
m.save_coordinates('PokerNow test', 'player_funds_area.3', {'x1': 5, 'y1': 6, 'x2': 7, 'y2': 8})
m.save_coordinates('PokerNow test', 'max_players', {'value': 6})
img = Image.new('RGB', (12, 9), (200, 10, 10))
m.update_table_image(pil_image=img, label='AH', table_name='PokerNow test')
m.update_state(state='CheckState.Unchecked', label='use_neural_network', table_name='PokerNow test')
t = m.get_table('PokerNow test')
check('coordinates saved', t['buttons_search_area'] == {'x1': 1, 'y1': 2, 'x2': 30, 'y2': 40})
check('per-player area nested like the scraper expects', t['player_funds_area']['3']['x2'] == 7)
check('card image comes back as PNG bytes', isinstance(t['AH'], bytes) and Image.open(io.BytesIO(t['AH'])).size == (12, 9))
check('image reloads in the editor', m.load_table_image('AH', 'PokerNow test').size == (12, 9))
check('copy a table', m.create_new_table_from_old('PokerNow copy', 'PokerNow test') and m.get_table('PokerNow copy')['max_players']['value'] == 6)
m.delete_table('PokerNow copy', COMPUTER_NAME)
check('delete a table', 'PokerNow copy' not in m.get_available_tables(COMPUTER_NAME))
m.update_tensorflow_model('PokerNow test', b'\x89HDF-weights', '{"model": 1}', '{"0": "AH"}')
m.load_table_nn_weights('PokerNow test')
from poker.tools.helper import get_dir
check('neural-network weights round-trip', open(get_dir('codebase') + '/loaded_model.h5', 'rb').read() == b'\x89HDF-weights')

from poker.tools.game_logger import GameLogger
import threading
g = GameLogger()
import requests
from poker.tools.mongo_manager import URL
requests.post(URL + 'insert_round', json={'rec': json.dumps({'GameID': 'g1', 'decision': 'Call'})})
check('rounds are stored locally', m.get_rounds('g1') == [{'GameID': 'g1', 'decision': 'Call'}])
import os
os.environ.setdefault('COMPUTERNAME', COMPUTER_NAME)
h = NS(histGameStage='Flop', lastGameID='g1', wins=0, losses=0, totalGames=0, histDecision='Call', histEquity=0.5)
tt = NS(myFundsChange=-3.5, current_strategy='Friends 1/2', version=6.0, ip='')
g.mark_last_game(tt, h, NS(selected_strategy={'max_abs_fundchange': 1000000}))
import time as _t; _t.sleep(0.5)
check('finished hand saved with its result', g.get_game_count('Friends 1/2') == 1 and g.get_strategy_return('Friends 1/2', 9999) == -3.5)
check('analyser charts work', g.get_fundschange_chart('Friends 1/2') == [-3.5] and not g.get_worst_games('Friends 1/2').empty)
check('top strategies table works', 'Return per bb in 100 Hands' in m.get_top_strategies().columns)
cards, dropped = g.get_collusion_cards(1, 'Flop')
check('no card sharing', cards == '' and dropped is False)
print('RESULT', ok, fail)
'''


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    p = s.getsockname()[1]
    s.close()
    return p


def main():
    if not os.path.exists(os.path.join(DR, 'poker', 'main.py')):
        print(f'skipped: no dickreuter checkout at {DR}')
        return 0
    try:
        import fastapi, pandas, PIL, requests, openpyxl  # noqa: F401
    except ImportError as e:
        print(f'skipped: {e}')
        return 0
    tmp = tempfile.mkdtemp()
    repo, data = os.path.join(tmp, 'dr'), os.path.join(tmp, 'data')
    port = free_port()
    shutil.copytree(DR, repo, ignore=shutil.ignore_patterns('.git', 'website', 'doc', 'notebooks', 'tests'))
    srv = None
    try:
        r = subprocess.run([sys.executable, os.path.join(HERE, 'install.py'), repo], capture_output=True, text=True)
        assert r.returncode == 0, r.stdout + r.stderr
        for ini in ('config.ini', 'config_default.ini'):  # use a free port for the test
            p = os.path.join(repo, 'poker', ini)
            txt = open(p).read().replace('127.0.0.1:7778', f'127.0.0.1:{port}')
            open(p, 'w').write(txt)
        srv = subprocess.Popen([sys.executable, os.path.join(HERE, 'local_server.py'), '--port', str(port),
                                '--data', data, '--dickreuter', repo])
        for _ in range(50):
            try:
                socket.create_connection(('127.0.0.1', port), 0.2).close()
                break
            except OSError:
                time.sleep(0.1)
        env = {**os.environ, 'PYTHONPATH': repo, 'COMPUTERNAME': socket.gethostname(), 'PYTHONIOENCODING': 'utf-8'}
        out = subprocess.run([sys.executable, '-c', CLIENT.replace('%PORT%', str(port))], cwd=repo, env=env,
                             capture_output=True, text=True, timeout=120)
        print(out.stdout)
        if 'RESULT' not in out.stdout:
            print(out.stderr[-3000:])
            return 1
        ok, fail = map(int, out.stdout.strip().splitlines()[-1].split()[1:])
        print(f'{ok} passed, {fail} failed')
        return 1 if fail else 0
    finally:
        if srv:
            srv.terminate()
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main())
