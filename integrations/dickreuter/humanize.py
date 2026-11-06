"""
humanize.py — make the bot's mouse and timing look like a person's (for sites where the bot is
allowed, e.g. a friends' game with its own bot detector).

Copied into dickreuter's poker/tools by install.py and used by mouse_mover.py and main.py:

  think_time(state, decision)   seconds to wait before acting, from how hard the spot is
  path(x1, y1, x2, y2)          [(x, y, seconds_until_next_point), ...] for one mouse movement
  click_hold()                  how long the button is held down
  aim(x1, y1, x2, y2)           where on a button to click (not the dead centre, not the edge)
  idle_move(x, y)               an occasional small drift while waiting, or None

Every number lives in SETTINGS so it can be tuned for a site. Nothing here reads the screen or
the network; it only shapes when and how the mouse moves.
"""
import math
import os
import random

SETTINGS = {
    # thinking time before acting (seconds), as a log-normal around these medians
    'think_easy': 1.1,        # preflop chart folds, free checks
    'think_normal': 2.4,      # ordinary calls / bets
    'think_hard': 4.5,        # big pots, river decisions, all-ins, close calls
    'think_spread': 0.45,     # log-normal sigma (bigger = more varied)
    'tank_chance': 0.05,      # sometimes think a long time about nothing in particular
    'tank_extra': (4.0, 10.0),
    'snap_chance': 0.06,      # ...and sometimes act almost at once
    'think_max': 14.0,        # never get near the site's action timer
    'appear_beat': (0.25, 0.7),  # minimum pause after the buttons appear

    # mouse movement
    'speed_px_per_s': (900, 1600),   # average speed of a movement
    'min_move_s': 0.18,
    'overshoot_chance': 0.35,        # overshoot slightly and correct, like a hand does
    'overshoot_frac': (0.03, 0.09),
    'wobble_px': (0.5, 2.5),         # low-frequency wobble along the path, not jitter
    'bow_frac': (-0.12, 0.12),       # sideways curve of the path
    'hold_s': (0.06, 0.14),          # mouse button held down this long per click
    'aim_box': (0.2, 0.8),           # click somewhere in the middle 60% of the button

    # after acting: drift off the buttons (or sometimes stay)
    'after_stay_chance': 0.3,
    'after_drift_px': (60, 260),

    # waiting between turns: occasional small idle movement (0 = never)
    'idle_moves_per_min': float(os.environ.get('POKER_COACH_IDLE_MOVES', '1.5')),  # 0 = dead still
    'idle_drift_px': (10, 70),
    'idle_speed_px_per_s': (60, 220),  # idle drifts are lazy, not reaches
}


def _lognormal(median, sigma):
    return median * math.exp(random.gauss(0, sigma))


def think_time(state=None, decision=None):
    """How long a person would take over this decision. state: the coach's table state (or None);
    decision: the coach's decision dict (or None)."""
    S = SETTINGS
    state, decision = state or {}, decision or {}
    tag = (decision.get('tag') or '').upper()
    action = (decision.get('action') or '').upper()
    board = state.get('board') or []
    pot, to_call = float(state.get('pot') or 0), float(state.get('toCall') or 0)
    stack = float(state.get('heroStack') or 0) or 1.0
    allin = action.replace('-', '').replace('_', '').replace(' ', '') == 'ALLIN'
    big = pot > 0.3 * stack or to_call > 0.25 * stack or allin
    if not board and tag == 'CHART' and action in ('FOLD', 'CHECK'):
        median = S['think_easy']
    elif big or len(board) == 5:
        median = S['think_hard']
    else:
        median = S['think_normal']
    r = random.random()
    if r < S['snap_chance']:
        t = random.uniform(0.35, 0.8)
    else:
        t = _lognormal(median, S['think_spread'])
        if r > 1 - S['tank_chance']:
            t += random.uniform(*S['tank_extra'])
    return max(random.uniform(*S['appear_beat']), min(t, S['think_max']))


def _min_jerk(t):
    """Position along a reach over normalised time t: slow start, fast middle, long slow-down."""
    return 10 * t ** 3 - 15 * t ** 4 + 6 * t ** 5


def _segment(x1, y1, x2, y2, duration):
    S = SETTINGS
    dist = math.hypot(x2 - x1, y2 - y1)
    if dist < 1:
        return []
    steps = int(max(6, min(90, duration * 120)))  # ~120 points a second, like a real mouse report rate
    nx, ny = -(y2 - y1) / dist, (x2 - x1) / dist
    bow = random.uniform(*S['bow_frac']) * dist
    cx, cy = (x1 + x2) / 2 + nx * bow, (y1 + y2) / 2 + ny * bow
    amp = random.uniform(*S['wobble_px'])
    freq, phase = random.uniform(1.0, 2.5), random.uniform(0, 2 * math.pi)
    pts, last_t = [], 0.0
    for i in range(1, steps + 1):
        t = i / steps
        e = _min_jerk(t)
        x = (1 - e) ** 2 * x1 + 2 * (1 - e) * e * cx + e ** 2 * x2
        y = (1 - e) ** 2 * y1 + 2 * (1 - e) * e * cy + e ** 2 * y2
        w = amp * math.sin(2 * math.pi * freq * t + phase) * math.sin(math.pi * t)  # fades out at both ends
        x, y = x + nx * w, y + ny * w
        # report intervals vary a little, as they do on a real machine
        dt = duration / steps * random.uniform(0.8, 1.2)
        pts.append((int(round(x)), int(round(y)), dt))
        last_t = t
    pts[-1] = (int(round(x2)), int(round(y2)), pts[-1][2])
    return pts


def path(x1, y1, x2, y2, idle=False):
    """Points for one movement from (x1, y1) to (x2, y2), with the wait after each point.
    idle=True: a slow lazy drift (no overshoot) for waiting between turns."""
    S = SETTINGS
    dist = math.hypot(x2 - x1, y2 - y1)
    if dist < 2:
        return [(int(x2), int(y2), 0.01)]
    if idle:
        return _segment(x1, y1, x2, y2, max(0.3, dist / random.uniform(*S['idle_speed_px_per_s'])))
    duration = max(S['min_move_s'], dist / random.uniform(*S['speed_px_per_s']))
    if dist > 80 and random.random() < S['overshoot_chance']:
        f = 1 + random.uniform(*S['overshoot_frac'])
        ox = x1 + (x2 - x1) * f + random.uniform(-4, 4)
        oy = y1 + (y2 - y1) * f + random.uniform(-4, 4)
        first = _segment(x1, y1, ox, oy, duration * 0.9)
        if first:  # brief pause at the far point, then a small correction
            x, y, dt = first[-1]
            first[-1] = (x, y, dt + random.uniform(0.03, 0.09))
        return first + _segment(ox, oy, x2, y2, random.uniform(0.08, 0.18))
    return _segment(x1, y1, x2, y2, duration)


def aim(x1, y1, x2, y2):
    """A point on the button: roughly central, never the same pixel twice."""
    lo, hi = SETTINGS['aim_box']
    fx = min(hi, max(lo, random.gauss(0.5, 0.13)))
    fy = min(hi, max(lo, random.gauss(0.5, 0.13)))
    return int(x1 + fx * (x2 - x1)), int(y1 + fy * (y2 - y1))


def click_hold():
    return random.uniform(*SETTINGS['hold_s'])


def after_action_target(x, y):
    """Where the mouse goes after clicking, or None to leave it where it is."""
    S = SETTINGS
    if random.random() < S['after_stay_chance']:
        return None
    d = random.uniform(*S['after_drift_px'])
    a = random.uniform(-math.pi * 0.95, -math.pi * 0.05)  # mostly upwards, off the button row
    return int(x + d * math.cos(a)), int(y + d * math.sin(a))


def idle_move(x, y, seconds_since_last_call=1.0):
    """While waiting: now and then (about idle_moves_per_min times a minute) a small slow drift."""
    rate = SETTINGS['idle_moves_per_min']
    if rate <= 0 or random.random() > rate * seconds_since_last_call / 60:
        return None
    d = random.uniform(*SETTINGS['idle_drift_px'])
    a = random.uniform(0, 2 * math.pi)
    return int(x + d * math.cos(a)), int(y + d * math.sin(a))
