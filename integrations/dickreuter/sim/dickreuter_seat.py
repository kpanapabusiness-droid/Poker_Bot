"""
A seat that plays exactly like dickreuter/poker: the simulator hands it the table, and it runs the same
steps dickreuter's main loop runs after reading the screen (table checks, other players, pots, buttons,
Monte Carlo equity, Decision, button choice). Only the screen reading and the mouse are replaced.

Pass decision_cls=CoachDecision to get the coach brain inside the same pipeline, which is how the bot
runs on your PC once install.py has patched it (fast fold off, card sharing off).
"""
import logging
import os
import sys
import time
import types

# ── make dickreuter importable without its GUI, OCR and VirtualBox dependencies ──


class _Anything:
    """Stands in for any GUI/OCR object: every attribute, call and subclass works and does nothing."""
    def __init__(self, *a, **k): pass
    def __call__(self, *a, **k): return _Anything()
    def __getattr__(self, name): return _Anything()
    def __iter__(self): return iter(())
    def __bool__(self): return False
    def __mro_entries__(self, bases): return (object,)


class _StubModule(types.ModuleType):
    def __getattr__(self, name):
        if name.startswith('__'):
            raise AttributeError(name)
        return _Anything()


def install_stubs():
    for mod in ('PyQt6', 'PyQt6.QtCore', 'PyQt6.QtGui', 'PyQt6.QtWidgets', 'PyQt6.sip', 'PIL.ImageQt',
                'tesserocr', 'virtualbox', 'pyautogui', 'pymouse'):
        if mod not in sys.modules:
            sys.modules[mod] = _StubModule(mod)
    for parent in ('PyQt6',):
        for child in ('QtCore', 'QtGui', 'QtWidgets', 'sip'):
            setattr(sys.modules[parent], child, sys.modules[parent + '.' + child])


def setup_dickreuter(path):
    install_stubs()
    path = os.path.abspath(path)
    if path not in sys.path:
        sys.path.insert(0, path)
    logging.disable(logging.ERROR)  # dickreuter logs every step; the simulator counts errors itself
    for name in ('table', 'montecarlo', 'handmemory', 'decision', 'poker'):
        logging.getLogger(name).setLevel(logging.ERROR)


class _Signals:
    """gui_signals: every signal's .emit() is a no-op."""
    def __getattr__(self, name):
        return types.SimpleNamespace(emit=lambda *a, **k: None)


class _Img:
    def save(self, *a, **k): pass
    def crop(self, *a, **k): return self


class _Logger:
    """GameLogger: nothing is written anywhere during a simulation."""
    def __getattr__(self, name):
        return lambda *a, **k: 0


class _Strategy:
    def __init__(self, strategy):
        self.selected_strategy = strategy
        self.current_strategy = strategy.get('Strategy', 'Default')
    def read_strategy(self, *a, **k): return True


BUTTONS = ('Fold', 'Check', 'Call', 'Call2', 'Bet', 'BetPlus', 'Bet half pot', 'Bet pot', 'Bet max', 'Bet Bluff',
           'Check Deception', 'Call Deception')


class DickreuterSeat:
    """One dickreuter bot. act(view) → (button, info)."""

    def __init__(self, name, dickreuter_dir, strategy, decision_cls=None, fast_fold=True, brain=None, mc_timeout=8.0):
        setup_dickreuter(dickreuter_dir)
        import pandas as pd
        from poker.decisionmaker.current_hand_memory import CurrentHandPreflopState, History
        from poker.decisionmaker.decisionmaker import Decision
        from poker.decisionmaker.montecarlo_python import run_montecarlo_wrapper
        from poker.scraper.table_screen_based import TableScreenBased
        from poker.tools.strategy_handler import StrategyHandler

        self.name = name
        self.decision_cls = decision_cls or Decision
        self.fast_fold = fast_fold
        self.brain = brain
        self._run_mc = run_montecarlo_wrapper
        sh = StrategyHandler()
        sh.selected_strategy = dict(strategy)
        sh.check_defaults()
        self.p = _Strategy(sh.selected_strategy)
        self.h = History()
        self.h.preflop_sheet = pd.read_excel(os.path.join(dickreuter_dir, 'poker', 'decisionmaker', 'preflop.xlsx'),
                                             sheet_name=None, engine='openpyxl')
        self.preflop_state = CurrentHandPreflopState()
        self.config = types.SimpleNamespace(config=types.SimpleNamespace(get=lambda s, k: str(mc_timeout) if k == 'montecarlo_timeout' else ''))
        self.TableCls = _make_table_class(TableScreenBased)
        self.last_info = {}

    def new_hand(self):
        self.h.previousCards = []  # the simulator knows when a hand starts; dickreuter checks for new cards

    def act(self, v):
        """v: the table from this seat's point of view (see holdem.Table.view)."""
        t = self.TableCls(v, self.p)
        if self.brain is not None:
            t.coach_brain = self.brain
        p, h = self.p, self.h
        mouse = _Mouse()
        ok = (t.get_my_cards() and t.get_new_hand(mouse, h, p) and t.get_table_cards(h) and t.get_dealer_position()
              and (not self.fast_fold or t.check_fast_fold(h, p, mouse)) and t.check_for_button()
              and p.read_strategy() and t.get_round_number(h) and t.check_for_checkbutton()
              and t.init_get_other_players_info() and t.get_other_player_status(p, h)
              and t.get_other_player_names(p) and t.get_other_player_funds(p) and t.get_total_pot_value(h)
              and t.get_round_pot_value(h) and t.check_for_call() and t.check_for_betbutton()
              and t.check_for_allincall() and t.get_current_call_value(p) and t.get_current_bet_value(p))
        if not ok:
            if mouse.clicked:  # fast fold: dickreuter clicks and goes straight back to reading the screen
                return mouse.clicked, {'fast_fold': True}
            raise RuntimeError('dickreuter pipeline stopped without acting')
        self._run_mc(p, _Signals(), self.config, None, t, _Logger(), self.preflop_state, h)
        d = self.decision_cls(t, h, p, _Logger())
        d.make_decision(t, h, p, _Logger())
        button = d.decision
        if button == 'Call' and t.allInCallButton:
            button = 'Call2'
        self._after(t, d, button)
        info = {'equity': getattr(t, 'equity', None), 'coach': getattr(d, 'coach', None),
                'bet_plus_inc': float(p.selected_strategy.get('BetPlusInc', 1))}
        self.last_info = info
        return button, info

    def _after(self, t, d, button):
        """What dickreuter's main loop records after each action."""
        h = self.h
        h.previousPot = t.totalPotValue
        h.histGameStage = t.gameStage
        h.histDecision = button
        h.histEquity = getattr(t, 'equity', 0)
        h.histMinCall = getattr(t, 'minCall', 0)
        h.histMinBet = getattr(t, 'minBet', 0)
        h.hist_other_players = t.other_players
        h.first_raiser = getattr(t, 'first_raiser', None)
        h.first_caller = getattr(t, 'first_caller', None)
        h.previous_decision = button
        h.lastRoundGameID = h.GameID
        h.previous_round_pot_value = t.round_pot_value
        h.last_round_bluff = False if getattr(t, 'currentBluff', 0) == 0 else True
        if t.gameStage == 'PreFlop' and d is not None:
            try:
                self.preflop_state.update_values(t, button, h, d)
            except Exception:
                pass


class _Mouse:
    def __init__(self): self.clicked = None
    def mouse_action(self, decision, tlc, options=None): self.clicked = decision
    def move_mouse_away_from_buttons_jump(self): pass
    def move_mouse_away_from_buttons(self): pass


def _make_table_class(TableScreenBased):
    class SimTable(TableScreenBased):
        """dickreuter's table with the screen reading replaced by the simulator's view."""
        def __init__(self, v, p):  # skip TableScraper/Table __init__ (they load templates)
            self.v = v
            self.version = 6.76
            self.ip = ''
            self.logger = logging.getLogger('table')
            self.gui_signals = _Signals()
            self.game_logger = _Logger()
            self.nn_model = None
            self.table_dict = {'mouse_all_in': {}, 'max_players': {'value': v['n']}}
            self.total_players = v['n']
            self.screenshot = _Img()
            self.entireScreenPIL = _Img()
            self.tlc = (0, 0)
            self.mt_tm = time.time()
            self.coach_player_names = v['names']
            # what the screen readers would have found
            self.my_cards = list(v['hero_cards'])
            self.table_cards = list(v['board'])
            self.dealer_position = v['dealer']
            self.players_in_game = list(v['in_hand'])
            self.player_funds = list(v['stacks'])
            self.player_pots = list(v['bets'])
            self.total_pot = v['total_pot']
            self.current_round_pot = v['round_pot']

        # screen reading → the simulator's values
        def take_screenshot(self, initial, p): return True
        def get_top_left_corner(self, p): return True
        def get_my_cards2(self): return True
        def get_table_cards2(self): return True
        def get_dealer_position2(self): return True
        def get_players_in_game(self): return True
        def get_players_funds(self, my_funds_only=False, skip=[]): return True
        def get_pots(self): return True
        def get_player_pots(self, skip=[]):
            self.player_pots = [0 if i in skip else b for i, b in enumerate(self.v['bets'])]
            return True
        def get_bot_pot(self, p):
            self.bot_pot = self.v['bets'][0]
            self.value = self.bot_pot
            return self.bot_pot
        def is_my_turn(self): return True
        def has_check_button(self): return self.v['to_call'] <= 0
        def has_call_button(self): return self.v['to_call'] > 0
        def has_raise_button(self): return self.v['min_raise_to'] is not None
        def has_bet_button(self): return self.v['min_raise_to'] is not None
        def has_all_in_call_button(self): return self.v['to_call'] > 0 and self.v['to_call'] >= self.v['stacks'][0]
        def get_call_value(self): return min(self.v['to_call'], self.v['stacks'][0])
        def get_raise_value(self): return self.v['min_raise_to'] if self.v['min_raise_to'] is not None else ''
        def lost_everything(self): return False
        def call_genetic_algorithm(self, p): return None
        def check_for_captcha(self, mouse): return True
        def check_for_imback(self, mouse): return True
        def check_for_resume_hand(self, mouse): return True
    return SimTable
