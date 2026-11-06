"""Tests for card_reader.py (cards by colour + OCR, money amounts). Run: python test_card_reader.py
Needs Tesseract (dickreuter's tesserocr, or the tesseract command)."""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from PIL import Image, ImageDraw, ImageFont  # noqa: E402
import card_reader as C  # noqa: E402

passed = failed = 0


def check(name, ok, detail=''):
    global passed, failed
    passed, failed = passed + ok, failed + (not ok)
    print(f"  {'✓' if ok else '✗'} {name} {'' if ok else detail}")


def font(size):
    for f in ('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',):  # the font these tests were tuned on
        try:
            return ImageFont.truetype(f, size)
        except OSError:
            pass
    return None


print('\nAmounts')
for text, want in [('$1,419,983', 1419983), ('POT: $7,500', 7500), ('RAISE TO $2K', 2000), ('$1.5M', 1.5e6),
                   ('$500', 500), ('Check', None), ('4', None)]:
    got = C.parse_amount(text, need_dollar=True)
    check(f'{text!r} → {want}', got == want, got)

fb, fh, fs = font(40), font(24), font(18)
if fb is None:
    print('  (skipped card and image tests: no TrueType font found)')
else:
    print('\nMoney read from images (dark on light, light on dark)')
    for amount, fg, bg in [('$532,000', (90, 90, 90), (250, 250, 245)), ('$189,000', (90, 90, 90), (250, 250, 245)),
                           ('$1,000', (255, 255, 255), (0, 0, 0)), ('$10,000', (255, 255, 255), (5, 5, 5))]:
        im = Image.new('RGB', (130, 26), bg)
        ImageDraw.Draw(im).text((8, 3), amount, font=fs, fill=fg)
        got = C.read_amount(im, (0, 0, 130, 26))
        check(f'{amount}', got == float(amount.strip('$').replace(',', '')), got)

    print('\nAll 52 cards, board style and hand style (four-colour deck)')
    cols = {'S': (40, 40, 40), 'H': (210, 40, 40), 'D': (30, 110, 200), 'C': (40, 150, 60)}
    bad = []
    for r in 'AKQJT98765432':
        for s, col in cols.items():
            txt = '10' if r == 'T' else r
            im = Image.new('RGB', (320, 120), (10, 10, 10))
            d = ImageDraw.Draw(im)
            d.rounded_rectangle((20, 10, 90, 105), 6, fill=(255, 255, 255))
            d.ellipse((25, 15, 45, 35), fill=col)
            d.text((88, 102), txt, font=fb, fill=col, anchor='rs')
            board = C.read_cards(im, (0, 0, 320, 120), 'board')
            im2 = Image.new('RGB', (160, 120), (220, 220, 220))
            d = ImageDraw.Draw(im2)
            d.rounded_rectangle((10, 8, 80, 110), 6, fill=(255, 255, 255))
            d.text((14, 10), txt, font=fh, fill=col)
            d.ellipse((15, 40, 32, 57), fill=col)
            hand = C.read_cards(im2, (0, 0, 160, 120), 'hand')
            if board != [r + s] or hand != [r + s]:
                bad.append((r + s, board, hand))
    check(f'104 cards read correctly ({104 - len(bad)}/104)', not bad, bad[:6])
    blank = Image.new('RGB', (200, 120), (10, 10, 10))
    check('no cards → empty list', C.read_cards(blank, (0, 0, 200, 120)) == [])

print(f'\n{passed} passed, {failed} failed\n')
sys.exit(1 if failed else 0)
