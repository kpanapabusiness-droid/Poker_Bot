"""
import_tables.py — load the ready-made table mappings in this folder (*.json) into the bot's local
database, so they appear in dickreuter's table list. Run again after updating a mapping: it
replaces the table of the same name. Your own tables are left alone.

    python import_tables.py [--data DIR]
"""
import argparse
import glob
import json
import os
import socket
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
from local_server import Store  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', default=os.path.join(os.path.expanduser('~'), 'poker', 'local-db'))
    o = ap.parse_args()
    store = Store(os.path.join(o.data, 'pokerbot.sqlite'))
    for f in sorted(glob.glob(os.path.join(HERE, '*.json'))):
        t = json.load(open(f))
        name = t.get('table_name') or os.path.splitext(os.path.basename(f))[0]
        t['table_name'] = name
        t['owner'] = socket.gethostname()  # yours, so Table Setup lets you adjust it
        store.put_table(name, t)
        print(f'  table ready: {name}')


if __name__ == '__main__':
    main()
