/*
 * icm.js — tournament chip values (Independent Chip Model, Malmuth–Harville).
 *
 * In a tournament, chips aren't money: doubling your stack doesn't double your prize equity, and
 * busting costs more than the chips. ICM turns everyone's stacks + the payout table into each
 * player's share of the prize pool. Kept separate from the cash-game EV maths on purpose: strategy.js
 * only uses it when ctx.format is a tournament AND payouts are known; otherwise decisions stay chip EV.
 *
 *   ICM.equity([5000, 3000, 2000], [0.5, 0.3, 0.2])  → each player's expected share of the pool
 *   ICM.allInValue({ stacks, payouts, hero, villain, risk, win, eq })  → $EV of calling/shoving vs folding
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PokerICM = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * Each player's prize equity. Malmuth–Harville: the chance to finish 1st is your share of the chips;
   * given who finished ahead, the next place is your share of the chips that remain. Exact, with the
   * players still to be placed memoised as a bitmask (fine up to ~12 players).
   */
  function equity(stacks, payouts) {
    const n = stacks.length;
    const pay = payouts.slice(0, n);
    const total = stacks.reduce((a, b) => a + Math.max(0, b), 0);
    const out = new Array(n).fill(0);
    if (total <= 0) return out;
    const memo = new Map();
    // probability-weighted equity for each player, given `mask` = players not yet placed, next place `place`
    function rec(mask, place) {
      if (place >= pay.length || mask === 0) return null;
      const key = mask;
      if (memo.has(key)) return memo.get(key);
      let left = 0;
      for (let i = 0; i < n; i++) if (mask & (1 << i)) left += Math.max(0, stacks[i]);
      const res = new Array(n).fill(0);
      if (left <= 0) { memo.set(key, res); return res; }
      for (let i = 0; i < n; i++) {
        if (!(mask & (1 << i)) || stacks[i] <= 0) continue;
        const p = stacks[i] / left;
        res[i] += p * pay[place];
        const sub = rec(mask & ~(1 << i), place + 1);
        if (sub) for (let j = 0; j < n; j++) res[j] += p * sub[j];
      }
      memo.set(key, res);
      return res;
    }
    const all = (1 << n) - 1;
    const r = rec(all, 0) || out;
    // players with no chips are out; they only keep whatever places are left over (none in practice)
    return r;
  }

  /**
   * Prize-equity value of an all-in confrontation between hero and one villain, vs folding.
   *   stacks: everyone's chips BEFORE this pot is settled (hero's and villain's chips not yet in the pot)
   *   potOthers: chips already in the middle that neither of us will get back if we fold (blinds, antes,
   *              other players' dead money); win: what hero wins on top of his own risk if he wins
   *   risk: what hero puts at risk (his remaining stack, or the call amount if the villain covers less)
   *   eq: hero's chance to win the all-in
   *   foldEq (shove only): chance the villain folds; then hero just collects potOthers (+ villain's posted chips)
   * Returns { fold, allIn, chipEV, icmEV, requiredEquity } — the $ equities (share of the pool).
   */
  function allInValue({ stacks, payouts, hero, villain, risk, win, eq, foldEq = 0, foldGain = 0, foldStacks = null }) {
    const base = foldStacks || stacks;
    const fold = equity(base, payouts)[hero];
    const winS = stacks.slice(), loseS = stacks.slice();
    winS[hero] += win; winS[villain] -= Math.min(stacks[villain], risk);
    loseS[hero] -= risk; loseS[villain] += risk + (win - Math.min(stacks[villain], risk));
    const eW = equity(winS, payouts)[hero], eL = equity(loseS, payouts)[hero];
    let fe = 0;
    if (foldEq > 0) { const fs = stacks.slice(); fs[hero] += foldGain; fe = equity(fs, payouts)[hero]; }
    const called = eq * eW + (1 - eq) * eL;
    const allIn = foldEq * fe + (1 - foldEq) * called;
    // equity needed to call (no fold equity): the eq at which calling = folding
    const req = eW - eL > 1e-12 ? (fold - eL) / (eW - eL) : 1;
    return { fold, allIn, requiredEquity: Math.max(0, Math.min(1, req)) };
  }

  /** Bubble factor: how much more a chip lost is worth than a chip won, for hero vs villain (1 = cash game). */
  function bubbleFactor(stacks, payouts, hero, villain, amount) {
    const cur = equity(stacks, payouts)[hero];
    const w = stacks.slice(), l = stacks.slice();
    const a = Math.min(amount, stacks[hero], stacks[villain]);
    w[hero] += a; w[villain] -= a; l[hero] -= a; l[villain] += a;
    const gain = equity(w, payouts)[hero] - cur, loss = cur - equity(l, payouts)[hero];
    return gain > 1e-12 ? loss / gain : Infinity;
  }

  return { equity, allInValue, bubbleFactor };
});
