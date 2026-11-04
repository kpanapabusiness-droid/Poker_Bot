// ==UserScript==
// @name         Torn Poker Coach (dev)
// @namespace    keanu.poker.coach
// @version      0.1.0
// @description  Passive live-coaching panel for Torn poker: equity, pot odds, ranges. Display only — never clicks or acts.
// @match        https://www.torn.com/page.php?sid=holdem*
// @match        https://www.torn.com/loader.php?sid=holdem*
// @require      https://raw.githubusercontent.com/kpanapabusiness-droid/Poker_Bot/main/poker-engine.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==
//
// SETUP
//   1. The engine loads from GitHub via the @require line in the header above
//      (repo: kpanapabusiness-droid/Poker_Bot). For offline testing, paste
//      the whole of poker-engine.js above this script's IIFE instead.
//   2. Check the @match URLs above against the real Torn poker URL (open poker, copy the address bar).
//   3. Fill in the SELECTORS in TornAdapter once we've inspected the table HTML.
//
// RULES WE STICK TO (Torn scripting compliance — re-check the official rules before using):
//   • Reads only the page you're viewing.  • Makes zero requests to Torn.  • Never clicks or acts.
//
(function () {
  'use strict';
  const E = window.PokerEngine;
  if (!E) { console.warn('[PokerCoach] PokerEngine not loaded — add the @require or paste the engine.'); return; }

  // ─────────────────────────── Site adapter ───────────────────────────
  // The ONLY site-specific part. Every adapter returns the same TableState shape,
  // so the engine + panel work unchanged on Torn, PokerNow, etc.
  //
  // TableState = {
  //   heroCards: ['As','Kd'] | [],
  //   board:     ['Qs','7d','2c'],
  //   pot:       number,          // total in the middle incl. current bets
  //   toCall:    number,          // what hero must add to continue (0 = can check)
  //   heroStack: number,
  //   players:   [{ name, seat, stack, inHand, isHero, isButton, lastAction, bet }],
  //   handId:    string | null,   // to detect new hands
  // }
  const TornAdapter = {
    // TODO: fill these in from the captured outerHTML snapshots.
    SELECTORS: {
      table: null,        // root element of the table
      heroCards: null,    // hero's two hole cards
      boardCards: null,   // community cards
      pot: null,          // pot amount text
      seats: null,        // each player seat
      callButton: null,   // read the call amount from its label (read-only!)
    },
    /** Convert one card element → "As". Torn's blackjack uses classes like card-hearts-A; poker may be similar. */
    readCard(el) {
      const cls = [...el.classList].find(c => /^card-(hearts|diamonds|clubs|spades)-/.test(c));
      if (!cls) return null;
      const [, suitWord, rank] = cls.split('-');
      const suit = { hearts: 'h', diamonds: 'd', clubs: 'c', spades: 's' }[suitWord];
      return (rank === '10' ? 'T' : rank) + suit;
    },
    readState() {
      const S = this.SELECTORS;
      if (!S.table || !document.querySelector(S.table)) return null;
      const q = sel => (sel ? [...document.querySelectorAll(sel)] : []);
      const num = txt => Number(String(txt || '').replace(/[^0-9.]/g, '')) || 0;
      return {
        heroCards: q(S.heroCards).map(el => this.readCard(el)).filter(Boolean),
        board: q(S.boardCards).map(el => this.readCard(el)).filter(Boolean),
        pot: num(q(S.pot)[0]?.textContent),
        toCall: num(q(S.callButton)[0]?.textContent),
        heroStack: 0,
        players: [], // TODO: parse seats (name, stack, inHand, button, last action)
        handId: null,
      };
    },
  };

  // ─────────────────────────── Coach logic ───────────────────────────
  // Phase 1: villains get position-based default ranges (or random if unknown).
  // Phase 3 replaces this with per-player ranges from the opponent tracker.
  function villainRanges(state) {
    const opps = state.players.filter(p => p.inHand && !p.isHero);
    if (!opps.length) return [null];
    return opps.map(() => null); // TODO Phase 3: tracker.rangeFor(p.name, position, actions)
  }

  let lastKey = '', lastResult = null;
  function compute(state) {
    if (!state || state.heroCards.length !== 2) return null;
    const key = [state.heroCards, state.board, state.pot, state.toCall, state.players.filter(p => p.inHand).length].join('|');
    if (key === lastKey) return lastResult; // only recompute when something changed
    lastKey = key;
    const ranges = villainRanges(state);
    const eq = E.equity({ hero: state.heroCards, board: state.board, villains: ranges, iterations: 15000 });
    const adv = E.advise({ equity: eq.equity, pot: state.pot, toCall: state.toCall });
    lastResult = { eq, adv, opponents: ranges.length, handClass: E.handClass(E.parseCards(state.heroCards)) };
    return lastResult;
  }

  // ─────────────────────────── Panel UI ───────────────────────────
  const COLORS = { RAISE: '#3b82f6', BET: '#3b82f6', CALL: '#22c55e', CHECK: '#a3a3a3', MARGINAL: '#f59e0b', FOLD: '#ef4444' };
  const panel = document.createElement('div');
  panel.id = 'poker-coach-panel';
  panel.style.cssText = 'position:fixed;top:90px;right:16px;z-index:99999;width:230px;padding:12px 14px;border-radius:10px;' +
    'background:rgba(15,17,21,.92);color:#e5e7eb;font:13px/1.4 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.4);cursor:move;';
  document.body.appendChild(panel);
  makeDraggable(panel);

  const pct = x => (x * 100).toFixed(0) + '%';
  function render(state, r) {
    if (!r) { panel.innerHTML = '<b>Poker Coach</b><div style="opacity:.6;margin-top:6px">Waiting for a hand…</div>'; return; }
    const { eq, adv } = r;
    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;opacity:.7;font-size:11px">
        <span>${r.handClass}${eq.handName ? ' · ' + eq.handName : ''}</span><span>vs ${r.opponents}</span></div>
      <div style="font-size:24px;font-weight:700;color:${COLORS[adv.action]};margin:4px 0">${adv.action}</div>
      <div style="font-size:12px;opacity:.85;margin-bottom:8px">${adv.reason}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 10px;font-size:12px">
        <span style="opacity:.6">Equity</span><b>${pct(eq.equity)}</b>
        <span style="opacity:.6">Need</span><b>${state.toCall > 0 ? pct(adv.requiredEquity) : '—'}</b>
        <span style="opacity:.6">Pot odds</span><b>${adv.ratio}</b>
        <span style="opacity:.6">Call EV</span><b>${state.toCall > 0 ? adv.ev.toFixed(0) : '—'}</b>
      </div>`;
  }

  function makeDraggable(el) {
    let sx, sy, ox, oy;
    el.addEventListener('mousedown', e => {
      sx = e.clientX; sy = e.clientY; const r = el.getBoundingClientRect(); ox = r.left; oy = r.top;
      const move = ev => { el.style.left = ox + ev.clientX - sx + 'px'; el.style.top = oy + ev.clientY - sy + 'px'; el.style.right = 'auto'; };
      const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    });
  }

  // ─────────────────────────── Loop ───────────────────────────
  // Poll the DOM a few times a second. (Could switch to MutationObserver later.)
  // DEV MODE: in the console, set window.__coachTestState = {heroCards:['As','Kd'], board:['Qs','7d','2c'], pot:150, toCall:50, players:[{inHand:true},{inHand:true,isHero:true}]}
  setInterval(() => {
    try {
      const state = window.__coachTestState || TornAdapter.readState();
      render(state, compute(state));
    } catch (e) { console.warn('[PokerCoach]', e); }
  }, 400);
})();
