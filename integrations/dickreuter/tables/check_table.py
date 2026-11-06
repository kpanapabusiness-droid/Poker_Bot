"""
check_table.py — run dickreuter's real screen-reading steps on saved screenshots with a table
mapping, and print what the bot would see and decide. Use it to check a mapping before playing.

    python check_table.py torn_9max.json SHOT1.png [SHOT2.png …] [--dickreuter DIR]

For every screenshot: whether the table was found, your cards, the board, the dealer seat, who is
still in the hand, stacks, bets, pot, the buttons, whether it's your turn, and the coach's decision
(when it is). Nothing is clicked: the mouse is a dummy.
"""
import argparse
import json
import logging
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'sim'))
sys.path.insert(0, os.path.join(HERE, '..'))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('table')
    ap.add_argument('shots', nargs='+')
    ap.add_argument('--dickreuter', default=os.environ.get('DICKREUTER_DIR', os.path.join(HERE, '..', '..', '..', '..', 'dickreuter', 'poker')))
    ap.add_argument('--blinds', default='500,1000')
    o = ap.parse_args()

    from run_sim import prepared_copy
    from dickreuter_seat import setup_dickreuter, _Signals, _Logger, _Strategy, _Mouse
    dr = prepared_copy(os.path.abspath(o.dickreuter))
    setup_dickreuter(dr)
    logging.disable(logging.CRITICAL)
    from PIL import Image
    from poker.decisionmaker.current_hand_memory import History, CurrentHandPreflopState
    from poker.decisionmaker.montecarlo_python import run_montecarlo_wrapper
    from poker.scraper.table_screen_based import TableScreenBased
    from poker.tools.strategy_handler import StrategyHandler
    from local_server import DEFAULT_STRATEGY
    import coach_decision as C
    import types
    import pandas as pd

    sb, bb = [float(x) for x in o.blinds.split(',')]
    table = json.load(open(o.table))
    table_dict = {}
    import base64
    for k, v in table.items():  # same conversion as dickreuter's MongoManager.get_table
        table_dict[k] = base64.b64decode(v) if isinstance(v, str) and v[:2] == 'iV' else v
    sh = StrategyHandler()
    sh.selected_strategy = dict(DEFAULT_STRATEGY, bigBlind=bb, smallBlind=sb)
    sh.check_defaults()
    p = _Strategy(sh.selected_strategy)
    h = History()
    h.preflop_sheet = pd.read_excel(os.path.join(dr, 'poker', 'decisionmaker', 'preflop.xlsx'), sheet_name=None, engine='openpyxl')
    pre = CurrentHandPreflopState()
    config = types.SimpleNamespace(config=types.SimpleNamespace(get=lambda s, k: '3' if k == 'montecarlo_timeout' else ''))
    brain = C.Brain(tracker_file='')

    for shot in o.shots:
        img = Image.open(shot).convert('RGB')
        t = TableScreenBased(p, table_dict, _Signals(), _Logger(), 6.76)
        t.entireScreenPIL = img
        t.take_screenshot = lambda *a, **k: True  # keep this screenshot (no live screen here)
        t.coach_brain = brain
        mouse = _Mouse()
        steps = [
            ('table found', lambda: t.get_top_left_corner(p)),
            ('your cards', lambda: t.get_my_cards()),
            ('new hand', lambda: t.get_new_hand(mouse, h, p)),
            ('board', lambda: t.get_table_cards(h)),
            ('dealer', lambda: t.get_dealer_position()),
            ('your turn', lambda: t.check_for_button()),
            ('round', lambda: t.get_round_number(h)),
            ('check button', lambda: t.check_for_checkbutton()),
            ('players', lambda: t.init_get_other_players_info()),
            ('who is in', lambda: t.get_other_player_status(p, h)),
            ('pot', lambda: t.get_total_pot_value(h)),
            ('round pot', lambda: t.get_round_pot_value(h)),
            ('call button', lambda: t.check_for_call()),
            ('raise button', lambda: t.check_for_betbutton()),
            ('all-in button', lambda: t.check_for_allincall()),
            ('call value', lambda: t.get_current_call_value(p)),
            ('raise value', lambda: t.get_current_bet_value(p)),
        ]
        stopped = None
        for name, fn in steps:
            try:
                if not fn():
                    stopped = name
                    break
            except Exception as e:
                stopped = f'{name} (error: {e!r})'
                break
        print(f"\n== {os.path.basename(shot)}")
        g = lambda k, d='—': getattr(t, k, d)
        print(f"  cards {g('mycards')}  board {g('cardsOnTable')}  dealer seat {g('dealer_position')}  "
              f"in hand {g('players_in_game')}  check button {g('checkButton')}")
        if stopped:
            print(f"  bot stops at: {stopped}" + ("  (normal when it isn't your turn)" if stopped == 'your turn' else ''))
            if stopped in ('table found', 'your cards'):
                continue
        try:
            n = int(table_dict.get('max_players', {}).get('value', 9))
            cr = C.coach_read(t, h.GameID, n)
            print(f"  stacks {cr['stacks']}")
            print(f"  bets   {cr['bets']}  pot {cr['pot']}  names {cr['names']}")
            if not stopped:
                run_montecarlo_wrapper(p, _Signals(), config, None, t, _Logger(), pre, h)
                d = C.CoachDecision(t, h, p, _Logger())
                d.make_decision(t, h, p, _Logger())
                c = d.coach or {}
                print(f"  COACH: {c.get('text')} [{c.get('tag')}] → button {d.decision}  ({c.get('reason')})")
        except Exception as e:
            print(f"  reading failed: {e!r}")
    brain.close()


if __name__ == '__main__':
    main()
