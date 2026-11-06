/*
 * poker-engine.js — core maths for the live poker coach (Phase 1)
 *
 * Plain JavaScript, no dependencies, no build step.
 * Works in Node (require('./poker-engine.js')) and in the browser /
 * Tampermonkey (exposes a global `PokerEngine`).
 *
 * Modules inside:
 *   1. Cards      — parse/format cards ("As", "Td", "9c")
 *   2. Evaluator  — fast 5–7 card hand evaluation → comparable score
 *   3. Ranges     — parse range notation ("22+, A2s+, KTo+, T9s-65s")
 *   4. Equity     — Monte Carlo equity: hero vs N villains (ranges or random)
 *   5. Odds       — pot odds, required equity, call EV, MDF, SPR
 *   6. Preflop    — starter open-raise (RFI) ranges by position
 *   7. Advice     — simple call/fold/raise recommendation from the numbers
 *
 * Card integer encoding: card = (rank - 2) * 4 + suit
 *   rank: 2..14 (T=10, J=11, Q=12, K=13, A=14)
 *   suit: 0=c, 1=d, 2=h, 3=s
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PokerEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ───────────────────────────── 1. Cards ─────────────────────────────
  const RANK_CHARS = '23456789TJQKA';
  const SUIT_CHARS = 'cdhs';

  function rankOf(card) { return (card >> 2) + 2; }
  function suitOf(card) { return card & 3; }

  function rankFromChar(ch) {
    const i = RANK_CHARS.indexOf(ch.toUpperCase());
    if (i < 0) throw new Error('Bad rank: ' + ch);
    return i + 2;
  }

  function parseCard(str) {
    const s = String(str).trim();
    let r = s.slice(0, -1), su = s.slice(-1).toLowerCase();
    if (r === '10') r = 'T';
    const rank = rankFromChar(r);
    const suit = SUIT_CHARS.indexOf(su);
    if (suit < 0) throw new Error('Bad suit: ' + str);
    return (rank - 2) * 4 + suit;
  }

  /** "AsKd" | "As Kd" | ["As","Kd"] → [int, int] */
  function parseCards(input) {
    if (Array.isArray(input)) return input.map(c => (typeof c === 'number' ? c : parseCard(c)));
    const s = String(input).replace(/[\s,]+/g, '');
    const out = [];
    for (let i = 0; i < s.length;) {
      const len = s.startsWith('10', i) ? 3 : 2;
      out.push(parseCard(s.slice(i, i + len)));
      i += len;
    }
    return out;
  }

  function cardToString(card) { return RANK_CHARS[rankOf(card) - 2] + SUIT_CHARS[suitOf(card)]; }

  // ──────────────────────────── 2. Evaluator ───────────────────────────
  // Score = category * 16^5 + up to five kicker ranks in base 16.
  // Higher score = better hand. Equal score = exact tie.
  const CATEGORY_NAMES = ['High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight',
    'Flush', 'Full house', 'Four of a kind', 'Straight flush'];
  const P16 = [65536, 4096, 256, 16, 1];
  const CAT_BASE = 1048576; // 16^5

  function score(cat, kickers) {
    let s = cat * CAT_BASE;
    for (let i = 0; i < kickers.length && i < 5; i++) s += kickers[i] * P16[i];
    return s;
  }

  /** Highest straight top-card in a rank bitmask (bit r set for rank r), or 0. */
  function straightHigh(mask) {
    if (mask & (1 << 14)) mask |= 1 << 1; // ace plays low for the wheel
    for (let high = 14; high >= 5; high--) {
      const m = 0b11111 << (high - 4);
      if ((mask & m) === m) return high;
    }
    return 0;
  }

  function topRanksFromMask(mask, n, exclude) {
    const out = [];
    for (let r = 14; r >= 2 && out.length < n; r--) {
      if ((mask & (1 << r)) && !(exclude && exclude.includes(r))) out.push(r);
    }
    return out;
  }

  const _rc = new Int8Array(15);
  /** Evaluate 5–7 cards (ints). Returns a comparable score. */
  function evaluate(cards) {
    _rc.fill(0);
    const sc = [0, 0, 0, 0], sm = [0, 0, 0, 0];
    let rankMask = 0;
    for (let i = 0; i < cards.length; i++) {
      const c = cards[i], r = (c >> 2) + 2, s = c & 3;
      _rc[r]++; sc[s]++; sm[s] |= 1 << r; rankMask |= 1 << r;
    }

    let flushScore = 0;
    for (let s = 0; s < 4; s++) {
      if (sc[s] >= 5) {
        const sf = straightHigh(sm[s]);
        if (sf) return score(8, [sf]);
        flushScore = score(5, topRanksFromMask(sm[s], 5));
      }
    }

    let quad = 0; const trips = [], pairs = [];
    for (let r = 14; r >= 2; r--) {
      const n = _rc[r];
      if (n === 4) quad = r; else if (n === 3) trips.push(r); else if (n === 2) pairs.push(r);
    }

    if (quad) return score(7, [quad, topRanksFromMask(rankMask, 1, [quad])[0] || 0]);
    if (trips.length && (trips.length > 1 || pairs.length)) {
      const p = Math.max(trips[1] || 0, pairs[0] || 0);
      return score(6, [trips[0], p]);
    }
    if (flushScore) return flushScore;
    const st = straightHigh(rankMask);
    if (st) return score(4, [st]);
    if (trips.length) return score(3, [trips[0], ...topRanksFromMask(rankMask, 2, [trips[0]])]);
    if (pairs.length >= 2) {
      const k = topRanksFromMask(rankMask, 1, [pairs[0], pairs[1]]);
      return score(2, [pairs[0], pairs[1], k[0] || 0]);
    }
    if (pairs.length) return score(1, [pairs[0], ...topRanksFromMask(rankMask, 3, [pairs[0]])]);
    return score(0, topRanksFromMask(rankMask, 5));
  }

  function categoryOf(scoreVal) { return Math.floor(scoreVal / CAT_BASE); }
  function handName(scoreVal) { return CATEGORY_NAMES[categoryOf(scoreVal)]; }

  // ───────────────────────────── 3. Ranges ─────────────────────────────
  // Supports: AA, AKs, AKo, AK (= s+o), 22+, A2s+, KTo+, 22-66, A2s-A5s,
  //           T9s-65s (connector runs), explicit combos like AsKs.
  function comboKey(a, b) { return a < b ? a * 52 + b : b * 52 + a; }

  function combosForClass(r1, r2, type) { // type: 'p' | 's' | 'o' | 'any'
    const out = [];
    for (let s1 = 0; s1 < 4; s1++) for (let s2 = 0; s2 < 4; s2++) {
      const c1 = (r1 - 2) * 4 + s1, c2 = (r2 - 2) * 4 + s2;
      if (r1 === r2) { if (s1 < s2) out.push([c1, c2]); continue; }
      if (type === 's' && s1 !== s2) continue;
      if (type === 'o' && s1 === s2) continue;
      out.push([c1, c2]);
    }
    return out;
  }

  function parseClass(tok) { // "AKs" → {hi:14, lo:13, type:'s'}
    const m = /^([2-9TJQKA])([2-9TJQKA])([so]?)$/i.exec(tok);
    if (!m) return null;
    let a = rankFromChar(m[1]), b = rankFromChar(m[2]);
    if (b > a) [a, b] = [b, a];
    const type = a === b ? 'p' : (m[3] ? m[3].toLowerCase() : 'any');
    return { hi: a, lo: b, type };
  }

  /** Parse range text → array of [card, card] combos (deduplicated). */
  function parseRange(text) {
    const seen = new Set(), out = [];
    const add = (combos) => combos.forEach(([a, b]) => {
      const k = comboKey(a, b);
      if (!seen.has(k)) { seen.add(k); out.push(a < b ? [a, b] : [b, a]); }
    });
    String(text).split(/[,\s]+/).filter(Boolean).forEach(raw => {
      const tok = raw.trim();
      // explicit combo, e.g. AsKs
      if (/^[2-9TJQKA][cdhs][2-9TJQKA][cdhs]$/i.test(tok)) {
        const [a, b] = parseCards(tok); add([[a, b]]); return;
      }
      // dash run: 22-66, A2s-A5s, T9s-65s
      if (tok.includes('-')) {
        const [x, y] = tok.split('-').map(parseClass);
        if (!x || !y) throw new Error('Bad range token: ' + tok);
        if (x.type === 'p') {
          for (let r = Math.min(x.hi, y.hi); r <= Math.max(x.hi, y.hi); r++) add(combosForClass(r, r, 'p'));
        } else if (x.hi === y.hi) { // A2s-A5s: fixed top card, kicker varies
          for (let r = Math.min(x.lo, y.lo); r <= Math.max(x.lo, y.lo); r++) add(combosForClass(x.hi, r, x.type));
        } else { // T9s-65s: keep the gap, slide both cards
          const gap = x.hi - x.lo;
          for (let h = Math.min(x.hi, y.hi); h <= Math.max(x.hi, y.hi); h++) add(combosForClass(h, h - gap, x.type));
        }
        return;
      }
      // plus: 22+ (pairs up to AA), A2s+ (kicker up to just below top card)
      if (tok.endsWith('+')) {
        const c = parseClass(tok.slice(0, -1));
        if (!c) throw new Error('Bad range token: ' + tok);
        if (c.type === 'p') for (let r = c.hi; r <= 14; r++) add(combosForClass(r, r, 'p'));
        else for (let r = c.lo; r < c.hi; r++) add(combosForClass(c.hi, r, c.type));
        return;
      }
      const c = parseClass(tok);
      if (!c) throw new Error('Bad range token: ' + tok);
      add(combosForClass(c.hi, c.lo, c.type));
    });
    return out;
  }

  function rangePercent(combos) { return combos.length / 1326; }

  /** Is a specific 2-card hand inside a range (array of combos)? */
  function inRange(hand, combos) {
    const k = comboKey(hand[0], hand[1]);
    return combos.some(([a, b]) => comboKey(a, b) === k);
  }

  /** "AKs" / "QJo" / "77" style class name for a hand. */
  function handClass(hand) {
    let [a, b] = hand; if (rankOf(b) > rankOf(a)) [a, b] = [b, a];
    const ra = RANK_CHARS[rankOf(a) - 2], rb = RANK_CHARS[rankOf(b) - 2];
    if (ra === rb) return ra + rb;
    return ra + rb + (suitOf(a) === suitOf(b) ? 's' : 'o');
  }

  // Random source for simulations. Math.random by default; setSeed(n) makes results repeatable (tests).
  let rand = Math.random;
  function setSeed(seed) {
    if (seed == null) { rand = Math.random; return; }
    let a = seed >>> 0;
    rand = function () { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }

  // ───────────────────────────── 4. Equity ─────────────────────────────
  /**
   * Monte Carlo equity.
   * @param {object} o
   *   hero:       "AsKd" or [int,int]
   *   board:      "" | "Qs7d2c" | [...]  (0, 3, 4 or 5 cards)
   *   villains:   array, one entry per opponent: range text, combos array, or null (= any two cards)
   *   dead:       optional known-folded / exposed cards
   *   iterations: default 20000
   * @returns {{equity, win, tie, lose, iterations, handName}}
   */
  function equity(o) {
    const hero = parseCards(o.hero);
    const board = o.board ? parseCards(o.board) : [];
    const dead = o.dead ? parseCards(o.dead) : [];
    const iters = o.iterations || 20000;
    const villains = (o.villains && o.villains.length ? o.villains : [null]).map(v =>
      v == null ? null : (Array.isArray(v) ? v : parseRange(v)));

    const baseUsed = new Uint8Array(52);
    [...hero, ...board, ...dead].forEach(c => {
      if (baseUsed[c]) throw new Error('Duplicate card: ' + cardToString(c));
      baseUsed[c] = 1;
    });
    // Pre-filter villain ranges against known cards.
    const vRanges = villains.map(r => r && r.filter(([a, b, w]) => !baseUsed[a] && !baseUsed[b] && (w == null || w > 0)));
    vRanges.forEach((r, i) => { if (r && !r.length) throw new RangeError('Villain ' + (i + 1) + ' range is empty after removing known cards'); });
    // Weighted ranges ([c1, c2, w]): sample combos in proportion to their weight.
    const cum = vRanges.map(r => {
      if (!r || !r.some(c => c.length > 2 && c[2] !== 1)) return null;
      const out = new Float64Array(r.length); let t = 0;
      for (let i = 0; i < r.length; i++) { t += r[i].length > 2 ? r[i][2] : 1; out[i] = t; }
      return out;
    });
    const pick = (r, c) => {
      if (!c) return r[(rand() * r.length) | 0];
      const x = rand() * c[c.length - 1]; let lo = 0, hi = c.length - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (c[m] > x) hi = m; else lo = m + 1; }
      return r[lo];
    };

    const used = new Uint8Array(52);
    const need = 5 - board.length;
    const fullBoard = new Array(5), cards7 = new Array(7);
    let eqSum = 0, wins = 0, ties = 0, done = 0, skipped = 0;

    const drawRandom = () => { let c; do { c = (rand() * 52) | 0; } while (used[c]); used[c] = 1; return c; };

    for (let it = 0; it < iters; it++) {
      used.set(baseUsed);
      const vHands = [];
      let ok = true;
      for (let vi = 0; vi < vRanges.length; vi++) {
        const r = vRanges[vi];
        if (!r) { vHands.push([drawRandom(), drawRandom()]); continue; }
        let tries = 0, h = null;
        while (tries++ < 50) {
          const cand = pick(r, cum[vi]);
          if (!used[cand[0]] && !used[cand[1]]) { h = cand; break; }
        }
        if (!h) { ok = false; break; }
        used[h[0]] = 1; used[h[1]] = 1; vHands.push(h);
      }
      if (!ok) { skipped++; continue; }

      for (let i = 0; i < board.length; i++) fullBoard[i] = board[i];
      for (let i = 0; i < need; i++) fullBoard[board.length + i] = drawRandom();
      for (let i = 0; i < 5; i++) cards7[i] = fullBoard[i];

      cards7[5] = hero[0]; cards7[6] = hero[1];
      const heroScore = evaluate(cards7);
      let best = heroScore, nBest = 1, heroBest = true;
      for (const vh of vHands) {
        cards7[5] = vh[0]; cards7[6] = vh[1];
        const s = evaluate(cards7);
        if (s > best) { best = s; nBest = 1; heroBest = false; }
        else if (s === best) nBest++;
      }
      if (heroBest) {
        if (nBest === 1) { wins++; eqSum += 1; } else { ties++; eqSum += 1 / nBest; }
      }
      done++;
    }

    const res = {
      equity: done ? eqSum / done : 0,
      win: done ? wins / done : 0,
      tie: done ? ties / done : 0,
      lose: done ? (done - wins - ties) / done : 0,
      iterations: done,
      skipped,
    };
    if (board.length >= 3) res.handName = handName(evaluate([...hero, ...board]));
    // Most samples rejected: the ranges overlap so much (card removal) that the result is unreliable.
    if (skipped > iters * 0.5) res.warning = `${skipped} of ${iters} samples rejected (ranges share too many cards)`;
    return res;
  }

  // ───────────────────── Weighted ranges and board-relative strength ─────────────────────
  /**
   * How every possible holding ranks on this board right now: Map(a*52+b → percentile 0..1), the
   * share of other holdings it beats (ties count half). Board-relative, so on Q-Q-6-5-4 a hand like
   * 6x (which the evaluator calls "two pair") ranks in the middle, not with the strong hands.
   */
  const _hsCache = new Map();
  function strengthPercentiles(board) {
    const b = parseCards(board);
    const key = b.join(',');
    if (_hsCache.has(key)) return _hsCache.get(key);
    const used = new Set(b);
    const list = [];
    for (let x = 0; x < 52; x++) for (let y = x + 1; y < 52; y++) {
      if (used.has(x) || used.has(y)) continue;
      list.push([x * 52 + y, evaluate([x, y, ...b])]);
    }
    list.sort((p, q) => p[1] - q[1]);
    const out = new Map();
    let i = 0;
    while (i < list.length) {
      let j = i; while (j < list.length && list[j][1] === list[i][1]) j++;
      const pct = (i + (j - i) / 2) / list.length; // below + half the ties
      for (let k = i; k < j; k++) out.set(list[k][0], pct);
      i = j;
    }
    if (_hsCache.size > 64) _hsCache.clear();
    _hsCache.set(key, out);
    return out;
  }
  const smoothStep = (x, thr, width) => 1 / (1 + Math.exp(-(x - thr) / width));

  /**
   * Update a range after an action: every holding's weight is multiplied by how likely this player
   * is to take this action with it. P(action | hand) rises smoothly with the hand's board-relative
   * strength around a threshold; draws (before the river) and a share of weak hands (bluffs / floats)
   * keep some weight. opts (from the opponent's tracked tendencies):
   *   valueThr: strength within their own range above which they bet/raise for value (by street; higher for raises)
   *   callThr:  strength within their own range above which they call
   *   bluffKeep / floatKeep: weight kept by weak hands that bet / call anyway
   *   drawBet / drawCall: weight kept by draws that bet / call
   *   slowplay: share of strong hands that check
   * Returns [c1, c2, w] triples with known cards removed. Throws RangeError if nothing is left
   * (the caller must handle it visibly; it never silently becomes "any two cards").
   */
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  function weightRange(range, board, action, opts = {}) {
    const b = parseCards(board);
    const street = b.length === 3 ? 'flop' : b.length === 4 ? 'turn' : 'river';
    const used = new Set([...b, ...(opts.dead ? parseCards(opts.dead) : [])]);
    const hs = strengthPercentiles(b);
    const raise = /raise|allin/.test(action);
    // Bet sizing (opts.size = chips put in / pot before; relSize = size vs this player's usual size, 1 = their
    // normal). Bigger than usual → a higher value bar and fewer medium hands. Smaller → merged: medium
    // hands bet small too. Calling a bigger bet needs a stronger hand.
    // Low stack-to-pot (opts.spr < 1.5): committed, so value and calls widen.
    const sz = opts.size != null ? clamp(opts.size, 0.05, 3) : null;
    const rel = opts.relSize != null ? clamp(opts.relSize, 0.2, 4) : sz != null ? sz / 0.55 : 1;
    const sizeShift = sz == null ? 0 : clamp(0.10 * Math.log2(rel), -0.12, 0.15);
    const sprShift = opts.spr != null && opts.spr < 1.5 ? -0.06 * (1.5 - Math.max(0, opts.spr)) : 0;
    // Casual players under-bluff big bets (a big river bet from them is usually value), so bigger than
    // usual → slightly fewer bluffs, smaller → slightly more. Aggressive players' extra bluffs come in
    // through opts.bluffKeep (their tracked aggression), not through size.
    const bluffKeep = (opts.bluffKeep ?? 0.15) * (raise ? 0.5 : 1) * (sz == null ? 1 : clamp(1 - 0.2 * Math.log2(rel), 0.6, 1.25)), floatKeep = opts.floatKeep ?? 0.25;
    // relative to their own range: value-bet the top ~45% / 40% / 35% by street, call with the top ~65% / 60% / 55%
    const valueThr = (opts.valueThr ?? { flop: 0.55, turn: 0.60, river: 0.65 }[street]) + (raise ? 0.12 : 0) + (/bet|raise|allin/.test(action) ? sizeShift + sprShift : 0);
    const callThr = (opts.callThr ?? { flop: 0.35, turn: 0.40, river: 0.45 }[street]) + (action === 'call' ? sizeShift * 0.8 + sprShift : 0);

    const drawBet = opts.drawBet ?? 0.55, drawCall = opts.drawCall ?? 0.85, slowplay = opts.slowplay ?? 0.25;
    const W = 0.05; // how gradual the thresholds are (strength units)
    // Thresholds are measured within THIS player's current range (relative strength), not against
    // random hands: a player who called twice and then bets the river does it with the strong end
    // of what they called with.
    const live = [];
    for (const c of range) {
      const [x, y] = c, w0 = c.length > 2 ? c[2] : 1;
      if (used.has(x) || used.has(y) || !(w0 > 0)) continue;
      live.push({ c, w0, a: hs.get(comboKey(x, y)) });
    }
    live.sort((p, q) => p.a - q.a);
    const total = live.reduce((t, e) => t + e.w0, 0);
    let below = 0;
    for (let i = 0; i < live.length;) {  // equal strength → equal rank
      let j = i, ww = 0; while (j < live.length && live[j].a === live[i].a) ww += live[j++].w0;
      for (let k = i; k < j; k++) live[k].rel = (below + ww / 2) / total;
      below += ww; i = j;
    }
    const out = [];
    for (const { c, w0, rel: h } of live) {
      const [x, y] = c;
      const draw = street !== 'river' && handFeatures([x, y], b).draw;
      let p;
      if (/bet|raise|allin/.test(action)) {
        // bluffs come from hands with little showdown value (medium hands mostly check, or bet small);
        // small bets also carry a "merged" share of medium hands
        const air = 1 - smoothStep(h, 0.45, 0.06);
        const merge = sz == null ? 0 : clamp(0.15 + 0.3 * (1 - rel), 0, 0.4) * smoothStep(h, 0.3, W) * (1 - smoothStep(h, valueThr, W));
        p = Math.max(smoothStep(h, valueThr, W), draw ? drawBet * (raise ? 0.6 : 1) : 0, bluffKeep * (sz == null ? 1 : air), merge);
      }
      else if (action === 'call') p = Math.max(smoothStep(h, callThr, W), draw ? drawCall : 0, floatKeep);
      else if (action === 'check') p = 1 - (1 - slowplay) * Math.max(smoothStep(h, valueThr, W), draw ? drawBet * 0.5 : 0);
      else p = 1;
      const w = w0 * p;
      if (w > 1e-4) out.push([x, y, w]);
    }
    if (!out.length) throw new RangeError(`range is empty after "${action}" on ${b.map(cardToString).join('')}`);
    return out;
  }
  /**
   * Each villain holding's equity against a weighted range of ours (what they think we hold), over the
   * cards still to come — not just the current board. Exact card removal: runout cards, our perceived
   * holdings and their holding never share a card (blockers). Ties count half.
   *   river: the board as it is; turn: every river card (exact); flop: `samples` seeded turn+river
   *   runouts (or all 1,081 with exact: true).
   * villain / ours: arrays of [c1, c2] or [c1, c2, w]. Returns Float64Array of equities (index = villain).
   * Fast: per runout, our holdings are sorted once by score with cumulative weights; each villain holding
   * is a binary search plus a correction for the few of our holdings that share its cards.
   */
  function rangeEquityVs(villain, ours, board, { samples = 48, exact = false } = {}) {
    const b = parseCards(board);
    const used = new Set(b);
    const need = 5 - b.length;
    const deck = []; for (let c = 0; c < 52; c++) if (!used.has(c)) deck.push(c);
    let runouts;
    if (need === 0) runouts = [[]];
    else if (need === 1) runouts = deck.map(c => [c]);
    else if (exact) { runouts = []; for (let i = 0; i < deck.length; i++) for (let j = i + 1; j < deck.length; j++) runouts.push([deck[i], deck[j]]); }
    else {
      runouts = [];
      for (let k = 0; k < samples; k++) {
        const i = (rand() * deck.length) | 0; let j = (rand() * (deck.length - 1)) | 0; if (j >= i) j++;
        runouts.push(need === 2 ? [deck[i], deck[j]] : deck.slice(0, need));
      }
    }
    const O = ours.filter(c => !used.has(c[0]) && !used.has(c[1]) && (c.length < 3 || c[2] > 0));
    const ow = O.map(c => (c.length > 2 ? c[2] : 1));
    const eqSum = new Float64Array(villain.length), cnt = new Float64Array(villain.length);
    const byCard = Array.from({ length: 52 }, () => []);
    O.forEach((c, i) => { byCard[c[0]].push(i); byCard[c[1]].push(i); });
    for (const R of runouts) {
      const full = [...b, ...R];
      const rset = new Set(R);
      const sc = new Float64Array(O.length);
      const idx = [];
      for (let i = 0; i < O.length; i++) {
        if (rset.has(O[i][0]) || rset.has(O[i][1])) { sc[i] = -1; continue; }
        sc[i] = evaluate([O[i][0], O[i][1], ...full]); idx.push(i);
      }
      idx.sort((p, q) => sc[p] - sc[q]);
      const sorted = idx.map(i => sc[i]);
      const cum = new Float64Array(idx.length + 1);
      for (let k = 0; k < idx.length; k++) cum[k + 1] = cum[k] + ow[idx[k]];
      const total = cum[idx.length];
      const lowerBound = x => { let lo = 0, hi = sorted.length; while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < x) lo = m + 1; else hi = m; } return lo; };
      const upperBound = x => { let lo = 0, hi = sorted.length; while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] <= x) lo = m + 1; else hi = m; } return lo; };
      for (let v = 0; v < villain.length; v++) {
        const [x, y] = villain[v];
        if (used.has(x) || used.has(y) || rset.has(x) || rset.has(y)) continue;
        const s = evaluate([x, y, ...full]);
        const lo = lowerBound(s), hi = upperBound(s);
        let below = cum[lo], ties = cum[hi] - cum[lo], tot = total;
        // our holdings that share a card with theirs can't exist alongside it
        const seen = new Set();
        for (const i of [...byCard[x], ...byCard[y]]) {
          if (seen.has(i) || sc[i] < 0) continue; seen.add(i);
          tot -= ow[i];
          if (sc[i] < s) below -= ow[i]; else if (sc[i] === s) ties -= ow[i];
        }
        if (tot <= 1e-12) continue;
        eqSum[v] += (below + ties / 2) / tot; cnt[v]++;
      }
    }
    for (let v = 0; v < villain.length; v++) eqSum[v] = cnt[v] ? eqSum[v] / cnt[v] : 0.5;
    return eqSum;
  }

  /** Effective number of combos in a (weighted) range. */
  /**
   * A soft preflop range: every hand gets a weight that falls smoothly from 1 around the top `pct` of
   * hands (by the same ranking topRange uses), never below `floor` — real players sometimes play
   * hands well outside their usual range, and a hard cut makes those hands impossible forever.
   * minus: also take out the top `minus` share softly (e.g. hands that would have raised instead).
   */
  const _softCache = new Map();
  function softRange(pct, { edge = 0.06, floor = 0.03, minus = 0 } = {}) {
    const key = [pct, edge, floor, minus].map(x => x.toFixed(3)).join('|');
    if (_softCache.has(key)) return _softCache.get(key);
    const out = [];
    let cum = 0;
    for (const cls of HAND_RANKING) {
      const combos = parseRange(cls);
      const p = (cum + combos.length / 2) / 1326;  // this class's percentile
      cum += combos.length;
      let w = floor + (1 - floor) / (1 + Math.exp((p - pct) / edge));
      if (minus > 0) w *= 1 - (1 - floor) / (1 + Math.exp((p - minus) / (edge / 2)));
      for (const [a, b] of combos) out.push([a, b, w]);
    }
    if (_softCache.size > 200) _softCache.clear();
    _softCache.set(key, out);
    return out;
  }
  const rangeSize = r => (r ? r.reduce((t, c) => t + (c.length > 2 ? c[2] : 1), 0) : 1326);

  // ────────────────────────────── 5. Odds ──────────────────────────────
  /**
   * pot = total in the middle INCLUDING villain's current bet; toCall = what you must add.
   * requiredEquity = toCall / (pot + toCall)
   */
  function potOdds(pot, toCall) {
    if (toCall <= 0) return { requiredEquity: 0, ratio: 'free', toCall: 0, pot };
    const req = toCall / (pot + toCall);
    return { requiredEquity: req, ratio: (pot / toCall).toFixed(1) + ':1', toCall, pot };
  }

  /** Immediate EV of calling (ignores future streets / implied odds). */
  function callEV(eq, pot, toCall) { return eq * (pot + toCall) - toCall; }

  /** Minimum defence frequency vs a bet: how often you must continue so bluffs don't auto-profit. */
  function mdf(bet, potBeforeBet) { return potBeforeBet / (potBeforeBet + bet); }

  /** How often a pure bluff of `bet` into `potBeforeBet` must work to break even. */
  function bluffBreakeven(bet, potBeforeBet) { return bet / (potBeforeBet + bet); }

  /** Stack-to-pot ratio. */
  function spr(effectiveStack, pot) { return pot > 0 ? effectiveStack / pot : Infinity; }

  /** Rule of 2 & 4: approx equity from clean outs. */
  function outsToEquity(outs, cardsToCome) { return Math.min(1, outs * (cardsToCome === 2 ? 0.04 : 0.02)); }

  // ───────────────────────────── 6. Preflop ────────────────────────────
  // STARTER APPROXIMATIONS of 6-max open-raise (RFI) ranges.
  // Not solver output — replace with proper solver charts in Phase 4.
  // For 9-handed tables, map: UTG/UTG+1 → tighter than LJ (use EP), MP → LJ.
  const RFI_RANGES = {
    EP: '66+,A9s+,KTs+,QTs+,JTs,T9s,ATo+,KJo+',                       // 9-max early position (~11%)
    LJ: '22+,A2s+,K9s+,Q9s+,J9s+,T9s,98s,87s,76s,65s,ATo+,KJo+,QJo',  // ~18%
    HJ: '22+,A2s+,K8s+,Q9s+,J9s+,T8s+,97s+,86s+,76s,65s,54s,A9o+,KTo+,QTo+,JTo',
    CO: '22+,A2s+,K5s+,Q7s+,J7s+,T7s+,96s+,85s+,75s+,64s+,54s,A7o+,K9o+,Q9o+,J9o+,T9o',
    BTN: '22+,A2s+,K2s+,Q4s+,J6s+,T6s+,95s+,85s+,74s+,63s+,53s+,43s,A2o+,K8o+,Q9o+,J8o+,T8o+,98o,87o',
    SB: '22+,A2s+,K4s+,Q6s+,J7s+,T7s+,96s+,86s+,75s+,65s,54s,A4o+,K9o+,Q9o+,J9o+,T9o',
  };
  const _rfiCache = {};
  function rfiRange(position) {
    const p = String(position).toUpperCase();
    if (!RFI_RANGES[p]) throw new Error('Unknown position: ' + position + ' (use ' + Object.keys(RFI_RANGES).join(', ') + ')');
    return _rfiCache[p] || (_rfiCache[p] = parseRange(RFI_RANGES[p]));
  }

  /** Map seat distance from the button to a position label. seatsFromButton: 0 = BTN, 1 = SB, 2 = BB, ... */
  function positionFromSeat(seatsFromButton, playersAtTable) {
    const n = playersAtTable;
    if (n === 2) return seatsFromButton === 0 ? 'BTN' : 'BB'; // heads-up: button posts the small blind
    if (seatsFromButton === 0) return 'BTN';
    if (seatsFromButton === 1) return 'SB';
    if (seatsFromButton === 2) return 'BB';
    const fromCutoff = n - seatsFromButton; // 1 = CO, 2 = HJ, 3 = LJ, 4+ = EP
    return ['CO', 'HJ', 'LJ'][fromCutoff - 1] || 'EP';
  }

  // All 169 starting hands, strongest first (equity vs 1 and 3 random hands, blended for
  // casual multiway tables). Used to turn "plays 45% of hands" into an actual range.
  const HAND_RANKING = 'AA,KK,QQ,JJ,TT,99,AKs,88,AQs,AKo,AJs,KQs,ATs,AQo,77,KJs,AJo,KTs,KQo,ATo,QJs,A9s,A8s,QTs,KJo,A7s,66,JTs,K9s,A9o,KTo,A4s,A6s,QJo,Q9s,K8s,A5s,A8o,55,QTo,J9s,A3s,A7o,K7s,A2s,T9s,K6s,K9o,Q8s,JTo,A5o,A6o,K5s,Q9o,J8s,K8o,A4o,K4s,A3o,Q7s,T8s,44,J9o,K7o,K3s,Q6s,K2s,J7s,T9o,98s,A2o,Q5s,Q8o,K6o,J8o,T7s,97s,Q4s,33,K5o,Q3s,Q7o,T8o,T6s,J5s,J6s,K4o,87s,Q2s,Q6o,J7o,K3o,98o,76s,Q5o,96s,J4s,J3s,86s,T7o,K2o,22,T5s,Q4o,J2s,97o,Q3o,87o,95s,J6o,85s,T4s,T6o,65s,75s,J5o,T3s,Q2o,T2s,96o,J4o,54s,64s,94s,76o,93s,86o,92s,84s,J3o,74s,T5o,T4o,53s,J2o,95o,63s,75o,82s,73s,85o,83s,65o,T3o,52s,43s,T2o,54o,62s,74o,64o,94o,42s,93o,72s,84o,92o,32s,53o,73o,83o,63o,43o,82o,52o,42o,72o,62o,32o'.split(',');
  const _topCache = {};
  /** The strongest `pct` (0–1) of all starting hands, as combos. */
  function topRange(pct) {
    const p = Math.max(0.005, Math.min(1, pct));
    const key = p.toFixed(3);
    if (_topCache[key]) return _topCache[key];
    const out = [];
    for (const cls of HAND_RANKING) {
      if (out.length / 1326 >= p) break;
      out.push(...parseRange(cls));
    }
    return (_topCache[key] = out);
  }

  // ─────────────────────── 6b. Postflop range narrowing ───────────────────────
  let _all = null;
  /** Every possible 2-card hand (1326 combos). */
  function allCombos() {
    if (_all) return _all;
    _all = [];
    for (let a = 0; a < 52; a++) for (let b = a + 1; b < 52; b++) _all.push([a, b]);
    return _all;
  }

  function straightOuts(mask) {
    const have = straightHigh(mask);
    let n = 0;
    for (let r = 2; r <= 14; r++) if (!(mask & (1 << r)) && straightHigh(mask | (1 << r)) > have) n++;
    return n;
  }

  /**
   * What a hand has on this board: does it improve on the board itself (pair or better using
   * a hole card), and does it hold a flush draw or straight draw (flop/turn only)?
   */
  function handFeatures(hand, board) {
    const cards = [...hand, ...board];
    const catFull = categoryOf(evaluate(cards));
    const catBoard = board.length ? categoryOf(evaluate(board)) : 0;
    const improved = catFull > catBoard;
    // Top pair or better: two pair+ using a hole card, an overpair, or pairing the board's top card.
    const maxBoard = board.length ? Math.max(...board.map(rankOf)) : 0;
    const hr = hand.map(rankOf), boardRanks = new Set(board.map(rankOf));
    let pairRank = 0;
    if (hr[0] === hr[1]) pairRank = hr[0];
    else for (const r of hr) if (boardRanks.has(r)) pairRank = Math.max(pairRank, r);
    const topPairPlus = improved && (catFull >= 2 || pairRank >= maxBoard);
    let flushDraw = false, straightDraw = false;
    if (board.length && board.length < 5) {
      const sc = [0, 0, 0, 0];
      cards.forEach(c => sc[suitOf(c)]++);
      flushDraw = hand.some(c => sc[suitOf(c)] === 4);
      const mask = cs => cs.reduce((m, c) => m | (1 << rankOf(c)), 0);
      straightDraw = catFull < 4 && straightOuts(mask(cards)) >= 2 && straightOuts(mask(cards)) > straightOuts(mask(board));
    }
    return { improved, topPairPlus, made: catFull, flushDraw, straightDraw, draw: flushDraw || straightDraw };
  }

  /**
   * Narrow a range after a postflop action on a given board. Starter heuristics, tune with data:
   *  flop bet/raise:        any pair-or-better using a hole card, or a draw  (+ bluffKeep share of the rest)
   *  turn/river bet/raise:  top pair or better, or a draw on the turn        (+ bluffKeep share of the rest)
   *  any call:              any pair-or-better using a hole card, or a draw  (+ floatKeep share of the rest)
   * Deterministic (keeps every Nth weak combo) so results are stable between refreshes.
   */
  function narrowRange(combos, board, action, opts = {}) {
    const bluffKeep = opts.bluffKeep ?? 0.2, floatKeep = opts.floatKeep ?? 0.33;
    const b = parseCards(board);
    const used = new Set(b);
    const aggressive = /bet|raise|allin/.test(action);
    // a raise is a stronger range than a bet: fewer bluffs survive it
    const keepShare = aggressive ? (/raise|allin/.test(action) ? bluffKeep * 0.4 : bluffKeep) : action === 'call' ? floatKeep : 1;
    if (keepShare >= 1) return combos;
    const every = Math.max(1, Math.round(1 / keepShare));
    const lateStreet = b.length >= 4;
    let weakSeen = 0;
    const out = combos.filter(([x, y]) => {
      if (used.has(x) || used.has(y)) return false;
      const f = handFeatures([x, y], b);
      const strong = aggressive && lateStreet ? (f.topPairPlus || (b.length < 5 && f.draw)) : (f.improved || f.draw);
      if (strong) return true;
      return (weakSeen++ % every) === 0;
    });
    return out.length ? out : combos;
  }

  // ───────────────────────────── 7. Advice ─────────────────────────────
  /**
   * Turn numbers into a simple recommendation. Deliberately transparent so you
   * can see WHY — this is the coaching layer, not a black box.
   * Thresholds are starting points to tune with your own hand data.
   */
  function advise({ equity: eq, pot, toCall, raiseThreshold = 0.65, marginalBand = 0.03 }) {
    const odds = potOdds(pot, toCall);
    const ev = callEV(eq, pot, toCall);
    const margin = eq - odds.requiredEquity;
    let action, reason;
    if (toCall <= 0) {
      action = eq >= raiseThreshold ? 'BET' : 'CHECK';
      reason = eq >= raiseThreshold ? 'Strong equity — bet for value' : 'No price to pay — check unless you have a plan to bluff';
    } else if (eq >= raiseThreshold) {
      action = 'RAISE'; reason = 'Well ahead of their range — raise for value';
    } else if (margin > marginalBand) {
      action = 'CALL'; reason = 'Equity beats the price you\'re getting';
    } else if (margin >= -marginalBand) {
      action = 'MARGINAL'; reason = 'Close to break-even — implied odds and reads decide it';
    } else {
      action = 'FOLD'; reason = 'Not enough equity for the price';
    }
    return { action, reason, equity: eq, requiredEquity: odds.requiredEquity, ratio: odds.ratio, ev, margin };
  }

  return {
    // cards
    parseCard, parseCards, cardToString, rankOf, suitOf,
    // evaluator
    evaluate, handName, categoryOf, CATEGORY_NAMES,
    // ranges
    parseRange, rangePercent, inRange, handClass,
    // equity
    equity, setSeed, random: () => rand(), strengthPercentiles, weightRange, rangeSize, softRange, rangeEquityVs,
    // odds
    potOdds, callEV, mdf, bluffBreakeven, spr, outsToEquity,
    // preflop
    RFI_RANGES, rfiRange, positionFromSeat,
    // postflop narrowing
    HAND_RANKING, topRange, allCombos, handFeatures, narrowRange,
    // advice
    advise,
  };
});
