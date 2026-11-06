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


def _f(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _start_stack(d):
    """Stack at the start of the hand, from the hand's first decision (adding back a posted blind)."""
    stack, bb = _f(d.get('hero_stack')), _f(d.get('bb')) or 0
    if stack is None:
        return None
    if d.get('street') == 'preflop':
        stack += {'BB': bb, 'SB': bb / 2}.get(d.get('position'), 0)
    return stack


def load(data_dir, log_dir, days=None):
    """One row per hand you were dealt into and the coach advised on.

    The result of a hand is your stack at the start of the next hand minus your stack at the start of
    this one, as read off the table by the coach. dickreuter's own result is only used for the latest
    hand, and only if it's believable (its money reading can pick up the wrong number)."""
    db_games = {}
    db = os.path.join(data_dir, 'pokerbot.sqlite')
    if os.path.exists(db):
        con = sqlite3.connect(db)
        for game_id, ts, strategy, fc, outcome, stage, data in con.execute(
                "SELECT game_id, ts, strategy, funds_change, outcome, stage, data FROM games ORDER BY id"):
            db_games[str(game_id)] = {'time': ts or '', 'strategy': strategy, 'db_result': fc or 0.0,
                                      'outcome': outcome, 'final_stage': stage,
                                      'final_decision': json.loads(data).get('FinalDecision')}
        con.close()
    decisions = defaultdict(list)
    path = os.path.join(log_dir, 'coach_decisions.csv')
    if os.path.exists(path):
        with open(path, encoding='utf-8-sig', errors='replace') as f:
            for r in csv.DictReader(f):
                decisions[r['game_id']].append(r)
    hands = sorted(decisions.items(), key=lambda kv: kv[1][0]['time'])
    games = []
    for i, (gid, ds) in enumerate(hands):
        g = {'game_id': gid, 'time': ds[0]['time'], 'strategy': '', 'outcome': '', 'final_decision': '',
             'final_stage': ''}
        g.update(db_games.get(gid, {}))
        if not g.get('final_stage'):
            g['final_stage'] = {'preflop': 'PreFlop', 'flop': 'Flop', 'turn': 'Turn', 'river': 'River'}.get(
                ds[-1]['street'], ds[-1]['street'])
        bb = _f(ds[0]['bb'])
        start = _start_stack(ds[0])
        nxt = _start_stack(hands[i + 1][1][0]) if i + 1 < len(hands) else None
        if start is not None and nxt is not None:
            g['result'], g['result_from'] = nxt - start, 'stacks'
        elif 'db_result' in g and (not bb or abs(g['db_result']) <= 400 * bb):
            g['result'], g['result_from'] = g['db_result'], 'dickreuter'
        else:
            g['result'], g['result_from'] = None, 'pending'
        g['decisions'] = len(ds)
        g['position'] = ds[0]['position']
        g['hero_cards'] = ds[0]['hero_cards']
        g['bb'] = bb
        g['last_action'] = f"{ds[-1]['action']} {ds[-1]['tag'] or ''}".strip()
        g['coach_played'] = True
        games.append(g)
    if days:
        cutoff = (datetime.datetime.now() - datetime.timedelta(days=days)).isoformat()
        games = [g for g in games if g['time'] >= cutoff]
    return games


def summarise(games):
    if not games:
        return "No hands logged yet. Play a session, then run this again."
    pending = [g for g in games if g['result'] is None]
    games = [g for g in games if g['result'] is not None]
    if not games:
        return "Only one hand logged so far - its result is known once the next hand starts."
    bbs = [g['bb'] for g in games if g['bb']]
    bb = sorted(bbs)[len(bbs) // 2] if bbs else None
    net = sum(g['result'] for g in games)
    lines = [f"Hands: {len(games)}   Net: {net:+.2f}" + (f"   ({net / bb:+.1f} bb, {net / bb / len(games) * 100:+.1f} bb/100)" if bb else ""),
             f"Win/loss per hand is worked out from your stack between hands"
             + (f" ({len(pending)} latest hand not counted yet)" if pending else ''), '']

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
        cols = ['time', 'game_id', 'hero_cards', 'position', 'result', 'result_from', 'bb', 'outcome', 'final_stage',
                'final_decision', 'last_action', 'decisions', 'coach_played', 'strategy']
        with open(out, 'w', newline='', encoding='utf-8-sig') as f:  # -sig so Excel shows the characters right
            w = csv.DictWriter(f, fieldnames=cols, extrasaction='ignore')
            w.writeheader()
            w.writerows(games)
        print(f"\nWrote {out}  (decisions are in {os.path.join(o.logs, 'coach_decisions.csv')})")


if __name__ == '__main__':
    main()
