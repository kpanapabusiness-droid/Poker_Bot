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
        if new != src:
            if not os.path.exists(path + '.orig'):
                shutil.copy(path, path + '.orig')
            open(path, 'w', encoding='utf-8').write(new)
            print(f"  patched: {os.path.relpath(path)} (db -> {LOCAL_DB})")
        else:
            print(f"  already patched: {os.path.relpath(path)}")

    os.environ.setdefault('POKER_COACH_BRAIN', os.path.join(HERE, 'brain.js'))
    print(f"\nDone. Before running dickreuter, set:\n  POKER_COACH_BRAIN={os.path.join(HERE, 'brain.js')}\n"
          "and make sure `node` is on your PATH. Untick auto-act to see each decision before it's played.")


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(os.path.abspath(sys.argv[1]))
