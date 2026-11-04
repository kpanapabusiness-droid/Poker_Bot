/*
 * strategy.js — the decision layer: tells you exactly what to do and how much.
 *
 * Preflop:  position charts → open / limp behind / 3-bet (value or bluff) / call / 4-bet / fold,
 *           with sizes in big blinds, plus push/fold mode for short stacks.
 * Postflop: scores every option by expected value (EV) — fold, check, call, bet ⅓/½/¾/pot,
 *           raise, all-in — using each opponent's range and a fold-equity model, then picks the best
 *           and tags it VALUE / PROTECTION / SEMI-BLUFF / BLUFF.
 *
 * All numbers here are STARTER defaults for typical casual (Torn) players. Phase 3 replaces the
 * population fold model with each opponent's real stats.
 *
 * Depends on poker-engine.js (global PokerEngine in the browser, require() in Node).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./poker-engine.js'));
  else root.PokerStrategy = factory(root.PokerEngine);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  // ─────────────────────────── Tunable model ───────────────────────────
  const MODEL = {
    // How often a typical casual player folds to a bet of size f (bet / pot). Casual players call too much.
    fold: { base: 0.26, slope: 0.30, max: 0.78, riverBonus: 0.06, vsRaiseBonus: 0.06, multiwayPenalty: 0.0 },
    // Share of your equity you actually realise before showdown (position + future streets).
    realise: { ip: 0.95, oop: 0.85, river: 1.0 },
    betSizes: [0.33, 0.5, 0.75, 1.0],
    raiseMultipliers: [2.5, 3.5],
    equityIters: 3000,
    preferSimpleWithin: 0.02, // if a bet beats check/call by < 2% of the pot, take the simpler line
  };

  // Preflop ranges (starter charts; replace with solver charts later)
  const RANGES = {
    overLimp: '22-99,A2s-A9s,KTs,QTs,J9s+,T8s+,97s+,86s+,75s+,64s+,54s',
    bbRaiseVsLimp: 'TT+,AJs+,KQs,AQo+',
    value3bet: 'QQ+,AKs,AKo',
    value3betVsLate: 'JJ+,AQs+,AQo+',
    bluff3bet: 'A5s,A4s',
    flat: '22-JJ,ATs-AQs,KJs+,QJs,JTs,T9s,98s,87s,AQo',
    flatBtnExtra: 'AJo,KQo,ATs,KTs,QTs,J9s,76s',
    bbDefendExtra: 'A2s-A9s,K9s,Q9s,J9s,T8s,97s,86s,75s,65s,54s,ATo,KJo,QJo,JTo',
    fourBet: 'KK+,AKs',
    call3bet: 'QQ,JJ,AKo,AQs',
    // push/fold (≤ 12bb effective), by position
    shove: {
      EP: '66+,ATs+,AJo+,KQs', LJ: '55+,A9s+,ATo+,KJs+,KQo', HJ: '44+,A8s+,ATo+,KTs+,KQo,QJs',
      CO: '22+,A2s+,A7o+,K9s+,KJo+,QTs+,JTs', BTN: '22+,A2s+,A2o+,K5s+,K9o+,Q8s+,QTo+,J8s+,JTo,T8s+,98s',
      SB: '22+,A2s+,A2o+,K2s+,K7o+,Q6s+,Q9o+,J7s+,J9o+,T7s+,97s+,87s', BB: '22+,A2s+,A5o+,K8s+,KTo+,QTs+,JTs',
    },
    callShove: '77+,ATs+,AJo+,KQs',
  };
  const _r = {};
  const R = txt => _r[txt] || (_r[txt] = E.parseRange(txt));
  const has = (hand, txt) => E.inRange(hand, R(txt));

  // ─────────────────────────── Helpers ───────────────────────────
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const roundTo = (x, step) => (step > 0 ? Math.max(step, Math.round(x / step) * step) : Math.round(x));
  const money = x => '$' + Math.round(x).toLocaleString();
  const pct = x => Math.round(x * 100) + '%';

  /** Probability a casual player folds to a bet/raise that is `f` times the pot. */
  function foldProb(f, { street, vsRaise, model = MODEL.fold, override } = {}) {
    if (override != null) return override;
    let p = model.base + model.slope * f;
    if (street === 'river') p += model.riverBonus;
    if (vsRaise) p += model.vsRaiseBonus;
    return clamp(p, 0, model.max);
  }

  /** Rank a villain's combos by how strong they are on this board (strongest first). */
  function strengthTable(combos, board, dead) {
    const deadSet = new Set(dead);
    const b = board, cat = 1048576;
    return combos
      .filter(([x, y]) => !deadSet.has(x) && !deadSet.has(y))
      .map(c => {
        let s = E.evaluate([...c, ...b]);
        if (b.length < 5) {
          const f = E.handFeatures(c, b);
          if (f.flushDraw) s += 1.3 * cat;
          if (f.straightDraw) s += 0.8 * cat;
        }
        return { c, s };
      })
      .sort((p, q) => q.s - p.s);
  }

  /** The part of a range that continues when it folds `fold` of the time: the strongest (1 - fold). */
  function continuing(table, fold) {
    const n = Math.max(1, Math.ceil(table.length * (1 - fold)));
    return table.slice(0, n).map(t => t.c);
  }

  function heroEquity(hero, board, villainRanges, iters) {
    try { return E.equity({ hero, board, villains: villainRanges, iterations: iters }).equity; }
    catch (e) { return E.equity({ hero, board, villains: villainRanges.map(() => null), iterations: iters }).equity; }
  }

  // ─────────────────────────── Preflop ───────────────────────────
  /**
   * ctx: { hero:[c,c], position, bb, heroStack, heroBet, toCall, pot, actions (this hand), heroName,
   *        villains:[{name, position, stack, bet}], numDealt }
   */
  function preflop(ctx) {
    const { hero, position: pos, bb } = ctx;
    const hc = E.handClass(hero);
    const pf = parsePreflop(ctx.actions, ctx.heroName);
    const eff = effectiveStack(ctx);
    const effBB = bb ? eff / bb : 100;
    const out = (action, amount, tag, reason, extra = {}) => ({ street: 'preflop', action, amount, tag, reason, handClass: hc, effBB, ...extra });
    const raiseTo = mult => roundTo(Math.min(mult * bb, ctx.heroStack + ctx.heroBet), bb);

    // Short stack: push or fold
    if (effBB <= 12 && pf.raises <= 1) {
      if (pf.raises === 0) {
        const range = RANGES.shove[pos] || RANGES.shove.CO;
        if (pos === 'BB' && ctx.toCall === 0 && !has(hero, range)) return out('CHECK', 0, 'PUSH/FOLD', `${effBB.toFixed(0)}bb deep: check your option`);
        return has(hero, range)
          ? out('ALL-IN', ctx.heroStack + ctx.heroBet, 'PUSH/FOLD', `${effBB.toFixed(0)}bb deep: ${hc} is a shove from ${pos}`)
          : out('FOLD', 0, 'PUSH/FOLD', `${effBB.toFixed(0)}bb deep: ${hc} isn't strong enough to shove from ${pos}`);
      }
      return has(hero, RANGES.callShove) || has(hero, RANGES.value3bet)
        ? out('ALL-IN', ctx.heroStack + ctx.heroBet, 'PUSH/FOLD', `${effBB.toFixed(0)}bb deep facing a raise: ${hc} is strong enough to get it in`)
        : out('FOLD', 0, 'PUSH/FOLD', `${effBB.toFixed(0)}bb deep facing a raise: ${hc} is too weak`);
    }

    // Unopened pot (maybe limpers)
    if (pf.raises === 0) {
      if (pos === 'BB') {
        if (pf.limpers > 0 && has(hero, RANGES.bbRaiseVsLimp))
          return out('RAISE', raiseTo(4 + pf.limpers), 'VALUE', `Raise the limpers: ${hc} is well ahead of limping hands`);
        return out('CHECK', 0, 'CHART', `Free flop in the big blind with ${hc}`);
      }
      const rfi = E.rfiRange(pos === 'BB' ? 'SB' : pos);
      if (E.inRange(hero, rfi)) {
        const size = pos === 'SB' ? 3 : 2.5 + pf.limpers; // +1bb per limper
        return out('RAISE', raiseTo(pf.limpers ? 3 + pf.limpers : size), 'VALUE',
          pf.limpers ? `${hc} is a raise over ${pf.limpers} limper${pf.limpers > 1 ? 's' : ''} from ${pos}` : `${hc} is in the ${pos} opening range — open`);
      }
      if (pf.limpers > 0 && has(hero, RANGES.overLimp) && ctx.toCall <= bb)
        return out('CALL', ctx.toCall, 'CHART', `Limp behind: ${hc} plays well multiway for a cheap price (sets/straights/flushes)`);
      if (ctx.toCall === 0) return out('CHECK', 0, 'CHART', 'Check');
      return out('FOLD', 0, 'CHART', `${hc} isn't in the ${pos} opening range — fold`);
    }

    // Facing exactly one raise
    if (pf.raises === 1 && !pf.heroRaised) {
      const opener = ctx.villains.find(v => v.name === pf.lastRaiser);
      const oPos = opener ? opener.position : 'CO';
      const late = ['CO', 'BTN', 'SB'].includes(oPos);
      const ip = !['SB', 'BB'].includes(pos);
      const value = has(hero, RANGES.value3bet) || (late && has(hero, RANGES.value3betVsLate));
      const bluff = !value && has(hero, RANGES.bluff3bet) && (late || pos === 'BTN');
      const threeBetTo = raiseTo(((pf.lastRaiseTo || 3 * bb) / bb) * (ip ? 3 : 4) + pf.callers);
      if (value) return out('RAISE', threeBetTo, 'VALUE', `3-bet ${hc} for value vs the ${oPos} open`);
      if (bluff) return out('RAISE', threeBetTo, 'BLUFF', `3-bet bluff: ${hc} blocks big aces and plays OK if called`);
      const price = ctx.toCall;
      const setMine = /^(\w)\1$/.test(hc) && price <= 0.07 * eff; // pocket pairs need ~15:1 implied odds
      const flatOk = has(hero, RANGES.flat) || (pos === 'BTN' && has(hero, RANGES.flatBtnExtra));
      if (flatOk && (!/^(\w)\1$/.test(hc) || setMine))
        return out('CALL', price, 'CHART', `Call: ${hc} plays well vs a ${oPos} open${ip ? ' with position' : ''}`);
      if (pos === 'BB' && has(hero, RANGES.flat + ',' + RANGES.bbDefendExtra)) {
        const eq = heroEquity(hero, [], [E.rfiRange(oPos === 'BB' ? 'SB' : oPos)], 2500);
        const need = price / (ctx.pot + price);
        if (eq * MODEL.realise.oop >= need)
          return out('CALL', price, 'CHART', `Defend the big blind: ${pct(eq)} vs their range, you need ${pct(need)}`);
      }
      return out('FOLD', 0, 'CHART', `${hc} doesn't play well vs a ${oPos} raise — fold`);
    }

    // Facing a 3-bet or more
    if (has(hero, RANGES.fourBet)) {
      const big = (pf.lastRaiseTo || 9 * bb) * 2.3;
      return big >= 0.4 * eff
        ? out('ALL-IN', ctx.heroStack + ctx.heroBet, 'VALUE', `${hc} vs a re-raise: get it all in`)
        : out('RAISE', roundTo(big, bb), 'VALUE', `4-bet ${hc} for value`);
    }
    if (pf.heroRaised && has(hero, RANGES.call3bet) && ctx.toCall <= 0.3 * eff)
      return out('CALL', ctx.toCall, 'CHART', `Call the 3-bet with ${hc} — too strong to fold, not strong enough to 4-bet`);
    return out('FOLD', 0, 'CHART', `${hc} vs ${pf.raises >= 2 ? 'a 3-bet' : 'a re-raise'}: fold`);
  }

  function parsePreflop(actions, heroName) {
    const r = { raises: 0, limpers: 0, callers: 0, lastRaiseTo: 0, lastRaiser: null, heroRaised: false };
    for (const a of actions || []) {
      if (a.type === 'street' && a.street !== 'preflop') break;
      if (a.type === 'raise' || a.type === 'allin' || (a.type === 'bet')) {
        r.raises++; r.lastRaiseTo = a.to || a.amount; r.lastRaiser = a.actor; r.callers = 0;
        if (a.actor === heroName) r.heroRaised = true;
      } else if (a.type === 'call') {
        if (r.raises === 0) r.limpers++; else r.callers++;
      }
    }
    return r;
  }

  function effectiveStack(ctx) {
    const heroTotal = ctx.heroStack + ctx.heroBet;
    const opp = Math.max(0, ...ctx.villains.map(v => (v.stack || 0) + (v.bet || 0)));
    return opp ? Math.min(heroTotal, opp) : heroTotal;
  }

  // ─────────────────────────── Postflop ───────────────────────────
  /**
   * ctx: { hero, board, pot, toCall, heroStack, heroBet, bb, position, street,
   *        villains:[{ name, combos|null, stack, bet, foldOverride? }], inPosition? }
   */
  function postflop(ctx) {
    const { hero, board, pot } = ctx;
    const street = ctx.street || (board.length === 3 ? 'flop' : board.length === 4 ? 'turn' : 'river');
    const step = ctx.bb || 1;
    const eff = effectiveStack(ctx);
    const heroAll = ctx.heroStack; // what hero can still add
    const ip = ctx.inPosition != null ? ctx.inPosition : ['BTN', 'CO'].includes(ctx.position);
    const real = street === 'river' ? MODEL.realise.river : ip ? MODEL.realise.ip : MODEL.realise.oop;
    const dead = [...hero, ...board];
    const villains = ctx.villains.length ? ctx.villains : [{ name: '?', combos: null, stack: eff, bet: 0 }];
    const tables = villains.map(v => strengthTable(v.combos || E.allCombos(), board, dead));
    const baseRanges = tables.map(t => t.map(x => x.c));
    const eq = heroEquity(hero, board, baseRanges, MODEL.equityIters * 2);
    const feat = E.handFeatures(hero, board);
    const maxBet = Math.max(0, ...villains.map(v => v.bet || 0));
    const facing = ctx.toCall > 0;
    const options = [];

    // Fold / check / call
    if (facing) {
      options.push({ action: 'FOLD', amount: 0, ev: 0 });
      const call = Math.min(ctx.toCall, heroAll);
      options.push({ action: call >= heroAll ? 'ALL-IN' : 'CALL', amount: call, ev: eq * real * (pot + call) - call, eq });
    } else {
      options.push({ action: 'CHECK', amount: 0, ev: eq * real * pot, eq });
    }

    // Bets / raises
    const sizes = [];
    if (!facing) {
      for (const f of MODEL.betSizes) sizes.push({ kind: 'BET', add: roundTo(f * pot, step), label: labelSize(f) });
    } else {
      for (const m of MODEL.raiseMultipliers) sizes.push({ kind: 'RAISE', to: roundTo(m * maxBet, step), label: `${m}x` });
    }
    if (eff <= 3 * pot || heroAll <= 1.2 * pot) sizes.push({ kind: 'ALL-IN', add: heroAll, label: 'all-in' });

    for (const s of sizes) {
      let add = s.kind === 'RAISE' ? s.to - ctx.heroBet : s.add;
      if (add >= heroAll) add = heroAll;
      if (add <= ctx.toCall) continue; // not a real raise
      const isAllIn = add >= heroAll;
      const totalTo = ctx.heroBet + add;
      const villainCall = Math.max(0, totalTo - maxBet); // what the bettor (or a checker) must add to continue
      const f = villainCall / (pot + add);
      const folds = villains.map((v, i) => foldProb(f, { street, vsRaise: facing, override: v.foldOverride != null ? clamp(v.foldOverride + 0.25 * (f - 0.5), 0, 0.95) : null }));
      const allFold = folds.reduce((p, x) => p * x, 1);
      const contRanges = tables.map((t, i) => continuing(t, folds[i]));
      const nCallers = Math.max(1, folds.reduce((n, x) => n + (1 - x), 0));
      const eqC = heroEquity(hero, board, contRanges, MODEL.equityIters);
      const finalPot = pot + add + villainCall * nCallers;
      const ev = allFold * pot + (1 - allFold) * (eqC * (street === 'river' ? 1 : real) * finalPot - add);
      options.push({
        action: isAllIn ? 'ALL-IN' : s.kind === 'BET' ? 'BET' : 'RAISE',
        amount: totalTo, add, sizeLabel: isAllIn ? 'all-in' : s.label, ev, eqC,
        foldEst: allFold, foldNeeded: add / (pot + add),
      });
    }

    // Pick the best, preferring the simpler line when it's close
    options.sort((a, b) => b.ev - a.ev);
    let best = options[0];
    const passive = options.find(o => ['CHECK', 'CALL'].includes(o.action));
    if (passive && best !== passive && best.ev - passive.ev < MODEL.preferSimpleWithin * pot) best = passive;
    if (best.action === 'CALL' && best.ev < 0) best = options.find(o => o.action === 'FOLD') || best;

    // Explain it
    let tag = 'CHART', reason;
    const heroMade = E.handName(E.evaluate([...hero, ...board]));
    if (['BET', 'RAISE', 'ALL-IN'].includes(best.action) && best.eqC != null && best.action !== 'CALL') {
      const madeValue = feat.topPairPlus || (feat.improved && feat.made >= 2);
      if (best.eqC >= 0.55 && (madeValue || !feat.draw || street === 'river')) { tag = 'VALUE'; reason = `${heroMade}: worse hands will call — ${pct(best.eqC)} when called`; }
      else if (street !== 'river' && feat.draw) { tag = 'SEMI-BLUFF'; reason = `${feat.flushDraw ? 'Flush draw' : 'Straight draw'}: win now if they fold, still ${pct(best.eqC)} if called`; }
      else if (eq >= 0.5) { tag = 'PROTECTION'; reason = `Ahead now but vulnerable — charge their draws (${pct(eq)} vs their range)`; }
      else { tag = 'BLUFF'; reason = `Needs a fold ${pct(best.foldNeeded)} of the time — estimate ${pct(best.foldEst)} for this size`; }
    } else if (best.action === 'CALL' || (best.action === 'ALL-IN' && facing && best.eqC == null)) {
      tag = 'CALL'; reason = `${pct(eq)} vs their range, you need ${pct(ctx.toCall / (pot + ctx.toCall))} — profitable call`;
    } else if (best.action === 'CHECK') {
      tag = eq >= 0.5 ? 'POT CONTROL' : 'CHECK';
      reason = eq >= 0.5 ? `${heroMade} is ahead but betting folds out worse and gets called by better` : `Not strong enough to bet and they won't fold enough to bluff`;
    } else if (best.action === 'FOLD') {
      tag = 'FOLD'; reason = `${pct(eq)} vs their range but you need ${pct(ctx.toCall / (pot + ctx.toCall))} — let it go`;
    }

    return {
      street, action: best.action, amount: best.action === 'CALL' || best.action === 'FOLD' || best.action === 'CHECK' ? best.amount : best.amount,
      add: best.add, sizeLabel: best.sizeLabel, tag, reason, equity: eq, eqWhenCalled: best.eqC, foldEst: best.foldEst,
      foldNeeded: best.foldNeeded, ev: best.ev, handName: heroMade, features: feat,
      options: options.map(o => ({ action: o.action, amount: o.amount, sizeLabel: o.sizeLabel, ev: o.ev })),
    };
  }

  function labelSize(f) { return f === 1 ? 'pot' : f === 0.5 ? '½ pot' : f === 0.75 ? '¾ pot' : f === 0.33 ? '⅓ pot' : Math.round(f * 100) + '%'; }

  /** One entry point: picks preflop or postflop logic. */
  function decide(ctx) {
    return ctx.board && ctx.board.length >= 3 ? postflop(ctx) : preflop(ctx);
  }

  /** Short human-readable line, e.g. "RAISE to $60" / "BET $35 (½ pot)". */
  function describe(d) {
    switch (d.action) {
      case 'FOLD': case 'CHECK': return d.action;
      case 'CALL': return `CALL ${money(d.amount)}`;
      case 'BET': return `BET ${money(d.amount)}${d.sizeLabel ? ` (${d.sizeLabel})` : ''}`;
      case 'RAISE': return `RAISE to ${money(d.amount)}`;
      case 'ALL-IN': return `ALL-IN ${money(d.amount)}`;
      default: return d.action;
    }
  }

  return { MODEL, RANGES, decide, preflop, postflop, describe, foldProb, strengthTable, continuing, parsePreflop };
});
