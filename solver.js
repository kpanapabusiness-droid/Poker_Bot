/*
 * solver.js — a heads-up river solver (CFR+), small enough to run live in a few hundred milliseconds.
 *
 * Given both players' ranges, the board, the pot and the stacks, it works out the equilibrium
 * strategy (what a perfect player would do against a perfect opponent holding that range) for a
 * small set of bet sizes, then tells you what to do with your actual hand. Because the opponent's
 * range comes from the tracker, the answer is "balanced play against what this player actually
 * holds", which is stronger than the one-street EV model when the river is a guessing game of
 * value bets, bluffs and bluff-catchers.
 *
 * No dependencies beyond poker-engine.js. Runs in Node and the browser.
 *
 *   const R = require('./solver.js');
 *   R.solveRiver({ board, hero: [c1, c2], heroRange, villainRange, pot, heroStack, villainStack,
 *                  facing: 0, heroFirst: true, iterations: 300, timeLimitMs: 600 })
 *   → { action: 'BET'|'CHECK'|'CALL'|'FOLD'|'RAISE'|'ALL-IN', amount, strategy: [{label, amount, prob}], ev, exploitability }
 *
 * Ranges are arrays of [c1, c2] combos (as poker-engine's combos); weights are optional ([c1, c2, w]).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./poker-engine.js'));
  else root.PokerSolver = factory(root.PokerEngine);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  const BET_SIZES = [0.33, 0.75, 1.25];  // fractions of the pot for a first bet
  const RAISE_SIZES = [1.0];              // pot-sized raise (fraction of the pot after calling)
  const MAX_RAISES = 2;                   // bet, raise, re-raise (then only call or fold)

  // ── Game tree ──
  // Players: 0 = hero, 1 = villain. put = chips each has put in during this river.
  function buildTree(o) {
    const P = o.pot, stacks = [o.heroStack, o.villainStack];
    let nodes = 0;
    function node(toAct, put, raises, lastAggressor, checked) {
      nodes++;
      const opp = 1 - toAct, facing = put[opp] - put[toAct];
      const potNow = P + put[0] + put[1];
      const left = stacks[toAct] - put[toAct];          // chips this player has left
      const oppLeft = stacks[opp] - put[opp];
      const kids = [];
      if (facing > 0) {
        kids.push({ label: 'FOLD', amount: 0, child: { type: 'fold', loser: toAct, put: [...put] } });
        const callTo = Math.min(put[opp], stacks[toAct]);
        const p2 = [...put]; p2[toAct] = callTo;
        kids.push({ label: put[opp] >= stacks[toAct] ? 'ALL-IN' : 'CALL', amount: callTo, child: { type: 'showdown', put: p2 } });
        if (raises < MAX_RAISES && left > facing && oppLeft > 0) {
          const tos = new Set();
          for (const f of RAISE_SIZES) tos.add(Math.min(put[opp] + f * (potNow + facing), stacks[toAct]));
          if (raises + 1 >= MAX_RAISES || true) tos.add(stacks[toAct]);
          for (const to of [...tos].sort((a, b) => a - b)) {
            if (to <= put[opp] + 1e-9) continue;
            const p3 = [...put]; p3[toAct] = to;
            kids.push({ label: to >= stacks[toAct] - 1e-9 ? 'ALL-IN' : 'RAISE', amount: to, child: node(opp, p3, raises + 1, toAct, false) });
          }
        }
      } else {
        // check: if the other player already checked, showdown; else they act
        kids.push({ label: 'CHECK', amount: 0, child: checked ? { type: 'showdown', put: [...put] } : node(opp, [...put], raises, lastAggressor, true) });
        if (left > 0 && oppLeft > 0) {
          const tos = new Set();
          for (const f of BET_SIZES) tos.add(Math.min(f * potNow, left));
          tos.add(left);
          for (const amt of [...tos].sort((a, b) => a - b)) {
            if (amt <= 0) continue;
            const p3 = [...put]; p3[toAct] = put[toAct] + amt;
            kids.push({ label: amt >= left - 1e-9 ? 'ALL-IN' : 'BET', amount: put[toAct] + amt, child: node(opp, p3, raises + 1, toAct, false) });
          }
        }
      }
      return { type: 'act', toAct, kids, put: [...put] };
    }
    // Start: hero facing a bet of `facing` (villain put it in), or first to act / checked to.
    let rootNode;
    if (o.facing > 0) rootNode = node(0, [0, o.facing], 1, 1, false);
    else rootNode = node(0, [0, 0], 0, -1, !o.heroFirst);
    return { root: rootNode, nodes };
  }

  // ── Ranges with card removal ──
  function prepRange(range, board, rankOf) {
    const dead = new Set(board);
    const combos = [];
    for (const c of range) {
      const a = c[0], b = c[1], w = c.length > 2 ? c[2] : 1;
      if (dead.has(a) || dead.has(b) || !(w > 0)) continue;
      combos.push({ a, b, w, rank: rankOf(a, b) });
    }
    return combos;
  }

  /**
   * Showdown values for `me` combos against opponent reach `opp` (aligned with oppCombos), with
   * card removal: for each of my hands, sum of opponent reach that beats / loses to / ties it,
   * excluding opponent hands that share a card. O((n + m) log) using sorted ranks and per-card sums.
   */
  function showdownSums(me, oppSorted, oppReach) {
    const n = me.length;
    const win = new Float64Array(n), lose = new Float64Array(n), tie = new Float64Array(n);
    // total and per-card totals
    let total = 0; const cardTot = new Float64Array(52);
    for (const o of oppSorted) { const r = oppReach[o.i]; total += r; cardTot[o.a] += r; cardTot[o.b] += r; }
    // my hands sorted by rank
    const order = me.map((m, i) => i).sort((x, y) => me[x].rank - me[y].rank);
    // weaker-than sums: walk up
    let j = 0, below = 0; const cardBelow = new Float64Array(52);
    let k = 0; // ties handled by grouping equal ranks
    for (let idx = 0; idx < n; idx++) {
      const m = me[order[idx]];
      while (j < oppSorted.length && oppSorted[j].rank < m.rank) { const o = oppSorted[j]; const r = oppReach[o.i]; below += r; cardBelow[o.a] += r; cardBelow[o.b] += r; j++; }
      // equal rank range
      if (k < j) k = j;
      let eq = 0; const eqCards = {};
      let q = j;
      while (q < oppSorted.length && oppSorted[q].rank === m.rank) { const o = oppSorted[q]; const r = oppReach[o.i]; eq += r; eqCards[o.a] = (eqCards[o.a] || 0) + r; eqCards[o.b] = (eqCards[o.b] || 0) + r; q++; }
      const same = sameComboReach(m, oppSorted, oppReach, j, q);
      const w = below - cardBelow[m.a] - cardBelow[m.b] + sameComboBelow(m, oppSorted, oppReach, j);
      const t = eq - (eqCards[m.a] || 0) - (eqCards[m.b] || 0) + same;
      const compatibleTotal = total - cardTot[m.a] - cardTot[m.b] + exactReach(m, oppSorted, oppReach);
      win[order[idx]] = w; tie[order[idx]] = t; lose[order[idx]] = compatibleTotal - w - t;
    }
    return { win, lose, tie };
  }
  // An opponent combo identical to mine was subtracted twice (once per card); add it back once.
  function exactReach(m, opp, reach) { const r = opp.lookup.get(m.a * 52 + m.b); return r === undefined ? 0 : reach[r]; }
  function sameComboBelow(m, opp, reach, j) { const r = opp.lookup.get(m.a * 52 + m.b); return r !== undefined && opp.posOf[r] < j ? reach[r] : 0; }
  function sameComboReach(m, opp, reach, j, q) { const r = opp.lookup.get(m.a * 52 + m.b); return r !== undefined && opp.posOf[r] >= j && opp.posOf[r] < q ? reach[r] : 0; }

  function compatibleSum(me, oppCombos, oppReach) {
    let total = 0; const cardTot = new Float64Array(52);
    for (let i = 0; i < oppCombos.length; i++) { const o = oppCombos[i], r = oppReach[i]; total += r; cardTot[o.a] += r; cardTot[o.b] += r; }
    const out = new Float64Array(me.length);
    for (let i = 0; i < me.length; i++) {
      const m = me[i];
      const r = oppCombos.lookup.get(m.a * 52 + m.b);
      out[i] = total - cardTot[m.a] - cardTot[m.b] + (r === undefined ? 0 : oppReach[r]);
    }
    return out;
  }

  function indexCombos(list) {
    list.lookup = new Map();
    list.forEach((c, i) => { c.i = i; const lo = Math.min(c.a, c.b), hi = Math.max(c.a, c.b); list.lookup.set(lo * 52 + hi, i); list.lookup.set(hi * 52 + lo, i); });
    list.sorted = [...list].sort((x, y) => x.rank - y.rank);
    list.sorted.lookup = list.lookup;
    list.sorted.posOf = new Int32Array(list.length);
    list.sorted.forEach((c, pos) => { list.sorted.posOf[c.i] = pos; });
    return list;
  }

  // ── CFR+ ──
  function solveRiver(o) {
    const board = o.board;
    const rankCache = new Map();
    const rankOf = (a, b) => { const k = a < b ? a * 52 + b : b * 52 + a; let r = rankCache.get(k); if (r === undefined) { r = E.evaluate([a, b, ...board]); rankCache.set(k, r); } return r; };
    const heroRange = [...(o.heroRange || [])];
    const hk = Math.min(o.hero[0], o.hero[1]) * 52 + Math.max(o.hero[0], o.hero[1]);
    if (!heroRange.some(c => Math.min(c[0], c[1]) * 52 + Math.max(c[0], c[1]) === hk)) heroRange.push([o.hero[0], o.hero[1], 1]);
    const R = [indexCombos(prepRange(heroRange, board, rankOf)), indexCombos(prepRange(o.villainRange || E.allCombos(), board, rankOf))];
    // villain can't hold our cards
    R[1] = indexCombos(R[1].filter(c => c.a !== o.hero[0] && c.a !== o.hero[1] && c.b !== o.hero[0] && c.b !== o.hero[1]));
    if (!R[1].length) return null;
    const { root, nodes } = buildTree(o);
    const P = o.pot;
    // allocate regrets / strategy sums per action node
    (function alloc(nd) {
      if (nd.type !== 'act') return;
      const n = R[nd.toAct].length, A = nd.kids.length;
      nd.regret = new Float64Array(n * A); nd.stratSum = new Float64Array(n * A);
      nd.kids.forEach(k => alloc(k.child));
    })(root);

    const strategyOf = (nd, out) => {
      const n = R[nd.toAct].length, A = nd.kids.length;
      for (let h = 0; h < n; h++) {
        let s = 0;
        for (let a = 0; a < A; a++) { const r = nd.regret[h * A + a]; s += r > 0 ? r : 0; }
        for (let a = 0; a < A; a++) { const r = nd.regret[h * A + a]; out[h * A + a] = s > 0 ? (r > 0 ? r : 0) / s : 1 / A; }
      }
      return out;
    };

    // Values for traverser p (per its combos), given opponent reach.
    function cfr(nd, p, reachP, reachO, iter) {
      const me = R[p], opp = R[1 - p];
      if (nd.type === 'fold') {
        const cs = compatibleSum(me, opp, reachO);
        const val = nd.loser === p ? -nd.put[p] : P + nd.put[1 - p];
        const out = new Float64Array(me.length);
        for (let i = 0; i < me.length; i++) out[i] = val * cs[i];
        return out;
      }
      if (nd.type === 'showdown') {
        const { win, lose, tie } = showdownSums(me, opp.sorted, reachO);
        const gain = P + nd.put[1 - p], loss = -nd.put[p], split = (P + nd.put[1 - p] - nd.put[p]) / 2;
        const out = new Float64Array(me.length);
        for (let i = 0; i < me.length; i++) out[i] = win[i] * gain + lose[i] * loss + tie[i] * split;
        return out;
      }
      const A = nd.kids.length;
      if (nd.toAct === p) {
        const n = me.length;
        const sigma = strategyOf(nd, new Float64Array(n * A));
        const vals = nd.kids.map((k, a) => {
          const rp = new Float64Array(n);
          for (let h = 0; h < n; h++) rp[h] = reachP[h] * sigma[h * A + a];
          return cfr(k.child, p, rp, reachO, iter);
        });
        const out = new Float64Array(n);
        for (let h = 0; h < n; h++) {
          let v = 0;
          for (let a = 0; a < A; a++) v += sigma[h * A + a] * vals[a][h];
          out[h] = v;
          for (let a = 0; a < A; a++) {
            const r = nd.regret[h * A + a] + vals[a][h] - v;
            nd.regret[h * A + a] = r > 0 ? r : 0; // CFR+
            nd.stratSum[h * A + a] += iter * reachP[h] * sigma[h * A + a]; // linear averaging
          }
        }
        return out;
      }
      const m = opp.length;
      const sigma = strategyOf(nd, new Float64Array(m * A));
      const out = new Float64Array(me.length);
      for (let a = 0; a < A; a++) {
        const ro = new Float64Array(m);
        for (let h = 0; h < m; h++) ro[h] = reachO[h] * sigma[h * A + a];
        const v = cfr(nd.kids[a].child, p, reachP, ro, iter);
        for (let i = 0; i < out.length; i++) out[i] += v[i];
      }
      return out;
    }

    const init = r => Float64Array.from(r, c => c.w);
    const maxIt = o.iterations || 300, deadline = Date.now() + (o.timeLimitMs || 600);
    let it = 0;
    for (it = 1; it <= maxIt; it++) {
      cfr(root, 0, init(R[0]), init(R[1]), it);
      cfr(root, 1, init(R[1]), init(R[0]), it);
      if (Date.now() > deadline) break;
    }

    // average strategy at the root for our actual hand
    const hIdx = R[0].lookup.get(Math.min(o.hero[0], o.hero[1]) * 52 + Math.max(o.hero[0], o.hero[1]));
    const A = root.kids.length;
    let s = 0; for (let a = 0; a < A; a++) s += root.stratSum[hIdx * A + a];
    const strategy = root.kids.map((k, a) => ({ label: k.label, amount: k.amount, prob: s > 0 ? root.stratSum[hIdx * A + a] / s : 1 / A }));
    // EV of each root action for our hand against the villain's average strategy
    const avgFix = nd => { if (nd.type !== 'act') return; const n = R[nd.toAct].length, A2 = nd.kids.length; nd.avg = new Float64Array(n * A2); for (let h = 0; h < n; h++) { let t = 0; for (let a = 0; a < A2; a++) t += nd.stratSum[h * A2 + a]; for (let a = 0; a < A2; a++) nd.avg[h * A2 + a] = t > 0 ? nd.stratSum[h * A2 + a] / t : 1 / A2; } nd.kids.forEach(k => avgFix(k.child)); };
    avgFix(root);
    const evAgainstAvg = (nd, p, reachO) => { // traverser p plays best response? no: plays average too, except root handled outside
      const me = R[p], opp = R[1 - p];
      if (nd.type === 'fold') { const cs = compatibleSum(me, opp, reachO); const val = nd.loser === p ? -nd.put[p] : P + nd.put[1 - p]; return Float64Array.from(cs, x => x * val); }
      if (nd.type === 'showdown') { const { win, lose, tie } = showdownSums(me, opp.sorted, reachO); const g = P + nd.put[1 - p], l = -nd.put[p], sp = (P + nd.put[1 - p] - nd.put[p]) / 2; return Float64Array.from(win, (w, i) => w * g + lose[i] * l + tie[i] * sp); }
      const A2 = nd.kids.length; const out = new Float64Array(me.length);
      if (nd.toAct === p) { const vals = nd.kids.map(k => evAgainstAvg(k.child, p, reachO)); for (let h = 0; h < me.length; h++) for (let a = 0; a < A2; a++) out[h] += nd.avg[h * A2 + a] * vals[a][h]; return out; }
      for (let a = 0; a < A2; a++) { const ro = Float64Array.from(reachO, (r, h) => r * nd.avg[h * A2 + a]); const v = evAgainstAvg(nd.kids[a].child, p, ro); for (let i = 0; i < out.length; i++) out[i] += v[i]; }
      return out;
    };
    const vReach = init(R[1]);
    const norm = compatibleSum(R[0], R[1], vReach)[hIdx] || 1;
    strategy.forEach((st, a) => { st.ev = evAgainstAvg(root.kids[a].child, 0, vReach)[hIdx] / norm; });
    // pick: most likely action; ties to the higher EV
    let best = strategy[0];
    for (const st of strategy) if (st.prob > best.prob + 1e-6 || (Math.abs(st.prob - best.prob) <= 1e-6 && st.ev > best.ev)) best = st;
    const ev = strategy.reduce((x, st) => x + st.prob * st.ev, 0);
    return { action: best.label, amount: best.amount, prob: best.prob, strategy, ev, iterations: Math.min(it, maxIt), nodes,
      heroCombos: R[0].length, villainCombos: R[1].length, exploitability: o.measure ? exploitability(root, R, P, init) : undefined };
  }

  /** How much a best response gains against the average strategies (lower is closer to equilibrium), in chips. */
  function exploitability(root, R, P, init) {
    const br = (nd, p, reachO) => {
      const me = R[p], opp = R[1 - p];
      if (nd.type === 'fold') { const cs = compatibleSum(me, opp, reachO); const val = nd.loser === p ? -nd.put[p] : P + nd.put[1 - p]; return Float64Array.from(cs, x => x * val); }
      if (nd.type === 'showdown') { const { win, lose, tie } = showdownSums(me, opp.sorted, reachO); const g = P + nd.put[1 - p], l = -nd.put[p], sp = (P + nd.put[1 - p] - nd.put[p]) / 2; return Float64Array.from(win, (w, i) => w * g + lose[i] * l + tie[i] * sp); }
      const A = nd.kids.length;
      if (nd.toAct === p) { const vals = nd.kids.map(k => br(k.child, p, reachO)); return Float64Array.from(vals[0], (_, h) => Math.max(...vals.map(v => v[h]))); }
      const out = new Float64Array(me.length);
      for (let a = 0; a < A; a++) { const ro = Float64Array.from(reachO, (r, h) => r * nd.avg[h * A + a]); const v = br(nd.kids[a].child, p, ro); for (let i = 0; i < out.length; i++) out[i] += v[i]; }
      return out;
    };
    const tot = p => { const v = br(root, p, init(R[1 - p])); let s = 0, w = 0; const cs = compatibleSum(R[p], R[1 - p], init(R[1 - p])); for (let i = 0; i < v.length; i++) { s += v[i] * R[p][i].w; w += cs[i] * R[p][i].w; } return s / w; };
    return (tot(0) + tot(1) - P) / 2; // in a constant-sum game the two best responses sum to the pot at equilibrium
  }

  /**
   * River advice in strategy.js's decision format, for one opponent. ctx is strategy.js's context
   * (hero, board, pot incl. bets, toCall, heroStack, heroBet, bb, inPosition, actions, villains with
   * combos and stack). heroRange: our own likely range (combos). Returns null when it doesn't apply
   * (not the river, more than one opponent). Plays the solver's mix with a repeatable seeded draw.
   */
  function adviseRiver(ctx, { heroRange, seed = '', heroName = 'Hero', iterations = 150, timeLimitMs = 700 } = {}) {
    if (!ctx || ctx.board.length !== 5 || !ctx.villains || ctx.villains.length !== 1) return null;
    const v = ctx.villains[0];
    const facing = ctx.toCall || 0;
    const pot = Math.max(ctx.pot - facing, ctx.bb || 1);
    const stack = Math.min(ctx.heroStack, (v.stack != null ? v.stack : ctx.heroStack) + facing);
    if (!(stack > 0)) return null;
    let st = 'preflop', villainChecked = false;
    for (const a of ctx.actions || []) {
      if (a.type === 'street') { st = a.street; villainChecked = false; }
      else if (st === 'river' && a.actor === v.name && a.type === 'check') villainChecked = true;
    }
    const heroFirst = facing === 0 && !ctx.inPosition && !villainChecked;
    const r = solveRiver({ board: ctx.board, hero: ctx.hero, heroRange: heroRange || E.allCombos(), villainRange: v.combos || E.allCombos(),
      pot, heroStack: stack, villainStack: stack, facing, heroFirst, iterations, timeLimitMs });
    if (!r) return null;
    let x = seeded(String(seed) + ctx.board.join(',') + facing)();
    let pick = r.strategy[r.strategy.length - 1];
    for (const s2 of r.strategy) { if ((x -= s2.prob) <= 0) { pick = s2; break; } }
    if (pick.prob < 0.05) pick = r.strategy.reduce((a, b) => (b.prob > a.prob ? b : a));
    const heroBet = ctx.heroBet || 0;
    const amt = s2 => (s2.label === 'FOLD' || s2.label === 'CHECK' ? 0 : s2.label === 'CALL' ? facing : heroBet + s2.amount);
    const pctPot = s2 => s2.label === 'BET' ? ` (${Math.round(s2.amount / pot * 100)}% pot)` : s2.label === 'RAISE' ? ` (${Math.round((s2.amount - facing) / (pot + 2 * facing) * 100)}% pot)` : '';
    return {
      action: pick.label, amount: amt(pick), tag: 'SOLVER',
      reason: `River solver vs their range: ${pick.label.toLowerCase()}${pctPot(pick)} ${Math.round(pick.prob * 100)}% of the time with this hand`,
      options: r.strategy.map(s2 => ({ action: s2.label, amount: amt(s2), ev: s2.ev, prob: s2.prob })),
      solver: { strategy: r.strategy.map(s2 => ({ label: s2.label, amount: amt(s2), prob: +s2.prob.toFixed(3), ev: +s2.ev.toFixed(2) })),
        iterations: r.iterations, heroCombos: r.heroCombos, villainCombos: r.villainCombos },
    };
  }

  function seeded(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return () => { h = Math.imul(h ^ (h >>> 15), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); h ^= h >>> 16; return (h >>> 0) / 4294967296; };
  }

  return { solveRiver, adviseRiver, buildTree, BET_SIZES, RAISE_SIZES };
});
