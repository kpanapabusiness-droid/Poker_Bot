"""
set_blinds.py — set your game's blinds for the bot, in the same units as the chips on screen.

    python set_blinds.py 500 1000            # small blind, big blind
    python set_blinds.py 500 1000 --stack 100000
    python set_blinds.py                     # asks you

dickreuter's strategy editor only goes up to a 10.00 big blind (it was built for cent games), so
this stores the blinds in the local database instead, where they override every strategy. The coach
reads them from there too. Restart the bot afterwards (close it and run Start Poker Bot again).
"""
import argparse
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from local_server import Store  # noqa: E402


def number(text):
    return float(str(text).replace(',', '').replace('$', '').strip())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('small', nargs='?')
    ap.add_argument('big', nargs='?')
    ap.add_argument('--stack', help='starting stack (optional)')
    ap.add_argument('--data', default=os.path.join(os.path.expanduser('~'), 'poker', 'local-db'))
    o = ap.parse_args()
    store = Store(os.path.join(o.data, 'pokerbot.sqlite'))
    cur = store.blinds()
    if cur:
        print(f"Current blinds: {cur['smallBlind']:g} / {cur['bigBlind']:g}")
    small = o.small or input('Small blind (e.g. 500): ')
    big = o.big or input('Big blind (e.g. 1000): ')
    stack = o.stack if o.stack is not None else (input('Starting stack (optional, press Enter to skip): ') if not o.small else '')
    try:
        small, big = number(small), number(big)
        stack = number(stack) if str(stack).strip() else None
    except ValueError:
        sys.exit("Those don't look like numbers. Try again, e.g. 500 and 1000.")
    if not (0 < small <= big):
        sys.exit('The small blind should be above 0 and no bigger than the big blind.')
    v = store.set_blinds(small, big, stack)
    print(f"Saved: blinds {v['smallBlind']:g} / {v['bigBlind']:g}" + (f", stack {stack:g}" if stack else '') +
          '. Restart the bot to use them.')


if __name__ == '__main__':
    main()
