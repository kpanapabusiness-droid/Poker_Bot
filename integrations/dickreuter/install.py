"""
install.py — plug this project's decision layer into a dickreuter/poker checkout.

    python install.py /path/to/dickreuter/poker

What it changes (idempotent, keeps a .orig backup of each file it edits):
  1. Copies coach_decision.py into poker/decisionmaker/.
  2. main.py: builds a CoachDecision instead of dickreuter's Decision. The original logic is still
     used as a fallback if the brain errors.
  3. strategy_handler.py: forces collusion OFF. dickreuter ships with it ON by default, which uploads
     your hole cards to the DeeperMind server and pulls in cards from other copies of the bot at the
     same table. That's card-sharing, not AI assistance: it isn't allowed even in a game where
     everyone has agreed to AI help.
  4. config.ini: points dickreuter's database at local_server.py on 127.0.0.1 instead of
     dickreuter.com, so tables, strategies and hand logs stay on your PC.
"""
import os
import re
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
LOCAL_DB = 'http://127.0.0.1:7778/'


def patch(path, old, new, marker):
    src = open(path, encoding='utf-8').read()
    if marker in src:
        print(f"  already patched: {os.path.relpath(path)}")
        return
    if old not in src:
        sys.exit(f"Couldn't find the expected code in {path}. dickreuter may have changed; patch it by hand:\n  {old!r} → {new!r}")
    if not os.path.exists(path + '.orig'):
        shutil.copy(path, path + '.orig')
    open(path, 'w', encoding='utf-8').write(src.replace(old, new, 1))
    print(f"  patched: {os.path.relpath(path)}")


def main(repo):
    pkg = os.path.join(repo, 'poker')
    if not os.path.exists(os.path.join(pkg, 'decisionmaker', 'decisionmaker.py')):
        sys.exit(f"{repo} doesn't look like a dickreuter/poker checkout")

    shutil.copy(os.path.join(HERE, 'coach_decision.py'), os.path.join(pkg, 'decisionmaker', 'coach_decision.py'))
    print("  copied: poker/decisionmaker/coach_decision.py")
    shutil.copy(os.path.join(HERE, 'card_reader.py'), os.path.join(pkg, 'scraper', 'card_reader.py'))
    shutil.copy(os.path.join(HERE, 'humanize.py'), os.path.join(pkg, 'tools', 'humanize.py'))
    print("  copied: poker/scraper/card_reader.py")

    main_py = os.path.join(pkg, 'main.py')
    patch(main_py,
          'from poker.decisionmaker.decisionmaker import Decision\n',
          'from poker.decisionmaker.decisionmaker import Decision\n'
          'from poker.decisionmaker.coach_decision import CoachDecision  # poker-coach brain\n',
          'CoachDecision  # poker-coach brain')
    patch(main_py,
          'd = Decision(table, history, strategy, self.game_logger)',
          'd = CoachDecision(table, history, strategy, self.game_logger)  # poker-coach',
          'CoachDecision(table, history, strategy, self.game_logger)')

    # dickreuter's "fast fold" clicks Fold preflop by itself for any hand missing from its preflop
    # sheet, before any decision maker runs, so the coach would never see those hands.
    patch(main_py,
          '                        table.check_fast_fold(history, strategy, mouse) and \\\n',
          "                        (True or 'poker-coach: fast fold off') and \\\n",
          'poker-coach: fast fold off')
    # dickreuter also runs a small web server on port 8005 that hands out screenshots of your screen
    # to its website (deepermind-pokerbot.com is allowed to call it from your browser). Not needed.
    patch(main_py,
          '    t2 = threading.Thread(target=local_restapi)\n    t2.daemon = True\n    t2.start()\n',
          '    # poker-coach: screenshot web server (port 8005) for deepermind-pokerbot.com switched off\n',
          'poker-coach: screenshot web server')

    # dickreuter's curve fitting passes plain lists to lmfit; lmfit 1.3+ no longer converts them,
    # so every Decision crashed with "can only concatenate list". Use numpy arrays.
    cf = os.path.join(pkg, 'decisionmaker', 'curvefitting.py')
    patch(cf,
          '        xf = [minEquity, max_X]\n        yf = [bigBlind, maxValue]\n',
          '        xf = np.array([minEquity, max_X], dtype=float)  # poker-coach: lmfit 1.3 fix\n'
          '        yf = np.array([bigBlind, maxValue], dtype=float)\n',
          'poker-coach: lmfit 1.3 fix')

    # Screenshots: dickreuter only grabbed the main monitor. Grab every monitor, and shift mouse
    # clicks by the same amount (an all-monitor picture starts at the far top-left monitor's corner).
    so = os.path.join(pkg, 'tools', 'screen_operations.py')
    src = open(so, encoding='utf-8').read()
    if 'poker-coach: all monitors' not in src:
        if 'ImageGrab.grab()' not in src:
            sys.exit(f"Couldn't find ImageGrab.grab() in {so}; dickreuter may have changed.")
        if not os.path.exists(so + '.orig'):
            shutil.copy(so, so + '.orig')
        open(so, 'w', encoding='utf-8').write(src.replace('ImageGrab.grab()', 'ImageGrab.grab(all_screens=True)  # poker-coach: all monitors'))
        print(f"  patched: {os.path.relpath(so)}")
    else:
        print(f"  already patched: {os.path.relpath(so)}")
    # Numbers: dickreuter read "$416,500" as 416.5 (it turned commas into decimal points, for
    # European cents). Treat commas as thousands separators, and let the reader see them.
    src = open(so, encoding='utf-8').read()
    if 'poker-coach: thousands' not in src and "replace(',', '.')" in src:
        src = src.replace("replace(',', '.')", "replace(',', '')")
        src = src.replace('api.SetVariable("tessedit_char_whitelist", "0123456789.$£B")',
                          'api.SetVariable("tessedit_char_whitelist", "0123456789.,$£B")  # poker-coach: thousands')
        open(so, 'w', encoding='utf-8').write(src)
        print(f"  patched: {os.path.relpath(so)} (thousands commas)")
    mm = os.path.join(pkg, 'tools', 'mouse_mover.py')
    # mouse_mover patched by an older version of this installer: start again from dickreuter's original
    _mm_src = open(mm, encoding='utf-8').read()
    if os.path.exists(mm + '.orig') and 'poker-coach' in _mm_src and 'humanize v1' not in _mm_src:
        shutil.copy(mm + '.orig', mm)
    patch(mm,
          "log = logging.getLogger(__name__)\n",
          "log = logging.getLogger(__name__)\n\n\n"
          "def _screen_origin():  # poker-coach: all monitors\n"
          "    \"\"\"Top-left of the whole desktop (negative when a monitor sits left of / above the main one).\"\"\"\n"
          "    try:\n"
          "        import ctypes\n"
          "        return ctypes.windll.user32.GetSystemMetrics(76), ctypes.windll.user32.GetSystemMetrics(77)\n"
          "    except Exception:\n"
          "        return 0, 0\n",
          "def _screen_origin():  # poker-coach: all monitors")
    patch(mm,
          "        log.debug(f\"Target position: {x1} {y1} {x2} {y2}\")\n",
          "        ox, oy = _screen_origin()  # poker-coach: screenshot coordinates -> screen coordinates\n"
          "        x1, y1, x2, y2 = x1 + ox, y1 + oy, x2 + ox, y2 + oy\n"
          "        log.debug(f\"Target position: {x1} {y1} {x2} {y2}\")\n",
          "poker-coach: screenshot coordinates -> screen coordinates")

    # Tables bigger than 6 seats: a few of dickreuter's seat calculations were written for 6-max
    # (hard-coded "% 5", "range(5)", "% 6"). Use the table's real size.
    tb = os.path.join(pkg, 'scraper', 'table.py')
    patch(tb,
          "        for n in range(5):  # n is absolute position of other player, 0 is player after bot\n"
          "            i = (\n"
          "                        self.dealer_position + n + 3 - 2) % 5",
          "        for n in range(self.total_players - 1):  # poker-coach: any table size\n"
          "            i = (\n"
          "                        self.dealer_position + n + 3 - 2) % (self.total_players - 1)",
          "poker-coach: any table size")
    patch(tb,
          "        for n in range(first_possible_caller, 5):",
          "        for n in range(first_possible_caller, self.total_players - 1):  # poker-coach: any table size (callers)",
          "poker-coach: any table size (callers)")
    tsb = os.path.join(pkg, 'scraper', 'table_screen_based.py')
    patch(tsb,
          "self.big_blind_position_abs_all = (self.dealer_position + 2) % 6",
          "self.big_blind_position_abs_all = (self.dealer_position + 2) % self.total_players  # poker-coach: any table size",
          "poker-coach: any table size")

    # dickreuter "corrected" any call or raise value of 90 or more by subtracting 90 (a fix for one
    # site's button text). With real chip amounts that turns a $1,000 call into $910. Remove it.
    ts = os.path.join(pkg, 'scraper', 'table_scraper.py')
    for what in ('call', 'raise'):
        patch(ts,
              f"        if round(self.{what}_value) >= 90:\n"
              f"            log.warning(\"Correcting {what} value from >90\")\n"
              f"            self.{what}_value -= 90\n",
              f"        # poker-coach: removed the '>= 90 → subtract 90' {what} value hack\n",
              f"poker-coach: removed the '>= 90 → subtract 90' {what} value hack")

    # Numbers on "coach_reader" tables (e.g. Torn): dickreuter's own reader uses the same greyscale OCR
    patch(so,
          '''def ocr(screenshot, image_area, table_dict, player=None, fast=False):
''',
          '''def ocr(screenshot, image_area, table_dict, player=None, fast=False):
    if table_dict.get('coach_reader'):  # poker-coach: shared amount reader
        from poker.scraper.card_reader import read_amount
        try:
            a = table_dict[image_area][player] if player else table_dict[image_area]
        except KeyError:
            return ''
        v = read_amount(screenshot, (a['x1'], a['y1'], a['x2'], a['y2']))
        return v if v is not None else ''
''',
          'poker-coach: shared amount reader')

    # Cards without a picture of every card: tables with "card_reader" set read them with card_reader.py
    ts = os.path.join(pkg, 'scraper', 'table_scraper.py')
    patch(ts,
          '''    def get_my_cards2(self):
        """Get my cards"""
        self.my_cards = []
''',
          '''    def get_my_cards2(self):
        """Get my cards"""
        self.my_cards = []
        if self.table_dict.get('card_reader'):  # poker-coach: card reader
            from poker.scraper.card_reader import read_cards
            a = self.table_dict['my_cards_area']
            self.my_cards = read_cards(self.screenshot, (a['x1'], a['y1'], a['x2'], a['y2']), 'hand')
            log.info(f"My cards: {self.my_cards}")
            return
''',
          'poker-coach: card reader')
    patch(ts,
          '''            log.info(f"My cards: {self.my_cards}")
            return
''',
          '''            log.info(f"My cards: {self.my_cards}")
            if len(self.my_cards) != 2:  # poker-coach: keep a picture of what it couldn't read
                from poker.scraper.card_reader import dump_failed
                dump_failed(self.screenshot, (a['x1'], a['y1'], a['x2'], a['y2']), 'hand',
                            get_dir('log') + '/card_debug')
            return
''',
          'poker-coach: keep a picture')
    patch(ts,
          '''        self.table_cards = []
        for value in CARD_VALUES:''',
          '''        self.table_cards = []
        if self.table_dict.get('card_reader'):  # poker-coach: card reader (board)
            from poker.scraper.card_reader import read_cards
            a = self.table_dict['table_cards_area']
            self.table_cards = read_cards(self.screenshot, (a['x1'], a['y1'], a['x2'], a['y2']), 'board')
            log.info(f"Table cards: {self.table_cards}")
            return len(self.table_cards) not in (1, 2)
        for value in CARD_VALUES:''',
          'poker-coach: card reader (board)')

    # dickreuter jumps the mouse to the top-right of the screen on every loop and every new hand,
    # even with "Act automatically" off. Only move it when the bot is allowed to act.
    patch(main_py,
          "                mouse.move_mouse_away_from_buttons_jump()\n",
          "                if self.gui_signals.ui.auto_act.isChecked():  # poker-coach: mouse stays put unless acting\n"
          "                    mouse.move_mouse_away_from_buttons_jump()\n",
          "poker-coach: mouse stays put unless acting")
    tsb = os.path.join(pkg, 'scraper', 'table_screen_based.py')
    patch(tsb,
          "            mouse.move_mouse_away_from_buttons_jump()\n",
          "            try:  # poker-coach: mouse stays put unless acting\n"
          "                acting = self.gui_signals.ui.auto_act.isChecked()\n"
          "            except Exception:\n"
          "                acting = False\n"
          "            if acting:\n"
          "                mouse.move_mouse_away_from_buttons_jump()\n",
          "poker-coach: mouse stays put unless acting")

    # Human-like mouse (humanize.py): dickreuter's mover shakes the pointer ±20px and teleports it when
    # moving left/up or "away from the buttons", and its click is instant. Instead: reach along a curved
    # min-jerk path (sometimes overshooting and correcting), click off-centre with a real press/release,
    # then drift off once (or stay). Between turns the mouse sits still.
    patch(mm,
          "    def mouse_mover(self, x1, y1, x2, y2):\n",
          "    def mouse_mover(self, x1, y1, x2, y2):  # poker-coach: humanize v1\n"
          "        from poker.tools import humanize\n"
          "        for x, y, dt in humanize.path(x1, y1, x2, y2):\n"
          "            if self.vbox_mode:\n"
          "                self.mouse_move_vbox(x, y)\n"
          "            else:\n"
          "                self.mouse.move(x, y)\n"
          "            time.sleep(dt)\n"
          "        self.old_x, self.old_y = x2, y2\n\n"
          "    def _mouse_mover_jittery(self, x1, y1, x2, y2):  # dickreuter's original\n",
          "poker-coach: humanize v1")
    patch(mm,
          "        self.mouse_mover(old_x1, old_y1, x1, y1)\n"
          "        self.mouse_clicker(x1, y1, x2 - x1, y2 - y1)",
          "        from poker.tools import humanize  # poker-coach: humanize (aim, press, hold, release)\n"
          "        tx, ty = humanize.aim(x1, y1, x2, y2)\n"
          "        self.mouse_mover(old_x1, old_y1, tx, ty)\n"
          "        time.sleep(np.random.uniform(0.04, 0.16))\n"
          "        if self.vbox_mode or not hasattr(self.mouse, 'press'):\n"
          "            self.click(tx, ty)\n"
          "        else:\n"
          "            self.mouse.press(tx, ty)\n"
          "            time.sleep(humanize.click_hold())\n"
          "            self.mouse.release(tx, ty)\n"
          "        self.old_x, self.old_y = tx, ty\n"
          "        time.sleep(np.random.uniform(0.15, 0.45))",
          "poker-coach: humanize (aim, press, hold, release)")
    patch(mm,
          "    def move_mouse_away_from_buttons_jump(self):\n",
          "    def move_mouse_away_from_buttons_jump(self):  # poker-coach: humanize idle\n"
          "        # dickreuter calls this every loop; the mouse sits still (or, if POKER_COACH_IDLE_MOVES is set,\n"
          "        # very occasionally drifts a little) until it's time to act\n"
          "        from poker.tools import humanize\n"
          "        if self.vbox_mode:\n"
          "            return\n"
          "        now = time.time()\n"
          "        last = getattr(self, '_idle_last', now)\n"
          "        self._idle_last = now\n"
          "        x, y = self.mouse.position()\n"
          "        target = humanize.idle_move(x, y, now - last)\n"
          "        if target:\n"
          "            self.mouse_mover(x, y, *target)\n\n"
          "    def _move_mouse_away_from_buttons_jump_original(self):\n",
          "poker-coach: humanize idle")
    patch(mm,
          "    def move_mouse_away_from_buttons(self):\n"
          "        x2 = int(np.round(np.random.uniform(1700, 2000, 1), 0)[0])\n"
          "        y2 = int(np.round(np.random.uniform(10, 200, 1), 0)[0])\n\n"
          "        time.sleep(np.random.uniform(0.5, 1.2, 1)[0])\n",
          "    def move_mouse_away_from_buttons(self):  # poker-coach: humanize after-action\n"
          "        from poker.tools import humanize\n"
          "        if not self.vbox_mode:\n"
          "            (x1, y1) = self.mouse.position()\n"
          "        else:\n"
          "            x1, y1 = self.old_x, self.old_y\n"
          "        target = humanize.after_action_target(x1, y1)\n"
          "        if target:\n"
          "            time.sleep(np.random.uniform(0.1, 0.6))\n"
          "            try:\n"
          "                self.mouse_mover(x1, y1, *target)\n"
          "            except Exception:\n"
          "                log.warning('Moving mouse away failed')\n"
          "        return\n",
          "poker-coach: humanize after-action")
    # Think before acting, like a person: how long depends on how hard the spot is (humanize.think_time)
    patch(main_py,
          "                if self.gui_signals.ui.auto_act.isChecked():\n"
          "                    mouse.mouse_action(mouse_target, table.tlc, action_options)\n",
          "                if self.gui_signals.ui.auto_act.isChecked():\n"
          "                    try:  # poker-coach: humanize think time\n"
          "                        from poker.tools import humanize\n"
          "                        wait = humanize.think_time(getattr(d, 'coach_state', None), getattr(d, 'coach', None))\n"
          "                        log.info(f'Thinking for {wait:.1f}s before acting')\n"
          "                        time.sleep(wait)\n"
          "                    except Exception as e:\n"
          "                        log.warning(f'think time failed: {e}')\n"
          "                    mouse.mouse_action(mouse_target, table.tlc, action_options)\n",
          "poker-coach: humanize think time")

    # Show the coach's advice in the bot window's "Last Decision" box, not just the button name
    patch(main_py,
          '        gui_signals.signal_decision.emit(str(d.decision + " " + sheet_name))\n',
          '        coach = getattr(d, "coach", None)  # poker-coach: advice in the Last Decision box\n'
          '        if coach:\n'
          '            gui_signals.signal_decision.emit(f"{coach.get(\'text\')}  [{coach.get(\'tag\')}]\\n{coach.get(\'reason\') or \'\'}")\n'
          '        else:\n'
          '            gui_signals.signal_decision.emit(str(d.decision + " " + sheet_name))\n',
          'poker-coach: advice in the Last Decision box')

    sh = os.path.join(pkg, 'tools', 'strategy_handler.py')
    patch(sh,
          "        if 'collusion' not in self.selected_strategy:\n            self.selected_strategy['collusion'] = 1\n",
          "        self.selected_strategy['collusion'] = 0  # poker-coach: never share cards with other bots\n",
          "poker-coach: never share cards")

    # 4. Point dickreuter at the local database (local_server.py) instead of dickreuter.com.
    for ini in ('config.ini', 'config_default.ini'):
        path = os.path.join(pkg, ini)
        if not os.path.exists(path):
            continue
        src = open(path, encoding='utf-8').read()
        new = re.sub(r'(?m)^db\s*=.*$', f'db = {LOCAL_DB}', src)
        # its remembered strategy ("Trial 1") lived on dickreuter's server; start on the local Default
        new = re.sub(r'(?m)^last_strategy\s*=\s*Trial 1\s*$', 'last_strategy = Default', new)
        # the shipped config names a VirtualBox VM ("w1064"); read this PC's own screen instead
        new = re.sub(r'(?m)^control\s*=.*$', 'control = Direct mouse control', new)
        if new != src:
            if not os.path.exists(path + '.orig'):
                shutil.copy(path, path + '.orig')
            open(path, 'w', encoding='utf-8').write(new)
            print(f"  patched: {os.path.relpath(path)} (db -> {LOCAL_DB})")
        else:
            print(f"  already patched: {os.path.relpath(path)}")

    # dickreuter saves a screenshot per decision into log/screenshots but never creates the folder
    patch(main_py,
          '                pil_image.save("log/screenshots/" + filename)\n',
          '                try:  # poker-coach: screenshots folder\n'
          '                    __import__("os").makedirs("log/screenshots", exist_ok=True)\n'
          '                    pil_image.save("log/screenshots/" + filename)\n'
          '                except Exception as e:\n'
          '                    log.warning(f"Could not save screenshot: {e}")\n',
          'poker-coach: screenshots folder')

    os.environ.setdefault('POKER_COACH_BRAIN', os.path.join(HERE, 'brain.js'))
    print(f"\nDone. Before running dickreuter, set:\n  POKER_COACH_BRAIN={os.path.join(HERE, 'brain.js')}\n"
          "and make sure `node` is on your PATH. Untick auto-act to see each decision before it's played.")


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(os.path.abspath(sys.argv[1]))
