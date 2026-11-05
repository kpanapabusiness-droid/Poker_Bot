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
 *     players: [{ seat, stack, bet, inHand }],   // seat: 1..nSeats-1 = seats to hero's left
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

  const PRIOR = T.create({}).estimate('__nobody__'); // the "average casual player" the tracker starts everyone at
  const STREETS = ['preflop', 'flop', 'turn', 'river'];
  const streetOf = board => (board.length === 0 ? 'preflop' : board.length === 3 ? 'flop' : board.length === 4 ? 'turn' : 'river');
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const name = seat => (seat === 0 ? 'Hero' : 'P' + seat);

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
  const seatsFromButton = (seat, t) => (seat - t.dealer + t.nSeats) % t.nSeats;
  function positionOf(seat, t) { return E.positionFromSeat(seatsFromButton(seat, t), t.nSeats); }
  /** Order players act in: preflop starts left of the big blind, postflop left of the button. */
  function actingOrder(seats, t, street) {
    const first = street === 'preflop' ? (t.nSeats === 2 ? 0 : 3) : 1;
    return [...seats].sort((a, b) => ((seatsFromButton(a, t) - first + t.nSeats) % t.nSeats) - ((seatsFromButton(b, t) - first + t.nSeats) % t.nSeats));
  }

  /** Rebuild an action list (strategy.js / tracker format) from the chips in front of each player. */
  function synthActions(t) {
    const street = streetOf(t.board);
    const current = { street, bets: { 0: t.heroBet || 0 } };
    for (const p of t.players) current.bets[p.seat] = p.bet || 0;
    const streets = [...(t.history || []).filter(h => STREETS.indexOf(h.street) < STREETS.indexOf(street)), current];
    const stackOf = seat => (seat === 0 ? t.heroStack : (t.players.find(p => p.seat === seat) || {}).stack);
    const actions = [];
    const allSeats = [0, ...t.players.map(p => p.seat)];
    const sb = t.nSeats === 2 ? 0 : 1, bbSeat = t.nSeats === 2 ? 1 : 2;
    for (const s of streets) {
      if (s.street !== 'preflop') actions.push({ type: 'street', street: s.street });
      let max = 0;
      if (s.street === 'preflop') {
        for (const seat of allSeats) {
          const k = seatsFromButton(seat, t);
          if (k === sb) actions.push({ type: 'post', actor: name(seat), blind: 'SB', amount: t.bb / 2 });
          if (k === bbSeat) actions.push({ type: 'post', actor: name(seat), blind: 'BB', amount: t.bb });
        }
        max = t.bb;
      }
      // Chips only show the latest size, so replay in ascending size (raises only ever go up),
      // breaking ties by table order: at equal size the first player is the bettor, the rest called.
      const order = actingOrder(allSeats, t, s.street);
      const seq = order.map((seat, i) => ({ seat, i, b: Number(s.bets[seat]) || 0 })).sort((x, y) => x.b - y.b || x.i - y.i);
      for (const { seat, b } of seq) {
        const blind = s.street === 'preflop' ? (seatsFromButton(seat, t) === bbSeat ? t.bb : seatsFromButton(seat, t) === sb ? t.bb / 2 : 0) : 0;
        if (b > max + 1e-9) {
          const allin = s === current && stackOf(seat) === 0;
          actions.push({ type: allin ? 'allin' : max > 0 ? 'raise' : 'bet', actor: name(seat), amount: b - blind, to: b });
          max = b;
        } else if (b > 0 && Math.abs(b - max) < 1e-9 && b > blind) {
          actions.push({ type: 'call', actor: name(seat), amount: b - blind });
        }
      }
    }
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

  /** Main entry: dickreuter table → strategy.js decision (plus the context, for debugging). */
  function decideFromTable(t) {
    if (!t || !t.heroCards || t.heroCards.length !== 2) throw new Error('need two hero cards');
    const board = t.board || [];
    const actions = synthActions(t);
    const role = preflopRole(actions);
    const live = t.players.filter(p => p.inHand);
    const villains = live.map(p => {
      const est = { ...PRIOR, ...((t.stats || {})[p.seat] || {}) };
      const pos = positionOf(p.seat, t);
      const r = villainRange(role[name(p.seat)], pos, est);
      return applyPostflop({ name: name(p.seat), position: pos, stack: p.stack, bet: p.bet || 0, foldOverride: est.f2b, ...r }, actions, E.parseCards(board), est);
    });
    const order = actingOrder([0, ...live.map(p => p.seat)], t, 'flop');
    const ctx = {
      hero: E.parseCards(t.heroCards), board: E.parseCards(board), pot: t.pot, toCall: t.toCall || 0,
      heroStack: t.heroStack, heroBet: t.heroBet || 0, bb: t.bb, position: positionOf(0, t),
      inPosition: order[order.length - 1] === 0, heroName: 'Hero', actions, villains,
    };
    const d = S.decide(ctx);
    return { ...d, text: S.describe(d), position: ctx.position, inPosition: ctx.inPosition,
      ranges: villains.map(v => ({ name: v.name, position: v.position, label: v.label, combos: v.combos ? v.combos.length : 1326 })) };
  }

  module.exports = { decideFromTable, synthActions, actingOrder, positionOf };

  // ── stdin/stdout server for coach_decision.py ──
  if (require.main === module && process.argv.includes('--serve')) {
    const rl = require('readline').createInterface({ input: process.stdin });
    rl.on('line', line => {
      let reply;
      try { const d = decideFromTable(JSON.parse(line)); delete d.features; reply = { ok: true, decision: d }; }
      catch (e) { reply = { ok: false, error: String(e && e.message || e) }; }
      process.stdout.write(JSON.stringify(reply) + '\n');
    });
  }
})();
