"""
local_server.py — a stand-in for dickreuter's online database, running only on your own PC.

Out of the box, dickreuter/poker sends everything to its author's server (dickreuter.com:7778):
your table mappings and screenshots, your strategies, every round you play, and (with collusion on)
your hole cards. It also refuses to start if that server says a newer version exists.

This server answers the same requests on 127.0.0.1 and keeps everything in one SQLite file on your
PC, so nothing leaves your machine. install.py points dickreuter's config.ini at it, and
start-bot.bat starts it before the bot.

    python local_server.py [--port 7778] [--data DIR] [--dickreuter DIR]

Data lives in DIR/pokerbot.sqlite (default: ~/poker/local-db). It only listens on 127.0.0.1.
Standard library only, so it needs nothing installed.
"""
import argparse
import base64
import datetime
import json
import logging
import os
import socket
import sqlite3
import sys
import threading
from email.parser import BytesParser
from email.policy import default as email_policy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

log = logging.getLogger('local_server')
COMPUTER_NAME = socket.gethostname()

# Every key dickreuter's decision maker and strategy editor read, so its own logic (used as the
# fallback when the coach brain can't decide) and its GUI work without the online strategies.
# Equities are fractions of 1. Set bigBlind/smallBlind to your game's blinds in the strategy editor.
DEFAULT_STRATEGY = {
    'Strategy': 'Default', 'pokerSite': 'Custom', 'computername': COMPUTER_NAME,
    'bigBlind': 0.02, 'smallBlind': 0.01, 'initialFunds': 2.0, 'initialFunds2': 2.0,
    'PreFlopMinCallEquity': 0.55, 'PreFlopMinBetEquity': 0.65, 'PreFlopMaxBetEquity': 0.95,
    'PreFlopCallPower': 1, 'PreFlopBetPower': 1,
    'FlopMinCallEquity': 0.55, 'FlopMinBetEquity': 0.65, 'FlopCallPower': 1, 'FlopBetPower': 1,
    'TurnMinCallEquity': 0.6, 'TurnMinBetEquity': 0.7, 'TurnCallPower': 1, 'TurnBetPower': 1,
    'RiverMinCallEquity': 0.65, 'RiverMinBetEquity': 0.75, 'RiverCallPower': 1, 'RiverBetPower': 1,
    'FlopBluff': 0, 'FlopBluffMinEquity': 0.2, 'FlopBluffMaxEquity': 0.35,
    'TurnBluffMinEquity': 0.2, 'TurnBluffMaxEquity': 0.35, 'RiverBluffMinEquity': 0.1, 'RiverBluffMaxEquity': 0.25,
    'FlopCheckDeceptionMinEquity': 0.9, 'TurnCheckDeceptionMinEquity': 0.9, 'RiverCheckDeceptionMinEquity': 0.9,
    'alwaysCallEquity': 0.95, 'betPotRiverEquity': 0.9, 'betPotRiverEquityMaxBBM': 30,
    'secondRiverBetPotMinEquity': 0.9, 'BetPlusInc': 1, 'minimum_bet_size': 3,
    'potAdjustment': 0.2, 'potAdjustmentPreFlop': 0.2, 'maxPotAdjustment': 0.2, 'maxPotAdjustmentPreFlop': 0.2,
    'secondRoundAdjustment': 0.05, 'secondRoundAdjustmentPreFlop': 0.05, 'secondRoundAdjustmentPowerIncrease': 1,
    'minBullyEquity': 0.6, 'maxBullyEquity': 0.9, 'bullyDivider': 1,
    'CoveredPlayersCallLikelihoodFlop': 0.5, 'considerLastGames': 1, 'strategyIterationGames': 1000,
    'minimumLossForIteration': -1,
    'max_abs_fundchange': 1_000_000,  # dickreuter skips logging any hand that won or lost more than this
    'use_relative_equity': 0, 'use_pot_multiples': 0,
    'opponent_raised_without_initiative_flop': 1, 'opponent_raised_without_initiative_turn': 1,
    'opponent_raised_without_initiative_river': 1, 'differentiate_reverse_sheet': 1, 'range_of_range': 0,
    'preflop_override': 1, 'gather_player_names': 0, 'collusion': 0,
    'flop_betting_condidion_1': 1, 'turn_betting_condidion_1': 1, 'river_betting_condidion_1': 1,
    'flop_bluffing_condidion_1': 1, 'turn_bluffing_condidion_1': 1, 'turn_bluffing_condidion_2': 1,
    'river_bluffing_condidion_1': 0, 'river_bluffing_condidion_2': 1,
    'always_call_low_stack_multiplier': 8, 'out_multiplier': 0, 'antibluff_percentage': 0,
    'pre_flop_equity_reduction_by_position': 0.01, 'pre_flop_equity_increase_if_bet': 0.2,
    'pre_flop_equity_increase_if_call': 0.1, 'range_multiple_players': 0.2, 'range_preflop': 1,
    'increased_preflop_betting': 1,
    **{f'range_utg{i}': 0.2 for i in range(9)},
}


class Store:
    def __init__(self, path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.lock = threading.Lock()
        with self.lock:
            self.db.executescript("""
                CREATE TABLE IF NOT EXISTS tables (name TEXT PRIMARY KEY, data TEXT, nn_weights TEXT);
                CREATE TABLE IF NOT EXISTS strategies (name TEXT PRIMARY KEY, data TEXT);
                CREATE TABLE IF NOT EXISTS rounds (id INTEGER PRIMARY KEY, game_id TEXT, ts TEXT, data TEXT);
                CREATE TABLE IF NOT EXISTS games (id INTEGER PRIMARY KEY, game_id TEXT, ts TEXT, strategy TEXT,
                                                  funds_change REAL, outcome TEXT, stage TEXT, data TEXT);
                CREATE INDEX IF NOT EXISTS rounds_game ON rounds(game_id);
            """)
            if not self.db.execute("SELECT 1 FROM strategies WHERE name='Default'").fetchone():
                self.db.execute("INSERT INTO strategies VALUES (?, ?)", ('Default', json.dumps(DEFAULT_STRATEGY)))
            self.db.commit()

    def q(self, sql, args=()):
        with self.lock:
            cur = self.db.execute(sql, args)
            self.db.commit()
            return cur.fetchall()

    # tables
    def table(self, name):
        r = self.q("SELECT data FROM tables WHERE name=?", (name,))
        return json.loads(r[0][0]) if r else None

    def put_table(self, name, data):
        self.q("INSERT INTO tables(name, data) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET data=excluded.data",
               (name, json.dumps(data)))


class Api:
    """One method per dickreuter endpoint. `a` is the merged query params and JSON body."""

    def __init__(self, store, dickreuter_dir):
        self.s = store
        self.dickreuter_dir = dickreuter_dir

    # ── app / updates ──
    def get_internal(self, a):
        sheet = os.path.join(self.dickreuter_dir, 'poker', 'decisionmaker', 'preflop.xlsx') if self.dickreuter_dir else ''
        return [{'current_version': 0, 'dl': '', 'latest_updates': [], 'preflop_url': sheet, 'payment_link': ''}]

    # ── strategies ──
    def get_playable_strategy_list(self, a):
        return [r[0] for r in self.s.q("SELECT name FROM strategies ORDER BY name='Default' DESC, name")]

    def get_strategy(self, a):
        r = self.s.q("SELECT data FROM strategies WHERE name=?", (a.get('name', 'Default'),))
        return [json.loads(r[0][0])] if r else []

    def save_strategy(self, a):
        st = json.loads(a['strategy'])
        st.pop('_id', None)
        st.setdefault('computername', COMPUTER_NAME)
        self.s.q("INSERT INTO strategies VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET data=excluded.data",
                 (st['Strategy'], json.dumps(st)))
        return True

    def update_strategy(self, a):
        st = json.loads(a['strategy'])
        st['Strategy'] = a.get('name', st.get('Strategy'))
        return self.save_strategy({'strategy': json.dumps(st)})

    def get_played_strategy_list(self, a):
        return [r[0] for r in self.s.q("SELECT DISTINCT strategy FROM games WHERE strategy IS NOT NULL")] or ['Default']

    def get_top_strategies(self, a):
        rows = self.s.q("SELECT strategy, COUNT(*), SUM(funds_change) FROM games GROUP BY strategy")
        out = []
        for name, n, total in rows:
            st = self.get_strategy({'name': name})
            bb = float(st[0].get('bigBlind', 1)) if st else 1
            out.append({'Strategy': name, 'Games': n, 'Return per bb in 100 Hands': (total or 0) / bb / n * 100 if n else 0})
        return json.dumps(out or [{'Strategy': 'Default', 'Games': 0, 'Return per bb in 100 Hands': 0}])

    # ── tables (mappings) ──
    def get_available_tables(self, a):
        return [r[0] for r in self.s.q("SELECT name FROM tables ORDER BY name")]

    def get_table(self, a):
        return self.s.table(a.get('table_name')) or {}

    def get_table_owner(self, a):
        t = self.s.table(a.get('table_name'))
        return t.get('owner', COMPUTER_NAME) if t else None

    def create_new_table(self, a):
        name = a.get('table_name')
        if not name or self.s.table(name) is not None:
            raise ApiError(409, False)
        self.s.put_table(name, {'table_name': name, 'owner': a.get('computer_name', COMPUTER_NAME)})
        return True

    def create_new_table_from_old(self, a):
        name, old = a.get('table_name'), self.s.table(a.get('old_table_name'))
        if not name or old is None or self.s.table(name) is not None:
            return False
        self.s.put_table(name, {**old, 'table_name': name, 'owner': a.get('computer_name', COMPUTER_NAME)})
        return True

    def _edit(self, name, fn):
        t = self.s.table(name)
        if t is None:
            raise ApiError(404, False)
        fn(t)
        self.s.put_table(name, t)
        return True

    def save_coordinates(self, a):
        label, coords = a['label'], json.loads(a['coordinates_dict'])

        def f(t):
            if '.' in label:  # per-player areas, e.g. player_funds_area.3
                base, player = label.split('.', 1)
                if not isinstance(t.get(base), dict):
                    t[base] = {}
                t[base][player] = coords
            else:
                t[label] = coords
        return self._edit(a['table_name'], f)

    def update_table_image(self, a):
        return self._edit(a['table_name'], lambda t: t.__setitem__(a['label'], a['pil_image']))

    def update_state(self, a):
        return self._edit(a['table_name'], lambda t: t.__setitem__(a['label'], str(a['state'])))

    def load_table_image(self, a):
        t = self.s.table(a.get('table_name')) or {}
        return t.get(a.get('image_name'))

    def delete_table(self, a):
        t = self.s.table(a.get('table_name'))
        if t and t.get('owner', COMPUTER_NAME) == a.get('owner', COMPUTER_NAME):
            self.s.q("DELETE FROM tables WHERE name=?", (a['table_name'],))
        return True

    def increment_plays(self, a):
        return True

    def update_tensorflow_model(self, a):
        name = a['table_name']
        weights = a.get('hdf5_file', b'')
        self._edit(name, lambda t: t.update({'_model': a.get('model_str'), '_class_mapping': a.get('class_mapping')}))
        self.s.q("UPDATE tables SET nn_weights=? WHERE name=?", (base64.b64encode(weights).decode(), name))
        return True

    def get_tensorflow_weights(self, a):
        r = self.s.q("SELECT nn_weights FROM tables WHERE name=?", (a.get('table_name'),))
        if not r or not r[0][0]:
            raise ApiError(404, 'no trained network for this table')
        return r[0][0]

    # ── game log (kept locally; this is what dickreuter used to upload) ──
    def insert_round(self, a):
        rec = json.loads(a['rec'])
        self.s.q("INSERT INTO rounds(game_id, ts, data) VALUES (?, ?, ?)",
                 (str(rec.get('GameID', '')), str(rec.get('logging_timestamp', '')), json.dumps(rec)))
        return True

    def get_rounds(self, a):
        return [json.loads(r[0]) for r in self.s.q("SELECT data FROM rounds WHERE game_id=? ORDER BY id", (str(a.get('game_id')),))]

    def insert_games(self, a):
        rec = json.loads(a['rec'])
        self.s.q("INSERT INTO games(game_id, ts, strategy, funds_change, outcome, stage, data) VALUES (?,?,?,?,?,?,?)",
                 (str(rec.get('GameID')), rec.get('logging_timestamp'), rec.get('Template'),
                  float(rec.get('FinalFundsChange') or 0), rec.get('FinalOutcome'), rec.get('FinalStage'), json.dumps(rec)))
        return True

    # ── card sharing: never ──
    def insert_collusion(self, a):
        return True

    def get_collusion_cards(self, a):
        return {'collusion_cards': '', 'player_dropped_out': False}

    # ── strategy analyser charts (simple local versions) ──
    def _games(self, a):
        st = a.get('strategy') or a.get('p_value')
        return self.s.q("SELECT funds_change, data FROM games WHERE (? IS NULL OR strategy=?) ORDER BY id", (st, st))

    def get_game_count(self, a):
        return len(self._games(a))

    def get_strategy_return(self, a):
        return sum(r[0] for r in self._games(a))

    def get_fundschange_chart(self, a):
        total, out = 0.0, []
        for fc, _ in self._games(a):
            total += fc
            out.append(round(total, 4))
        return out

    def get_worst_games(self, a):
        rows = sorted(self._games(a), key=lambda r: r[0])[:20]
        return [{k: json.loads(d).get(k) for k in ('GameID', 'FinalFundsChange', 'FinalStage', 'FinalDecision', 'FinalEquity')}
                for _, d in rows]

    def get_histrogram_data(self, a):
        return {'equity_win': [], 'equity_loss': []}

    def get_scatterplot_data(self, a):
        return {'wins': '[]', 'losses': '[]'}

    def get_stacked_bar_data(self, a):
        return {'d': '{}'}

    def get_stacked_bar_data2(self, a):
        return json.dumps([])


class ApiError(Exception):
    def __init__(self, status, body):
        super().__init__(body)
        self.status, self.body = status, body


def make_handler(api):
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            self._serve()

        def do_GET(self):
            self._serve()

        def _serve(self):
            url = urlparse(self.path)
            name = url.path.strip('/')
            args = {k: v[0] for k, v in parse_qs(url.query).items()}
            n = int(self.headers.get('Content-Length') or 0)
            body = self.rfile.read(n) if n else b''
            ctype = self.headers.get('Content-Type', '')
            try:
                if body and 'application/json' in ctype:
                    args.update(json.loads(body))
                elif body and 'multipart/form-data' in ctype:
                    msg = BytesParser(policy=email_policy).parsebytes(b'Content-Type: ' + ctype.encode() + b'\r\n\r\n' + body)
                    for part in msg.iter_parts():
                        key = part.get_param('name', header='content-disposition')
                        val = part.get_payload(decode=True)
                        args[key] = val if part.get_filename() else val.decode('utf-8', 'replace')
                elif body and 'x-www-form-urlencoded' in ctype:
                    args.update({k: v[0] for k, v in parse_qs(body.decode()).items()})
                fn = getattr(api, name, None)
                if fn is None or name.startswith('_'):
                    log.warning("unknown endpoint %s (answered with an empty list)", name)
                    status, result = 200, []
                else:
                    status, result = 200, fn(args)
            except ApiError as e:
                status, result = e.status, e.body
            except Exception as e:  # keep the bot alive; it'll log its own error
                log.exception("error in %s", name)
                status, result = 500, {'error': str(e)}
            out = json.dumps(result, default=str).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(out)))
            self.end_headers()
            self.wfile.write(out)

        def log_message(self, fmt, *args):
            log.debug(fmt, *args)

    return Handler


def serve(port=7778, data_dir=None, dickreuter_dir=None, block=True):
    data_dir = data_dir or os.path.join(os.path.expanduser('~'), 'poker', 'local-db')
    api = Api(Store(os.path.join(data_dir, 'pokerbot.sqlite')), dickreuter_dir)
    httpd = ThreadingHTTPServer(('127.0.0.1', port), make_handler(api))
    log.info("Local poker database on http://127.0.0.1:%d/ (data in %s)", port, data_dir)
    if block:
        httpd.serve_forever()
    else:
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--port', type=int, default=7778)
    ap.add_argument('--data', default=None)
    ap.add_argument('--dickreuter', default=os.environ.get('DICKREUTER_DIR'))
    o = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(message)s')
    try:
        serve(o.port, o.data, o.dickreuter)
    except OSError as e:
        sys.exit(f"Couldn't start on port {o.port} ({e}). Is it already running?")
