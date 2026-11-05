"""
report.py — how is the bot doing? Reads the hand results (local database) and the coach's decision
log, prints a summary, and writes hands.csv with one row per hand for Excel or SQL.

    python report.py [--days N] [--data DIR] [--logs DIR]

Everything here is read from your PC: ~/poker/local-db/pokerbot.sqlite and ~/poker/logs/.
"""
import argparse
import csv
import datetime
import json
import os
import sqlite3
from collections import defaultdict

HOME = os.path.join(os.path.expanduser('~'), 'poker')


def load(data_dir, log_dir, days=None):
    db = os.path.join(data_dir, 'pokerbot.sqlite')
    games = []
    if os.path.exists(db):
        con = sqlite3.connect(db)
        for game_id, ts, strategy, fc, outcome, stage, data in con.execute(
                "SELECT game_id, ts, strategy, funds_change, outcome, stage, data FROM games ORDER BY id"):
            games.append({'game_id': game_id, 'time': ts or '', 'strategy': strategy, 'result': fc or 0.0,
                          'outcome': outcome, 'final_stage': stage, 'final_decision': json.loads(data).get('FinalDecision')})
        con.close()
    decisions = defaultdict(list)
    path = os.path.join(log_dir, 'coach_decisions.csv')
    if os.path.exists(path):
        with open(path, encoding='utf-8') as f:
            for r in csv.DictReader(f):
                decisions[r['game_id']].append(r)
    if days:
        cutoff = (datetime.datetime.now() - datetime.timedelta(days=days)).isoformat()
        games = [g for g in games if g['time'] >= cutoff]
    for g in games:
        ds = decisions.get(str(g['game_id']), [])
        g['decisions'] = len(ds)
        g['position'] = ds[0]['position'] if ds else ''
        g['hero_cards'] = ds[0]['hero_cards'] if ds else ''
        g['bb'] = float(ds[0]['bb']) if ds and ds[0]['bb'] else None
        g['last_action'] = f"{ds[-1]['action']} {ds[-1]['tag'] or ''}".strip() if ds else ''
        g['coach_played'] = bool(ds)
    return games


def summarise(games):
    if not games:
        return "No hands logged yet. Play a session, then run this again."
    bbs = [g['bb'] for g in games if g['bb']]
    bb = sorted(bbs)[len(bbs) // 2] if bbs else None
    net = sum(g['result'] for g in games)
    lines = [f"Hands: {len(games)}   Net: {net:+.2f}" + (f"   ({net / bb:+.1f} bb, {net / bb / len(games) * 100:+.1f} bb/100)" if bb else ""),
             f"Coach decided in {sum(g['coach_played'] for g in games)} of them (the rest used dickreuter's fallback)", '']

    def table(title, key):
        groups = defaultdict(list)
        for g in games:
            groups[g[key] or '?'].append(g['result'])
        lines.append(title)
        for k, rs in sorted(groups.items(), key=lambda kv: -len(kv[1])):
            per = f"{sum(rs) / bb / len(rs) * 100:+8.1f} bb/100" if bb else ''
            lines.append(f"  {k:<16} {len(rs):>5} hands  {sum(rs):+10.2f}  {per}")
        lines.append('')

    table('By position', 'position')
    table('By street the hand ended', 'final_stage')
    table("By the coach's last action", 'last_action')
    lines.append('Biggest losses (worth reviewing with Claude)')
    for g in sorted(games, key=lambda g: g['result'])[:5]:
        lines.append(f"  {g['time'][:16]}  game {g['game_id']}  {g['hero_cards']:<6} {g['position'] or '?':<4} "
                     f"{g['result']:+.2f}  last: {g['last_action'] or g['final_decision']}")
    return '\n'.join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--days', type=float)
    ap.add_argument('--data', default=os.path.join(HOME, 'local-db'))
    ap.add_argument('--logs', default=os.environ.get('POKER_COACH_LOG_DIR') or os.path.join(HOME, 'logs'))
    o = ap.parse_args()
    games = load(o.data, o.logs, o.days)
    print(summarise(games))
    if games:
        os.makedirs(o.logs, exist_ok=True)
        out = os.path.join(o.logs, 'hands.csv')
        cols = ['time', 'game_id', 'hero_cards', 'position', 'result', 'bb', 'outcome', 'final_stage',
                'final_decision', 'last_action', 'decisions', 'coach_played', 'strategy']
        with open(out, 'w', newline='', encoding='utf-8') as f:
            w = csv.DictWriter(f, fieldnames=cols, extrasaction='ignore')
            w.writeheader()
            w.writerows(games)
        print(f"\nWrote {out}  (decisions are in {os.path.join(o.logs, 'coach_decisions.csv')})")


if __name__ == '__main__':
    main()
