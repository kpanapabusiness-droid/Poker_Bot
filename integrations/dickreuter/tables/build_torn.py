"""
Build the Torn hold'em (9 seats) table mapping for dickreuter from one of your own screenshots.

    python build_torn.py SCREENSHOT.png [--out torn_9max.json]

Use a full-desktop screenshot from dickreuter's Table Setup (Save Screenshots) taken when it's your
turn, at a 9-seat table, with the browser where you'll keep it. Everything is measured from the
"Poker" heading above the table, so the window can move as long as the page layout stays the same
(same zoom, same window width, not scrolled).

Cards and money are read by card_reader.py (colour + OCR), so no card pictures are needed.
"""
import argparse
import base64
import io
import json
import os
import sys

from PIL import Image

# Positions measured on a 4480x1440 desktop screenshot with the "Poker" heading at (655, 210).
# Everything below is relative to that heading's top-left corner.
TLC = (655, 210)
HEADING = (655, 210, 720, 234)
COIN = {1: (764, 672), 2: (658, 549), 3: (658, 424), 4: (764, 300), 5: (1234, 300),
        6: (1340, 424), 7: (1340, 549), 8: (1234, 672), 0: (942, 679)}   # green "$" coin of each seat
CHIP = {1: (848, 617), 2: (822, 558), 3: (822, 498), 4: (852, 439), 5: (1208, 439),
        6: (1241, 498), 7: (1241, 557), 8: (1208, 616), 0: (1029, 634)}  # bet chip (top-left)
BOARD = (895, 455, 1195, 545)
HAND = (1010, 695, 1165, 805)
POT = (980, 428, 1120, 452)            # "POT: $7,500" (includes this street's bets)
BUTTONS = (815, 855, 1265, 897)
TEMPLATES = {                          # cut from the screenshot (it must be your turn in it)
    'topleft_corner': HEADING,
    'dealer_button': (879, 674, 890, 685),
    'covered_card': (835, 736, 853, 756),     # part of a face-down card in a seat panel (faded when folded)
    'my_turn': (1094, 678, 1106, 694),        # hourglass next to your stack: only there on your turn
    'check_button': (1031, 868, 1066, 883),
    'fold_button': (1222, 868, 1249, 883),
    'raise_button': (828, 868, 868, 883),     # "RAISE" of "RAISE TO $…"
}
NEVER = ('call_button', 'bet_button', 'all_in_call_button', 'im_back', 'resume_hand', 'lost_everything',
         'fast_fold_button')  # not captured yet: a template that never matches


def rel(box):
    x1, y1, x2, y2 = box
    return {'x1': x1 - TLC[0], 'y1': y1 - TLC[1], 'x2': x2 - TLC[0], 'y2': y2 - TLC[1]}


def png_b64(img):
    b = io.BytesIO()
    img.save(b, format='PNG')
    return base64.b64encode(b.getvalue()).decode()


def never_template():
    img = Image.new('RGB', (9, 9), (255, 0, 255))
    for i in range(9):
        img.putpixel((i, i), (0, 255, 0))
    return png_b64(img)


def seat_dealer_area(s):
    cx, cy = COIN[s]
    if s == 0:
        return (900, 660, 1180, 712)
    left = cx < 1000
    # the dealer button sits on the table side of the seat panel, level with the stack
    return (cx + 95, cy - 12, cx + 150, cy + 32) if left else (cx - 52, cy - 12, cx + 2, cy + 32)


def build(shot):
    im = Image.open(shot).convert('RGB')
    t = {'table_name': 'Torn holdem 9', 'owner': None, 'max_players': {'value': 9},
         'card_reader': {'board': 'board', 'hand': 'hand'}, 'coach_reader': True}
    for k, box in TEMPLATES.items():
        t[k] = png_b64(im.crop(box))
    for k in NEVER:
        t[k] = never_template()
    t['buttons_search_area'] = rel(BUTTONS)
    t['my_turn_search_area'] = rel((1080, 668, 1120, 702))
    t['lost_everything_search_area'] = rel(BUTTONS)
    t['table_cards_area'] = rel(BOARD)
    t['my_cards_area'] = rel(HAND)
    t['total_pot_area'] = rel(POT)
    t['current_round_pot'] = rel(POT)
    t['call_value'] = rel((1000, 862, 1100, 888))
    t['raise_value'] = rel((826, 862, 902, 888))
    t['game_number'] = rel(POT)
    for k in ('player_funds_area', 'player_name_area', 'player_pot_area', 'covered_card_area', 'button_search_area'):
        t[k] = {}
    for s, (cx, cy) in COIN.items():
        bx, by = CHIP[s]
        t['player_funds_area'][str(s)] = rel((cx + 15, cy - 3, cx + 108, cy + 16))
        t['player_name_area'][str(s)] = rel((cx - 4, cy + 22, cx + 104, cy + 42))
        t['player_pot_area'][str(s)] = rel((bx - 25, by + 17, bx + 41, by + 33))  # centred under the chip, clear of the rim
        t['covered_card_area'][str(s)] = rel((cx + 34, cy + 38, cx + 104, cy + 92)) if s else rel(HAND)
        t['button_search_area'][str(s)] = rel(seat_dealer_area(s))
    # mouse targets (only used with "Act automatically"): the three action buttons
    t['mouse_fold'] = rel((1190, 862, 1260, 890))
    t['mouse_check'] = rel((1000, 862, 1100, 890))
    t['mouse_call'] = rel((1000, 862, 1100, 890))
    t['mouse_call2'] = rel((1000, 862, 1100, 890))
    t['mouse_raise'] = rel((830, 862, 930, 890))
    return t


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('screenshot')
    ap.add_argument('--out', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), 'torn_9max.json'))
    o = ap.parse_args()
    table = build(o.screenshot)
    json.dump(table, open(o.out, 'w'))
    print(f'Wrote {o.out} ({len(table)} entries)')
