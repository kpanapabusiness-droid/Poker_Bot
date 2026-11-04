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
    const vRanges = villains.map(r => r && r.filter(([a, b]) => !baseUsed[a] && !baseUsed[b]));
    vRanges.forEach((r, i) => { if (r && !r.length) throw new Error('Villain ' + (i + 1) + ' range is empty after removing known cards'); });

    const used = new Uint8Array(52);
    const need = 5 - board.length;
    const fullBoard = new Array(5), cards7 = new Array(7);
    let eqSum = 0, wins = 0, ties = 0, done = 0, skipped = 0;

    const drawRandom = () => { let c; do { c = (Math.random() * 52) | 0; } while (used[c]); used[c] = 1; return c; };

    for (let it = 0; it < iters; it++) {
      used.set(baseUsed);
      const vHands = [];
      let ok = true;
      for (const r of vRanges) {
        if (!r) { vHands.push([drawRandom(), drawRandom()]); continue; }
        let tries = 0, h = null;
        while (tries++ < 50) {
          const cand = r[(Math.random() * r.length) | 0];
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
    return res;
  }

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
    const keepShare = aggressive ? bluffKeep : action === 'call' ? floatKeep : 1;
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
    equity,
    // odds
    potOdds, callEV, mdf, bluffBreakeven, spr, outsToEquity,
    // preflop
    RFI_RANGES, rfiRange, positionFromSeat,
    // postflop narrowing
    allCombos, handFeatures, narrowRange,
    // advice
    advise,
  };
});
