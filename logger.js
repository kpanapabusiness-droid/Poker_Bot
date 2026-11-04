/*
 * logger.js — hand history + decision logger, and the report built from it.
 *
 * For every hand you're dealt into it records:
 *   - your cards, position, big blind, final board
 *   - every decision point: what the coach recommended (action, size, tag, EV) vs what you did,
 *     whether you followed it, and the EV you gave up by deviating (postflop, where the coach
 *     prices every option)
 *   - the result: chips won/lost, worked out from the game log and cross-checked against your stack
 *
 * "EV lost" measures DECISION quality and ignores luck: a bad call that wins still counts as a mistake.
 * Results swing wildly in the short run; EV lost is the number to watch.
 *
 * Storage is pluggable ({ load, save }); the overlay uses localStorage. Works in browser + Node.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PokerLogger = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_HANDS = 2500;
  const SESSION_GAP_MS = 30 * 60 * 1000; // 30 min without a hand starts a new session
  const ACT = { fold: 'FOLD', check: 'CHECK', call: 'CALL', bet: 'BET', raise: 'RAISE', allin: 'ALL-IN' };
  const HERO_ACTIONS = new Set(Object.keys(ACT));

  /** Chips hero put in and won, from the hand's log lines. allIn=true means amounts may be incomplete. */
  function heroResult(actions, heroName) {
    let committed = 0, street = 0, won = 0, allIn = false;
    for (const a of actions) {
      if (a.type === 'street') { street = 0; continue; }
      if (a.actor !== heroName) continue;
      if (a.type === 'post' || a.type === 'call' || a.type === 'bet') { committed += a.amount; street += a.amount; }
      else if (a.type === 'raise') { const add = Math.max(0, a.to - street); committed += add; street = a.to; }
      else if (a.type === 'allin') { allIn = true; if (a.amount) { committed += a.amount; street += a.amount; } }
      else if (a.type === 'win') won += a.amount;
    }
    return { committed, won, net: won - committed, allIn };
  }

  /** Did hero follow the recommendation? Same action; for bets/raises also a similar size (±35%). */
  function compare(rec, actual) {
    const recA = rec.action, actA = ACT[actual.type];
    const sameAction = recA === actA ||
      (recA === 'ALL-IN' && ['CALL', 'RAISE', 'BET'].includes(actA) && actual.amount >= rec.amount * 0.95) ||
      (actA === 'ALL-IN' && ['CALL', 'RAISE', 'BET'].includes(recA));
    let sizeOk = true;
    if (sameAction && ['BET', 'RAISE'].includes(recA) && rec.amount && actual.amount) {
      sizeOk = Math.abs(actual.amount - rec.amount) / rec.amount <= 0.35;
    }
    return { followed: sameAction, sizeOk };
  }

  /** EV hero gave up: best option's EV minus the EV of the option hero actually took (postflop only). */
  function evLost(rec, actual) {
    if (!rec.options || !rec.options.length) return null;
    const best = Math.max(...rec.options.map(o => o.ev));
    const actA = ACT[actual.type];
    const same = rec.options.filter(o => o.action === actA || (actA === 'ALL-IN' && o.action === 'ALL-IN'));
    if (!same.length) return null;
    const amt = actual.amount || 0;
    const pick = same.reduce((p, o) => (Math.abs((o.amount || 0) - amt) < Math.abs((p.amount || 0) - amt) ? o : p));
    return Math.max(0, best - pick.ev);
  }

  function create({ load, save, now = () => Date.now() } = {}) {
    let db = { hands: [] };
    try { const d = load && load(); if (d && Array.isArray(d.hands)) db = d; } catch (e) {}
    const sessionStart = now();
    let cur = null;          // hand being played
    let lastFinal = null;    // finished hand awaiting the stack cross-check at the next hand's start

    function persist() {
      if (db.hands.length > MAX_HANDS) db.hands.splice(0, db.hands.length - MAX_HANDS);
      try { save && save(db); } catch (e) {}
    }

    function heroActionsFrom(actions, heroName, fromIdx) {
      for (let i = fromIdx; i < actions.length; i++) {
        const a = actions[i];
        if (a.actor === heroName && HERO_ACTIONS.has(a.type)) {
          return { i, type: a.type, amount: a.type === 'raise' ? a.to : (a.amount || 0) };
        }
      }
      return null;
    }

    function finalize(h) {
      if (h.done) return;
      const r = heroResult(h.actions, h.heroName);
      h.done = true;
      const rec = {
        id: h.handId, t: h.t, pos: h.pos, bb: h.bb, cards: h.cards, board: h.board,
        net: r.net, netSrc: 'log', allIn: r.allIn, startStack: h.startStack,
        decisions: h.decisions,
      };
      db.hands.push(rec);
      lastFinal = rec;
      persist();
    }

    /**
     * Call every tick with the adapter's TableState, the coach's decision for this moment (or null),
     * and { position, bb }. Safe to call repeatedly with the same state.
     */
    function observe(state, decision, meta = {}) {
      if (!state) return;
      const heroP = state.players && state.players.find(p => p.isHero);
      const heroName = heroP && heroP.name;

      // New hand?
      if (state.handId && (!cur || cur.handId !== state.handId)) {
        if (cur && !cur.done && cur.active) finalize(cur);
        // Cross-check the previous hand's result against the stack now (before this hand's money moves)
        if (lastFinal && heroP && lastFinal.startStack != null && !lastFinal.stackChecked && state.street === 'preflop') {
          const nowStack = state.heroStack + state.heroBet; // chips in front this preflop came out of that stack
          const stackNet = nowStack - lastFinal.startStack;
          lastFinal.stackNet = stackNet;
          lastFinal.stackChecked = true;
          if (lastFinal.allIn) { lastFinal.net = stackNet; lastFinal.netSrc = 'stack'; }
          persist();
        }
        const voluntary = heroName && state.actions.some(a => a.actor === heroName && HERO_ACTIONS.has(a.type));
        cur = {
          handId: state.handId, t: now(), active: !!state.heroInHand, done: false, heroName,
          pos: meta.position || null, bb: meta.bb || 0, cards: state.heroCards.slice(), board: [],
          startStack: state.heroInHand && !voluntary ? state.heroStack + state.heroBet : null,
          decisions: [], pending: null, actions: [],
        };
      }
      if (!cur || !cur.active) {
        // hero might be dealt in a moment after the hand starts
        if (cur && !cur.active && state.heroInHand && state.handId === cur.handId) {
          cur.active = true; cur.cards = state.heroCards.slice(); cur.heroName = heroName;
          if (cur.startStack == null) cur.startStack = state.heroStack + state.heroBet;
        }
        if (!cur || !cur.active) return;
      }

      cur.actions = state.actions;
      cur.heroName = cur.heroName || heroName;
      if (state.board.length >= cur.board.length) cur.board = state.board.slice();
      if (meta.position && !cur.pos) cur.pos = meta.position;
      if (meta.bb && !cur.bb) cur.bb = meta.bb;

      // Resolve a pending decision once hero's action shows up in the log
      if (cur.pending) {
        const act = heroActionsFrom(state.actions, cur.heroName, cur.pending.idx);
        if (act) {
          const p = cur.pending; cur.pending = null;
          const actual = { type: act.type, amount: act.amount };
          const cmp = compare(p.rec, actual);
          cur.decisions.push({
            street: p.street, pot: p.pot, toCall: p.toCall, eq: p.rec.equity != null ? +p.rec.equity.toFixed(3) : null,
            rec: { action: p.rec.action, amount: p.rec.amount || 0, tag: p.rec.tag, ev: p.rec.ev != null ? Math.round(p.rec.ev) : null },
            actual, followed: cmp.followed, sizeOk: cmp.sizeOk, evLost: (() => { const x = evLost(p.rec, actual); return x == null ? null : Math.round(x); })(),
          });
        }
      }
      // Record the coach's advice when it's hero's turn
      if (state.isHeroTurn && decision && !cur.pending) {
        cur.pending = {
          idx: state.actions.length, street: state.street, pot: state.pot, toCall: state.toCall,
          rec: { action: decision.action, amount: decision.amount, tag: decision.tag, ev: decision.ev, equity: decision.equity,
            options: decision.options ? decision.options.map(o => ({ action: o.action, amount: o.amount, ev: o.ev })) : null },
        };
      } else if (state.isHeroTurn && decision && cur.pending && cur.pending.street === state.street && cur.pending.idx === state.actions.length) {
        // still the same decision: keep the latest advice (it can refine as the timer runs)
        cur.pending.rec = { ...cur.pending.rec, action: decision.action, amount: decision.amount, tag: decision.tag, ev: decision.ev, equity: decision.equity,
          options: decision.options ? decision.options.map(o => ({ action: o.action, amount: o.amount, ev: o.ev })) : null };
      }

      // Hand over (winner posted)?
      if (state.actions.some(a => a.type === 'win')) finalize(cur);
    }

    // ─────────────────────────── Report ───────────────────────────
    function report({ since = 0 } = {}) {
      const hands = db.hands.filter(h => h.t >= since);
      const bbOf = h => (h.bb > 0 ? h.net / h.bb : 0);
      const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
      const decisions = hands.flatMap(h => h.decisions.map(d => ({ ...d, hand: h })));
      const followedHands = hands.filter(h => h.decisions.length && h.decisions.every(d => d.followed));
      const deviatedHands = hands.filter(h => h.decisions.some(d => !d.followed));
      const priced = decisions.filter(d => d.evLost != null);
      const evLostBB = sum(priced, d => (d.hand.bb > 0 ? d.evLost / d.hand.bb : 0));
      const byPos = {};
      for (const h of hands) { const p = h.pos || '?'; (byPos[p] = byPos[p] || { hands: 0, bb: 0, net: 0 }); byPos[p].hands++; byPos[p].bb += bbOf(h); byPos[p].net += h.net; }
      Object.values(byPos).forEach(x => { x.bb100 = x.hands ? (x.bb / x.hands) * 100 : 0; });
      // Patterns: what you do instead of the advice
      const patterns = {};
      for (const d of decisions.filter(d => !d.followed)) {
        const k = `${d.rec.action} → you ${ACT[d.actual.type] || d.actual.type}`;
        (patterns[k] = patterns[k] || { count: 0, evLost: 0, net: 0 });
        patterns[k].count++; patterns[k].evLost += d.evLost || 0; patterns[k].net += d.hand.net;
      }
      return {
        hands: hands.length,
        net: sum(hands, h => h.net),
        bb100: hands.length ? (sum(hands, bbOf) / hands.length) * 100 : 0,
        decisions: decisions.length,
        followRate: decisions.length ? decisions.filter(d => d.followed).length / decisions.length : null,
        followedNet: sum(followedHands, h => h.net), followedHands: followedHands.length,
        deviatedNet: sum(deviatedHands, h => h.net), deviatedHands: deviatedHands.length,
        evLost: sum(priced, d => d.evLost), evLostBB, evLostPer100: hands.length ? (evLostBB / hands.length) * 100 : 0,
        costliest: priced.filter(d => d.evLost > 0).sort((a, b) => b.evLost - a.evLost).slice(0, 5)
          .map(d => ({ id: d.hand.id, cards: d.hand.cards, board: d.hand.board, street: d.street, rec: d.rec, actual: d.actual, evLost: d.evLost })),
        byPosition: byPos,
        patterns: Object.entries(patterns).map(([k, v]) => ({ pattern: k, ...v })).sort((a, b) => b.evLost - a.evLost || b.count - a.count),
        biggestPots: hands.slice().sort((a, b) => Math.abs(b.net) - Math.abs(a.net)).slice(0, 5).map(h => ({ id: h.id, cards: h.cards, board: h.board, net: h.net })),
      };
    }

    /** One row per decision (plus one row for hands with no decision) — for Excel / SQL. */
    function toCSV() {
      const cols = ['hand_id', 'time', 'position', 'bb', 'cards', 'board', 'hand_net', 'net_source', 'street', 'pot', 'to_call', 'equity',
        'rec_action', 'rec_amount', 'rec_tag', 'rec_ev', 'actual_action', 'actual_amount', 'followed', 'size_ok', 'ev_lost'];
      const q = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
      const rows = [cols.join(',')];
      for (const h of db.hands) {
        const base = [h.id, new Date(h.t).toISOString(), h.pos, h.bb, (h.cards || []).join(' '), (h.board || []).join(' '), h.net, h.netSrc];
        if (!h.decisions.length) rows.push([...base, '', '', '', '', '', '', '', '', '', '', '', '', ''].map(q).join(','));
        for (const d of h.decisions) {
          rows.push([...base, d.street, d.pot, d.toCall, d.eq, d.rec.action, d.rec.amount, d.rec.tag, d.rec.ev,
            ACT[d.actual.type] || d.actual.type, d.actual.amount, d.followed, d.sizeOk, d.evLost].map(q).join(','));
        }
      }
      return rows.join('\n');
    }

    /** Start time of the current session: hands since the last 30-minute gap (empty if idle 30+ min). */
    function sessionSince() {
      const hs = db.hands;
      if (!hs.length) return sessionStart;
      if (now() - hs[hs.length - 1].t > SESSION_GAP_MS) return now();
      let i = hs.length - 1;
      while (i > 0 && hs[i].t - hs[i - 1].t <= SESSION_GAP_MS) i--;
      return hs[i].t;
    }

    return {
      observe, report, toCSV, sessionSince,
      hands: () => db.hands,
      exportData: () => JSON.parse(JSON.stringify(db)),
      importData: d => { if (d && Array.isArray(d.hands)) { db = d; persist(); } },
      reset: () => { db = { hands: [] }; cur = null; lastFinal = null; persist(); },
    };
  }

  return { create, heroResult, compare, evLost };
});
