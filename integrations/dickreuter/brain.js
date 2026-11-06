/*
 * brain.js — lets dickreuter/poker (the DeeperMind bot) use this project's decision layer.
 *
 * dickreuter's own decisions are equity thresholds from a hand-tuned strategy sheet: it never
 * models opponents, never compares bet sizes by EV, and only sees its own equity vs random-ish hands.
 * This module takes what dickreuter's screen scraper reads, turns it into the context strategy.js
 * expects (ranges per opponent, synthesised action history, positions) and returns a decision.
 *
 * Two ways to use it:
 *   require('./brain.js').decideFromTable(table)        // in Node, for tests and benchmarks
 *   node brain.js --serve                                // JSON lines on stdin → JSON lines on stdout
 *                                                        // (what coach_decision.py talks to)
 *
 * Input ("table", built by coach_decision.py from dickreuter's TableScreenBased object):
 *   { heroCards: ['AS','KD'], board: ['QH','7D','2C'], pot, toCall, heroStack, heroBet, bb,
 *     nSeats, dealer,                     // dealer: seats to hero's left (0 = hero has the button)
 *     players: [{ seat, stack, bet, inHand, away? }],   // seat: 1..nSeats-1 = seats to hero's left;
 *                                         // away: sitting out / waiting for the big blind (not dealt in)
 *     history: [{ street, bets: { seat: amount } }],  // last seen bets on earlier streets, this hand
 *     stats?: { [seat]: { vpip, pfr, threeBet, af, f2b } } }   // optional overrides for the priors
 *
 * dickreuter doesn't read an action log, so the action history is rebuilt from the chips in front
 * of each player, in table order. It sees the size of every bet and raise but can miss a fold or a
 * bet that happened after hero last acted on an earlier street.
 */
(function () {
  'use strict';
  const path = require('path');
  const root = path.join(__dirname, '..', '..');
  const E = require(path.join(root, 'poker-engine.js'));
  const S = require(path.join(root, 'strategy.js'));
  const T = require(path.join(root, 'tracker.js'));
  const SOLVER = require(path.join(root, 'solver.js'));

  // POKER_COACH_MODEL='{"exploit":{"elastic":true}}' overrides strategy settings (for simulator tests).
  if (process.env.POKER_COACH_MODEL) {
    const merge = (dst, src) => { for (const [k, v] of Object.entries(src)) { if (v && typeof v === 'object' && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object') merge(dst[k], v); else dst[k] = v; } };
    merge(S.MODEL, JSON.parse(process.env.POKER_COACH_MODEL));
  }
  const PRIOR = T.create({}).estimate('__nobody__'); // the "average casual player" the tracker starts everyone at
  const STREETS = ['preflop', 'flop', 'turn', 'river'];
  const streetOf = board => (board.length === 0 ? 'preflop' : board.length === 3 ? 'flop' : board.length === 4 ? 'turn' : 'river');
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  /** A player's name: what the screen reader saw (cleaned), else a seat label. */
  const cleanName = n => String(n || '').replace(/[^A-Za-z0-9_.\-]/g, '').slice(0, 24);
  function nameOf(t, seat) {
    if (seat === 0) return 'Hero';
    const p = (t.players || []).find(x => x.seat === seat);
    const n = p && cleanName(p.name);
    return n && n.length >= 2 ? n : 'Seat' + seat;
  }

  // ── Ranges (same model as the Torn overlay) ──
  const POS_WIDTH = { EP: 0.55, LJ: 0.7, HJ: 0.85, CO: 1.05, BTN: 1.4, SB: 1.15, BB: 0.8 };
  const without = (combos, remove) => { const k = new Set(remove.map(([a, b]) => a * 52 + b)); return combos.filter(([a, b]) => !k.has(a * 52 + b)); };

  function villainRange(action, position, est) {
    const pfrW = clamp(est.pfr * (POS_WIDTH[position] || 1), 0.03, 0.8);
    const SP = S.MODEL.preflopSoft;
    if (SP && SP.on) {
      const o = { edge: SP.edge, floor: SP.floor };
      switch (action) {
        case 'raise': return { combos: E.softRange(pfrW, o), label: `opened ${position} · top ${Math.round(pfrW * 100)}%` };
        case '3bet+': { const w = clamp(est.threeBet * 1.3, 0.02, 0.35); return { combos: E.softRange(w, o), label: `3-bet+ · top ${Math.round(w * 100)}%` }; }
        case 'call': { const w = clamp(est.vpip, 0.08, 0.85); return { combos: E.softRange(w, { ...o, minus: clamp(est.threeBet * 0.6, 0.01, 0.2) }), label: `called a raise · ${Math.round(w * 100)}%` }; }
        case 'limp': { const w = clamp(est.vpip, 0.1, 0.9); return { combos: E.softRange(w, { ...o, minus: clamp(est.pfr * 0.6, 0.01, 0.25) }), label: `limped · ${Math.round(w * 100)}%` }; }
        default: return { combos: null, label: 'any two' };
      }
    }
    switch (action) {
      case 'raise': return { combos: E.topRange(pfrW), label: `opened ${position} · top ${Math.round(pfrW * 100)}%` };
      case '3bet+': { const w = clamp(est.threeBet * 1.3, 0.02, 0.35); return { combos: E.topRange(w), label: `3-bet+ · top ${Math.round(w * 100)}%` }; }
      case 'call': { const w = clamp(est.vpip, 0.08, 0.85); return { combos: without(E.topRange(w), E.topRange(clamp(est.threeBet * 0.6, 0.01, 0.2))), label: `called a raise · ${Math.round(w * 100)}%` }; }
      case 'limp': { const w = clamp(est.vpip, 0.1, 0.9); return { combos: without(E.topRange(w), E.topRange(clamp(est.pfr * 0.6, 0.01, 0.25))), label: `limped · ${Math.round(w * 100)}%` }; }
      default: return { combos: null, label: 'any two' };
    }
  }

  /**
   * Condition a villain's range on each of their postflop actions (weighted: every holding's weight
   * × how likely this player is to act this way with it). Their tracked tendencies move the
   * thresholds: aggressive players bet a wider range, players who rarely fold call wider, and both
   * bluff/float more or less. Steps are recorded in `history` for diagnostics; an action that would
   * leave nothing is skipped with a warning, never replaced by random hands.
   */
  function applyPostflop(villain, actions, board, est) {
    const af = est.af != null ? est.af : 1, f2b = est.f2b != null ? est.f2b : 0.4;
    const RM = S.MODEL.rangeModel;
    const opts = {
      bluffKeep: clamp(RM.bluffBase + RM.bluffPerAf * af, RM.bluffBase, RM.bluffMax), floatKeep: clamp(0.75 - f2b, 0.1, 0.6) * RM.floatScale,
      valueShift: clamp(-0.05 * (af - 1), -0.12, 0.08), callShift: clamp((f2b - 0.40) * 0.6, -0.15, 0.15), slowplay: RM.slowplay,
    };
    const LEN = { flop: 3, turn: 4, river: 5 };
    const base = RM.base;
    let street = 'preflop', combos = villain.combos || E.allCombos(), narrowed = false;
    const history = [{ step: 'preflop', label: villain.label, combos: E.rangeSize(villain.combos) }];
    const warnings = [];
    // pot as the hand goes, for bet sizes (chips added / pot before) and stack-to-pot
    let pot = 0;
    const usual = est.betSize != null ? est.betSize : null;  // this player's typical bet size, if tracked
    for (const a of actions) {
      if (a.type === 'street') { street = a.street; continue; }
      const potBefore = pot;
      if (a.amount > 0) pot += a.amount;
      if (street === 'preflop' || a.actor !== villain.name || !['bet', 'raise', 'allin', 'call', 'check'].includes(a.type)) continue;
      const b = board.slice(0, LEN[street]);
      if (b.length < LEN[street]) continue;
      const [v0, c0] = base[street];
      const kind = a.type === 'allin' ? (a.over ? 'raise' : 'bet') : a.type;  // an all-in into an unbet pot is a bet
      const size = a.amount > 0 && potBefore > 0 ? a.amount / potBefore : null;
      const spr = villain.stack != null && pot > 0 ? villain.stack / pot : null;
      const sizing = size == null ? {} : { size, spr, ...(usual != null && kind !== 'call' ? { relSize: size / usual } : {}) };
      try {
        combos = E.weightRange(combos, b, kind, { ...opts, ...sizing, valueThr: v0 + opts.valueShift, callThr: c0 + opts.callShift });
        narrowed = true;
        history.push({ step: `${street} ${kind}`, combos: Math.round(E.rangeSize(combos)),
          ...(size != null ? { size: +size.toFixed(2), sizingRead: usual != null ? `vs their usual ${usual.toFixed(2)}` : 'population (no sizing read yet)' } : {}) });
      } catch (e) {
        warnings.push(`${villain.name}: no holding fits "${a.type}" on the ${street} — kept the range from before it`);
      }
    }
    const out = narrowed ? { ...villain, combos } : { ...villain };
    out.rangeHistory = history;
    if (warnings.length) out.warnings = warnings;
    return out;
  }

  // ── Positions and action order ──
  /**
   * Seats with someone sitting in them, clockwise from hero. Empty seats are skipped for positions,
   * blinds and acting order (a 9-seat table with 5 players plays like 5-handed). A seat counts as
   * taken if it has a stack, chips in front, or cards; hero and the dealer always count.
   */
  function ring(t) {
    if (t._ring) return t._ring;
    const taken = new Set([0, t.dealer]);
    // Sitting out / waiting for the big blind (p.away, from the screen reader) isn't dealt in, even with chips.
    for (const p of t.players || []) if (((p.stack || 0) > 0 && !p.away) || (p.bet || 0) > 0 || p.inHand) taken.add(p.seat);
    for (const h of t.history || []) {
      for (const [seat, b] of Object.entries(h.bets || {})) if (b > 0) taken.add(Number(seat));
      for (const seat of h.live || []) taken.add(Number(seat));
    }
    const r = [...taken].filter(x => x >= 0 && x < t.nSeats).sort((a, b) => a - b);
    Object.defineProperty(t, '_ring', { value: r, enumerable: false });
    return r;
  }
  const tableSize = t => ring(t).length;
  const seatsFromButton = (seat, t) => {
    const r = ring(t), n = r.length;
    const i = r.indexOf(seat), d = r.indexOf(t.dealer);
    if (i < 0) return (seat - t.dealer + t.nSeats) % t.nSeats; // not seated (shouldn't happen)
    return (i - d + n) % n;
  };
  function positionOf(seat, t) { return E.positionFromSeat(seatsFromButton(seat, t), tableSize(t)); }
  /** Order players act in: preflop starts left of the big blind, postflop left of the button. */
  function actingOrder(seats, t, street) {
    const n = tableSize(t);
    const first = street === 'preflop' ? (n === 2 ? 0 : 3) : 1;
    return [...seats].sort((a, b) => ((seatsFromButton(a, t) - first + n * 2) % n) - ((seatsFromButton(b, t) - first + n * 2) % n));
  }

  /**
   * Rebuild the action list (strategy.js / tracker format) from what we saw at each of our turns.
   * t.history: earlier snapshots this hand, oldest first: { street, bets: {seat: chips}, heroBet,
   * live: [seats], hero: {action, amount} } (hero = what we did at that snapshot). The current
   * table is the last snapshot. Between two snapshots: first our own action, then whatever chips
   * other players added (replayed smallest first, since raises only go up; at equal size the
   * first in table order bet and the rest called).
   */
  function synthActions(t, finalHero) {
    const name = seat => nameOf(t, seat);
    const street = streetOf(t.board);
    const current = { street, bets: {}, heroBet: t.heroBet || 0, live: t.players.filter(p => p.inHand).map(p => p.seat) };
    for (const p of t.players) current.bets[p.seat] = p.bet || 0;
    const snaps = [...(t.history || []), current];
    const stackOf = seat => (seat === 0 ? t.heroStack : (t.players.find(p => p.seat === seat) || {}).stack);
    const allSeats = ring(t); // hero and everyone sitting at the table
    const sb = tableSize(t) === 2 ? 0 : 1, bbSeat = tableSize(t) === 2 ? 1 : 2;
    const k = seat => seatsFromButton(seat, t);
    const actions = [];
    let cur = null, level = 0, put = {};
    const startStreet = st => {
      cur = st; put = {}; level = 0;
      if (st === 'preflop') {
        for (const seat of allSeats) {
          if (k(seat) === sb) { actions.push({ type: 'post', actor: name(seat), blind: 'SB', amount: t.bb / 2 }); put[seat] = t.bb / 2; }
          if (k(seat) === bbSeat) { actions.push({ type: 'post', actor: name(seat), blind: 'BB', amount: t.bb }); put[seat] = t.bb; }
        }
        level = t.bb;
      } else actions.push({ type: 'street', street: st });
    };
    const chips = (seat, to, allin) => {
      const had = put[seat] || 0;
      if (to <= had + 1e-9) return;
      // over: did this raise someone? (an all-in into an unbet pot is a bet, not a raise)
      if (to > level + 1e-9) { actions.push({ type: allin ? 'allin' : (level > 0 || cur === 'preflop') ? 'raise' : 'bet', actor: name(seat), amount: to - had, to, over: level > 0 && !(cur === 'preflop' && level <= t.bb) }); level = to; }
      else actions.push({ type: 'call', actor: name(seat), amount: to - had });
      put[seat] = to;
    };
    const heroAct = h => {
      if (!h) return;
      const a = h.action;
      if (a === 'FOLD') actions.push({ type: 'fold', actor: 'Hero' });
      else if (a === 'CHECK') actions.push({ type: 'check', actor: 'Hero' });
      else if (a === 'CALL' || (a === 'ALL-IN' && (h.amount || 0) <= level + 1e-9)) chips(0, level, a === 'ALL-IN');
      else if (a === 'BET' || a === 'RAISE' || a === 'ALL-IN') chips(0, Math.max(h.amount || 0, level), a === 'ALL-IN');
    };
    const order0 = () => actingOrder(allSeats.filter(x => x !== 0), t, cur);
    // Checks aren't visible as chips: a live player who put nothing in on a street that ended unbet checked.
    const checksFor = (liveSeats, st) => {
      if (st === 'preflop') return;
      for (const seat of actingOrder(allSeats.filter(x => x !== 0), t, st))
        if (liveSeats.includes(seat) && !(put[seat] > 0)) actions.push({ type: 'check', actor: name(seat), inferred: true });
    };
    let prevHero = null;
    for (let i = 0; i < snaps.length; i++) {
      const s = snaps[i];
      if (s.street !== cur) {
        const liveNext = (s.live || []).map(Number);
        if (cur !== null) {
          heroAct(prevHero); // our last action on the street before
          // anyone still in on the new street must have matched the last bet of the old one
          for (const seat of order0(s)) if (liveNext.includes(seat) && (put[seat] || 0) < level - 1e-9) chips(seat, level, false);
          if (level === 0) checksFor(liveNext, cur);  // the street went by unbet: everyone still in checked
        }
        else if (s.street !== 'preflop') startStreet('preflop');
        // streets we never saw (everyone checked): mark them, with the checks
        for (let j = STREETS.indexOf(cur) + 1; j < STREETS.indexOf(s.street); j++) { startStreet(STREETS[j]); checksFor(liveNext, STREETS[j]); }
        startStreet(s.street);
        prevHero = null;
      } else heroAct(prevHero);
      // our chips should match what we did; if we have no record of it, infer it from the chips
      if ((s.heroBet || 0) > (put[0] || 0) + 1e-9) chips(0, s.heroBet, false);
      const order = actingOrder(allSeats.filter(x => x !== 0), t, s.street);
      const seq = order.map((seat, idx) => ({ seat, idx, b: Number((s.bets || {})[seat]) || 0 })).sort((x, y) => x.b - y.b || x.idx - y.idx);
      for (const { seat, b } of seq) chips(seat, b, s === current && stackOf(seat) === 0);
      // on the street we're deciding on: players who act before us and have nothing in, while nobody has bet, checked
      if (s === current && s.street !== 'preflop' && level === 0) {
        const ord = actingOrder(allSeats, t, s.street), me = ord.indexOf(0);
        for (const seat of ord.slice(0, me)) if ((s.live || []).map(Number).includes(seat) && !actions.some(a => a.type === 'check' && a.actor === name(seat) && a.inferred && a._st === s.street))
          actions.push({ type: 'check', actor: name(seat), inferred: true, _st: s.street });
      }
      prevHero = s.hero || null;
    }
    if (finalHero) heroAct(finalHero);
    return actions;
  }

  function preflopRole(actions) {
    const out = {}; let raises = 0;
    for (const a of actions) {
      if (a.type === 'street') break;
      if (a.type === 'raise' || a.type === 'bet' || a.type === 'allin') { raises++; out[a.actor] = raises === 1 ? 'raise' : '3bet+'; }
      else if (a.type === 'call' && !out[a.actor]) out[a.actor] = raises ? 'call' : 'limp';
    }
    return out;
  }

  /** Main entry: dickreuter table → strategy.js decision (plus the context, for debugging).
   *  `estimateFor(name)` gives a player's stats (the tracker's, when one is running). */
  // Simulator only: POKER_COACH_SEED makes equity sampling depend on the spot, so two coach versions
  // facing the same spot draw the same samples (less noise when comparing them). Off at the real table.
  const SPOT_SEED = process.env.POKER_COACH_SEED;
  function seedFor(t) {
    const key = `${SPOT_SEED}|${t.heroCards}|${t.board}|${t.pot}|${t.toCall}|${t.heroStack}`;
    let h = 2166136261;
    for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
    return h >>> 0;
  }

  /**
   * What an average opponent would think WE hold, from our actions this hand: our preflop role
   * (open, 3-bet, call, limp, big blind check) narrowed by each of our postflop actions with the same
   * weighted update used for opponents. The strategy narrows it once more for the bet it's considering.
   */
  function heroPerceived(t, actions, role) {
    const pos = positionOf(0, t);
    let r;
    switch (role.Hero) {
      case 'raise': r = E.topRange(clamp(0.22 * (POS_WIDTH[pos] || 1), 0.08, 0.5)); break;
      case '3bet+': r = E.topRange(0.08); break;
      case 'call': r = without(E.topRange(0.35), E.topRange(0.04)); break;
      case 'limp': r = without(E.topRange(0.55), E.topRange(0.08)); break;
      default: r = E.allCombos();  // big blind check, or no action seen
    }
    const LEN = { flop: 3, turn: 4, river: 5 };
    const board = E.parseCards(t.board || []);
    let street = 'preflop', pot = 0;
    for (const a0 of actions) {
      const potBefore = pot; if (a0.amount > 0) pot += a0.amount;
      const a = a0.amount > 0 && potBefore > 0 ? { ...a0, size: a0.amount / potBefore } : a0;
      if (a.type === 'street') { street = a.street; continue; }
      if (street === 'preflop' || a.actor !== 'Hero' || !['bet', 'raise', 'allin', 'call', 'check'].includes(a.type)) continue;
      const b = board.slice(0, LEN[street]);
      if (b.length < LEN[street]) continue;
      try { r = E.weightRange(r, b, a.type, a.size ? { size: a.size } : {}); } catch (e) { /* keep the range from before that action */ }
    }
    return r;
  }

  /** Each live opponent's range from their actions this hand (preflop role, then every postflop action). */
  function buildVillains(t, estimateFor) {
    const name = seat => nameOf(t, seat);
    const board = t.board || [];
    const actions = synthActions(t);
    const role = preflopRole(actions);
    const live = t.players.filter(p => p.inHand);
    const villains = live.map(p => {
      const tracked = estimateFor ? estimateFor(name(p.seat)) : null;
      const est = { ...PRIOR, ...(tracked || {}), ...((t.stats || {})[p.seat] || {}) };
      const pos = positionOf(p.seat, t);
      const r = villainRange(role[name(p.seat)], pos, est);
      const st = streetOf(board);
      return applyPostflop({ name: name(p.seat), position: pos, stack: p.stack, bet: p.bet || 0,
        // the fold rate for this street (flop/turn/river), and for facing a raise after they bet
        foldOverride: est.f2bStreet && est.f2bStreet[st] != null ? est.f2bStreet[st] : est.f2b, foldToRaise: est.foldToRaise, aggression: est.af,
        foldBias: est.foldBias ? est.foldBias[st] || 0 : 0,
        foldTo3bet: est.foldTo3bet, threeBetHands: est.raw ? est.raw.f3bOpp || 0 : 0, betSize: est.betSize,
        type: est.type ? est.type.short : '?', hands: est.hands || 0, est, preflopRole: role[name(p.seat)] || 'none', ...r }, actions, E.parseCards(board), est);
    });
    return { actions, role, live, villains };
  }

  function decideFromTable(t, estimateFor, opts = {}) {
    const name = seat => nameOf(t, seat);
    if (!t || !t.heroCards || t.heroCards.length !== 2) throw new Error('need two hero cards');
    if (SPOT_SEED && E.setSeed) E.setSeed(seedFor(t));
    const board = t.board || [];
    const { actions, role, live, villains } = buildVillains(t, estimateFor);
    const order = actingOrder([0, ...live.map(p => p.seat)], t, 'flop');
    const ctx = {
      hero: E.parseCards(t.heroCards), board: E.parseCards(board), pot: t.pot, toCall: t.toCall || 0,
      heroStack: t.heroStack, heroBet: t.heroBet || 0, bb: t.bb, position: positionOf(0, t),
      inPosition: order[order.length - 1] === 0, heroName: 'Hero', actions, villains,
      // game context: how many were dealt in, and where we sit relative to the button
      tableSize: tableSize(t), seatsFromButton: seatsFromButton(0, t), format: t.format || 'cash',
      heroRange: board.length >= 3 ? heroPerceived(t, actions, role) : null,
      ...(t.payouts ? { payouts: t.payouts } : {}),
      ...(t.stacksBehind ? { stacksBehind: t.stacksBehind } : {}),
    };
    let d = S.decide(ctx);
    const solved = (opts.solver !== false) ? riverSolve(t, ctx, actions, role, villains, opts, d) : null;
    if (solved) d = solved;
    const warnings = [...(d.warnings || []), ...villains.flatMap(v => v.warnings || [])];
    return { ...d, text: S.describe(d), position: ctx.position, inPosition: ctx.inPosition,
      ...(warnings.length ? { warnings } : {}),
      perceivedCombos: ctx.heroRange ? Math.round(E.rangeSize(ctx.heroRange)) : null,
      ranges: villains.map(v => ({ name: v.name, position: v.position, label: v.label, type: v.type, hands: v.hands,
        combos: Math.round(E.rangeSize(v.combos)), steps: v.rangeHistory,
        ...(t.debugRanges ? { full: v.combos, est: { vpip: v.est && v.est.vpip, pfr: v.est && v.est.pfr, af: v.aggression, f2b: v.foldOverride, role: v.preflopRole } } : {}) })) };
  }

  // ── River solver (heads-up) ──
  // How we assume we play, to give ourselves a range the solver can balance: a solid regular.
  const HERO_PROFILE = { vpip: 0.25, pfr: 0.2, threeBet: 0.08, af: 2.5, f2b: 0.4, wtsd: 0.3 };
  const SOLVER_OPTS = { iterations: 150, timeLimitMs: 700 };

  function riverSolve(t, ctx, actions, role, villains, opts, base) {
    if (ctx.board.length !== 5 || villains.length !== 1) return null;
    // our range as the opponent sees it: the same perceived range the rest of the coach uses
    let heroRange = ctx.heroRange;
    if (!heroRange) {
      let hero = villainRange(role.Hero, ctx.position, HERO_PROFILE);
      hero = applyPostflop({ name: 'Hero', ...hero }, actions, ctx.board, HERO_PROFILE);
      heroRange = hero.combos;
    }
    const r = SOLVER.adviseRiver(ctx, { heroRange, seed: t.gameId || '', ...SOLVER_OPTS, ...(opts.solverOpts || {}) });
    return r ? { ...r, equity: base.equity } : null;
  }

  // ── Learning opponents across hands ──
  const HERO_ACTION = { FOLD: 'fold', CHECK: 'check', CALL: 'call', BET: 'bet', RAISE: 'raise', 'ALL-IN': 'allin' };

  /**
   * Turn what we saw of one hand into a tracker log. dickreuter only shows us the table when it's
   * our turn, so this fills in what it can: everyone's bets (from the chips), our own action, and
   * folds (a player who had cards and later didn't). When the hand ended right after our bet on
   * the flop or turn, whoever was still in folded (if they'd called, we'd have acted again). On the
   * river we use our stack in the next hand to tell a fold from a call.
   */
  function handToLog(hand, nextHeroStack) {
    const t = hand.table, d = hand.decision;
    const name = seat => nameOf(t, seat);
    const log = [{ type: 'start', handId: String(hand.gameId), size: tableSize(t) }];
    const acts = synthActions(t, d && HERO_ACTION[d.action] ? { action: d.action, amount: d.amount } : null);
    // folds between snapshots: live on an earlier street, gone by a later one
    const snaps = [...(t.history || []), { street: streetOf(t.board), live: t.players.filter(p => p.inHand).map(p => p.seat) }];
    const seated = t.players.filter(p => cleanName(p.name).length >= 2 && (!p.away || p.inHand || (p.bet || 0) > 0)).map(p => p.seat);
    const foldsAt = {}; // street -> [seat]
    const everLive = new Set();
    snaps.forEach(s => (s.live || []).forEach(x => everLive.add(Number(x))));
    for (const seat of seated) if (!everLive.has(seat)) (foldsAt.preflop = foldsAt.preflop || []).push(seat); // folded before we acted
    for (let i = 1; i < snaps.length; i++) {
      const before = new Set((snaps[i - 1].live || []).map(Number)), after = new Set((snaps[i].live || []).map(Number));
      for (const seat of before) if (!after.has(seat)) (foldsAt[snaps[i - 1].street] = foldsAt[snaps[i - 1].street] || []).push(seat);
    }
    // A blind whose preflop decision we never saw (we folded first and the hand ended for us) mustn't
    // count as a hand they didn't play: drop their post, so the tracker doesn't credit them a hand.
    const decided = new Set(acts.filter(a => !['post', 'street'].includes(a.type)).map(a => a.actor));
    for (const st of Object.keys(foldsAt)) for (const seat of foldsAt[st]) decided.add(name(seat));
    const heroSawFlop = snaps.some(x => x.street !== 'preflop');
    if (!heroSawFlop) for (let i = acts.length - 1; i >= 0; i--) if (acts[i].type === 'post' && !decided.has(acts[i].actor)) acts.splice(i, 1);
    let street = 'preflop';
    const flushFolds = st => { for (const seat of foldsAt[st] || []) log.push({ type: 'fold', actor: name(seat) }); delete foldsAt[st]; };
    for (const a of acts) {
      if (a.type === 'street') { flushFolds(street); street = a.street; }
      log.push(a);
    }
    if (d && ['BET', 'RAISE', 'ALL-IN'].includes(d.action) && (d.amount || 0) > (t.toCall || 0) + (t.heroBet || 0)) {
      const live = t.players.filter(p => p.inHand);
      if (live.length) {
        // The hand ended after our bet. Before the river, a call would have brought us another turn.
        let folded = street !== 'river';
        if (street === 'river' && typeof nextHeroStack === 'number') {
          const ifFold = t.heroStack + t.pot; // we get our bet back and win the pot
          folded = Math.abs(nextHeroStack - ifFold) < Math.max(t.bb * 0.5, 1e-9);
        }
        if (folded) for (const p of live) log.push({ type: 'fold', actor: name(p.seat) });
      }
    }
    flushFolds(street);
    return log;
  }

  /** A brain that remembers opponents. trackerFile: where to keep their stats (JSON). */
  function createBrain({ trackerFile, solver } = {}) { // solver: false to switch the river solver off
    const fs = require('fs');
    const tracker = T.create({
      load: () => (trackerFile && fs.existsSync(trackerFile) ? JSON.parse(fs.readFileSync(trackerFile, 'utf8')) : null),
      save: db => { if (trackerFile) { fs.mkdirSync(path.dirname(trackerFile), { recursive: true }); fs.writeFileSync(trackerFile + '.tmp', JSON.stringify(db)); fs.renameSync(trackerFile + '.tmp', trackerFile); } },
    });
    let hand = null; // { gameId, table, decision } for the hand in progress
    const known = () => tracker.players();

    /** OCR noise: "Fish_King" read as "Fish_Kinq" should be the same person. */
    function canonical(n) {
      if (!n || /^Seat\d+$/.test(n) || n === 'Hero') return n;
      const all = known();
      if (all.includes(n)) return n;
      let best = null, bestD = 2;
      for (const k of all) { const dist = lev(n.toLowerCase(), k.toLowerCase()); if (dist < bestD && Math.abs(k.length - n.length) <= 1) { best = k; bestD = dist; } }
      return best && n.length >= 5 ? best : n;
    }

    function finish(nextHeroStack) {
      if (!hand) return 0;
      const log = handToLog(hand, nextHeroStack);
      // fold-model feedback: after each of our bets, did each opponent we predicted for fold?
      for (const b of hand.bets || []) {
        let st = 'preflop', after = false;
        const seen = new Set();
        for (const a of log) {
          if (a.type === 'street') { if (after) break; st = a.street; continue; }
          if (st !== b.street) continue;
          if (a.actor === 'Hero' && ['bet', 'raise', 'allin'].includes(a.type)) { after = true; seen.clear(); continue; }
          if (!after || !(a.actor in b.preds) || seen.has(a.actor)) continue;
          seen.add(a.actor);
          tracker.noteFold(a.actor, b.street, b.preds[a.actor], a.type === 'fold');
        }
      }
      const added = tracker.ingest([...log, { type: 'start', handId: '__next__' + hand.gameId }]);
      hand = null;
      return added;
    }

    function decide(t) {
      if (t.gameId != null && hand && String(hand.gameId) !== String(t.gameId)) finish(t.heroStack);
      t = { ...t, players: (t.players || []).map(p => ({ ...p, name: canonical(cleanName(p.name)) })) };
      if (t.stacksBehind) t.stacksBehind = Object.fromEntries(Object.entries(t.stacksBehind).map(([k, v]) => [k === 'Hero' ? k : canonical(cleanName(k)), v]));
      const size = tableSize(t);
      const d = decideFromTable(t, n => (/^Seat\d+$/.test(n) ? null : tracker.estimate(n, { tableSize: size })), { solver });
      if (t.gameId != null) {
        const bets = hand && String(hand.gameId) === String(t.gameId) ? (hand.bets || []) : [];
        if (d.villainFolds && ['BET', 'RAISE', 'ALL-IN'].includes(d.action) && (t.board || []).length >= 3)
          bets.push({ street: streetOf(t.board), preds: d.villainFolds });
        hand = { gameId: t.gameId, table: t, decision: d, bets };
      }
      return d;
    }

    return { decide, finish, tracker, handToLog };
  }

  function lev(a, b) {
    const m = a.length, n = b.length; if (!m || !n) return m + n;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[n];
  }

  module.exports = { decideFromTable, createBrain, handToLog, synthActions, actingOrder, positionOf, nameOf, buildVillains, applyPostflop, villainRange, heroPerceived, PRIOR };

  // ── stdin/stdout server for coach_decision.py ──
  if (require.main === module && process.argv.includes('--serve')) {
    const argOf = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
    const brain = createBrain({ trackerFile: argOf('--tracker') || process.env.POKER_COACH_TRACKER || null,
      solver: !(process.argv.includes('--no-solver') || process.env.POKER_COACH_SOLVER === '0') });
    const rl = require('readline').createInterface({ input: process.stdin });
    rl.on('line', line => {
      let reply;
      try {
        const msg = JSON.parse(line);
        if (msg.cmd === 'eval') reply = { ok: true, scores: msg.hands.map(h => E.evaluate(E.parseCards(h))) };
        else if (msg.cmd === 'finish') reply = { ok: true, added: brain.finish(msg.heroStack) };
        else if (msg.cmd === 'players') reply = { ok: true, players: brain.tracker.players().map(n => { const e = brain.tracker.estimate(n); return { name: n, hands: e.hands, vpip: e.vpip, pfr: e.pfr, f2b: e.f2b, type: e.type.label }; }) };
        else { const d = brain.decide(msg.table || msg); delete d.features; reply = { ok: true, decision: d }; }
      }
      catch (e) { reply = { ok: false, error: String(e && e.message || e) }; }
      process.stdout.write(JSON.stringify(reply) + '\n');
    });
  }
})();
