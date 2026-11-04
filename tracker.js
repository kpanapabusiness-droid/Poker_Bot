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
  };
  const MAX_SHOWS = 12, MAX_PROCESSED = 3000;

  function emptyStats() {
    return { hands: 0, vpip: 0, pfr: 0, tbOpp: 0, tb: 0, aggr: 0, calls: 0, facedBet: 0, foldToBet: 0, sawFlop: 0, wtsd: 0, shows: [], lastSeen: 0 };
  }

  /** Split a full log (oldest first) into hands. A hand is complete once a later hand has started or a winner is posted. */
  function splitHands(log) {
    const hands = []; let cur = null;
    for (const a of log) {
      if (a.type === 'start') { if (cur) cur.complete = true; cur = { handId: a.handId, actions: [], complete: false }; hands.push(cur); continue; }
      if (cur) { cur.actions.push(a); if (a.type === 'win') cur.won = true; }
    }
    hands.forEach(h => { if (h.won) h.complete = true; });
    return hands;
  }

  /** Turn one completed hand's actions into per-player increments. Pure function (easy to test). */
  function analyseHand(actions) {
    const P = {}; const get = n => (P[n] = P[n] || { dealt: true, vpip: false, pfr: false, tbOpp: false, tb: false, aggr: 0, calls: 0, facedBet: 0, foldToBet: 0, sawFlop: false, wtsd: false, foldedPre: false, shows: [] });
    const PLAYER_TYPES = new Set(['post', 'fold', 'check', 'call', 'bet', 'raise', 'allin', 'show', 'win']);
    let street = 'preflop', raises = 0, betOpen = false, lastRaiser = null;
    const pfAction = {};
    for (const a of actions) {
      if (a.type === 'street') {
        street = a.street; betOpen = false;
        if (street === 'flop') Object.entries(P).forEach(([, s]) => { if (!s.foldedPre) s.sawFlop = true; });
        continue;
      }
      if (!a.actor || !PLAYER_TYPES.has(a.type)) continue;
      const s = get(a.actor);
      if (street === 'preflop') {
        if (a.type === 'post') continue;
        const facingRaise = raises >= 1 && lastRaiser !== a.actor;
        if (facingRaise) s.tbOpp = true;
        if (a.type === 'call') { s.vpip = true; pfAction[a.actor] = pfAction[a.actor] || (raises ? 'call' : 'limp'); }
        if (a.type === 'raise' || a.type === 'bet' || a.type === 'allin') {
          s.vpip = true; s.pfr = true;
          if (raises >= 1) s.tb = true;
          raises++; lastRaiser = a.actor; pfAction[a.actor] = raises === 1 ? 'raise' : '3bet+';
        }
        if (a.type === 'fold') s.foldedPre = true;
      } else {
        if (a.type === 'bet' || a.type === 'raise' || a.type === 'allin') { if (betOpen) s.facedBet++; s.aggr++; betOpen = true; }
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

    /** Feed the current full log; any newly completed hands are counted once. Returns how many hands were added. */
    function ingest(log) {
      let added = 0;
      for (const h of splitHands(log)) {
        if (!h.complete || !h.handId || processed.has(h.handId)) continue;
        const per = analyseHand(h.actions);
        for (const [name, x] of Object.entries(per)) {
          const s = db.players[name] = db.players[name] || emptyStats();
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
    function estimate(name) {
      const s = db.players[name] || emptyStats();
      const est = {
        hands: s.hands,
        vpip: shrink(s.vpip, s.hands, PRIORS.vpip),
        pfr: shrink(s.pfr, s.hands, PRIORS.pfr),
        threeBet: shrink(s.tb, s.tbOpp, PRIORS.threeBet),
        af: (s.aggr + PRIORS.af.p * PRIORS.af.w) / (s.calls + PRIORS.af.w),
        f2b: shrink(s.foldToBet, s.facedBet, PRIORS.f2b),
        wtsd: shrink(s.wtsd, s.sawFlop, PRIORS.wtsd),
        shows: s.shows.slice(-5),
        raw: s,
      };
      est.pfr = Math.min(est.pfr, est.vpip);
      est.type = classify(est);
      return est;
    }

    return {
      ingest, estimate,
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
