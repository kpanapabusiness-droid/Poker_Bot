"""
card_reader.py — read playing cards off a screenshot without a picture of every card.

dickreuter recognises a card by matching an exact picture of it, so a new site needs all 52 cards
saved (twice, if your cards are drawn a different size from the board). This reader works on any
site that draws cards as white faces with a coloured rank and suit, like Torn:

  1. find the white card faces inside the search area,
  2. the suit is the colour of the ink (four-colour decks: black ♠, red ♥, blue ♦, green ♣;
     two-colour decks fall back to the shape of the suit symbol),
  3. the rank is read with Tesseract, restricted to A K Q J 10 9 … 2.

    read_cards(pil_image, box, layout='board' | 'hand') -> ['4S', 'KD', ...]

box is (x1, y1, x2, y2) in the image. For 'hand' only fully visible face-up cards count; a card
back, avatar or face-down card is skipped.
"""
import os
import shutil
import subprocess
import tempfile

import numpy as np
from PIL import Image

RANKS = 'AKQJT98765432'


def _tesserocr():
    """The tesserocr module if it's the real one (dickreuter installs it), else None → Tesseract CLI."""
    try:
        import tesserocr
    except ImportError:
        return None
    # the Windows wheel has no __version__, so check it's a real module on disk (the simulator's stub isn't)
    return tesserocr if getattr(tesserocr, '__file__', None) and hasattr(tesserocr, 'PyTessBaseAPI') else None

_apis = {}


def _api(psm_name, whitelist):
    """A tesserocr reader (cached), trying dickreuter's tessdata then Tesseract's own; None → use the CLI."""
    key = (psm_name, whitelist)
    if key in _apis:
        return _apis[key]
    api = None
    tesserocr = _tesserocr()
    if tesserocr is not None:
        paths = []
        try:
            from poker.tools.screen_operations import tesserpath
            paths.append(tesserpath)
        except Exception:
            pass
        paths.append(None)
        for path in paths:
            try:
                kw = {'path': path} if path else {}
                api = tesserocr.PyTessBaseAPI(psm=getattr(tesserocr.PSM, psm_name), **kw)
                api.SetVariable('tessedit_char_whitelist', whitelist)
                break
            except Exception as e:
                import logging
                logging.getLogger(__name__).warning(f'tesserocr with tessdata {path!r} failed: {e}')
                api = None
    _apis[key] = api
    return api


def _tesseract_exe():
    exe = shutil.which('tesseract')
    if exe:
        return exe
    for p in (r'C:\Program Files\Tesseract-OCR\tesseract.exe', r'C:\Program Files (x86)\Tesseract-OCR\tesseract.exe'):
        if os.path.exists(p):
            return p
    return None


def _ocr(img):
    """Single-word OCR of a rank glyph, whitelisted. tesserocr if available (dickreuter has it), else the CLI."""
    api = _api('SINGLE_WORD', 'AKQJ1098765432')
    if api is not None:
        api.SetImage(img)
        return api.GetUTF8Text().strip()
    exe = _tesseract_exe()
    if not exe:
        return ''
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, 'r.png')
        img.save(p)
        out = subprocess.run([exe, p, 'stdout', '--psm', '8', '-c', 'tessedit_char_whitelist=AKQJ1098765432'],
                             capture_output=True, text=True)
        return out.stdout.strip()


def _faces(arr):
    """Bounding boxes of white card faces (connected bright regions of card shape)."""
    # live cards are pure white; folded (greyed-out) cards are ~225, so they are ignored
    white = (arr[:, :, 0] > 240) & (arr[:, :, 1] > 240) & (arr[:, :, 2] > 240)
    h, w = white.shape
    seen = np.zeros_like(white)
    boxes = []
    # flood fill on a coarse grid for speed
    for y0 in range(0, h, 3):
        for x0 in range(0, w, 3):
            if not white[y0, x0] or seen[y0, x0]:
                continue
            stack = [(y0, x0)]
            seen[y0, x0] = True
            xs, ys = [x0], [y0]
            n = 0
            while stack:
                y, x = stack.pop()
                n += 1
                for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    yy, xx = y + dy, x + dx
                    if 0 <= yy < h and 0 <= xx < w and white[yy, xx] and not seen[yy, xx]:
                        seen[yy, xx] = True
                        stack.append((yy, xx))
                        xs.append(xx)
                        ys.append(yy)
            bx1, bx2, by1, by2 = min(xs), max(xs), min(ys), max(ys)
            bw, bh = bx2 - bx1 + 1, by2 - by1 + 1
            if bw >= 25 and bh >= 35 and 1.1 <= bh / bw <= 2.2 and n > 0.35 * bw * bh:
                boxes.append((bx1, by1, bx2 + 1, by2 + 1))
    # merge boxes that overlap (white split by ink)
    boxes.sort()
    merged = []
    for b in boxes:
        if merged and b[0] <= merged[-1][2] - 5 and not (b[3] < merged[-1][1] or b[1] > merged[-1][3]):
            m = merged[-1]
            merged[-1] = (min(m[0], b[0]), min(m[1], b[1]), max(m[2], b[2]), max(m[3], b[3]))
        else:
            merged.append(b)
    return merged


def _ink(card):
    """Mask of 'ink' pixels on a card face (anything clearly not white)."""
    a = card.astype(int)
    return (a.min(axis=2) < 160)


def _suit_from_colour(card, ink):
    a = card.astype(int)
    px = a[ink]
    if len(px) < 20:
        return None
    r, g, b = px[:, 0], px[:, 1], px[:, 2]
    sat = px.max(axis=1) - px.min(axis=1)
    coloured = sat > 60
    if coloured.mean() < 0.3:
        return 'S'  # black ink
    r, g, b = r[coloured], g[coloured], b[coloured]
    votes = {'H': np.sum((r > g + 40) & (r > b + 40)), 'D': np.sum((b > r + 40) & (b >= g)),
             'C': np.sum((g > r + 30) & (g > b))}
    return max(votes, key=votes.get)


def _isolate(mask, first):
    """Keep just the rank glyph: the first (hand: top) or last (board: bottom) band of ink rows,
    so the suit symbol printed next to it doesn't confuse the OCR. Cropped to its ink."""
    rows = mask.any(axis=1)
    runs, start = [], None
    for i, r in enumerate(list(rows) + [False]):
        if r and start is None:
            start = i
        elif not r and start is not None:
            if i - start >= 4:
                runs.append((start, i))
            start = None
    if not runs:
        return None
    y1, y2 = runs[0] if first else runs[-1]
    band = mask[y1:y2]
    cols = np.where(band.any(axis=0))[0]
    return band[:, cols[0]:cols[-1] + 1]


def _rank(card_img, layout):
    """OCR the rank from where this site prints it. Several scalings vote, which irons out the odd misread."""
    w, h = card_img.size
    regions = ([(0.35, 0.40, 1.0, 1.0), (0.0, 0.0, 1.0, 1.0)] if layout == 'board'
               else [(0.0, 0.0, 0.5, 0.36), (0.0, 0.0, 0.6, 0.45)])
    for (fx1, fy1, fx2, fy2) in regions:
        crop = card_img.crop((int(fx1 * w), int(fy1 * h), int(fx2 * w), int(fy2 * h)))
        g = np.array(crop.convert('RGB')).astype(int)
        mask = g.min(axis=2) < 160  # ink → black on white, whatever its colour
        mask = _isolate(mask, first=(layout != 'board'))
        if mask is None:
            continue
        bw = Image.fromarray(np.where(mask, 0, 255).astype('uint8'))
        votes = {}
        for scale, resample in ((2, Image.NEAREST), (3, Image.NEAREST), (4, Image.NEAREST), (3, Image.LANCZOS), (5, Image.LANCZOS)):
            big = bw.resize((bw.width * scale, bw.height * scale), resample)
            for pad in (12, 30):
                img = Image.new('L', (big.width + 2 * pad, big.height + 2 * pad), 255)
                img.paste(big, (pad, pad))
                txt = _ocr(img).upper().replace('O', '0').replace('I', '1')
                r = 'T' if '10' in txt else next((ch for ch in txt if ch in RANKS), None)
                if r:
                    votes[r] = votes.get(r, 0) + 1
        if votes:
            best = max(votes, key=votes.get)
            if best in '38':  # OCR mixes these up; an 8 has ink down its left side, a 3 doesn't
                h2, w2 = mask.shape
                left = mask[int(0.15 * h2):int(0.85 * h2), :max(1, int(0.3 * w2))].any(axis=1).mean()
                best = '8' if left > 0.6 else '3'
            return best
    return None


def read_cards(img, box, layout='board'):
    """Cards visible in box, left to right, as dickreuter strings like 'AS', 'TD'."""
    x1, y1, x2, y2 = [int(v) for v in box]
    region = img.convert('RGB').crop((x1, y1, x2, y2))
    arr = np.array(region)
    out = []
    notes = []
    for (bx1, by1, bx2, by2) in _faces(arr):
        card = arr[by1:by2, bx1:bx2]
        ink = _ink(card)
        if ink.mean() < 0.02:  # blank white rectangle (not a card face)
            notes.append(f'blank {bx2 - bx1}x{by2 - by1}')
            continue
        suit = _suit_from_colour(card, ink)
        rank = _rank(region.crop((bx1, by1, bx2, by2)), layout)
        notes.append(f'face {bx2 - bx1}x{by2 - by1} at {bx1},{by1}: rank={rank} suit={suit}')
        if suit and rank:
            out.append(rank + suit)
    global last_notes
    last_notes = notes
    return out


last_notes = []  # what read_cards saw on its last call, for the debug log
_last_dump = [0.0]


def dump_failed(img, box, name, folder, every=5.0, keep=30):
    """Save the search area (and a note of what was found) when cards weren't read, at most every few seconds."""
    import time, glob, logging
    now = time.time()
    if now - _last_dump[0] < every:
        return
    _last_dump[0] = now
    try:
        os.makedirs(folder, exist_ok=True)
        x1, y1, x2, y2 = [int(v) for v in box]
        stamp = time.strftime('%H%M%S')
        img.convert('RGB').crop((x1, y1, x2, y2)).save(os.path.join(folder, f'{name}_{stamp}.png'))
        img.convert('RGB').save(os.path.join(folder, f'{name}_{stamp}_table.png'))
        logging.getLogger(__name__).info(f'card reader {name}: {last_notes or "no white card faces found"} '
                                         f'(image {img.size}, box {box}) -> saved {name}_{stamp}.png')
        files = sorted(glob.glob(os.path.join(folder, f'{name}_*.png')))
        for f in files[:-keep]:
            os.remove(f)
    except Exception as e:
        logging.getLogger(__name__).warning(f'card reader debug dump failed: {e}')


if __name__ == '__main__':
    import sys
    im = Image.open(sys.argv[1])
    box = tuple(int(v) for v in sys.argv[2].split(','))
    print(read_cards(im, box, sys.argv[3] if len(sys.argv) > 3 else 'board'))


# ── Amounts ("$1,419,983", "POT: $7,500", "RAISE TO $2K") ──
import re as _re

_AMOUNT = _re.compile(r'\$?\s*(\d[\d,]*(?:\.\d+)?)\s*([KMB])?', _re.I)
_tess_text = None


def _ocr_text(img):
    api = _api('SINGLE_LINE', '$0123456789,.KMBPOT: ')
    if api is not None:
        api.SetImage(img)
        return api.GetUTF8Text().strip()
    exe = _tesseract_exe()
    if not exe:
        return ''
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, 'a.png')
        img.save(p)
        out = subprocess.run([exe, p, 'stdout', '--psm', '7', '-c', 'tessedit_char_whitelist=$0123456789,.KMBPOT: '],
                             capture_output=True, text=True)
        return out.stdout.strip()


def parse_amount(text, need_dollar=False):
    """'$1,419,983' → 1419983, '$2K' → 2000, '$1.5M' → 1500000; None if there's no number.
    need_dollar: only accept text with a '$' (sites that always print one), so specks aren't read as 4."""
    if need_dollar and '$' not in text:
        return None
    best = None
    for m in _AMOUNT.finditer(text.replace(' ', '') if '$' in text else text):
        num = float(m.group(1).replace(',', ''))
        mult = {'K': 1e3, 'M': 1e6, 'B': 1e9}.get((m.group(2) or '').upper(), 1)
        best = num * mult  # the last number wins ("POT: $7,500" → 7500)
    return best


def read_amount(img, box, need_dollar=True):
    """Read a money amount in box (dark text on light or light text on dark). Greyscale, upscaled,
    so Tesseract sees the anti-aliased edges; a few scalings vote."""
    from PIL import ImageOps
    x1, y1, x2, y2 = [int(v) for v in box]
    rgb = np.array(img.convert('RGB').crop((x1, y1, x2, y2))).astype(int)
    if rgb.shape[0] < 4 or rgb.shape[1] < 4:
        return None
    lum = rgb.mean(axis=2)
    dark_bg = np.median(lum) < 128
    # money text is white/grey; anything colourful (table rim, chips, coins) is background
    colourful = (rgb.max(axis=2) - rgb.min(axis=2)) > 45
    lum[colourful] = 0 if dark_bg else 255
    g = Image.fromarray(lum.clip(0, 255).astype('uint8'))
    if dark_bg:
        g = ImageOps.invert(g)  # light text on dark → dark on light
    votes = {}
    for scale in (3, 4, 5):
        big = g.resize((g.width * scale, g.height * scale), Image.LANCZOS)
        v = parse_amount(_ocr_text(ImageOps.expand(big, 20, fill=255)), need_dollar)
        if v is not None:
            votes[v] = votes.get(v, 0) + 1
    if not votes:
        return None
    return max(votes, key=lambda k: (votes[k], k))


_tess_name = None


def read_text(img, box):
    """A player name or label: one line, letters/digits/_.- only."""
    global _tess_name
    from PIL import ImageOps
    x1, y1, x2, y2 = [int(v) for v in box]
    g = img.convert('L').crop((x1, y1, x2, y2))
    if np.median(np.array(g)) < 128:
        g = ImageOps.invert(g)
    big = ImageOps.expand(g.resize((g.width * 4, g.height * 4), Image.LANCZOS), 20, fill=255)
    allowed = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-'
    api = _api('SINGLE_LINE', allowed)
    if api is not None:
        api.SetImage(big)
        txt = api.GetUTF8Text()
    else:
        exe = _tesseract_exe()
        if not exe:
            return ''
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, 'n.png')
            big.save(p)
            txt = subprocess.run([exe, p, 'stdout', '--psm', '7', '-c', 'tessedit_char_whitelist=' + allowed],
                                 capture_output=True, text=True).stdout
    return ''.join(ch for ch in txt.strip() if ch in allowed)


def seat_status(img, name_box):
    """Is this seat in the hand? Torn fades a seat's name when the player isn't playing the hand
    and writes why underneath: "Folded" (dealt in, then folded), "Sitting out" / "Waiting BB" (not
    dealt in), or nothing (empty seat). The words aren't OCR-readable (faint grey), but their length
    is: "Folded" is about 40px wide, the other two about 60px.

    Returns 'active', 'folded', 'away' or 'empty'. Measured on Torn's default theme (6 Nov 2026)."""
    x1, y1, x2, y2 = [int(v) for v in name_box]
    x1 = max(0, x1)
    g = np.array(img.convert('L')).astype(int)
    name = g[y1:y2, x1:x2]
    if name.size == 0:
        return 'active'
    if name.min() < 130:  # dark name text: playing this hand
        return 'active'
    status = g[y1 + 56:y1 + 73, x1:x1 + 100]
    if status.size == 0:
        return 'folded'
    ink = (status < np.median(status) - 25).sum(0) > 0
    cols = np.where(ink)[0]
    width = int(cols[-1] - cols[0] + 1) if len(cols) else 0
    if width == 0:
        return 'empty'
    return 'away' if width >= 50 else 'folded'
