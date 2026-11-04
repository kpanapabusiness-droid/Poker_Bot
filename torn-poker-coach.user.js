// ==UserScript==
// @name         Torn Poker Coach
// @namespace    keanu.poker.coach
// @version      0.3.0
// @description  Live poker coach for Torn: tells you what to do and how much (value, bluff, semi-bluff), with equity, odds, positions and opponent ranges. Display only — never clicks or acts.
// @match        https://www.torn.com/page.php?sid=holdem*
// @require      https://raw.githubusercontent.com/kpanapabusiness-droid/Poker_Bot/main/poker-engine.js
// @require      https://raw.githubusercontent.com/kpanapabusiness-droid/Poker_Bot/main/torn-adapter.js
// @require      https://raw.githubusercontent.com/kpanapabusiness-droid/Poker_Bot/main/strategy.js
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
  const E = window.PokerEngine, A = window.TornAdapter, S = window.PokerStrategy;
  if (!E || !A || !S) { console.warn('[PokerCoach] engine/adapter/strategy not loaded — check the @require lines.'); return; }

  // ─────────────────────────── Opponent ranges ───────────────────────────
  // Start from what each opponent did PREFLOP, then narrow on every postflop bet/raise/call.
  // Starter heuristics — Phase 3 adds per-player stats.
  const THREE_BET = '99+,AJs+,KQs,AQo+';
  const FLAT_CALL = '22+,A2s+,K9s+,Q9s+,J9s+,T8s+,97s+,86s+,75s+,65s,54s,ATo+,KJo+,QJo';
  const rangeCache = {};
  const parsed = txt => rangeCache[txt] || (rangeCache[txt] = E.parseRange(txt));

  function villainRange(action, position) {
    switch (action) {
      case 'raise': return { combos: E.rfiRange(position === 'BB' ? 'SB' : (position && E.RFI_RANGES[position] ? position : 'CO')), label: `opened ${position || ''}` };
      case '3bet+': return { combos: parsed(THREE_BET), label: '3-bet+' };
      case 'call': return { combos: parsed(FLAT_CALL), label: 'called a raise' };
      default: return { combos: null, label: action === 'limp' ? 'limped (any)' : action === 'check' ? 'BB check (any)' : 'any two' };
    }
  }

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

  function bigBlind(state) {
    const bb = state.actions.find(a => a.type === 'post' && a.blind === 'BB');
    if (bb) return bb.amount;
    const posted = state.actions.filter(a => a.type === 'post').map(a => a.amount);
    return posted.length ? Math.max(...posted) : 0;
  }

  // ─────────────────────────── Coach logic ───────────────────────────
  let lastKey = '', lastResult = null;
  function compute(state) {
    if (!state || !state.heroInHand || state.heroCards.length !== 2) return null;
    const pos = A.positions(state, E.positionFromSeat);
    const pf = A.preflopActions(state);
    const heroP = state.players.find(p => p.isHero);
    const villains = state.players.filter(p => p.inHand && !p.isHero).map(p => {
      const r = villainRange(pf[p.name], pos[p.slot]);
      return applyPostflop({ name: p.name, slot: p.slot, position: pos[p.slot] || '?', stack: p.stack, bet: p.bet, ...r }, state.actions, state.board);
    });
    const key = [state.handId, state.heroCards, state.board, state.pot, state.toCall, state.heroStack, villains.map(v => v.name + v.label + v.bet)].join('|');
    if (key === lastKey) return lastResult; // only recompute when something changed
    lastKey = key;

    // Postflop order: the player closest after the button acts first; hero is "in position" if he acts last.
    const order = slot => (slot - (state.dealerSlot ?? 0) - 1 + 9) % 9;
    const inPosition = villains.every(v => order(0) > order(v.slot));
    const bb = bigBlind(state);
    const ctx = {
      hero: E.parseCards(state.heroCards), board: E.parseCards(state.board), pot: state.pot, toCall: state.toCall,
      heroStack: state.heroStack, heroBet: state.heroBet, bb, position: pos[0] || 'CO', inPosition,
      heroName: heroP && heroP.name, actions: state.actions, villains,
    };
    const d = S.decide(ctx);
    const eff = Math.min(state.heroStack + state.heroBet, Math.max(0, ...villains.map(v => v.stack + v.bet)) || Infinity);
    lastResult = { d, villains, heroPos: pos[0] || '?', inPosition, bb, spr: state.pot ? eff / state.pot : null,
      handClass: E.handClass(ctx.hero) };
    return lastResult;
  }

  // ─────────────────────────── Panel UI ───────────────────────────
  const ACTION_COLORS = { RAISE: '#3b82f6', BET: '#3b82f6', 'ALL-IN': '#a855f7', CALL: '#22c55e', CHECK: '#a3a3a3', FOLD: '#ef4444' };
  const TAG_COLORS = { VALUE: '#22c55e', 'SEMI-BLUFF': '#f59e0b', BLUFF: '#f97316', PROTECTION: '#38bdf8', 'POT CONTROL': '#a3a3a3',
    CALL: '#22c55e', FOLD: '#ef4444', CHECK: '#a3a3a3', CHART: '#94a3b8', 'PUSH/FOLD': '#a855f7' };
  const panel = document.createElement('div');
  panel.id = 'poker-coach-panel';
  panel.style.cssText = 'position:fixed;top:110px;right:16px;z-index:99999;width:270px;padding:12px 14px;border-radius:10px;' +
    'background:rgba(15,17,21,.94);color:#e5e7eb;font:13px/1.4 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.4);cursor:move;user-select:none;';
  try { const p = JSON.parse(localStorage.getItem('pokerCoachPos') || 'null'); if (p) { panel.style.left = p.left; panel.style.top = p.top; panel.style.right = 'auto'; } } catch (e) {}
  document.body.appendChild(panel);
  makeDraggable(panel);

  const pct = x => (x == null ? '—' : Math.round(x * 100) + '%');
  const usd = x => '$' + Math.round(x).toLocaleString();
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const row = (k, v) => `<span style="opacity:.6">${k}</span><b>${v}</b>`;
  const optLabel = o => o.action === 'BET' ? `Bet ${usd(o.amount)}${o.sizeLabel ? ' · ' + o.sizeLabel : ''}` :
    o.action === 'RAISE' ? `Raise to ${usd(o.amount)}` : o.action === 'CALL' ? `Call ${usd(o.amount)}` :
    o.action === 'ALL-IN' ? `All-in ${usd(o.amount)}` : o.action[0] + o.action.slice(1).toLowerCase();

  function render(state, r) {
    if (!state) { panel.innerHTML = '<b>Poker Coach</b><div style="opacity:.6;margin-top:6px">No table found</div>'; return; }
    if (!r) { panel.innerHTML = `<b>Poker Coach</b><div style="opacity:.6;margin-top:6px">${state.heroInHand ? 'Reading hand…' : 'Not in this hand — waiting'}</div>`; return; }
    const { d } = r;
    const yourTurn = state.isHeroTurn;
    const color = yourTurn ? (ACTION_COLORS[d.action] || '#e5e7eb') : '#9ca3af';
    const tagColor = TAG_COLORS[d.tag] || '#94a3b8';
    const bluffLine = d.foldNeeded != null && ['BLUFF', 'SEMI-BLUFF', 'PROTECTION'].includes(d.tag)
      ? `<div style="font-size:11px;margin-top:3px;opacity:.85">Needs folds ${pct(d.foldNeeded)} · expected ${pct(d.foldEst)}</div>` : '';
    const opts = (d.options || []).slice(0, 5).map(o => {
      const best = o.action === d.action && Math.round(o.amount) === Math.round(d.amount);
      return `<div style="display:flex;justify-content:space-between;${best ? 'color:#fff;font-weight:600' : 'opacity:.7'}">
        <span>${best ? '▶ ' : ''}${esc(optLabel(o))}</span><span>${o.ev >= 0 ? '+' : ''}${usd(o.ev)}</span></div>`;
    }).join('');

    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;opacity:.75;font-size:11px">
        <span>${esc(r.handClass)} · ${esc(r.heroPos)}${state.street !== 'preflop' ? (r.inPosition ? ' · IP' : ' · OOP') : ''} · ${esc(state.street)}</span>
        <span>${d.handName ? esc(d.handName) : ''}</span></div>
      <div style="display:flex;align-items:center;gap:8px;margin:5px 0 2px">
        <div style="font-size:22px;font-weight:800;color:${color}">${esc(S.describe(d))}</div>
      </div>
      <div><span style="display:inline-block;font-size:10px;font-weight:700;letter-spacing:.04em;padding:1px 6px;border-radius:4px;background:${tagColor}22;color:${tagColor};border:1px solid ${tagColor}55">${esc(d.tag)}</span>
        ${yourTurn ? '' : '<span style="font-size:10px;opacity:.6;margin-left:6px">preview — not your turn</span>'}</div>
      <div style="font-size:12px;margin-top:5px;opacity:.9">${esc(d.reason)}</div>
      ${bluffLine}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:3px 10px;font-size:12px;margin-top:8px">
        ${row('Equity', pct(d.equity))}
        ${row('To call', state.toCall > 0 ? usd(state.toCall) : 'free')}
        ${row('Pot', usd(state.pot))}
        ${row('SPR', r.spr != null && isFinite(r.spr) ? r.spr.toFixed(1) : '—')}
      </div>
      ${opts ? `<div style="margin-top:8px;border-top:1px solid rgba(255,255,255,.1);padding-top:6px;font-size:11px">
        <div style="opacity:.5;margin-bottom:2px">Options (EV)</div>${opts}</div>` : ''}
      <div style="margin-top:8px;border-top:1px solid rgba(255,255,255,.1);padding-top:6px;font-size:11px">
        ${r.villains.map(v => `<div style="display:flex;justify-content:space-between;gap:6px">
          <span>${esc(v.name)} <span style="opacity:.55">${esc(v.position)}</span></span>
          <span style="opacity:.75">${esc(v.label)}${v.combos ? ' · ' + pct(E.rangePercent(v.combos)) : ''}</span></div>`).join('') || '<span style="opacity:.6">No opponents</span>'}
      </div>
      <div style="font-size:10px;opacity:.4;margin-top:6px">Starter model: casual-player fold rates · ranges from this hand's actions</div>`;
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
