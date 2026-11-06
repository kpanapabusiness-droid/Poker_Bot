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

    # after acting: always move off the buttons (people don't rest the pointer on a button)
    'after_stay_chance': 0.0,
    'after_drift_px': (90, 280),

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
        return _segment(x1, y1, x2, y2, min(2.0, max(0.3, dist / random.uniform(*S['idle_speed_px_per_s']))))
    duration = max(S['min_move_s'], dist / random.uniform(*S['speed_px_per_s']))
    duration = min(duration, 1.5)  # never a long glide, whatever the distance
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
    """Where the mouse goes after clicking: up and off the button row, a varied distance and angle."""
    S = SETTINGS
    if random.random() < S['after_stay_chance']:
        return None
    d = random.uniform(*S['after_drift_px'])
    a = random.uniform(-math.pi * 5 / 6, -math.pi / 6)  # upwards, at least half the distance: clear of the button row
    return int(x + d * math.cos(a)), int(y + d * math.sin(a))


def idle_move(x, y, seconds_since_last_call=1.0):
    """While waiting: now and then (about idle_moves_per_min times a minute) a small slow drift."""
    rate = SETTINGS['idle_moves_per_min']
    if rate <= 0 or random.random() > rate * seconds_since_last_call / 60:
        return None
    d = random.uniform(*SETTINGS['idle_drift_px'])
    a = random.uniform(0, 2 * math.pi)
    return int(x + d * math.cos(a)), int(y + d * math.sin(a))


# ── bet sizes: a preset button, a tidy typed number, or whatever number came to mind ──

SETTINGS.update({
    'bet_preset_chance': 0.35,   # use a preset button (1/2, 3/4, 3BB, Pot) when one is close enough
    'bet_preset_close': 0.18,    # ...within 18% of the size the coach wants
    'bet_round_chance': 0.6,     # of typed bets: tidy number (else an untidy one like 45,555)
    'typo_chance': 0.04,         # mistype a digit, notice, backspace, fix it
})


def bet_amount(target, bb, lo=None, hi=None, tidy=None):
    """A typed size. tidy=True: round like a person (5 BB steps, or two significant digits, or whole
    BBs); tidy=False: near the coach's size but untidy (45,555); None: pick by bet_round_chance."""
    bb = float(bb or 0) or 1.0
    t = float(target)
    if tidy is None:
        tidy = random.random() < SETTINGS['bet_round_chance']
    if tidy:
        r = random.random()
        if r < 0.4 and t >= 10 * bb:
            step = 5 * bb
        elif r < 0.75 and t >= 1000:
            step = 10 ** (len(str(int(t))) - 2)  # 2 significant digits: 36,400 → 36,000
        else:
            step = bb
        v = max(step, round(t / step) * step)
    else:
        v = t * random.uniform(0.96, 1.04)
        digits = str(int(v))
        if random.random() < 0.5 and len(digits) >= 4:  # people mash a repeated digit: 45,555 / 38,888
            keep = max(2, len(digits) - random.randint(2, 3))
            mashed = int(digits[:keep] + digits[keep - 1] * (len(digits) - keep))
            if abs(mashed - v) <= 0.06 * v:
                v = mashed
    if lo is not None:
        v = max(v, float(lo))
    if hi is not None:
        v = min(v, float(hi))
    return int(round(v))


def bet_plan(target, bb, lo, hi, presets):
    """How to make this bet. presets: {'1/2': value, '3/4': value, ...} that the table's buttons
    would set right now. Returns {'how': 'preset', 'preset': name, 'amount': value} or
    {'how': 'type', 'amount': n}."""
    t = float(target)
    close = {k: v for k, v in (presets or {}).items()
             if v and lo <= v <= hi and abs(v - t) / max(t, 1.0) <= SETTINGS['bet_preset_close']}
    if close and random.random() < SETTINGS['bet_preset_chance']:
        name = min(close, key=lambda k: abs(close[k] - t))
        return {'how': 'preset', 'preset': name, 'amount': int(close[name])}
    return {'how': 'type', 'amount': bet_amount(t, bb, lo, hi)}


def type_amount(amount):
    """Select what's in the focused box and type the amount key by key at typing speed, now and
    then hitting a wrong digit and correcting it (Windows)."""
    import ctypes
    import time
    user32 = ctypes.windll.user32
    KEYUP = 0x0002
    BACKSPACE, CTRL, A = 0x08, 0x11, 0x41

    def tap(vk):
        user32.keybd_event(vk, 0, 0, 0)
        time.sleep(random.uniform(0.03, 0.09))
        user32.keybd_event(vk, 0, KEYUP, 0)

    user32.keybd_event(CTRL, 0, 0, 0)
    time.sleep(random.uniform(0.04, 0.1))
    tap(A)                                     # select all
    time.sleep(random.uniform(0.02, 0.06))
    user32.keybd_event(CTRL, 0, KEYUP, 0)
    time.sleep(random.uniform(0.08, 0.25))
    digits = str(int(amount))
    for i, ch in enumerate(digits):
        if i and random.random() < SETTINGS['typo_chance']:
            wrong = random.choice([d for d in '0123456789' if d != ch])
            tap(0x30 + int(wrong))
            time.sleep(random.uniform(0.25, 0.7))  # notice it
            tap(BACKSPACE)
            time.sleep(random.uniform(0.1, 0.3))
        tap(0x30 + int(ch))
        # a short burst for repeated digits, a beat between groups of three
        same = i and digits[i - 1] == ch
        time.sleep(random.uniform(0.04, 0.12) if same else random.uniform(0.07, 0.22))
    time.sleep(random.uniform(0.15, 0.5))      # glance at what you typed


# ── sharing the mouse with you ──
# The bot remembers where it last put the pointer. If the pointer is somewhere else, you moved it:
# the bot stops what it's doing, waits until you've left the mouse alone for a moment, then carries
# on from wherever the pointer now is. It still acts before the turn timer runs out.

SETTINGS.update({
    'user_quiet_s': 1.5,       # how long the mouse must be untouched before the bot takes it
    'turn_budget_s': 20.0,     # from the bot's decision to its click, at most (then it acts anyway)
    'idle_after_user_s': 10.0,  # no idle drifts until you've left the mouse alone this long
})

_state = {'last_set': None, 'user_at': 0.0, 'deadline': None, 'told': False}


def _moved(a, b, tol=4):
    return a is not None and b is not None and (abs(a[0] - b[0]) > tol or abs(a[1] - b[1]) > tol)


def note_set(x, y):
    """The bot just put the pointer here."""
    _state['last_set'] = (int(x), int(y))


def observe(pos):
    """Look at where the pointer is; True if you've moved it since the bot (or you) last did."""
    import time
    pos = (int(pos[0]), int(pos[1]))
    if _moved(pos, _state['last_set']):
        _state['user_at'] = time.time()
        _state['last_set'] = pos  # new baseline: further movement counts as you again
        return True
    if _state['last_set'] is None:
        _state['last_set'] = pos
    return False


def user_idle_for():
    import time
    return time.time() - _state['user_at']


def begin_turn():
    """Start the clock for this decision (thinking + waiting for you + clicking)."""
    import time
    _state['deadline'] = time.time() + SETTINGS['turn_budget_s']
    _state['told'] = False


def end_turn():
    _state['deadline'] = None


def wait_for_user(get_pos, log=None):
    """If you're using the mouse, wait until you've stopped for user_quiet_s (or the turn is nearly up)."""
    import time
    observe(get_pos())
    deadline = _state['deadline']
    if deadline is None or time.time() > deadline + 30:  # not in a turn (pre-action, I'm back): wait 5 s at most
        deadline = time.time() + 5
    while user_idle_for() < SETTINGS['user_quiet_s']:
        if time.time() >= deadline:
            if log:
                log.info("You're still using the mouse but time's nearly up - acting now")
            return
        if log and not _state['told']:
            log.info("You're using the mouse - waiting until you stop")
            _state['told'] = True
        time.sleep(0.25)
        observe(get_pos())


def glide(points, move, get_pos):
    """Move along points; stop (return False) as soon as the pointer isn't where we left it."""
    import time
    for x, y, dt in points:
        if _state['last_set'] is not None and _moved(get_pos(), _state['last_set']):
            observe(get_pos())
            return False
        move(x, y)
        note_set(x, y)
        time.sleep(dt)
    return True
