"""
card_reader_on.py — switch a table you mapped yourself in Table Setup over to this project's readers,
so you don't have to save a picture of all 52 cards or every number.

  card_reader:  your cards and the board are read from white card faces (needs my_cards_area and
                table_cards_area set in Table Setup)
  coach_reader: stacks, bets, pot and names are read with the shared amount reader

    python card_reader_on.py                 list your tables
    python card_reader_on.py "My Site 6"     switch both readers on for that table
    python card_reader_on.py "My Site 6" --off

Close the bot first (it keeps the database open); start it again afterwards.
"""
import argparse
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
from local_server import Store  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('table', nargs='?')
    ap.add_argument('--off', action='store_true')
    ap.add_argument('--data', default=os.path.join(os.path.expanduser('~'), 'poker', 'local-db'))
    o = ap.parse_args()
    store = Store(os.path.join(o.data, 'pokerbot.sqlite'))
    names = [r[0] for r in store.db.execute('SELECT name FROM tables ORDER BY name')]
    if not o.table:
        print('Your tables:')
        for n in names:
            t = store.table(n) or {}
            flags = [f for f in ('card_reader', 'coach_reader') if t.get(f)]
            print(f'  {n}' + (f'   ({", ".join(flags)} on)' if flags else ''))
        return
    t = store.table(o.table)
    if t is None:
        sys.exit(f'No table called {o.table!r}. Run without a name to list them.')
    for f in ('card_reader', 'coach_reader'):
        if o.off:
            t.pop(f, None)
        else:
            t[f] = True
    missing = [k for k in ('topleft_corner', 'my_cards_area', 'table_cards_area') if k not in t]
    store.put_table(o.table, t)
    print(f"{o.table}: card reader {'off' if o.off else 'on'}")
    if missing and not o.off:
        print('  still to set in Table Setup: ' + ', '.join(missing))


if __name__ == '__main__':
    main()
