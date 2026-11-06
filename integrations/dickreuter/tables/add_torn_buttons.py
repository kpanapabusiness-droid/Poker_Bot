"""
add_torn_buttons.py — finish the Torn table: real Call and Bet button pictures plus the bet-size
mouse positions (½ pot, pot, max, +), cut from the bot's own per-decision screenshots
(log/screenshots/*.png, which are already cropped to the "Poker" heading), then check every button
picture against every screenshot the same way the bot does.

    python add_torn_buttons.py CALL_SHOT.png BET_SHOT.png ALLIN_SHOT.png [more screenshots to check ...]

CALL_SHOT: a screenshot showing "RAISE TO / CALL / FOLD"; BET_SHOT: one showing "BET / CHECK / FOLD";
ALLIN_SHOT: one showing the two-button "ALL-IN / FOLD" bar (full screenshots are cropped automatically).
Positions are relative to the heading, like everything in torn_9max.json.
"""
import argparse
import base64
import io
import json
import os

import cv2
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))

BAR = (112, 645, 675, 687)                 # the whole action-button bar (2- and 3-button layouts)
CUT = {                                    # just the word, cut from the screenshot that shows it
    'call_button': ('call', (369, 658, 395, 673)),   # "CALL" of "CALL $3K"
    'bet_button': ('bet', (186, 658, 206, 673)),     # "BET" of "BET $1K"
    'all_in_call_button': ('allin', (234, 658, 272, 673)),  # "ALL-IN" of the two-button ALL-IN / FOLD bar
}
MOUSE = {                                  # where to click (only used with "Act automatically")
    'mouse_half_pot': (301, 610, 316, 625),  # "1/2" preset
    'mouse_full_pot': (377, 610, 395, 625),  # "Pot" preset
    'mouse_all_in': (413, 610, 435, 625),    # "Max" preset
    'mouse_increase': (640, 610, 650, 625),  # "+" next to the amount
    'mouse_call2': (175, 652, 275, 680),     # ALL-IN when calling means all-in (left of the bar in both layouts)
}
THRESHOLD = 0.03                           # present buttons score <= 0.015, absent ones >= 0.045
BUTTONS = ('fold_button', 'check_button', 'call_button', 'raise_button', 'bet_button', 'all_in_call_button')


def box(b):
    return {'x1': b[0], 'y1': b[1], 'x2': b[2], 'y2': b[3]}


def png_b64(img):
    b = io.BytesIO()
    img.save(b, format='PNG')
    return base64.b64encode(b.getvalue()).decode()


def crop_to_heading(t, im):
    """A full screenshot → the same crop the bot makes (from the "Poker" heading)."""
    tl = cv2.cvtColor(np.array(Image.open(io.BytesIO(base64.b64decode(t['topleft_corner']))).convert('RGB')), cv2.COLOR_RGB2BGR)
    res = cv2.matchTemplate(cv2.cvtColor(np.array(im), cv2.COLOR_RGB2BGR), tl, cv2.TM_SQDIFF_NORMED)
    mn, _, (x, y), _ = cv2.minMaxLoc(res)
    if mn > 0.01:
        return im  # already cropped
    return im.crop((x, y, x + 1500, y + 1100))


def found(t, shot, key, area='buttons_search_area'):
    """Same test as the bot's is_template_in_search_area (TM_SQDIFF_NORMED <= the table's button_threshold)."""
    a = t[area]
    region = cv2.cvtColor(np.array(shot.crop((a['x1'], a['y1'], a['x2'], a['y2']))), cv2.COLOR_RGB2BGR)
    tpl = cv2.cvtColor(np.array(Image.open(io.BytesIO(base64.b64decode(t[key]))).convert('RGB')), cv2.COLOR_RGB2BGR)
    res = cv2.matchTemplate(region, tpl, cv2.TM_SQDIFF_NORMED)
    return float(res.min()) <= float(t.get('button_threshold', 0.01))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('call_shot')
    ap.add_argument('bet_shot')
    ap.add_argument('allin_shot', help='full screenshot showing ALL-IN / FOLD (cropped here from the heading)')
    ap.add_argument('check', nargs='*')
    ap.add_argument('--table', default=os.path.join(HERE, 'torn_9max.json'))
    o = ap.parse_args()
    t = json.load(open(o.table))
    shots = {'call': Image.open(o.call_shot).convert('RGB'), 'bet': Image.open(o.bet_shot).convert('RGB'),
             'allin': crop_to_heading(t, Image.open(o.allin_shot).convert('RGB'))}
    for key, (which, b) in CUT.items():
        t[key] = png_b64(shots[which].crop(b))
    for key, b in MOUSE.items():
        t[key] = box(b)
    t['buttons_search_area'] = box(BAR)
    t['button_threshold'] = THRESHOLD
    t['lost_everything_search_area'] = box(BAR)
    json.dump(t, open(o.table, 'w'))
    print(f'Updated {o.table}\n')
    print(f"{'screenshot':<28}" + ''.join(f'{k.replace("_call_button", "").replace("_button", ""):>7}' for k in BUTTONS))
    for path in [o.call_shot, o.bet_shot, o.allin_shot] + o.check:
        im = crop_to_heading(t, Image.open(path).convert('RGB'))
        print(f'{os.path.basename(path):<28}' + ''.join(f"{'yes' if found(t, im, k) else '-':>7}" for k in BUTTONS))


if __name__ == '__main__':
    main()
