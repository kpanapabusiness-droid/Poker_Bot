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
  if (typeof module === 'object' && module.exports) {
    let icm = null; try { icm = require('./icm.js'); } catch (e) { icm = null; }
    module.exports = factory(require('./poker-engine.js'), icm);
  } else root.PokerStrategy = factory(root.PokerEngine, root.PokerICM || null);
})(typeof self !== 'undefined' ? self : this, function (E, ICM) {
  'use strict';

  // ─────────────────────────── Tunable model ───────────────────────────
  const MODEL = {
    // How often a typical casual player folds to a bet of size f (bet / pot). Casual players call too much.
    fold: { base: 0.26, slope: 0.15, max: 0.78, riverBonus: 0.06, vsRaiseBonus: 0.06, multiwayPenalty: 0.0 },
    // Share of your equity you actually realise before showdown (position + future streets).
    realise: { ip: 0.95, oop: 0.85, river: 1.0 },
    // Hand-aware realisation (6 Nov): out of position you act first every street, so opponents bet you
    // off your equity; how much you lose depends on the hand. on:false goes back to the flat numbers above.
    realiseHand: {
      on: false,
      oop: { flop: 0.78, turn: 0.86 }, ip: { flop: 0.98, turn: 1.0 },
      draw: 0.08,       // flush draws / open-enders keep their equity better (and win big pots)
      weakMade: -0.08,  // second pair and worse: hard to play, often folded by the river
      multiway: -0.04,  // per extra opponent
      preflop: { pair: 0.05, suited: 0.05, connected: 0.03, offsuitJunk: -0.08 },
      min: 0.55, max: 1.05,
    },
    // Out of position after calling preflop, don't lead into the raiser on the flop with less than a
    // value hand: check and let them c-bet (they bet most flops), then check-raise or call.
    noDonk: false,
    // Opening ranges by table size (players dealt in): heads-up the button opens most hands, and
    // the first seat at a full 9-handed table plays tighter than a generic early seat.
    rfiBySize: { on: true, headsUp: 0.80, utg9: 0.10, utg8: 0.115 },
    // Exploits (6 Nov). elastic: how much more a player folds as the bet grows depends on who they
    // are: callers barely change (so value bets go bigger), tight players fold much more to big bets.
    // overbets: extra bet sizes above the pot.
    exploit: { elastic: false, slopeBase: 0.05, slopeF2b: 0.5, overbets: [] },
    // Small bets get few folds: nobody folds a big share of hands for a cheap price. Folds are capped
    // at mdfCap × the share that "minimum defence" allows (bet / (pot + bet)). 0 = off.
    // Off since 7 Nov: folds now come from the opponent's own range, and a capped, weak range should
    // fold far more than "minimum defence" — the cap blocked that. (It was added for a hand that turned
    // out to be a misread bet.)
    mdfCap: 0,
    // Raising someone who bet: the hands that call a raise are a stronger slice of their range than a
    // straight "top (1 − fold)" cut. Equity when called is measured against this share of it. 1 = off.
    raiseCallShare: 0.6,
    raiseCallStreets: ['river'],  // where that applies (earlier streets, draws and medium hands call raises too)
    // A raise that only works as a bluff must beat calling/checking by this share of the pot: the
    // fold estimate is the least reliable number here, so don't bluff away a hand that can win at showdown
    // on a thin edge.
    bluffMargin: 0.10,  // (replaced by `uncertainty` below; kept so old overrides don't break)
    // margin (share of the pot) an aggressive line must beat the passive one by: base + unknown × u,
    // u = 1 with no read (< 15 hands), 0.6, 0.3, 0.1 with 100+ hands
    uncertainty: { base: 0.04, unknown: 0.08 },
    // preflop exploit: 3-bet bluffs by the opener's fold-to-3-bet (after seeing them face minSeen 3-bets)
    exploit3bet: { minSeen: 6, wideAt: 0.65, noneAt: 0.35, extra: 'A2s-A3s,K9s,KTs,QTs,JTs,T9s,98s,87s,76s' },
    // How villains respond to our bets/raises (rangeFolds on): each holding continues with probability
    // rising around an absolute strength threshold that goes up with the price (need = their call /
    // the pot after calling) and when they're facing a raise. off = the older population fold curve.
    rangeFolds: true,
    // learn per opponent how far our fold predictions are off (tracker foldBias) and correct for it
    learnFolds: true,
    // How opponents' ranges are narrowed by their own actions (brain.js applyPostflop):
    // [value threshold, call threshold] within their range by street, bluff/float weights from aggression.
    // preflop ranges for opponents: soft edge and a floor (0 = the old hard cut)
    preflopSoft: { on: true, edge: 0.06, floor: 0.03 },
    // Calibrated 7 Nov against the simulator's real hole cards: with these, the bettor's real hand sits at
    // the 52nd percentile of the modelled river range (50 = unbiased; the old values put it at the 30th).
    rangeModel: { base: { flop: [0.55, 0.25], turn: [0.58, 0.30], river: [0.60, 0.35] }, bluffBase: 0.12, bluffPerAf: 0.07, bluffMax: 0.45,
                  floatScale: 1.0, slowplay: 0.25 },
    // Calibrated 7 Nov against simulated folds (expected vs actual, turn bluffs 41% vs 46%): casual players
    // call more than a range-reasoner would, so perceivedWeight is 0.25 (it was 0.5) and thresholds lower.
    response: { base: { flop: 0.48, turn: 0.48, river: 0.50 }, priceSlope: 0.6, vsRaise: 0.06, f2bShift: 1.0, width: 0.04, drawCall: 0.95,
                // perceived-range model: continue when equity vs what our bet represents > price + callBias + stickiness × (f2b − 0.4)
                callBias: 0.0, stickiness: 1.2, eqWidth: 0.06, perceivedWeight: 0.25, perceivedWeightVsRaise: 0.75, runoutSamples: 48, strongHand: 0.85 },
    // Stack depth preflop: short (≤ shortBB) drops speculative calls/limps that need deep stacks to
    // pay off; deep (≥ deepBB) adds more of them in position.
    depth: { on: true, shortBB: 40, deepBB: 150, deepFlat: '22-66,A2s-A9s,K9s,Q9s,J9s,T8s,97s,86s,75s,64s,54s' },
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

  // ─────────────────────────── Tournaments (ICM) ───────────────────────────
  /**
   * Only for ctx.format === 'tournament' with ctx.payouts (prize shares, 1st first) and ctx.stacksBehind
   * ({ name: chips behind now }, everyone still in the tournament at this table, 'Hero' included).
   * Without payouts, tournament decisions stay chip EV and say so.
   */
  const icmOn = ctx => !!(ICM && ctx.format === 'tournament' && Array.isArray(ctx.payouts) && ctx.payouts.length && ctx.stacksBehind);
  /** Prize equity of calling an all-in: pot goes to the winner; a fold gives the pot to the villain. */
  function icmCall(ctx, villainName, call, eq) {
    const names = Object.keys(ctx.stacksBehind), h = names.indexOf(ctx.heroName || 'Hero'), v = names.indexOf(villainName);
    if (h < 0 || v < 0) return null;
    const S = names.map(n => Math.max(0, ctx.stacksBehind[n]));
    const fold = S.slice(); fold[v] += ctx.pot;
    const win = S.slice(); win[h] += ctx.pot;
    const lose = S.slice(); lose[h] -= Math.min(call, S[h]); lose[v] += ctx.pot + Math.min(call, S[h]);
    const eF = ICM.equity(fold, ctx.payouts)[h], eW = ICM.equity(win, ctx.payouts)[h], eL = ICM.equity(lose, ctx.payouts)[h];
    const req = eW - eL > 1e-12 ? clamp((eF - eL) / (eW - eL), 0, 1) : 1;
    return { req, fold: eF, call: eq * eW + (1 - eq) * eL };
  }
  /** Prize equity of an unopened shove: everyone behind may call with a range that widens as they get shorter. */
  function icmShove(ctx, heroCards, behind) {
    const names = Object.keys(ctx.stacksBehind), h = names.indexOf(ctx.heroName || 'Hero');
    if (h < 0) return null;
    const S = names.map(n => Math.max(0, ctx.stacksBehind[n]));
    const fold = ICM.equity(S, ctx.payouts)[h];
    let pAllFold = 1, ev = 0;
    const calls = behind.map(v => {
      const i = names.indexOf(v.name); if (i < 0) return null;
      const bbs = (S[i] + (v.bet || 0)) / (ctx.bb || 1);
      const width = clamp(0.06 + 1.2 / Math.max(1, bbs), 0.06, 0.45);  // shorter stacks call wider
      return { i, p: width, range: E.topRange(width) };
    }).filter(Boolean);
    calls.forEach(c => { pAllFold *= 1 - c.p; });
    const steal = S.slice(); steal[h] += ctx.pot;
    ev += pAllFold * ICM.equity(steal, ctx.payouts)[h];
    for (const c of calls) {  // first-caller approximation: this player calls, the rest fold
      const pc = c.p * calls.filter(x => x !== c).reduce((q, x) => q * (1 - x.p), 1);
      const eq = heroEquity(heroCards, [], [c.range], 2000);
      const risk = Math.min(S[h], S[c.i] + 0);
      const win = S.slice(); win[h] += ctx.pot + risk; win[c.i] -= risk;
      const lose = S.slice(); lose[h] -= risk; lose[c.i] += ctx.pot + risk;
      ev += pc * (eq * ICM.equity(win, ctx.payouts)[h] + (1 - eq) * ICM.equity(lose, ctx.payouts)[h]);
    }
    const pCovered = 1 - pAllFold - calls.reduce((t, c) => t + c.p * calls.filter(x => x !== c).reduce((q, x) => q * (1 - x.p), 1), 0);
    ev += Math.max(0, pCovered) * fold * 0.6;  // two or more callers: rare; valued pessimistically
    return { shove: ev, fold };
  }

  // ─────────────────────────── Helpers ───────────────────────────
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const roundTo = (x, step) => (step > 0 ? Math.max(step, Math.round(x / step) * step) : Math.round(x));
  const money = x => '$' + Math.round(x).toLocaleString();

  /** The opening range for this seat, given how many players were dealt in (ctx.tableSize). */
  function openRange(ctx, pos) {
    const R2 = MODEL.rfiBySize, n = ctx.tableSize;
    if (R2.on && n) {
      if (n === 2 && pos === 'BTN') return E.topRange(R2.headsUp);
      if (pos === 'EP' && ctx.seatsFromButton === 3 && n >= 8) return E.topRange(n === 9 ? R2.utg9 : R2.utg8);
    }
    return E.rfiRange(pos === 'BB' ? 'SB' : pos);
  }

  /** Share of preflop equity a big blind defender keeps out of position, by hand shape ('KJo', '76s', '55'). */
  function preflopRealise(hc) {
    const RH = MODEL.realiseHand;
    if (!RH.on) return MODEL.realise.oop;
    const order = '23456789TJQKA';
    const pair = hc.length === 2 || hc[0] === hc[1];
    const suited = hc[2] === 's';
    const gap = Math.abs(order.indexOf(hc[0]) - order.indexOf(hc[1])) - 1;
    let r = RH.oop.flop;
    if (pair) r += RH.preflop.pair;
    if (suited) r += RH.preflop.suited;
    if (!pair && gap <= 1) r += RH.preflop.connected;
    if (!pair && !suited && gap >= 2 && order.indexOf(hc[0]) < 10 + (hc[0] === 'A' ? 2 : 0)) r += RH.preflop.offsuitJunk;
    return clamp(r, RH.min, RH.max);
  }

  /** Share of equity we keep to showdown postflop (position, street, hand type, number of opponents). */
  function postflopRealise(ip, street, feat, nOpp) {
    if (street === 'river') return MODEL.realise.river;
    const RH = MODEL.realiseHand;
    if (!RH.on) return ip ? MODEL.realise.ip : MODEL.realise.oop;
    let r = (ip ? RH.ip : RH.oop)[street] ?? (ip ? MODEL.realise.ip : MODEL.realise.oop);
    if (feat.draw) r += RH.draw;
    if (feat.improved && feat.made >= 1 && !feat.topPairPlus && !feat.draw) r += RH.weakMade * (ip ? 0.5 : 1);
    r += RH.multiway * Math.max(0, nOpp - 1);
    return clamp(r, RH.min, RH.max);
  }

  /** Did someone other than hero make the last preflop raise (and are they still in the hand)? */
  function villainHasInitiative(ctx) {
    const pf = parsePreflop(ctx.actions, ctx.heroName);
    if (!pf.lastRaiser || pf.lastRaiser === ctx.heroName) return false;
    return ctx.villains.some(v => v.name === pf.lastRaiser);
  }
  const pct = x => Math.round(x * 100) + '%';

  /** Probability a casual player folds to a bet/raise that is `f` times the pot. */
  /**
   * How often this villain folds to our bet/raise. A tracked fold-to-bet rate is mostly made of
   * spots where they checked or called; it says little about a player who has just bet and faces
   * a raise. So when they have chips in (we're raising their bet) we use the vs-raise model, scaled
   * by how often they bluff (aggression): a passive player who bets has it.
   */
  function villainFold(v, f, street, facing) {
    // f = what they must add / the pot after our bet. The share of hands minimum defence lets them
    // fold is f; nobody folds much more than that to a cheap bet.
    const cap = MODEL.mdfCap > 0 ? MODEL.mdfCap * f : 1;
    if (facing && (v.bet || 0) > 0) {
      const p = foldProb(f, { street, vsRaise: true });
      const k = v.aggression != null ? clamp(0.45 + 0.2 * v.aggression, 0.5, 1.15) : 1;
      return clamp(Math.min(p * k, cap), 0, MODEL.fold.max);
    }
    const X = MODEL.exploit;
    const slope = X.elastic && v.foldOverride != null ? X.slopeBase + X.slopeF2b * v.foldOverride : 0.25;
    const p = foldProb(f, { street, vsRaise: facing, override: v.foldOverride != null ? clamp(v.foldOverride + slope * (f - 0.5), 0, 0.95) : null });
    return Math.min(p, cap);
  }

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
      .filter(([x, y, w]) => !deadSet.has(x) && !deadSet.has(y) && (w == null || w > 0))
      .map(c => {
        const h = [c[0], c[1]];  // weighted ranges carry the weight as a third item: never feed it to the evaluator
        let s = E.evaluate([...h, ...b]);
        if (b.length < 5) {
          const f = E.handFeatures(h, b);
          if (f.flushDraw) s += 1.3 * cat;
          if (f.straightDraw) s += 0.8 * cat;
        }
        return { c, s, w: c.length > 2 ? c[2] : 1, draw: b.length < 5 && E.handFeatures(h, b).draw };
      })
      .sort((p, q) => q.s - p.s);
  }

  /** The part of a range that continues when it folds `fold` of the time: the strongest (1 - fold). */
  /** The strongest part of a range that carries (1 − fold) of its weight: who continues vs our bet. */
  function continuing(table, fold) {
    const total = table.reduce((t, e) => t + e.w, 0);
    const want = Math.max(1e-9, total * (1 - fold));
    const out = [];
    let got = 0;
    for (const e of table) {
      if (got >= want) break;
      const take = Math.min(e.w, want - got);  // the last holding may count only partly
      out.push(e.c.length > 2 || take !== 1 ? [e.c[0], e.c[1], take] : e.c);
      got += take;
    }
    return out.length ? out : [table[0].c];
  }

  // Problems met while deciding (empty ranges, unreliable samples). Reset per decision and returned
  // with it, so a fallback is always visible in the log, never silent.
  let WARN = [];
  function heroEquity(hero, board, villainRanges, iters) {
    try {
      const r = E.equity({ hero, board, villains: villainRanges, iterations: iters });
      if (r.warning && !WARN.includes(r.warning)) WARN.push(r.warning);
      return r.equity;
    } catch (e) {
      // Only per villain whose range is impossible: that one is treated as any two cards, and it's flagged.
      const fixed = villainRanges.map(r => {
        if (!r) return r;
        const ok = r.filter(([a, b, w]) => !hero.includes(a) && !hero.includes(b) && !board.includes(a) && !board.includes(b) && (w == null || w > 0));
        return ok.length ? ok : null;
      });
      const msg = `equity fallback: ${e.message}; ${fixed.filter(x => !x).length} range(s) treated as any two cards`;
      if (!WARN.includes(msg)) WARN.push(msg);
      return E.equity({ hero, board, villains: fixed, iterations: iters }).equity;
    }
  }

  /**
   * Who continues against our bet/raise, from each villain's own (weighted) range: a holding calls if
   * it is strong enough on this board for the price (absolute strength, since players call with
   * "I have trips", not with "the top half of my range"). Draws continue before the river at a rate
   * that falls with the price. Their tracked fold-to-bet moves the threshold.
   * Returns { fold, cont } where cont is the continuing range with weights.
   */
  // bias: this opponent's learned fold bias on this street (they fold more than predicted → positive →
  // a higher bar to continue). Shifts the threshold on the strength / equity scale.
  function rangeResponse(table, absHS, street, need, facingRaise, f2b, perceived, board, bias) {
    const R = MODEL.response;
    if (perceived && perceived.length && R.perceivedWeight > 0) {
      // Casual players mostly look at their own hand; better players weigh what our line represents.
      // perceivedWeight blends the two (0 = own hand only, 1 = our range only).
      const pr = perceivedResponse(table, street, need, f2b == null ? null : f2b - (facingRaise ? 0.1 : 0), perceived, board, bias);
      // facing a raise after they bet, even casual players think about what the raise means
      const k0 = facingRaise ? R.perceivedWeightVsRaise : R.perceivedWeight;
      const own = rangeResponse(table, absHS, street, need, facingRaise, f2b, null, board, bias);
      // Blend per holding: strong made hands mostly ignore what our line represents (casual players
      // don't fold trips to a raise), medium and weak hands respect it. k falls to 0 above the
      // strongHand strength percentile.
      const ownW = new Map(own.cont.map(c => [c[0] * 52 + c[1], c[2]]));
      const prW = new Map(pr.cont.map(c => [c[0] * 52 + c[1], c[2]]));
      let tw = 0, cw = 0;
      const cont = [];
      for (const e of table) {
        const key = e.c[0] * 52 + e.c[1];
        const kk = e.c[0] < e.c[1] ? e.c[0] * 52 + e.c[1] : e.c[1] * 52 + e.c[0];
        const strong = 1 / (1 + Math.exp(-((absHS.get(kk) ?? 0.5) - R.strongHand) / 0.03));
        const k = k0 * (1 - strong);
        const w = (1 - k) * (ownW.get(key) || 0) + k * (prW.get(key) || 0);
        tw += e.w; cw += w;
        if (w > 1e-6) cont.push([e.c[0], e.c[1], w]);
      }
      return { fold: tw > 0 ? 1 - cw / tw : 1, cont };
    }
    // f2b here is the stat for this situation: fold-to-bet when facing a bet, fold-to-raise when they bet
    // and face our raise (centred on its own prior, 0.5). Unknown → no shift.
    const sticky = f2b == null ? 0 : R.f2bShift * (f2b - (facingRaise ? 0.5 : 0.4));
    const thr = R.base[street] + R.priceSlope * (need - 0.25) + (facingRaise ? R.vsRaise : 0) + sticky + (bias || 0);
    const drawCall = clamp(R.drawCall - 1.5 * (need - 0.2), 0.15, 0.95);
    let tw = 0, cw = 0;
    const cont = [];
    for (const e of table) {
      const k = e.c[0] < e.c[1] ? e.c[0] * 52 + e.c[1] : e.c[1] * 52 + e.c[0];
      let p = 1 / (1 + Math.exp(-((absHS.get(k) ?? 0.5) - thr) / R.width));
      if (street !== 'river' && e.draw) p = Math.max(p, drawCall);
      tw += e.w; cw += e.w * p;
      if (e.w * p > 1e-6) cont.push([e.c[0], e.c[1], e.w * p]);
    }
    return { fold: tw > 0 ? 1 - cw / tw : 1, cont };
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
    if (effBB <= 12 && pf.raises <= 1 && icmOn(ctx)) {
      if (pf.raises === 0) {
        const behind = ctx.villains.filter(v => v.position !== pos);
        const r = icmShove(ctx, hero, behind);
        if (r) {
          if (r.shove > r.fold) return out('ALL-IN', ctx.heroStack + ctx.heroBet, 'ICM', `${effBB.toFixed(0)}bb, tournament: shoving ${hc} is worth ${(100 * r.shove).toFixed(2)}% of the prize pool vs ${(100 * r.fold).toFixed(2)}% folding`);
          if (pos === 'BB' && ctx.toCall === 0) return out('CHECK', 0, 'ICM', `${effBB.toFixed(0)}bb, tournament: check your option`);
          return out('FOLD', 0, 'ICM', `${effBB.toFixed(0)}bb, tournament: shoving ${hc} costs prize equity (${(100 * r.shove).toFixed(2)}% vs ${(100 * r.fold).toFixed(2)}%)`);
        }
      } else {
        const opener = ctx.villains.find(v => v.name === pf.lastRaiser);
        if (opener) {
          const eq = heroEquity(hero, [], [opener.combos && opener.combos.length ? opener.combos : E.topRange(0.25)], 2500);
          const r = icmCall(ctx, opener.name, ctx.toCall, eq);
          if (r) return eq >= r.req
            ? out('ALL-IN', ctx.heroStack + ctx.heroBet, 'ICM', `Tournament: ${hc} has ${pct(eq)} vs their range; prize-pool maths needs ${pct(r.req)} — get it in`)
            : out('FOLD', 0, 'ICM', `Tournament: ${hc} has ${pct(eq)}, but busting costs more than doubling gains here — needs ${pct(r.req)}`);
        }
      }
    }
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
      const rfi = openRange(ctx, pos);
      if (E.inRange(hero, rfi)) {
        const size = pos === 'SB' ? 3 : 2.5 + pf.limpers; // +1bb per limper
        return out('RAISE', raiseTo(pf.limpers ? 3 + pf.limpers : size), 'VALUE',
          pf.limpers ? `${hc} is a raise over ${pf.limpers} limper${pf.limpers > 1 ? 's' : ''} from ${pos}` : `${hc} is in the ${pos} opening range — open`);
      }
      const D = MODEL.depth, shortStack = D.on && effBB <= D.shortBB;
      if (pf.limpers > 0 && has(hero, RANGES.overLimp) && ctx.toCall <= bb && !(shortStack && !/^(\w)\1$/.test(hc) && !hc.startsWith('A')))
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
      // 3-bet bluffs follow the opener's real fold-to-3-bet once we've seen them face a few: more against
      // players who fold too much, none against players who won't.
      const X3 = MODEL.exploit3bet, ft3 = opener && opener.threeBetHands >= X3.minSeen ? opener.foldTo3bet : null;
      const bluffRange = ft3 == null ? RANGES.bluff3bet : ft3 >= X3.wideAt ? RANGES.bluff3bet + ',' + X3.extra : ft3 <= X3.noneAt ? null : RANGES.bluff3bet;
      const bluff = !value && bluffRange && has(hero, bluffRange) && (late || pos === 'BTN' || (ft3 != null && ft3 >= X3.wideAt));
      const threeBetTo = raiseTo(((pf.lastRaiseTo || 3 * bb) / bb) * (ip ? 3 : 4) + pf.callers);
      if (value) return out('RAISE', threeBetTo, 'VALUE', `3-bet ${hc} for value vs the ${oPos} open`);
      if (bluff) return out('RAISE', threeBetTo, 'BLUFF', `3-bet bluff: ${hc} blocks big aces and plays OK if called`);
      const price = ctx.toCall;
      const setMine = /^(\w)\1$/.test(hc) && price <= 0.07 * eff; // pocket pairs need ~15:1 implied odds
      const D = MODEL.depth;
      if (D.on && ip && effBB >= D.deepBB && has(hero, D.deepFlat) && price <= 0.05 * eff)
        return out('CALL', price, 'CHART', `Deep stacks: ${hc} can win a big pot when it hits, and you have position`);
      if (D.on && effBB <= D.shortBB && /^[2-9T][2-9]s$/.test(hc)) // small suited connectors / gappers
        return out('FOLD', 0, 'CHART', `${effBB.toFixed(0)}bb is too short for ${hc} to pay off when it hits — fold`);
      // From the small blind, flatting a raise is the worst spot at the table (out of position, with
      // the big blind still to act): 3-bet or fold, except pocket pairs at a good set-mining price.
      const flatOk = (pos !== 'SB' || setMine) && (has(hero, RANGES.flat) || (pos === 'BTN' && has(hero, RANGES.flatBtnExtra)));
      if (flatOk && (!/^(\w)\1$/.test(hc) || setMine))
        return out('CALL', price, 'CHART', `Call: ${hc} plays well vs a ${oPos} open${ip ? ' with position' : ''}`);
      if (pos === 'BB' && has(hero, RANGES.flat + ',' + RANGES.bbDefendExtra)) {
        // Their actual opening range when we have one (tracked players), else the standard chart.
        const openRange = opener && opener.combos && opener.combos.length ? opener.combos : E.rfiRange(oPos === 'BB' ? 'SB' : oPos);
        const eq = heroEquity(hero, [], [openRange], 2500);
        const need = price / (ctx.pot + price);
        if (eq * preflopRealise(hc) >= need)
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

  /**
   * The better model, used when we know what our line represents: each of their holdings continues
   * when its showdown equity against our perceived range (after this bet) beats the price they're
   * getting, shifted by how sticky this player is (tracked fold-to-bet). Card removal is exact: our
   * perceived holdings that share a card with theirs don't count (blockers). Before the river, draws
   * continue at a rate that falls with the price.
   */
  // What our range looks like after this bet (cached per decision, kind and size bucket).
  let PERC = new Map();
  function perceivedAfter(heroRange, board, kind, hero, size) {
    if (!heroRange) return null;
    const key = kind + ':' + (Math.round(size * 4) / 4);
    if (!PERC.has(key)) {
      let r = null;
      try { r = E.weightRange(heroRange, board, kind, { dead: hero, size }); } catch (e) { r = null; }
      PERC.set(key, r);
    }
    return PERC.get(key);
  }
  // Per-decision cache: their equity vs our perceived range doesn't change with our bet size.
  let EQV = new Map();
  function equityVsPerceived(table, perceived, board) {
    let byTable = EQV.get(perceived);
    if (!byTable) { byTable = new Map(); EQV.set(perceived, byTable); }
    if (!byTable.has(table)) byTable.set(table, E.rangeEquityVs(table.map(e => e.c), perceived, board, { samples: MODEL.response.runoutSamples }));
    return byTable.get(table);
  }
  function perceivedResponse(table, street, need, f2b, perceived, board, bias) {
    const R = MODEL.response;
    const thr = need + R.callBias + R.stickiness * ((f2b ?? 0.4) - 0.4) + (bias || 0);
    const drawCall = clamp(R.drawCall - 1.5 * (need - 0.2), 0.15, 0.95);
    // their equity over the cards to come (draws included), not current-board strength
    const eqs = equityVsPerceived(table, perceived, board);
    let tw = 0, cw = 0;
    const cont = [];
    for (let ti = 0; ti < table.length; ti++) {
      const e = table[ti], [x, y] = e.c, eq = eqs[ti];
      let p = 1 / (1 + Math.exp(-(eq - thr) / R.eqWidth));
      // draws: equity over the runouts already counts them; keep a floor for implied odds before the river
      if (street !== 'river' && e.draw) p = Math.max(p, drawCall * 0.5);
      tw += e.w; cw += e.w * p;
      if (e.w * p > 1e-6) cont.push([x, y, e.w * p]);
    }
    return { fold: tw > 0 ? 1 - cw / tw : 1, cont };
  }

  /**
   * EV of betting/raising to `totalTo` (we add `add`). Each villain folds or continues from their own
   * range (rangeResponse); every combination of callers is weighed by its probability (exact for up to
   * 4 villains, sampled beyond), with equity against exactly those callers' continuing ranges and the
   * pot those callers can actually build: a caller adds at most their stack, and we only risk what the
   * deepest caller can match (the rest comes back). Side pots between callers are not split (approximation).
   */
  function evalAggression({ villains, tables, absHS, hero, board, pot, add, totalTo, street, real, heroBet, heroRange, isRaise }) {
    const n = villains.length;
    // what this bet says about us: our perceived range, narrowed by this action
    const perceived = perceivedAfter(heroRange, board, isRaise ? 'raise' : 'bet', hero, add / Math.max(pot, 1e-9));
    const resp = villains.map((v, i) => {
      const callAmt = Math.max(0, Math.min(totalTo - (v.bet || 0), v.stack != null ? v.stack : Infinity));
      const need = callAmt / (pot + add + callAmt);
      // facing our raise after they bet, their own fold-to-raise is the relevant stat (not fold-to-bet)
      const facingRaise = (v.bet || 0) > 0;
      return { callAmt, ...rangeResponse(tables[i], absHS, street, need, facingRaise, facingRaise ? v.foldToRaise : v.foldOverride, perceived, board,
        MODEL.learnFolds ? v.foldBias : 0) };
    });
    // MDF bound: nobody folds far more than the price justifies to a small bet
    if (MODEL.mdfCap > 0) resp.forEach(r => { const cap = MODEL.mdfCap * r.callAmt / (pot + add); if (r.fold > cap) r.fold = cap; });
    const folds = resp.map(r => r.fold);
    const allFold = folds.reduce((p, x) => p * x, 1);
    // Every combination of callers, exactly (no random sampling). With many opponents only the 8 most
    // likely callers are enumerated; any caller combination too unlikely to evaluate (or involving the
    // others) is counted as a loss of everything we put in, so a bluff's EV can't be inflated by
    // scenarios we skipped.
    const order = villains.map((_, i) => i).sort((a, b) => folds[a] - folds[b]);
    const top = order.slice(0, 8), rest = order.slice(8);
    const pRestFold = rest.reduce((p, i) => p * folds[i], 1);
    const subsets = [];
    let skipped = 1 - pRestFold;  // anyone outside the top 8 calling
    for (let m = 1; m < 1 << top.length; m++) {
      let p = pRestFold; const who = [];
      for (let k = 0; k < top.length; k++) { const i = top[k]; if (m & (1 << k)) { p *= 1 - folds[i]; who.push(i); } else p *= folds[i]; }
      if (p > 1e-4) subsets.push({ who, p }); else skipped += p;
    }
    const eqMemo = new Map();
    const eqVs = who => {
      const key = who.join(',');
      if (!eqMemo.has(key)) eqMemo.set(key, heroEquity(hero, board, who.map(i => resp[i].cont), who.length > 1 ? 2000 : MODEL.equityIters));
      return eqMemo.get(key);
    };
    let ev = allFold * pot, eqSum = 0, pSum = 0;
    const cases = [];
    const rl = street === 'river' ? 1 : real;
    for (const { who, p } of subsets) {
      // Side pots by each player's total on this street (T). Slice k = (L_k − L_{k−1}) × everyone who
      // reached L_k (us + callers); the first slice also holds the dead money (earlier streets, folded
      // players' bets). Each slice is won against only the callers who reached it. Our chips above the
      // deepest caller's total come back.
      const T = who.map(i => ({ i, t: (villains[i].bet || 0) + resp[i].callAmt }));
      const maxT = Math.max(...T.map(x => x.t));
      const ourAdd = Math.max(0, Math.min(totalTo, maxT) - heroBet);
      const dead = Math.max(0, pot - heroBet - T.reduce((a, x) => a + (villains[x.i].bet || 0), 0));
      const levels = [...new Set(T.map(x => Math.min(x.t, totalTo)))].sort((a, b) => a - b);
      let won = 0, prev = 0, eqMain = null;
      for (const L of levels) {
        const elig = T.filter(x => Math.min(x.t, totalTo) >= L).map(x => x.i);
        const eq = eqVs(elig);
        if (eqMain === null) eqMain = eq;
        won += eq * ((L - prev) * (1 + elig.length) + (prev === 0 ? dead : 0));
        prev = L;
      }
      ev += p * (rl * won - ourAdd);
      eqSum += p * eqMain; pSum += p;
      if (cases.length < 6) cases.push({ callers: who.map(i => villains[i].name), p: +p.toFixed(3), eq: +eqMain.toFixed(3) });
    }
    if (skipped > 0) ev -= skipped * add;  // pessimistic: everything we put in is lost
    return { ev, eqC: pSum ? eqSum / pSum : null, allFold, folds, cases };
  }

  /**
   * A short structured "why" for a postflop decision: our hand and equity, each opponent's range size
   * and how reliable the read is, what our line represents, the price, every option's EV, and for a
   * bet: which of their hands we expect to fold or call, and whether we block their strong hands.
   */
  function explainDecision({ ctx, best, eq, feat, heroMade, villains, tables, street, pot, board, hero }) {
    const abs = E.strengthPercentiles(board);
    const hk = hero[0] < hero[1] ? hero[0] * 52 + hero[1] : hero[1] * 52 + hero[0];
    const conf = n => (n >= 100 ? 'high' : n >= 40 ? 'medium' : n >= 15 ? 'low' : 'none (population average)');
    const cat = c => { const n = E.handName(E.evaluate([c[0], c[1], ...board])); return n; };
    const mix = r => {  // weighted share of each hand type
      const m = {}; let t = 0;
      for (const c of r) { const w = c.length > 2 ? c[2] : 1, k = cat(c); m[k] = (m[k] || 0) + w; t += w; }
      return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, w]) => `${k} ${Math.round(100 * w / t)}%`).join(', ');
    };
    const out = {
      hand: `${heroMade} (beats ${Math.round(100 * (abs.get(hk) ?? 0))}% of hands on this board)`,
      equity: +eq.toFixed(3),
      opponents: villains.map((v, i) => ({ name: v.name, combos: Math.round(E.rangeSize(v.combos)), read: conf(v.hands || 0), range: mix(tables[i].map(t => t.c)) })),
      ourPerceivedCombos: ctx.heroRange ? Math.round(E.rangeSize(ctx.heroRange)) : null,
      price: ctx.toCall > 0 ? +(ctx.toCall / (pot + ctx.toCall)).toFixed(3) : null,
      chosen: { action: best.action, ev: +(best.ev || 0).toFixed(2), foldEst: best.foldEst != null ? +best.foldEst.toFixed(3) : null, eqWhenCalled: best.eqC != null ? +best.eqC.toFixed(3) : null },
    };
    // for a bet/raise against one opponent: who folds, who calls, and our blockers
    if (['BET', 'RAISE', 'ALL-IN'].includes(best.action) && villains.length === 1 && MODEL.rangeFolds && best.add) {
      const v = villains[0], totalTo = best.amount, add = best.add;
      const callAmt = Math.max(0, Math.min(totalTo - (v.bet || 0), v.stack != null ? v.stack : Infinity));
      let perceived = null;
      if (ctx.heroRange) { try { perceived = E.weightRange(ctx.heroRange, board, (v.bet || 0) > 0 ? 'raise' : 'bet', { dead: hero }); } catch (e) { perceived = null; } }
      const r = rangeResponse(tables[0], abs, street, callAmt / (pot + add + callAmt), (v.bet || 0) > 0, (v.bet || 0) > 0 ? v.foldToRaise : v.foldOverride, perceived, board);
      const contW = new Map(r.cont.map(c => [c[0] * 52 + c[1], c[2]]));
      const folding = tables[0].map(t => [t.c[0], t.c[1], t.w - (contW.get(t.c[0] * 52 + t.c[1]) || 0)]).filter(c => c[2] > 1e-6);
      out.theyFold = folding.length ? mix(folding) : 'nothing';
      out.theyCall = r.cont.length ? mix(r.cont) : 'nothing';
      // blockers: of all holdings in the top 10% on this board, how many contain one of our cards
      let strong = 0, blocked = 0;
      for (const [k, p] of abs) if (p >= 0.9) { strong++; const a = Math.floor(k / 52), b = k % 52; if (hero.includes(a) || hero.includes(b)) blocked++; }
      out.blockers = strong ? `we hold a card of ${Math.round(100 * blocked / (strong + blocked))}% of the strongest holdings` : 'none';
      out.uncertainty = `their read is ${conf(v.hands || 0)}; fold estimate ${Math.round(100 * r.fold)}% (needed ${Math.round(100 * add / (pot + add))}%)`;
    }
    return out;
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
    const dead = [...hero, ...board];
    const villains = ctx.villains.length ? ctx.villains : [{ name: '?', combos: null, stack: eff, bet: 0 }];
    const real = postflopRealise(ip, street, E.handFeatures(hero, board), villains.length);
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
      for (const f of [...MODEL.betSizes, ...(MODEL.exploit.overbets || [])]) sizes.push({ kind: 'BET', add: roundTo(f * pot, step), label: labelSize(f) });
    } else {
      for (const m of MODEL.raiseMultipliers) sizes.push({ kind: 'RAISE', to: roundTo(m * maxBet, step), label: `${m}x` });
    }
    if (eff <= 3 * pot || heroAll <= 1.2 * pot) sizes.push({ kind: 'ALL-IN', add: heroAll, label: 'all-in' });

    const absHS = MODEL.rangeFolds ? E.strengthPercentiles(board) : null;
    for (const s of sizes) {
      let add = s.kind === 'RAISE' ? s.to - ctx.heroBet : s.add;
      if (add >= heroAll) add = heroAll;
      if (add <= ctx.toCall) continue; // not a real raise
      const isAllIn = add >= heroAll;
      const totalTo = ctx.heroBet + add;
      if (MODEL.rangeFolds) {
        const o = evalAggression({ villains, tables, absHS, hero, board, pot, add, totalTo, street, real, heroBet: ctx.heroBet || 0,
          heroRange: ctx.heroRange, isRaise: facing });
        // a raise/all-in nobody can call more than part of is still that action; the EV uses what they can match
        options.push({ action: isAllIn ? 'ALL-IN' : s.kind === 'BET' ? 'BET' : 'RAISE', amount: totalTo, add, sizeLabel: isAllIn ? 'all-in' : s.label,
          ev: o.ev, eqC: o.eqC, foldEst: o.allFold, foldNeeded: add / (pot + add), folds: o.folds, callerCases: o.cases });
        continue;
      }
      const villainCall = Math.max(0, totalTo - maxBet); // what the bettor (or a checker) must add to continue
      const f = villainCall / (pot + add);
      const folds = villains.map(v => villainFold(v, f, street, facing));
      const allFold = folds.reduce((p, x) => p * x, 1);
      // Facing a bet, the bettor's calls of our raise come from the strong end of what they bet.
      const share = facing && (MODEL.raiseCallStreets || []).includes(street) ? MODEL.raiseCallShare : 1;
      const contRanges = tables.map((t, i) => continuing(t, 1 - (1 - folds[i]) * ((villains[i].bet || 0) > 0 ? share : 1)));
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
    // We bet and got raised: a re-raise only makes sense with a strong hand. Their raise range is
    // much stronger than the model's one-street guess, and re-raise wars without the goods are how
    // stacks get lost (seen in simulations), so non-value re-raises fall back to call or fold.
    if (facing && (ctx.heroBet || 0) > 0 && ['RAISE', 'ALL-IN'].includes(best.action) && best.eqC != null && best.eqC < 0.6) {
      const alt = options.filter(o => o.action === 'CALL' || o.action === 'FOLD' || (o.action === 'ALL-IN' && o.eqC == null)).sort((a, b) => b.ev - a.ev)[0];
      if (alt) best = alt;
    }
    // Model uncertainty: an aggressive line must beat the passive one by a margin that grows the less we
    // know about the opponent (few hands seen → our range and fold estimates are mostly population
    // guesses). Raises facing a bet pay the full margin; bets that are mostly bluffs pay half.
    if (passive && ['BET', 'RAISE', 'ALL-IN'].includes(best.action)) {
      const U = MODEL.uncertainty;
      const known = Math.min(...villains.map(v => v.hands || 0));
      const u = known >= 100 ? 0.1 : known >= 40 ? 0.3 : known >= 15 ? 0.6 : 1;
      const margin = (U.base + U.unknown * u) * (facing ? 1 : (best.eqC != null && best.eqC < 0.5 ? 0.5 : 0));
      if (margin > 0 && best.ev - passive.ev < margin * pot) best = passive;
    }
    if (best.action === 'CALL' && best.ev < 0) best = options.find(o => o.action === 'FOLD') || best;
    // Tournament: calling a bet that puts someone all-in is a prize-pool decision, not a chip one.
    let icmNote = null;
    if (icmOn(ctx) && facing && villains.length === 1 && (ctx.toCall >= heroAll - 1e-9 || (villains[0].stack || 0) <= 1e-9)) {
      const r = icmCall(ctx, villains[0].name, Math.min(ctx.toCall, heroAll), eq * real);
      if (r) {
        const callOpt = options.find(o => o.action === 'CALL' || o.action === 'ALL-IN') , foldOpt = options.find(o => o.action === 'FOLD');
        best = eq * real >= r.req ? (callOpt || best) : (foldOpt || best);
        icmNote = `tournament all-in: ${pct(eq * real)} equity vs ${pct(r.req)} needed by prize-pool maths (chip maths: ${pct(ctx.toCall / (pot + ctx.toCall))})`;
      }
    }
    // Out of position on the flop vs the preflop raiser: check everything but value hands to them.
    if (MODEL.noDonk && !ip && !facing && street === 'flop' && best.action === 'BET' && villainHasInitiative(ctx)) {
      const value = best.eqC != null && best.eqC >= 0.6 && (feat.topPairPlus || feat.made >= 2);
      if (!value) best = options.find(o => o.action === 'CHECK') || best;
    }

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
    if (icmNote) { tag = 'ICM'; reason = icmNote; }
    else if (ctx.format === 'tournament' && !icmOn(ctx)) reason += ' (tournament without payouts: chip EV only)';

    const explain = explainDecision({ ctx, best, eq, feat, heroMade, villains, tables, street, pot, board, hero, real });
    return {
      explain,
      ...(best.folds ? { villainFolds: Object.fromEntries(villains.map((v, i) => [v.name, best.folds[i]])) } : {}),
      street, action: best.action, amount: best.action === 'CALL' || best.action === 'FOLD' || best.action === 'CHECK' ? best.amount : best.amount,
      add: best.add, sizeLabel: best.sizeLabel, tag, reason, equity: eq, eqWhenCalled: best.eqC, foldEst: best.foldEst,
      foldNeeded: best.foldNeeded, ev: best.ev, handName: heroMade, features: feat,
      options: options.map(o => ({ action: o.action, amount: o.amount, sizeLabel: o.sizeLabel, ev: o.ev,
        ...(o.eqC != null ? { eqWhenCalled: o.eqC } : {}), ...(o.foldEst != null ? { foldEst: o.foldEst, foldNeeded: o.foldNeeded } : {}),
        ...(o.callerCases ? { callerCases: o.callerCases } : {}), ...(o.eq != null ? { equity: o.eq } : {}) })),
    };
  }

  function labelSize(f) { return f === 1 ? 'pot' : f === 0.5 ? '½ pot' : f === 0.75 ? '¾ pot' : f === 0.33 ? '⅓ pot' : Math.round(f * 100) + '%'; }

  /** One entry point: picks preflop or postflop logic. */
  function decide(ctx) {
    WARN = []; EQV = new Map(); PERC = new Map();
    const d = ctx.board && ctx.board.length >= 3 ? postflop(ctx) : preflop(ctx);
    if (WARN.length) d.warnings = [...(d.warnings || []), ...WARN];
    return d;
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
