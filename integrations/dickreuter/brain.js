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
    switch (action) {
      case 'raise': return { combos: E.topRange(pfrW), label: `opened ${position} · top ${Math.round(pfrW * 100)}%` };
      case '3bet+': { const w = clamp(est.threeBet * 1.3, 0.02, 0.35); return { combos: E.topRange(w), label: `3-bet+ · top ${Math.round(w * 100)}%` }; }
      case 'call': { const w = clamp(est.vpip, 0.08, 0.85); return { combos: without(E.topRange(w), E.topRange(clamp(est.threeBet * 0.6, 0.01, 0.2))), label: `called a raise · ${Math.round(w * 100)}%` }; }
      case 'limp': { const w = clamp(est.vpip, 0.1, 0.9); return { combos: without(E.topRange(w), E.topRange(clamp(est.pfr * 0.6, 0.01, 0.25))), label: `limped · ${Math.round(w * 100)}%` }; }
      default: return { combos: null, label: 'any two' };
    }
  }

  function applyPostflop(villain, actions, board, est) {
    const opts = { bluffKeep: clamp(0.06 + 0.07 * est.af, 0.06, 0.45), floatKeep: clamp(0.75 - est.f2b, 0.1, 0.6) };
    const LEN = { flop: 3, turn: 4, river: 5 };
    let street = 'preflop', combos = villain.combos || E.allCombos(), narrowed = false;
    for (const a of actions) {
      if (a.type === 'street') { street = a.street; continue; }
      if (street === 'preflop' || a.actor !== villain.name || !['bet', 'raise', 'allin', 'call'].includes(a.type)) continue;
      const b = board.slice(0, LEN[street]);
      if (b.length < LEN[street]) continue;
      combos = E.narrowRange(combos, b, a.type, opts); narrowed = true;
    }
    return narrowed ? { ...villain, combos } : villain;
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
      if (to > level + 1e-9) { actions.push({ type: allin ? 'allin' : (level > 0 || cur === 'preflop') ? 'raise' : 'bet', actor: name(seat), amount: to - had, to }); level = to; }
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
    let prevHero = null;
    for (let i = 0; i < snaps.length; i++) {
      const s = snaps[i];
      if (s.street !== cur) {
        if (cur !== null) {
          heroAct(prevHero); // our last action on the street before
          // anyone still in on the new street must have matched the last bet of the old one
          for (const seat of order0(s)) if ((s.live || []).map(Number).includes(seat) && (put[seat] || 0) < level - 1e-9) chips(seat, level, false);
        }
        else if (s.street !== 'preflop') startStreet('preflop');
        // streets we never saw (everyone checked): just mark them
        for (let j = STREETS.indexOf(cur) + 1; j < STREETS.indexOf(s.street); j++) startStreet(STREETS[j]);
        startStreet(s.street);
        prevHero = null;
      } else heroAct(prevHero);
      // our chips should match what we did; if we have no record of it, infer it from the chips
      if ((s.heroBet || 0) > (put[0] || 0) + 1e-9) chips(0, s.heroBet, false);
      const order = actingOrder(allSeats.filter(x => x !== 0), t, s.street);
      const seq = order.map((seat, idx) => ({ seat, idx, b: Number((s.bets || {})[seat]) || 0 })).sort((x, y) => x.b - y.b || x.idx - y.idx);
      for (const { seat, b } of seq) chips(seat, b, s === current && stackOf(seat) === 0);
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
  function decideFromTable(t, estimateFor, opts = {}) {
    const name = seat => nameOf(t, seat);
    if (!t || !t.heroCards || t.heroCards.length !== 2) throw new Error('need two hero cards');
    const board = t.board || [];
    const actions = synthActions(t);
    const role = preflopRole(actions);
    const live = t.players.filter(p => p.inHand);
    const villains = live.map(p => {
      const tracked = estimateFor ? estimateFor(name(p.seat)) : null;
      const est = { ...PRIOR, ...(tracked || {}), ...((t.stats || {})[p.seat] || {}) };
      const pos = positionOf(p.seat, t);
      const r = villainRange(role[name(p.seat)], pos, est);
      return applyPostflop({ name: name(p.seat), position: pos, stack: p.stack, bet: p.bet || 0, foldOverride: est.f2b, aggression: est.af,
        type: est.type ? est.type.short : '?', hands: est.hands || 0, ...r }, actions, E.parseCards(board), est);
    });
    const order = actingOrder([0, ...live.map(p => p.seat)], t, 'flop');
    const ctx = {
      hero: E.parseCards(t.heroCards), board: E.parseCards(board), pot: t.pot, toCall: t.toCall || 0,
      heroStack: t.heroStack, heroBet: t.heroBet || 0, bb: t.bb, position: positionOf(0, t),
      inPosition: order[order.length - 1] === 0, heroName: 'Hero', actions, villains,
      // game context: how many were dealt in, and where we sit relative to the button
      tableSize: tableSize(t), seatsFromButton: seatsFromButton(0, t), format: t.format || 'cash',
    };
    let d = S.decide(ctx);
    const solved = (opts.solver !== false) ? riverSolve(t, ctx, actions, role, villains, opts, d) : null;
    if (solved) d = solved;
    return { ...d, text: S.describe(d), position: ctx.position, inPosition: ctx.inPosition,
      ranges: villains.map(v => ({ name: v.name, position: v.position, label: v.label, type: v.type, hands: v.hands,
        combos: v.combos ? v.combos.length : 1326 })) };
  }

  // ── River solver (heads-up) ──
  // How we assume we play, to give ourselves a range the solver can balance: a solid regular.
  const HERO_PROFILE = { vpip: 0.25, pfr: 0.2, threeBet: 0.08, af: 2.5, f2b: 0.4, wtsd: 0.3 };
  const SOLVER_OPTS = { iterations: 150, timeLimitMs: 700 };

  function riverSolve(t, ctx, actions, role, villains, opts, base) {
    if (ctx.board.length !== 5 || villains.length !== 1) return null;
    let hero = villainRange(role.Hero, ctx.position, HERO_PROFILE);
    hero = applyPostflop({ name: 'Hero', ...hero }, actions, ctx.board, HERO_PROFILE);
    const r = SOLVER.adviseRiver(ctx, { heroRange: hero.combos, seed: t.gameId || '', ...SOLVER_OPTS, ...(opts.solverOpts || {}) });
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
    const log = [{ type: 'start', handId: String(hand.gameId) }];
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
      const added = tracker.ingest([...handToLog(hand, nextHeroStack), { type: 'start', handId: '__next__' + hand.gameId }]);
      hand = null;
      return added;
    }

    function decide(t) {
      if (t.gameId != null && hand && String(hand.gameId) !== String(t.gameId)) finish(t.heroStack);
      t = { ...t, players: (t.players || []).map(p => ({ ...p, name: canonical(cleanName(p.name)) })) };
      const d = decideFromTable(t, n => (/^Seat\d+$/.test(n) ? null : tracker.estimate(n)), { solver });
      if (t.gameId != null) hand = { gameId: t.gameId, table: t, decision: d };
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

  module.exports = { decideFromTable, createBrain, handToLog, synthActions, actingOrder, positionOf, nameOf };

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
