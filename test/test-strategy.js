// Decision-layer tests on textbook spots. Run with: node test/test-strategy.js
const S = require('../strategy.js');
const E = require('../poker-engine.js');
const h = s => E.parseCards(s);
E.setSeed(42); // repeatable simulations
let pass = 0, fail = 0;
const base = { bb: 10, heroStack: 1000, heroBet: 0, villains: [{ name: 'V', position: 'CO', stack: 1000, bet: 0 }], heroName: 'Hero', actions: [] };
function spot(name, ctx, expectActions, expectTag) {
  const d = S.decide({ ...base, ...ctx });
  const okA = [].concat(expectActions).includes(d.action);
  const okT = !expectTag || [].concat(expectTag).includes(d.tag);
  const ok = okA && okT;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name.padEnd(46)} → ${S.describe(d).padEnd(22)} ${d.tag.padEnd(11)} ${ok ? '' : '(expected ' + [].concat(expectActions).join('/') + (expectTag ? ' ' + [].concat(expectTag).join('/') : '') + ')'}`);
  return d;
}
const raiseBy = (actor, to) => [{ type: 'raise', actor, amount: to - 10, to }];

console.log('\nPreflop');
spot('AA under the gun, unopened', { hero: h('AsAd'), position: 'EP', pot: 15, toCall: 10 }, 'RAISE', 'VALUE');
spot('72o under the gun, unopened', { hero: h('7s2d'), position: 'EP', pot: 15, toCall: 10 }, 'FOLD');
spot('A5s on the button, unopened', { hero: h('As5s'), position: 'BTN', pot: 15, toCall: 10 }, 'RAISE');
spot('Big blind, limped pot, weak hand', { hero: h('Ts3h'), position: 'BB', pot: 30, toCall: 0, heroBet: 10, actions: [{ type: 'call', actor: 'V', amount: 10 }] }, 'CHECK');
spot('Big blind, limped pot, QQ', { hero: h('QsQh'), position: 'BB', pot: 30, toCall: 0, heroBet: 10, actions: [{ type: 'call', actor: 'V', amount: 10 }] }, 'RAISE', 'VALUE');
spot('55 in the CO behind a limper (iso-raise)', { hero: h('5s5h'), position: 'CO', pot: 25, toCall: 10, actions: [{ type: 'call', actor: 'V', amount: 10 }] }, 'RAISE', 'VALUE');
spot('97s in the LJ behind a limper (limp behind)', { hero: h('9s7s'), position: 'LJ', pot: 25, toCall: 10, actions: [{ type: 'call', actor: 'V', amount: 10 }] }, 'CALL');
spot('AKo vs a CO open', { hero: h('AhKd'), position: 'BTN', pot: 45, toCall: 30, actions: raiseBy('V', 30) }, 'RAISE', 'VALUE');
spot('A4s on BTN vs CO open (3-bet bluff)', { hero: h('As4s'), position: 'BTN', pot: 45, toCall: 30, actions: raiseBy('V', 30) }, 'RAISE', 'BLUFF');
spot('77 on BTN vs CO open, deep (set-mine)', { hero: h('7s7d'), position: 'BTN', pot: 45, toCall: 30, actions: raiseBy('V', 30) }, 'CALL');
spot('76s on BTN vs CO open, 200bb deep (speculative call)', { hero: h('7s6s'), position: 'BTN', pot: 45, toCall: 30, heroStack: 2000, actions: raiseBy('V', 30), villains: [{ name: 'V', position: 'CO', stack: 2000, bet: 30 }] }, 'CALL');
spot('76s on BTN vs CO open, 35bb (too short to pay off)', { hero: h('7s6s'), position: 'BTN', pot: 45, toCall: 30, heroStack: 350, actions: raiseBy('V', 30), villains: [{ name: 'V', position: 'CO', stack: 350, bet: 30 }] }, 'FOLD');
{ // 6 Nov, Torn: trips with a weak kicker vs a river lead from a check-caller → call, don't shove
  const b = E.parseCards('Qc5c6h4dQd');
  let c = E.topRange(0.5); c = E.weightRange(c, b.slice(0, 3), 'call'); c = E.weightRange(c, b.slice(0, 4), 'call'); c = E.weightRange(c, b, 'bet');
  // what our line says (button open, bet flop, bet turn), as the brain builds it
  let ours = E.topRange(0.31); ours = E.weightRange(ours, b.slice(0, 3), 'bet'); ours = E.weightRange(ours, b.slice(0, 4), 'bet');
  spot('Q9 trips vs a river lead after check-calling the turn (call, raising only gets called by better)', { hero: h('Qh9d'), board: b, pot: 3032220, toCall: 1516110, heroStack: 9104445, bb: 25000, position: 'BTN', street: 'river', inPosition: true, heroRange: ours, villains: [{ name: 'V', position: 'BB', stack: 4076149, bet: 1516110, combos: c }] }, 'CALL');
}
spot('J4o vs an open', { hero: h('Jd4c'), position: 'HJ', pot: 45, toCall: 30, actions: raiseBy('V', 30) }, 'FOLD');
spot('KK facing a 3-bet', { hero: h('KsKd'), position: 'CO', pot: 140, toCall: 60, heroBet: 30, actions: [...raiseBy('Hero', 30), { type: 'raise', actor: 'V', amount: 60, to: 90 }] }, ['RAISE', 'ALL-IN'], 'VALUE');
spot('A9o facing a 3-bet', { hero: h('Ad9c'), position: 'CO', pot: 140, toCall: 60, heroBet: 30, actions: [...raiseBy('Hero', 30), { type: 'raise', actor: 'V', amount: 60, to: 90 }] }, 'FOLD');
spot('10bb A7o in the CO (shove)', { hero: h('Ad7c'), position: 'CO', pot: 15, toCall: 10, heroStack: 100, villains: [{ name: 'V', position: 'BTN', stack: 1000, bet: 0 }] }, 'ALL-IN', 'PUSH/FOLD');
spot('10bb 83o under the gun (fold)', { hero: h('8d3c'), position: 'EP', pot: 15, toCall: 10, heroStack: 100 }, 'FOLD', 'PUSH/FOLD');

console.log('\nPostflop');
spot('Nut flush, checked to you', { hero: h('AhKh'), board: h('Qh7h2h'), position: 'BTN', pot: 60, toCall: 0 }, 'BET', 'VALUE');
spot('Flopped set, checked to you', { hero: h('7s7d'), board: h('7hKc2d'), position: 'BTN', pot: 60, toCall: 0 }, 'BET', 'VALUE');
spot('Flush draw facing a half-pot bet', { hero: h('KhQh'), board: h('Th7h2c'), position: 'BTN', pot: 90, toCall: 30, villains: [{ name: 'V', position: 'CO', stack: 1000, bet: 30 }] }, ['RAISE', 'CALL'], ['SEMI-BLUFF', 'CALL']);
spot('Set on a wet turn facing a bet', { hero: h('7s7d'), board: h('7hTh9c2s'), position: 'CO', pot: 120, toCall: 60, villains: [{ name: 'V', position: 'BTN', stack: 1000, bet: 60 }] }, ['RAISE', 'ALL-IN', 'CALL']);
const riverRange = E.narrowRange(E.allCombos(), 'Ah7c2d9sKc', 'bet');
spot('Bottom pair vs a pot-sized river bet', { hero: h('2s3d'), board: h('Ah7c2d9sKc'), position: 'BTN', pot: 200, toCall: 100, villains: [{ name: 'V', position: 'CO', stack: 1000, bet: 100, combos: riverRange }] }, 'FOLD');
spot('Pure air on the river, checked to you vs folder', { hero: h('6s5s'), board: h('AhKd9c2hQc'), position: 'BTN', pot: 100, toCall: 0, villains: [{ name: 'V', position: 'BB', stack: 1000, bet: 0, foldOverride: 0.7 }] }, 'BET', 'BLUFF');
spot('Pure air on the river vs a calling station', { hero: h('6s5s'), board: h('AhKd9c2hQc'), position: 'BTN', pot: 100, toCall: 0, villains: [{ name: 'V', position: 'BB', stack: 1000, bet: 0, foldOverride: 0.05 }] }, 'CHECK');
spot('Nuts on the river facing a bet', { hero: h('AsKs'), board: h('QsJsTs2d3c'), position: 'BTN', pot: 200, toCall: 100, villains: [{ name: 'V', position: 'CO', stack: 1000, bet: 100 }] }, ['RAISE', 'ALL-IN'], 'VALUE');
spot('Short stack: top pair, checked to, SPR < 1', { hero: h('AsQd'), board: h('Ah8c3d'), position: 'BTN', pot: 200, toCall: 0, heroStack: 150, villains: [{ name: 'V', position: 'BB', stack: 600, bet: 0 }] }, ['ALL-IN', 'BET'], 'VALUE');
// Small blind facing an open: 3-bet or fold, no flat calls (pairs at a set-mining price excepted).
spot('SB facing a CO open with AJs (no flat from the small blind)', { hero: h('AhJh'), board: [], position: 'SB', pot: 35, toCall: 20, heroBet: 5, actions: [{ type: 'post', actor: 'Hero', amount: 5 }, { type: 'post', actor: 'B', amount: 10 }, ...raiseBy('V', 30)], villains: [{ name: 'V', position: 'CO', stack: 1000, bet: 30 }, { name: 'B', position: 'BB', stack: 1000, bet: 10 }] }, ['FOLD', 'RAISE']);
// We bet the flop and got raised: no re-raise without a strong hand.
spot('Bet the flop with a draw, got raised: no re-raise war', { hero: h('QhJh'), board: h('Th4h2c'), position: 'BTN', pot: 260, toCall: 120, heroBet: 60, villains: [{ name: 'V', position: 'BB', stack: 820, bet: 180 }] }, ['CALL', 'FOLD']);
// A passive player who folds a lot when they check doesn't fold much once they've bet: don't raise-bluff them.
const passiveBet = E.narrowRange(E.allCombos(), 'Ah9c4d', 'bet', { bluffKeep: 0.06 });
spot('Air facing a passive player\'s flop bet (high fold-to-bet, low aggression)', { hero: h('6s5h'), board: h('Ah9c4d'), position: 'BTN', pot: 150, toCall: 50, villains: [{ name: 'V', position: 'BB', stack: 1000, bet: 50, combos: passiveBet, foldOverride: 0.8, aggression: 0.3 }] }, 'FOLD');

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
