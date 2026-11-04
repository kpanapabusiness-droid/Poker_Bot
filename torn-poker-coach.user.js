// ==UserScript==
// @name         Torn Poker Coach
// @namespace    keanu.poker.coach
// @version      0.5.0
// @description  Live poker coach for Torn: tells you what to do and how much (value, bluff, semi-bluff), with equity, odds, positions and opponent ranges. Display only — never clicks or acts.
// @match        https://www.torn.com/page.php?sid=holdem*
// @require      https://raw.githubusercontent.com/kpanapabusiness-droid/Poker_Bot/main/poker-engine.js
// @require      https://raw.githubusercontent.com/kpanapabusiness-droid/Poker_Bot/main/torn-adapter.js
// @require      https://raw.githubusercontent.com/kpanapabusiness-droid/Poker_Bot/main/strategy.js
// @require      https://raw.githubusercontent.com/kpanapabusiness-droid/Poker_Bot/main/tracker.js
// @require      https://raw.githubusercontent.com/kpanapabusiness-droid/Poker_Bot/main/logger.js
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
  const E = window.PokerEngine, A = window.TornAdapter, S = window.PokerStrategy, T = window.PokerTracker, L = window.PokerLogger;
  if (!E || !A || !S || !T || !L) { console.warn('[PokerCoach] engine/adapter/strategy/tracker/logger not loaded — check the @require lines.'); return; }

  // ─────────────────────────── Opponent tracker (Phase 3) ───────────────────────────
  // Learns every player from completed hands in the game log. Saved in this browser (localStorage on torn.com).
  const STORE_KEY = 'pokerCoachTracker';
  const tracker = T.create({
    load: () => { try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (e) { return null; } },
    save: d => { try { localStorage.setItem(STORE_KEY, JSON.stringify(d)); } catch (e) {} },
  });
  // ─────────────────────────── Hand logger ───────────────────────────
  // Records every hand + decision (coach's advice vs what you did, EV lost) for the Report view.
  const HANDS_KEY = 'pokerCoachHands';
  const logger = L.create({
    load: () => { try { return JSON.parse(localStorage.getItem(HANDS_KEY) || 'null'); } catch (e) { return null; } },
    save: d => { try { localStorage.setItem(HANDS_KEY, JSON.stringify(d)); } catch (e) { console.warn('[PokerCoach] hand log storage full — export and reset it', e); } },
  });
  function downloadCSV() {
    const blob = new Blob([logger.toCSV()], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'poker-coach-hands-' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // Console helpers
  window.PokerCoach = {
    stats: name => tracker.estimate(name),
    players: () => tracker.players().map(n => ({ name: n, ...summary(tracker.estimate(n)) })),
    exportStats: () => tracker.exportData(),
    importStats: d => tracker.importData(d),
    resetStats: () => tracker.reset(),
    report: (allTime = true) => logger.report({ since: allTime ? 0 : logger.sessionSince() }),
    hands: () => logger.hands(),
    exportHands: () => logger.exportData(),
    importHands: d => logger.importData(d),
    downloadCSV,
    resetHands: () => logger.reset(),
  };
  const summary = e => ({ type: e.type.label, hands: e.hands, vpip: Math.round(e.vpip * 100), pfr: Math.round(e.pfr * 100), af: +e.af.toFixed(1), f2b: Math.round(e.f2b * 100) });

  // ─────────────────────────── Opponent ranges ───────────────────────────
  // Sized from each player's OWN stats (shrunk towards average for strangers), then narrowed
  // on every postflop bet/raise/call with bluff/float shares matched to how aggressive they are.
  const POS_WIDTH = { EP: 0.55, LJ: 0.7, HJ: 0.85, CO: 1.05, BTN: 1.4, SB: 1.15, BB: 0.8 };
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const without = (combos, remove) => { const k = new Set(remove.map(([a, b]) => a * 52 + b)); return combos.filter(([a, b]) => !k.has(a * 52 + b)); };

  function villainRange(action, position, est) {
    const pfrW = clamp(est.pfr * (POS_WIDTH[position] || 1), 0.03, 0.8);
    switch (action) {
      case 'raise': return { combos: E.topRange(pfrW), label: `opened ${position || ''} · top ${Math.round(pfrW * 100)}%` };
      case '3bet+': { const w = clamp(est.threeBet * 1.3, 0.02, 0.35); return { combos: E.topRange(w), label: `3-bet+ · top ${Math.round(w * 100)}%` }; }
      case 'call': {
        const w = clamp(est.vpip, 0.08, 0.85);
        return { combos: without(E.topRange(w), E.topRange(clamp(est.threeBet * 0.6, 0.01, 0.2))), label: `called a raise · ${Math.round(w * 100)}% player` };
      }
      case 'limp': {
        const w = clamp(est.vpip, 0.1, 0.9);
        return { combos: without(E.topRange(w), E.topRange(clamp(est.pfr * 0.6, 0.01, 0.25))), label: `limped · ${Math.round(w * 100)}% player` };
      }
      default: return { combos: null, label: action === 'check' ? 'BB check (any)' : 'any two' };
    }
  }

  const BOARD_LEN = { flop: 3, turn: 4, river: 5 };
  function applyPostflop(villain, actions, board, est) {
    const opts = { bluffKeep: clamp(0.06 + 0.07 * est.af, 0.06, 0.45), floatKeep: clamp(0.75 - est.f2b, 0.1, 0.6) };
    let street = 'preflop', combos = villain.combos || E.allCombos();
    const steps = [];
    for (const a of actions) {
      if (a.type === 'street') { street = a.street; continue; }
      if (street === 'preflop' || a.actor !== villain.name) continue;
      if (!['bet', 'raise', 'allin', 'call'].includes(a.type)) continue;
      const b = board.slice(0, BOARD_LEN[street]);
      if (b.length < BOARD_LEN[street]) continue;
      combos = E.narrowRange(combos, b, a.type, opts);
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
      const est = tracker.estimate(p.name);
      const r = villainRange(pf[p.name], pos[p.slot], est);
      return applyPostflop({ name: p.name, slot: p.slot, position: pos[p.slot] || '?', stack: p.stack, bet: p.bet,
        est, foldOverride: est.f2b, ...r }, state.actions, state.board, est);
    });
    const key = [state.handId, state.heroCards, state.board, state.pot, state.toCall, state.heroStack, villains.map(v => v.name + v.label + v.bet + v.est.hands)].join('|');
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

  // ─────────────────────────── Views: Coach | Report ───────────────────────────
  let view = 'coach', scope = 'session';
  const tabBtn = (id, label, active) => `<button data-pc="${id}" style="all:unset;cursor:pointer;font-size:11px;font-weight:700;padding:2px 8px;border-radius:4px;${active ? 'background:rgba(255,255,255,.15);color:#fff' : 'color:#9ca3af'}">${label}</button>`;
  const tabs = () => `<div style="display:flex;gap:4px;margin:-2px 0 8px">${tabBtn('coach', 'Coach', view === 'coach')}${tabBtn('report', 'Report', view === 'report')}</div>`;

  function render(state, r) {
    const body = view === 'report' ? reportView() : coachView(state, r);
    panel.innerHTML = tabs() + body;
  }

  function sessionLine() {
    const s = logger.report({ since: logger.sessionSince() });
    if (!s.hands) return 'Session: no hands logged yet';
    return `Session: ${s.hands} hand${s.hands === 1 ? '' : 's'} · ${s.net >= 0 ? '+' : '−'}${usd(Math.abs(s.net))} · followed ${s.followRate == null ? '—' : pct(s.followRate)}`;
  }

  function coachView(state, r) {
    if (!state) return '<div style="opacity:.6">No table found</div>';
    if (!r) return `<div style="opacity:.6">${state.heroInHand ? 'Reading hand…' : 'Not in this hand — waiting'}</div>
      <div style="font-size:10px;opacity:.45;margin-top:8px">${esc(sessionLine())}</div>`;
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

    return `
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
        ${r.villains.map(v => {
          const e = v.est, t = e.type, tc = TYPE_COLORS[t.short] || '#94a3b8';
          return `<div style="margin-bottom:4px">
            <div style="display:flex;justify-content:space-between;gap:6px">
              <span>${esc(v.name)} <span style="opacity:.55">${esc(v.position)}</span>
                <span style="font-size:9px;font-weight:700;color:${tc};margin-left:3px">${esc(t.short)}</span></span>
              <span style="opacity:.6">${e.hands ? `VPIP ${pct(e.vpip)} · PFR ${pct(e.pfr)} · F2B ${pct(e.f2b)} · n${e.hands}` : 'new player'}</span></div>
            <div style="opacity:.6;font-size:10px">${esc(v.label)}${v.combos ? ' → ' + pct(E.rangePercent(v.combos)) + ' of hands' : ''}</div></div>`;
        }).join('') || '<span style="opacity:.6">No opponents</span>'}
      </div>
      ${headsUpNote(r)}
      <div style="font-size:10px;opacity:.45;margin-top:6px">${esc(sessionLine())}</div>
      <div style="font-size:10px;opacity:.35;margin-top:2px">${tracker.players().length} players tracked · strangers start as average casual players</div>`;
  }

  function reportView() {
    const rp = logger.report({ since: scope === 'session' ? logger.sessionSince() : 0 });
    const sign = x => (x >= 0 ? '+' : '−') + usd(Math.abs(x));
    const scopeBtns = `<div style="display:flex;gap:4px;margin-bottom:6px">${tabBtn('scope-session', 'Session', scope === 'session')}${tabBtn('scope-all', 'All time', scope === 'all')}
      <span style="flex:1"></span>${tabBtn('csv', '⬇ CSV', false)}</div>`;
    if (!rp.hands) return scopeBtns + '<div style="opacity:.6;font-size:12px">No hands logged yet. Play a few and they\'ll show up here.</div>';
    const cardStr = c => (c || []).join(' ');
    const actStr = a => a.action ? `${a.action}${a.amount ? ' ' + usd(a.amount) : ''}` : `${(a.type || '').toUpperCase()}${a.amount ? ' ' + usd(a.amount) : ''}`;
    const pos = Object.entries(rp.byPosition).sort((a, b) => b[1].hands - a[1].hands)
      .map(([p, x]) => `<span style="opacity:.6">${esc(p)}</span><span>${x.hands}h</span><b style="color:${x.bb100 >= 0 ? '#22c55e' : '#ef4444'}">${x.bb100 >= 0 ? '+' : ''}${x.bb100.toFixed(0)} bb/100</b>`).join('');
    return scopeBtns + `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:3px 10px;font-size:12px">
        ${row('Hands', rp.hands)}
        ${row('Result', `<span style="color:${rp.net >= 0 ? '#22c55e' : '#ef4444'}">${sign(rp.net)}</span>`)}
        ${row('bb/100', rp.bb100.toFixed(1))}
        ${row('Followed', rp.followRate == null ? '—' : pct(rp.followRate))}
        ${row('EV lost', usd(rp.evLost))}
        ${row('EV lost/100', rp.evLostPer100.toFixed(1) + ' bb')}
      </div>
      <div style="font-size:11px;margin-top:6px;opacity:.85">Followed every time: ${rp.followedHands} hands, ${sign(rp.followedNet)} · Went your own way: ${rp.deviatedHands} hands, ${sign(rp.deviatedNet)}</div>
      ${rp.patterns.length ? `<div style="margin-top:8px;border-top:1px solid rgba(255,255,255,.1);padding-top:6px;font-size:11px">
        <div style="opacity:.5;margin-bottom:2px">Your habits vs the coach</div>
        ${rp.patterns.slice(0, 4).map(x => `<div style="display:flex;justify-content:space-between"><span>Coach ${esc(x.pattern)}</span><span style="opacity:.75">×${x.count}${x.evLost ? ' · −' + usd(x.evLost) + ' EV' : ''}</span></div>`).join('')}</div>` : ''}
      ${rp.costliest.length ? `<div style="margin-top:8px;border-top:1px solid rgba(255,255,255,.1);padding-top:6px;font-size:11px">
        <div style="opacity:.5;margin-bottom:2px">Costliest decisions</div>
        ${rp.costliest.slice(0, 3).map(x => `<div style="margin-bottom:3px"><b>${esc(cardStr(x.cards))}</b> <span style="opacity:.6">${esc(x.street)} · ${esc(cardStr(x.board))}</span><br>
          <span style="opacity:.8">Coach: ${esc(actStr(x.rec))} · You: ${esc(actStr(x.actual))}</span> <span style="color:#ef4444">−${usd(x.evLost)} EV</span></div>`).join('')}</div>` : ''}
      <div style="margin-top:8px;border-top:1px solid rgba(255,255,255,.1);padding-top:6px;font-size:11px">
        <div style="opacity:.5;margin-bottom:2px">By position</div>
        <div style="display:grid;grid-template-columns:auto auto 1fr;gap:2px 10px">${pos}</div></div>
      <div style="font-size:10px;opacity:.4;margin-top:6px">Results swing with luck — EV lost is the number to shrink</div>`;
  }

  panel.addEventListener('click', e => {
    const b = e.target.closest('[data-pc]');
    if (!b) return;
    const id = b.getAttribute('data-pc');
    if (id === 'coach' || id === 'report') view = id;
    else if (id === 'scope-session') scope = 'session';
    else if (id === 'scope-all') scope = 'all';
    else if (id === 'csv') downloadCSV();
    render(lastState, lastRender);
  });
  let lastState = null, lastRender = null;

  const TYPE_COLORS = { STATION: '#22c55e', FISH: '#22c55e', MANIAC: '#ef4444', NIT: '#38bdf8', ROCK: '#38bdf8', TAG: '#f59e0b', LAG: '#f97316', AVG: '#94a3b8', '?': '#6b7280' };
  function headsUpNote(r) {
    if (r.villains.length !== 1) return '';
    const t = r.villains[0].est.type;
    if (t.short === '?' || t.short === 'AVG') return '';
    return `<div style="margin-top:6px;font-size:11px;padding:4px 6px;border-radius:4px;background:rgba(255,255,255,.05)">
      <b>vs ${esc(t.label)}:</b> ${esc(t.note)}</div>`;
  }

  function makeDraggable(el) {
    let sx, sy, ox, oy;
    el.addEventListener('mousedown', e => {
      if (e.target.closest('button')) return; // let tab/CSV buttons click
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
      if (!window.__coachTestState) tracker.ingest(A.readLog(document)); // learn from any newly finished hands
      const r = compute(state);
      if (!window.__coachTestState && state) logger.observe(state, r && r.d, { position: r ? r.heroPos : null, bb: r ? r.bb : 0 });
      lastState = state; lastRender = r;
      render(state, r);
    } catch (e) { console.warn('[PokerCoach]', e); }
  }, 400);
})();
