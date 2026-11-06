/*
 * tracker.js — learns each opponent from every hand you watch (Phase 3).
 *
 * Reads completed hands from the game log (parsed by the adapter) and keeps per-player counts:
 *   VPIP   — voluntarily put money in preflop (calls/raises, not blind posts)
 *   PFR    — raised preflop
 *   3-bet  — re-raised preflop when facing a raise (and how often they had the chance)
 *   AF     — aggression after the flop: (bets + raises) / calls
 *   F2B    — folded when facing a bet after the flop
 *   WTSD   — went to showdown after seeing the flop
 *   shows  — hands they revealed at showdown (with what they did preflop)
 *
 * Small samples are shrunk towards "average casual player" priors, so 3 hands don't make
 * someone a maniac: estimate = (observed + prior × weight) / (opportunities + weight).
 *
 * Storage is pluggable: pass { load, save } (the overlay uses localStorage on torn.com).
 * Works in the browser (global PokerTracker) and in Node (module.exports).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PokerTracker = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Average casual (Torn) player — what everyone starts at. Weights = how many hands/opportunities
  // of evidence it takes before a player's own numbers count as much as the prior.
  const PRIORS = {
    vpip: { p: 0.40, w: 12 }, pfr: { p: 0.12, w: 12 }, threeBet: { p: 0.05, w: 8 },
    af: { p: 1.5, w: 10 }, f2b: { p: 0.40, w: 10 }, wtsd: { p: 0.35, w: 10 },
    // situational (7 Nov): each counted only where the player had the chance
    fourBet: { p: 0.03, w: 8 }, foldTo3bet: { p: 0.55, w: 8 }, cbet: { p: 0.60, w: 8 }, foldToCbet: { p: 0.45, w: 8 },
    f2bFlop: { p: 0.40, w: 8 }, f2bTurn: { p: 0.42, w: 8 }, f2bRiver: { p: 0.45, w: 8 }, foldToRaise: { p: 0.50, w: 8 },
  };
  // counters added together hand by hand (opportunity, then success)
  const COUNTS = ['betSizeSum', 'betSizeN', 'fbOpp', 'fb', 'f3bOpp', 'f3b', 'cbetOpp', 'cbet', 'fcbOpp', 'fcb', 'ftrOpp', 'ftr',
    'facedFlop', 'foldFlop', 'facedTurn', 'foldTurn', 'facedRiver', 'foldRiver', 'riverAggr', 'riverCalls'];
  const sizeBand = n => (!n ? null : n <= 2 ? 'hu' : n <= 6 ? 'short' : 'full');
  const MAX_SHOWS = 12, MAX_PROCESSED = 3000;

  function emptyStats() {
    const s = { hands: 0, vpip: 0, pfr: 0, tbOpp: 0, tb: 0, aggr: 0, calls: 0, facedBet: 0, foldToBet: 0, sawFlop: 0, wtsd: 0, shows: [], lastSeen: 0 };
    for (const k of COUNTS) s[k] = 0;
    s.bySize = {};
    return s;
  }

  /** Split a full log (oldest first) into hands. A hand is complete once a later hand has started or a winner is posted. */
  function splitHands(log) {
    const hands = []; let cur = null;
    for (const a of log) {
      if (a.type === 'start') { if (cur) cur.complete = true; cur = { handId: a.handId, size: a.size || null, actions: [], complete: false }; hands.push(cur); continue; }
      if (cur) { cur.actions.push(a); if (a.type === 'win') cur.won = true; }
    }
    hands.forEach(h => { if (h.won) h.complete = true; });
    return hands;
  }

  /** Turn one completed hand's actions into per-player increments. Pure function (easy to test). */
  function analyseHand(actions) {
    const P = {}; const get = n => (P[n] = P[n] || { dealt: true, vpip: false, pfr: false, tbOpp: false, tb: false, aggr: 0, calls: 0, facedBet: 0, foldToBet: 0, sawFlop: false, wtsd: false, foldedPre: false, shows: [],
      ...Object.fromEntries(COUNTS.map(k => [k, 0])) });
    let opener = null, pfRaiser = null, streetBettor = null, flopActed = new Set(), potT = 0;
    const betThisStreet = new Set();
    const FACED = { flop: ['facedFlop', 'foldFlop'], turn: ['facedTurn', 'foldTurn'], river: ['facedRiver', 'foldRiver'] };
    const PLAYER_TYPES = new Set(['post', 'fold', 'check', 'call', 'bet', 'raise', 'allin', 'show', 'win']);
    let street = 'preflop', raises = 0, betOpen = false, lastRaiser = null;
    const pfAction = {};
    for (const a of actions) {
      if (a.type === 'street') {
        street = a.street; betOpen = false; streetBettor = null; betThisStreet.clear();
        if (street === 'flop') Object.entries(P).forEach(([, s]) => { if (!s.foldedPre) s.sawFlop = true; });
        continue;
      }
      const potBefore = potT;
      if (a.amount > 0) potT += a.amount;  // pot as the hand goes, for bet sizes
      if (!a.actor || !PLAYER_TYPES.has(a.type)) continue;
      const s = get(a.actor);
      if (street === 'preflop') {
        if (a.type === 'post') continue;
        const facing = lastRaiser !== a.actor;
        // a 3-bet chance is facing exactly one raise; a 4-bet chance is facing a 3-bet
        if (facing && raises === 1 && !s.tbOpp) s.tbOpp = true;
        if (facing && raises === 2 && !s._fbSeen) { s.fbOpp++; s._fbSeen = true; }
        if (raises === 2 && a.actor === opener && !s._f3Seen) { s.f3bOpp++; s._f3Seen = true; if (a.type === 'fold') s.f3b++; }
        if (a.type === 'call') { s.vpip = true; pfAction[a.actor] = pfAction[a.actor] || (raises ? 'call' : 'limp'); }
        if (a.type === 'raise' || a.type === 'bet' || a.type === 'allin') {
          s.vpip = true; s.pfr = true;
          if (raises === 1) s.tb = true;
          if (raises === 2) s.fb++;
          raises++; lastRaiser = a.actor; pfAction[a.actor] = raises === 1 ? 'raise' : '3bet+';
          if (raises === 1) opener = a.actor;
          pfRaiser = a.actor;
        }
        if (a.type === 'fold') s.foldedPre = true;
      } else {
        const aggro = a.type === 'bet' || a.type === 'raise' || a.type === 'allin';
        if (aggro && a.amount > 0 && potBefore > 0) { s.betSizeSum += Math.min(3, a.amount / potBefore); s.betSizeN++; }  // their bet sizes
        // c-bet: the preflop raiser's first flop action while nobody has bet
        if (street === 'flop' && a.actor === pfRaiser && !flopActed.has(a.actor) && !betOpen) { s.cbetOpp++; if (aggro) s.cbet++; }
        if (street === 'flop') flopActed.add(a.actor);
        if (betOpen && a.actor !== streetBettor) {
          const [fk, ok] = FACED[street] || [];
          if (fk) { s[fk]++; if (a.type === 'fold') s[ok]++; }
          if (street === 'flop' && streetBettor === pfRaiser) { s.fcbOpp++; if (a.type === 'fold') s.fcb++; }
          if (betThisStreet.has(a.actor)) { s.ftrOpp++; if (a.type === 'fold') s.ftr++; }  // they bet, we raised
        }
        if (street === 'river') { if (aggro) s.riverAggr++; else if (a.type === 'call') s.riverCalls++; }
        if (aggro) { if (betOpen) s.facedBet++; s.aggr++; betOpen = true; streetBettor = a.actor; betThisStreet.add(a.actor); }
        else if (a.type === 'call') { s.calls++; if (betOpen) s.facedBet++; }
        else if (a.type === 'fold') { if (betOpen) { s.facedBet++; s.foldToBet++; } }
      }
      if ((a.type === 'show' || (a.type === 'win' && a.cards && a.cards.length)) && a.cards && a.cards.length === 2) {
        if (s.sawFlop) s.wtsd = true;
        s.shows.push({ cards: a.cards, desc: a.desc || null, preflop: pfAction[a.actor] || 'check/blind' });
      }
    }
    return P;
  }

  function create({ load, save, now = () => Date.now() } = {}) {
    let db = { players: {}, processed: [] };
    try { const d = load && load(); if (d && d.players) db = d; } catch (e) {}
    const processed = new Set(db.processed);

    function persist() {
      db.processed = [...processed].slice(-MAX_PROCESSED);
      try { save && save(db); } catch (e) {}
    }

    /**
     * After our bet: we predicted `pred` (chance this player folds); did they? Builds a per-street record
     * of how far our fold model is off for this player, used as a correction (shrunk: ~10 observations
     * before it counts fully, so a few hands don't swing it).
     */
    function noteFold(name, street, pred, folded) {
      if (!name || pred == null || !['flop', 'turn', 'river'].includes(street)) return;
      const s = db.players[name] = db.players[name] || emptyStats();
      s.foldModel = s.foldModel || {};
      const m = s.foldModel[street] = s.foldModel[street] || { n: 0, pred: 0, act: 0 };
      // fading memory (×0.97 per bet, ~30 bets): if a player changes how they play, the correction follows
      m.n = m.n * 0.97 + 1; m.pred = m.pred * 0.97 + pred; m.act = m.act * 0.97 + (folded ? 1 : 0);
    }

    /** Feed the current full log; any newly completed hands are counted once. Returns how many hands were added. */
    function ingest(log) {
      let added = 0;
      for (const h of splitHands(log)) {
        if (!h.complete || !h.handId || processed.has(h.handId)) continue;
        const per = analyseHand(h.actions);
        const band = sizeBand(h.size);
        for (const [name, x] of Object.entries(per)) {
          const s = db.players[name] = db.players[name] || emptyStats();
          for (const k of COUNTS) s[k] = (s[k] || 0) + (x[k] || 0);
          if (band) {  // the same few numbers by table size, for context-aware estimates
            s.bySize = s.bySize || {};
            const z = s.bySize[band] = s.bySize[band] || { hands: 0, vpip: 0, pfr: 0, facedBet: 0, foldToBet: 0 };
            z.hands++; if (x.vpip) z.vpip++; if (x.pfr) z.pfr++; z.facedBet += x.facedBet; z.foldToBet += x.foldToBet;
          }
          s.hands++; s.lastSeen = now();
          if (x.vpip) s.vpip++; if (x.pfr) s.pfr++; if (x.tbOpp) s.tbOpp++; if (x.tb) s.tb++;
          s.aggr += x.aggr; s.calls += x.calls; s.facedBet += x.facedBet; s.foldToBet += x.foldToBet;
          if (x.sawFlop) s.sawFlop++; if (x.wtsd) s.wtsd++;
          for (const sh of x.shows) { s.shows.push({ ...sh, handId: h.handId }); if (s.shows.length > MAX_SHOWS) s.shows.shift(); }
        }
        processed.add(h.handId); added++;
      }
      if (added) persist();
      return added;
    }

    const shrink = (x, n, prior) => (x + prior.p * prior.w) / (n + prior.w);

    /** Shrunk estimates for one player (falls back to priors for strangers). */
    function estimate(name, ctx = {}) {
      const s = db.players[name] || emptyStats();
      const c = k => s[k] || 0;
      const est = {
        hands: s.hands,
        vpip: shrink(s.vpip, s.hands, PRIORS.vpip),
        pfr: shrink(s.pfr, s.hands, PRIORS.pfr),
        threeBet: shrink(s.tb, s.tbOpp, PRIORS.threeBet),
        af: (s.aggr + PRIORS.af.p * PRIORS.af.w) / (s.calls + PRIORS.af.w),
        f2b: shrink(s.foldToBet, s.facedBet, PRIORS.f2b),
        wtsd: shrink(s.wtsd, s.sawFlop, PRIORS.wtsd),
        fourBet: shrink(c('fb'), c('fbOpp'), PRIORS.fourBet),
        foldTo3bet: shrink(c('f3b'), c('f3bOpp'), PRIORS.foldTo3bet),
        cbet: shrink(c('cbet'), c('cbetOpp'), PRIORS.cbet),
        foldToCbet: shrink(c('fcb'), c('fcbOpp'), PRIORS.foldToCbet),
        foldToRaise: shrink(c('ftr'), c('ftrOpp'), PRIORS.foldToRaise),
        // typical postflop bet size (chips / pot before), shrunk toward 0.55 pot with ~8 bets of weight
        betSize: (c('betSizeSum') + 0.55 * 8) / (c('betSizeN') + 8), betSizeN: c('betSizeN'),
        shows: s.shows.slice(-5),
        raw: s,
      };
      // fold to a bet by street: shrunk toward the player's own overall fold-to-bet (not the population),
      // so a few river hands don't override what we know about them
      const byStreet = (f, n, pr) => (f + est.f2b * pr.w) / (n + pr.w);
      est.f2bStreet = { flop: byStreet(c('foldFlop'), c('facedFlop'), PRIORS.f2bFlop), turn: byStreet(c('foldTurn'), c('facedTurn'), PRIORS.f2bTurn),
        river: byStreet(c('foldRiver'), c('facedRiver'), PRIORS.f2bRiver) };
      // at this table size: shrunk toward their overall numbers (hierarchical), when we have a few hands there
      const band = sizeBand(ctx.tableSize), z = band && s.bySize && s.bySize[band];
      if (z && z.hands) {
        est.vpip = (z.vpip + est.vpip * 20) / (z.hands + 20);
        est.pfr = (z.pfr + est.pfr * 20) / (z.hands + 20);
        est.f2b = (z.foldToBet + est.f2b * 10) / (z.facedBet + 10);
        est.sizeBand = band; est.sizeHands = z.hands;
      }
      est.pfr = Math.min(est.pfr, est.vpip);
      // how much more (+) or less (−) often they fold than our model predicted, by street (shrunk to 0)
      const fm = s.foldModel || {};
      est.foldBias = Object.fromEntries(['flop', 'turn', 'river'].map(st => {
        const m = fm[st]; return [st, m && m.n ? (m.act - m.pred) / (m.n + 10) : 0];
      }));
      est.type = classify(est);
      return est;
    }

    return {
      ingest, estimate, noteFold,
      players: () => Object.keys(db.players),
      exportData: () => JSON.parse(JSON.stringify(db)),
      importData: d => { if (d && d.players) { db = d; processed.clear(); (d.processed || []).forEach(x => processed.add(x)); persist(); } },
      reset: () => { db = { players: {}, processed: [] }; processed.clear(); persist(); },
    };
  }

  /** Player type from stats. Needs ~15 hands before it commits to a label. */
  function classify(e) {
    if (e.hands < 15) return { label: 'Unknown', short: '?', note: `only ${e.hands} hand${e.hands === 1 ? '' : 's'} seen` };
    // thresholds account for shrinkage: a true 15% player reads ~21% after 40 hands
    const loose = e.vpip >= 0.38, tight = e.vpip < 0.24, aggressive = e.af >= 1.8 || e.pfr >= 0.30, passive = e.af < 1.1;
    if (loose && passive && e.f2b < 0.38) return { label: 'Calling Station', short: 'STATION', note: "calls too much — value bet thin, don't bluff" };
    if (loose && aggressive) return { label: 'Maniac', short: 'MANIAC', note: 'bets/raises a lot — call down lighter, let them bluff' };
    if (loose) return { label: 'Loose-Passive', short: 'FISH', note: 'plays too many hands — value bet, bluff less' };
    if (tight && e.pfr / Math.max(e.vpip, 0.01) < 0.5) return { label: 'Rock', short: 'ROCK', note: 'only plays strong hands, rarely raises — respect their bets' };
    if (tight) return { label: 'Nit', short: 'NIT', note: 'very tight — steal their blinds, fold to their aggression' };
    if (e.pfr / Math.max(e.vpip, 0.01) >= 0.6) return { label: aggressive ? 'LAG' : 'TAG', short: aggressive ? 'LAG' : 'TAG', note: aggressive ? 'loose-aggressive regular — tricky, avoid big bluffs' : 'solid regular — play straightforwardly' };
    return { label: 'Average', short: 'AVG', note: 'no big leaks spotted yet' };
  }

  return { PRIORS, create, splitHands, analyseHand, classify };
});
