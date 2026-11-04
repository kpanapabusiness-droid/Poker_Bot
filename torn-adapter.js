/*
 * torn-adapter.js — reads Torn City's Texas Hold'em table into a TableState.
 *
 * Read-only: it only looks at the page. It never clicks, types or sends anything.
 *
 * Torn uses CSS-module class names with hashes (e.g. "communityCards___j55GN").
 * The hash part can change whenever Torn redeploys, so every selector here matches
 * on the stable PREFIX only ([class*="communityCards___"]). If something breaks after
 * a Torn update, check these prefixes first.
 *
 * Seat numbering (verified against live snapshots, Nov 2026):
 *   hero = slot 0; opponents = playerPositioner-1..8, clockwise from the hero.
 *   Action moves in ascending slot order (…7 → 8 → hero → 1 → 2…).
 *   The dealer marker uses the same numbering: dealer___ position-N.
 *   Bets in front of players: player-pot-N (hero = player-pot-0).
 *
 * Works in the browser (global TornAdapter) and in Node with jsdom (module.exports).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TornAdapter = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SEL = {
    wrapper: '[class*="holdemWrapper___"]',
    community: '[class*="communityCards___"]',
    faceCard: '[role="img"][class*="fourColors___"]',   // a face-up card
    seat: '[class*="playerPositioner-"]',
    opponent: '[class*="opponent___"]',
    name: '[class*="name___"]',
    stack: '[class*="potString___"]',
    oppState: '[class*="state___"]',
    hero: '[class*="playerMeGateway___"] [class*="self___"]',
    heroHand: '[class*="hand___"]',
    heroStack: '[class*="pot___"]',
    dealer: '[class*="dealer___"]',
    totalPot: '[class*="totalPotWrap___"]',
    playerBet: '[class*="player-pot-"]',
    buttons: '[class*="buttonsWrap___"] button',
    status: '[class*="statusWrapper___"] [class*="status___"]',
    logItems: '[class*="messagesList___"] li',
  };

  const SUITS = { hearts: 'h', diamonds: 'd', clubs: 'c', spades: 's' };
  const SUIT_SYMBOLS = { '♥': 'h', '♦': 'd', '♣': 'c', '♠': 's' };
  const NOT_DEALT = /^(waiting bb|sitting out|waiting)$/i;

  const text = el => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const money = s => { const m = String(s || '').replace(/,/g, '').match(/\$?\s*([0-9]+(?:\.[0-9]+)?)/); return m ? Number(m[1]) : 0; };
  const classHas = (el, prefix) => !!el && [...el.classList].some(c => c.startsWith(prefix + '___'));
  const slotFrom = (el, re) => { const m = [...el.classList].join(' ').match(re); return m ? Number(m[1]) : null; };

  /** Card element → "As" / "Td". Torn classes look like "hearts-A___ZKSys", "spades-10___bxbJ_". */
  function readCard(el) {
    for (const c of el.classList) {
      const m = c.match(/^(hearts|diamonds|clubs|spades)-(10|[2-9JQKA])___/);
      if (m) return (m[2] === '10' ? 'T' : m[2]) + SUITS[m[1]];
    }
    return null;
  }
  const readCards = scope => (scope ? [...scope.querySelectorAll(SEL.faceCard)].map(readCard).filter(Boolean) : []);

  // ─────────────────────────── Action log ───────────────────────────
  /** Turn one log line's text ("raised $10 to $20", "reveals [Q♣, 6♥] (Pair…)") into an action object. */
  function parseLogLine(actor, body) {
    let m;
    const b = body.trim();
    if ((m = b.match(/^(\S+) started$/)) && actor === 'Game') return { type: 'start', handId: m[1] };
    if (/^The (preflop|flop|turn|river)/i.test(actor)) {
      const street = actor.match(/preflop|flop|turn|river/i)[0].toLowerCase();
      return { type: 'street', street, cards: parseCardText(b) };
    }
    if ((m = b.match(/^posted small blind \$([\d,]+)/))) return { type: 'post', actor, blind: 'SB', amount: money(m[1]) };
    if ((m = b.match(/^posted big blind \$([\d,]+)/))) return { type: 'post', actor, blind: 'BB', amount: money(m[1]) };
    if ((m = b.match(/^posted \$([\d,]+)/))) return { type: 'post', actor, blind: 'dead', amount: money(m[1]) };
    if (/^folded/.test(b)) return { type: 'fold', actor };
    if (/^checked/.test(b)) return { type: 'check', actor };
    if ((m = b.match(/^called \$([\d,]+)/))) return { type: 'call', actor, amount: money(m[1]) };
    if ((m = b.match(/^bet \$([\d,]+)/))) return { type: 'bet', actor, amount: money(m[1]) };
    if ((m = b.match(/^raised \$([\d,]+) to \$([\d,]+)/))) return { type: 'raise', actor, amount: money(m[1]), to: money(m[2]) };
    if (/all[- ]in/i.test(b)) return { type: 'allin', actor, amount: money(b) };
    if (/^reveals/.test(b)) return { type: 'show', actor, cards: parseCardText(b.split(']')[0]), desc: (b.match(/\(([^)]+)\)/) || [])[1] };
    if ((m = b.match(/^won \$([\d,]+)/))) return { type: 'win', actor, amount: money(m[1]), cards: parseCardText(b.split(']')[0]) };
    if (/joined the table/.test(b)) return { type: 'join', actor };
    if (/left the table/.test(b)) return { type: 'leave', actor };
    return { type: 'other', actor, text: b };
  }

  /** "A♥, 8♠, 10♣" → ["Ah","8s","Tc"] */
  function parseCardText(s) {
    const out = [], re = /(10|[2-9JQKA])\s*([♥♦♣♠])/g; let m;
    while ((m = re.exec(s))) out.push((m[1] === '10' ? 'T' : m[1]) + SUIT_SYMBOLS[m[2]]);
    return out;
  }

  /** All log lines, oldest first. */
  function readLog(doc) {
    return [...doc.querySelectorAll(SEL.logItems)].map(li => {
      const actor = text(li.querySelector('em'));
      const em = li.querySelector('em');
      const body = text(li).slice(text(em).length).trim();
      return parseLogLine(actor, body);
    });
  }

  /** Only the current hand's lines (everything after the last "Game … started"). */
  function currentHandLog(log) {
    let i = -1;
    for (let k = log.length - 1; k >= 0; k--) if (log[k].type === 'start') { i = k; break; }
    return i < 0 ? { handId: null, actions: [] } : { handId: log[i].handId, actions: log.slice(i + 1) };
  }

  // ─────────────────────────── Table state ───────────────────────────
  /**
   * Read the whole table. Returns null if there's no poker table on the page.
   * TableState = {
   *   handId, street, heroCards, board, pot, toCall, heroStack, heroBet, isHeroTurn,
   *   heroInHand, players:[{ slot, name, id, stack, bet, state, inHand, dealt, isHero, isButton }],
   *   dealerSlot, actions, statusText, buttons
   * }
   */
  function readState(doc) {
    doc = doc || document;
    const wrap = doc.querySelector(SEL.wrapper);
    if (!wrap) return null;

    // Bets in front of each seat: player-pot-N
    const bets = {};
    wrap.querySelectorAll(SEL.playerBet).forEach(el => {
      const slot = slotFrom(el, /player-pot-(\d+)___/);
      if (slot != null) bets[slot] = money(text(el));
    });

    const dealerEl = wrap.querySelector(SEL.dealer);
    const dealerSlot = dealerEl ? slotFrom(dealerEl, /position-(\d+)___/) : null;

    // Opponents
    const players = [...wrap.querySelectorAll(SEL.seat)].map(seatEl => {
      const slot = slotFrom(seatEl, /playerPositioner-(\d+)___/);
      const o = seatEl.querySelector(SEL.opponent);
      if (!o) return null; // empty seat
      const state = text(o.querySelector(SEL.oppState));
      const folded = classHas(o, 'folded');
      return {
        slot, isHero: false,
        id: (o.id || '').replace('player-', '') || null,
        name: text(o.querySelector(SEL.name)),
        stack: money(text(o.querySelector(SEL.stack))),
        bet: bets[slot] || 0,
        state: /^\d+(\s+\d+)?$/.test(state) ? 'Thinking' : state, // active players show timer digits
        inHand: !folded,
        dealt: !NOT_DEALT.test(state),
        isButton: slot === dealerSlot,
      };
    }).filter(Boolean);

    // Hero
    const heroEl = wrap.querySelector(SEL.hero) || doc.querySelector(SEL.hero);
    let heroCards = [], heroStack = 0, heroInHand = false;
    if (heroEl) {
      const heroState = text(heroEl.querySelector('[class*="state___"]'));
      heroCards = readCards(heroEl.querySelector(SEL.heroHand));
      heroStack = money(text(heroEl.querySelector(SEL.heroStack)));
      heroInHand = !classHas(heroEl, 'folded') && heroCards.length === 2;
      players.push({
        slot: 0, isHero: true, id: (heroEl.id || '').replace('player-', '') || null, name: null,
        stack: heroStack, bet: bets[0] || 0, state: heroInHand ? '' : heroState.replace(/^\$[\d,]+\s*/, ''),
        inHand: heroInHand, dealt: heroInHand || !NOT_DEALT.test(heroState.replace(/^\$[\d,]+\s*/, '')), isButton: dealerSlot === 0,
      });
    }
    players.sort((a, b) => a.slot - b.slot);

    // Board, pot, buttons, status
    const board = readCards(wrap.querySelector(SEL.community));
    const pot = money(text(wrap.querySelector(SEL.totalPot)));
    const buttons = [...doc.querySelectorAll(SEL.buttons)].map(b => text(b));
    const statusText = text(doc.querySelector(SEL.status));
    const isHeroTurn = /your turn/i.test(statusText);

    // What hero must add: prefer the "Call $X" button, otherwise work it out from the bets on the table.
    const heroBet = bets[0] || 0;
    const callBtn = buttons.find(b => /^call \$/i.test(b));
    const maxBet = Math.max(0, ...players.filter(p => p.inHand || p.bet).map(p => p.bet));
    let toCall = callBtn ? money(callBtn) : Math.max(0, maxBet - heroBet);
    if (heroStack) toCall = Math.min(toCall, heroStack);
    if (isHeroTurn && buttons.some(b => /^check$/i.test(b))) toCall = 0;

    // Hero's name: the log names hero but the seat doesn't — find the log actor who isn't an opponent.
    const log = readLog(doc);
    const { handId, actions } = currentHandLog(log);
    const oppNames = new Set(players.filter(p => !p.isHero).map(p => p.name));
    const hero = players.find(p => p.isHero);
    if (hero) {
      const candidates = actions.filter(a => a.actor && !oppNames.has(a.actor) && a.type !== 'join' && a.type !== 'leave' && !/^(Game|The )/.test(a.actor));
      hero.name = candidates.length ? candidates[candidates.length - 1].actor : null;
    }

    const street = ['preflop', 'flop', 'flop', 'flop', 'turn', 'river'][board.length] || 'preflop';
    return { handId, street, heroCards, board, pot, toCall, heroStack, heroBet, isHeroTurn, heroInHand,
      players, dealerSlot, actions, statusText, buttons };
  }

  // ─────────────────────────── Positions ───────────────────────────
  /**
   * Position label for every dealt player, using the dealer slot and seat order.
   * Returns { [slot]: 'BTN' | 'SB' | 'BB' | 'EP' | 'LJ' | 'HJ' | 'CO' }.
   * Heads-up: the button is also the small blind; we label it 'BTN'.
   */
  function positions(state, positionFromSeat) {
    const dealt = state.players.filter(p => p.dealt).sort((a, b) => a.slot - b.slot);
    if (!dealt.length || state.dealerSlot == null) return {};
    // the button is the dealer seat, or the next dealt seat after it if the dealer isn't dealt in
    let start = dealt.findIndex(p => p.slot >= state.dealerSlot);
    if (start < 0) start = 0;
    if (dealt[start].slot !== state.dealerSlot) start = (start - 1 + dealt.length) % dealt.length;
    const out = {};
    dealt.forEach((p, i) => {
      const fromBtn = (i - start + dealt.length) % dealt.length;
      out[p.slot] = positionFromSeat(fromBtn, dealt.length);
    });
    return out;
  }

  /**
   * Simple preflop read for each player in the current hand:
   * 'raise' (opened), '3bet+' (re-raised), 'call', 'limp', 'check' (BB option), or null.
   */
  function preflopActions(state) {
    const out = {}; let raises = 0, street = 'preflop';
    for (const a of state.actions) {
      if (a.type === 'street') { street = a.street; continue; }
      if (street !== 'preflop' || !a.actor) continue;
      if (a.type === 'raise' || a.type === 'bet' || a.type === 'allin') { raises++; out[a.actor] = raises === 1 ? 'raise' : '3bet+'; }
      else if (a.type === 'call') { if (!out[a.actor]) out[a.actor] = raises ? 'call' : 'limp'; }
      else if (a.type === 'check') { if (!out[a.actor]) out[a.actor] = 'check'; }
    }
    return out;
  }

  return { SEL, readState, readCard, readLog, parseLogLine, parseCardText, currentHandLog, positions, preflopActions, money };
});
