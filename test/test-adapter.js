// Tests the Torn adapter against real (anonymised) table snapshots.
// Run with: node test/test-adapter.js   (needs: npm install)
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const A = require('../torn-adapter.js');
const E = require('../poker-engine.js');

let pass = 0, fail = 0;
function check(name, cond, info = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (info !== '' ? '  →  ' + JSON.stringify(info) : '')); }
}
const load = n => A.readState(new JSDOM(fs.readFileSync(path.join(__dirname, 'fixtures', `snap${n}.html`), 'utf8')).window.document);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('\nSnapshot 1 — hero waiting for BB, flop of previous hand');
let s = load(1);
check('board = Ah 8s 8h', eq(s.board, ['Ah', '8s', '8h']), s.board);
check('street = flop', s.street === 'flop', s.street);
check('pot = 60', s.pot === 60, s.pot);
check('hero NOT in hand (waiting BB)', s.heroInHand === false);
check('not hero turn', !s.isHeroTurn);
check('9 seats read (8 opponents + hero)', s.players.length === 9, s.players.length);
check('dealer slot = 1', s.dealerSlot === 1, s.dealerSlot);

console.log('\nSnapshot 2 — new hand, preflop, hero dealt Ts 3h');
s = load(2);
check('hero cards = Ts 3h', eq(s.heroCards, ['Ts', '3h']), s.heroCards);
check('board empty (5 face down)', s.board.length === 0, s.board);
check('street = preflop', s.street === 'preflop');
check('pot = 35', s.pot === 35, s.pot);
check('hero in hand', s.heroInHand);
check('hero stack = 1990', s.heroStack === 1990, s.heroStack);
check('hero bet = 10 (posted)', s.heroBet === 10, s.heroBet);
check('toCall = 0 (bets level at 10)', s.toCall === 0, s.toCall);
check('dealer slot 2 = Player4', s.players.find(p => p.slot === 2).name === 'Player4' && s.dealerSlot === 2);
const pos = A.positions(s, E.positionFromSeat);
check('positions: P4 BTN, P6 SB, P7 BB', pos[2] === 'BTN' && pos[4] === 'SB' && pos[5] === 'BB', pos);
check('Player5 (Waiting BB) and Player8 (Sitting out) not dealt',
  !s.players.find(p => p.name === 'Player5').dealt && !s.players.find(p => p.name === 'Player8').dealt);
check('hero name found from log', s.players.find(p => p.isHero).name === 'Hero', s.players.find(p => p.isHero).name);
check('handId parsed', !!s.handId, s.handId);

console.log('\nSnapshot 4 — flop, hero to act facing $10');
s = load(4);
check('board = 4h Ah Tc', eq(s.board, ['4h', 'Ah', 'Tc']), s.board);
check('hero turn', s.isHeroTurn);
check('toCall = 10 (from Call button)', s.toCall === 10, s.toCall);
check('pot = 150', s.pot === 150, s.pot);
const pf = A.preflopActions(s);
check('preflop: Hero raised, Player1 limped then called', pf.Hero === 'raise' && pf.Player1 === 'limp', pf);
check('Player4 folded → not in hand', !s.players.find(p => p.name === 'Player4').inHand);

console.log('\nSnapshot 5 — turn, facing $170');
s = load(5);
check('board has 4 cards', eq(s.board, ['4h', 'Ah', 'Tc', '3c']), s.board);
check('street = turn', s.street === 'turn');
check('toCall = 170', s.toCall === 170, s.toCall);
check('pot = 340', s.pot === 340, s.pot);

console.log('\nSnapshot 6 — river, heads-up vs Player1 facing $255');
s = load(6);
check('board = 4h Ah Tc 3c 5c', eq(s.board, ['4h', 'Ah', 'Tc', '3c', '5c']), s.board);
check('street = river', s.street === 'river');
check('toCall = 255', s.toCall === 255, s.toCall);
check('pot = 765', s.pot === 765, s.pot);
const opps = s.players.filter(p => p.inHand && !p.isHero);
check('only Player1 still in hand', opps.length === 1 && opps[0].name === 'Player1', opps.map(p => p.name));
check('Player1 bet 255 on the table', opps[0].bet === 255, opps[0].bet);
check('Hero has two pair (tens and threes)', E.handName(E.evaluate(E.parseCards([...s.heroCards, ...s.board]))) === 'Two pair');
const r = E.equity({ hero: s.heroCards, board: s.board, villains: [null], iterations: 20000 });
const adv = E.advise({ equity: r.equity, pot: s.pot, toCall: s.toCall });
console.log(`    End-to-end: ${s.heroCards.join(' ')} on ${s.board.join(' ')} → equity ${(r.equity * 100).toFixed(0)}% vs random, need ${(adv.requiredEquity * 100).toFixed(0)}% → ${adv.action}`);
check('End-to-end advice produced', ['CALL', 'RAISE', 'MARGINAL', 'FOLD'].includes(adv.action), adv.action);
// Same spot vs a range that bets big on a 3-club river (made hands + flushes) — shows why ranges matter
const r2 = E.equity({ hero: s.heroCards, board: s.board, villains: ['AA,TT,55,33,A5,A4,A3,KcQc,KcJc,Kc9c,QcJc,Jc9c,9c8c,8c7c,7c6c,6c2c,2c2d,AT,A2s'], iterations: 20000 });
console.log(`    Same spot vs a strong betting range: equity ${(r2.equity * 100).toFixed(0)}% → ${E.advise({ equity: r2.equity, pot: s.pot, toCall: s.toCall }).action}`);
check('Equity vs a strong range is much lower than vs random', r2.equity < r.equity - 0.2, [r.equity, r2.equity]);

console.log('\nLog parser');
const L = A.parseLogLine;
check('raise', eq(L('X', 'raised $10 to $20'), { type: 'raise', actor: 'X', amount: 10, to: 20 }));
check('call with commas', L('X', 'called $1,250').amount === 1250);
check('blinds', L('X', 'posted small blind $5').blind === 'SB' && L('X', 'posted big blind $10').blind === 'BB');
check('street cards', eq(L('The flop:', 'A♥, 8♠, 10♣').cards, ['Ah', '8s', 'Tc']));
check('reveal', eq(L('X', 'reveals [Q♣, 6♥] (Pair of Eights)').cards, ['Qc', '6h']));
check('game start', L('Game', 'abc123 started').handId === 'abc123');

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
