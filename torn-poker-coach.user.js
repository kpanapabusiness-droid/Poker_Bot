// ==UserScript==
// @name         Torn Poker Coach
// @namespace    keanu.poker.coach
// @version      0.2.0
// @description  Passive live-coaching panel for Torn poker: equity, pot odds, positions, opponent ranges. Display only — never clicks or acts.
// @match        https://www.torn.com/page.php?sid=holdem*
// @require      https://raw.githubusercontent.com/kpanapabusiness-droid/Poker_Bot/main/poker-engine.js
// @require      https://raw.githubusercontent.com/kpanapabusiness-droid/Poker_Bot/main/torn-adapter.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==
//
// RULES WE STICK TO (Torn scripting compliance — re-check the official rules before using):
//   • Reads only the page you're viewing.  • Makes zero requests to Torn.  • Never clicks or acts.
//
// DEV MODE: set window.__coachTestState to a TableState object in the console to drive the panel by hand.
//
(function () {
  'use strict';
  const E = window.PokerEngine, A = window.TornAdapter;
  if (!E || !A) { console.warn('[PokerCoach] engine/adapter not loaded — check the @require lines.'); return; }

  // ─────────────────────────── Opponent ranges (Phase 1.5) ───────────────────────────
  // Narrow each opponent by what they did PREFLOP this hand. Starter ranges, not solver output.
  // Phase 3 replaces this with per-player stats + street-by-street narrowing.
  const THREE_BET = '99+,AJs+,KQs,AQo+';
  const FLAT_CALL = '22+,A2s+,K9s+,Q9s+,J9s+,T8s+,97s+,86s+,75s+,65s,54s,ATo+,KJo+,QJo';
  const rangeCache = {};
  const parsed = txt => rangeCache[txt] || (rangeCache[txt] = E.parseRange(txt));

  function villainRange(action, position) {
    switch (action) {
      case 'raise': return { combos: E.rfiRange(['BB'].includes(position) ? 'SB' : (position || 'CO')), label: `opened ${position || ''}` };
      case '3bet+': return { combos: parsed(THREE_BET), label: '3-bet+' };
      case 'call': return { combos: parsed(FLAT_CALL), label: 'called a raise' };
      default: return { combos: null, label: action === 'limp' ? 'limped (any)' : action === 'check' ? 'BB check (any)' : 'any two' };
    }
  }

  // Postflop: narrow each opponent's range by their bets/raises/calls on each street.
  const BOARD_LEN = { flop: 3, turn: 4, river: 5 };
  function applyPostflop(villain, actions, board) {
    let street = 'preflop', combos = villain.combos || E.allCombos();
    const steps = [];
    for (const a of actions) {
      if (a.type === 'street') { street = a.street; continue; }
      if (street === 'preflop' || a.actor !== villain.name) continue;
      if (!['bet', 'raise', 'allin', 'call'].includes(a.type)) continue;
      const b = board.slice(0, BOARD_LEN[street]);
      if (b.length < BOARD_LEN[street]) continue;
      combos = E.narrowRange(combos, b, a.type);
      steps.push(`${a.type === 'allin' ? 'shove' : a.type} ${street}`);
    }
    if (!steps.length) return villain;
    return { ...villain, combos, label: villain.label + ' → ' + steps.join(', ') };
  }

  // ─────────────────────────── Coach logic ───────────────────────────
  let lastKey = '', lastResult = null;
  function compute(state) {
    if (!state || !state.heroInHand || state.heroCards.length !== 2) return null;
    const pos = A.positions(state, E.positionFromSeat);
    const pf = A.preflopActions(state);
    const villains = state.players.filter(p => p.inHand && !p.isHero).map(p => {
      const r = villainRange(pf[p.name], pos[p.slot]);
      return applyPostflop({ name: p.name, position: pos[p.slot] || '?', stack: p.stack, bet: p.bet, ...r }, state.actions, state.board);
    });
    const key = [state.handId, state.heroCards, state.board, state.pot, state.toCall, villains.map(v => v.name + v.label)].join('|');
    if (key === lastKey) return lastResult; // only recompute when something changed
    lastKey = key;

    const ranges = villains.length ? villains.map(v => v.combos) : [null];
    let eq;
    try { eq = E.equity({ hero: state.heroCards, board: state.board, villains: ranges, iterations: 15000 }); }
    catch (e) { eq = E.equity({ hero: state.heroCards, board: state.board, villains: ranges.map(() => null), iterations: 15000 }); }
    const adv = E.advise({ equity: eq.equity, pot: state.pot, toCall: state.toCall });
    const hero = state.players.find(p => p.isHero);
    lastResult = {
      eq, adv, villains,
      heroPos: pos[0] || '?',
      handClass: E.handClass(E.parseCards(state.heroCards)),
      inOpenRange: state.street === 'preflop' && pos[0] ? E.inRange(E.parseCards(state.heroCards), E.rfiRange(pos[0] === 'BB' ? 'SB' : pos[0])) : null,
      spr: hero && state.pot ? E.spr(Math.min(hero.stack, Math.max(0, ...villains.map(v => v.stack + v.bet))), state.pot) : null,
    };
    return lastResult;
  }

  // ─────────────────────────── Panel UI ───────────────────────────
  const COLORS = { RAISE: '#3b82f6', BET: '#3b82f6', CALL: '#22c55e', CHECK: '#a3a3a3', MARGINAL: '#f59e0b', FOLD: '#ef4444' };
  const panel = document.createElement('div');
  panel.id = 'poker-coach-panel';
  panel.style.cssText = 'position:fixed;top:110px;right:16px;z-index:99999;width:250px;padding:12px 14px;border-radius:10px;' +
    'background:rgba(15,17,21,.93);color:#e5e7eb;font:13px/1.4 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.4);cursor:move;user-select:none;';
  try { const p = JSON.parse(localStorage.getItem('pokerCoachPos') || 'null'); if (p) { panel.style.left = p.left; panel.style.top = p.top; panel.style.right = 'auto'; } } catch (e) {}
  document.body.appendChild(panel);
  makeDraggable(panel);

  const pct = x => (x * 100).toFixed(0) + '%';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const row = (k, v) => `<span style="opacity:.6">${k}</span><b>${v}</b>`;

  function render(state, r) {
    if (!state) { panel.innerHTML = '<b>Poker Coach</b><div style="opacity:.6;margin-top:6px">No table found</div>'; return; }
    if (!r) { panel.innerHTML = `<b>Poker Coach</b><div style="opacity:.6;margin-top:6px">${state.heroInHand ? 'Reading hand…' : 'Not in this hand — waiting'}</div>`; return; }
    const { eq, adv } = r;
    const yourTurn = state.isHeroTurn;
    const action = yourTurn ? adv.action : 'WAITING';
    const color = yourTurn ? COLORS[adv.action] : '#6b7280';
    const preflopNote = r.inOpenRange == null ? '' :
      `<div style="font-size:11px;margin-top:2px;color:${r.inOpenRange ? '#22c55e' : '#f59e0b'}">${r.handClass} is ${r.inOpenRange ? '' : 'NOT '}in the ${r.heroPos} open range</div>`;
    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;opacity:.75;font-size:11px">
        <span>${esc(r.handClass)} · ${esc(r.heroPos)} · ${esc(state.street)}</span><span>${eq.handName ? esc(eq.handName) : ''}</span></div>
      <div style="font-size:24px;font-weight:700;color:${color};margin:4px 0 2px">${action}</div>
      <div style="font-size:12px;opacity:.85">${yourTurn ? esc(adv.reason) : 'Preview — updates when it\'s your turn'}</div>
      ${preflopNote}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:3px 10px;font-size:12px;margin-top:8px">
        ${row('Equity', pct(eq.equity))}
        ${row('Need', state.toCall > 0 ? pct(adv.requiredEquity) : '—')}
        ${row('To call', state.toCall > 0 ? '$' + state.toCall.toLocaleString() : 'free')}
        ${row('Pot odds', adv.ratio)}
        ${row('Call EV', state.toCall > 0 ? (adv.ev >= 0 ? '+' : '') + '$' + Math.round(adv.ev).toLocaleString() : '—')}
        ${row('SPR', r.spr != null && isFinite(r.spr) ? r.spr.toFixed(1) : '—')}
      </div>
      <div style="margin-top:8px;border-top:1px solid rgba(255,255,255,.1);padding-top:6px;font-size:11px">
        ${r.villains.map(v => `<div style="display:flex;justify-content:space-between;gap:6px">
          <span>${esc(v.name)} <span style="opacity:.55">${esc(v.position)}</span></span>
          <span style="opacity:.75">${esc(v.label)}${v.combos ? ' · ' + pct(E.rangePercent(v.combos)) : ''}</span></div>`).join('') || '<span style="opacity:.6">No opponents</span>'}
      </div>
      <div style="font-size:10px;opacity:.4;margin-top:6px">Ranges from this hand's actions (starter heuristics)</div>`;
  }

  function makeDraggable(el) {
    let sx, sy, ox, oy;
    el.addEventListener('mousedown', e => {
      sx = e.clientX; sy = e.clientY; const b = el.getBoundingClientRect(); ox = b.left; oy = b.top;
      const move = ev => { el.style.left = ox + ev.clientX - sx + 'px'; el.style.top = oy + ev.clientY - sy + 'px'; el.style.right = 'auto'; };
      const up = () => {
        document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up);
        try { localStorage.setItem('pokerCoachPos', JSON.stringify({ left: el.style.left, top: el.style.top })); } catch (e) {}
      };
      document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    });
  }

  // ─────────────────────────── Loop ───────────────────────────
  setInterval(() => {
    try {
      const state = window.__coachTestState || A.readState(document);
      render(state, compute(state));
    } catch (e) { console.warn('[PokerCoach]', e); }
  }, 400);
})();
