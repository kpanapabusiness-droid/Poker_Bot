// Tests for brain.js: action rebuilding, learning opponents, names. Run: node integrations/dickreuter/test_brain.js
const B = require('./brain.js');
const fs = require('fs'), os = require('os'), path = require('path');
let pass = 0, fail = 0;
const check = (name, ok, detail) => { ok ? pass++ : fail++; console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ' ' + JSON.stringify(detail)}`); };
const base = o => ({ bb: 2, nSeats: 6, dealer: 0, heroStack: 200, heroBet: 0, ...o });
const seats = (f = () => ({})) => [1, 2, 3, 4, 5].map(s => ({ seat: s, stack: 200, bet: 0, inHand: true, name: 'Player' + s, ...f(s) }));
const brief = acts => acts.map(a => a.type === 'street' ? '|' + a.street : `${a.actor}:${a.type}${a.to ? a.to : ''}`).join(' ');

console.log('\nRebuilding the action from snapshots');
// Hero on the button (dealer 0). UTG (seat 3) opens to 6, hero 3-bets to 18, UTG calls; flop.
const pre = { street: 'preflop', heroBet: 0, bets: { 1: 1, 2: 2, 3: 6, 4: 0, 5: 0 }, live: [1, 2, 3], hero: { action: 'RAISE', amount: 18 } };
let t = base({ heroCards: ['AS', 'KS'], board: ['KD', '7C', '2H'], pot: 39, toCall: 0, heroStack: 182,
  players: seats(s => ({ inHand: s === 3 })), history: [pre] });
let acts = B.synthActions(t);
check('open, 3-bet and call attributed to the right players',
  brief(acts) === 'Player1:post Player2:post Player3:raise6 Hero:raise18 Player3:call |flop', brief(acts));
// villain bets into us on the turn after we checked the flop
const flop = { street: 'flop', heroBet: 0, bets: { 3: 0 }, live: [3], hero: { action: 'CHECK', amount: 0 } };
t = base({ heroCards: ['AS', 'KS'], board: ['KD', '7C', '2H', '9S'], pot: 59, toCall: 20, heroStack: 182,
  players: seats(s => ({ inHand: s === 3, bet: s === 3 ? 20 : 0 })), history: [pre, flop] });
acts = B.synthActions(t);
check('a checked street, then a bet on the next', brief(acts).endsWith('Player3:call |flop Hero:check |turn Player3:bet20'), brief(acts));
check('no history: hero raise inferred from our chips', brief(B.synthActions(base({ heroCards: ['AS', 'KS'], board: [], pot: 30, toCall: 12, heroBet: 6,
  players: seats(s => ({ bet: s === 1 ? 1 : s === 2 ? 2 : s === 3 ? 18 : 0, inHand: [1, 2, 3].includes(s) })) }))).includes('Hero:raise6 Player3:raise18'));

console.log('\nLearning opponents');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-'));
const file = path.join(dir, 'players.json');
let brain = B.createBrain({ trackerFile: file });
// 20 hands where Player3 opens and folds to our flop c-bet, and Player4 always limps
for (let i = 0; i < 20; i++) {
  const g = 'g' + i;
  brain.decide(base({ gameId: g, heroCards: ['QS', 'JS'], board: [], pot: 11, toCall: 6,
    players: seats(s => ({ bet: s === 1 ? 1 : s === 2 ? 2 : s === 3 ? 6 : 0, inHand: [1, 2, 3].includes(s) })), history: [] }));
  brain.decide(base({ gameId: g, heroCards: ['QS', 'JS'], board: ['2D', '7C', 'KH'], pot: 15, toCall: 0, heroStack: 194,
    players: seats(s => ({ inHand: s === 3 })), history: [{ street: 'preflop', heroBet: 0, bets: { 1: 1, 2: 2, 3: 6 }, live: [1, 2, 3], hero: { action: 'CALL', amount: 6 } }] }));
}
brain.finish(); // last hand
const e3 = brain.tracker.estimate('Player3'), e4 = brain.tracker.estimate('Player4');
check('every hand counted once per player', e3.hands === 20 && e4.hands === 20, { e3: e3.hands, e4: e4.hands });
check('raiser learned as a raiser', e3.raw.pfr === 20 && e3.pfr > 0.4, e3.raw);
check('player who folded before us learned as tight', e4.raw.vpip === 0 && e4.vpip < 0.2, e4.raw);
const lastDecision = brain.decide(base({ gameId: 'x', heroCards: ['9S', '8S'], board: [], pot: 11, toCall: 6,
  players: seats(s => ({ bet: s === 1 ? 1 : s === 2 ? 2 : s === 3 ? 6 : 0, inHand: [1, 2, 3].includes(s) })), history: [] }));
const r3 = lastDecision.ranges.find(r => r.name === 'Player3');
check('tracked stats reach the decision (range uses their numbers)', r3 && r3.hands === 20, lastDecision.ranges);
check('stats saved to disk', fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).players.Player3.hands === 20);
brain = B.createBrain({ trackerFile: file });
check('stats survive a restart', brain.tracker.estimate('Player3').hands === 20);

console.log('\nFolds to our bets');
brain = B.createBrain({});
let bets = 0;
const cbet = g => {
  const d = brain.decide(base({ gameId: g, heroCards: ['AS', 'KD'], board: ['2D', '7C', '9H'], pot: 15, toCall: 0, heroStack: 194,
    players: seats(s => ({ inHand: s === 3 })), history: [{ street: 'preflop', heroBet: 0, bets: { 1: 1, 2: 2, 3: 6 }, live: [1, 2, 3], hero: { action: 'CALL', amount: 6 } }] }));
  if (d.action === 'BET') bets++;
};
for (let i = 0; i < 5; i++) cbet('f' + i);
brain.finish();
const f3 = brain.tracker.estimate('Player3');
check('hand ending after our flop bet counts as a fold to our bet', bets > 0 && f3.raw.foldToBet === bets && f3.raw.facedBet === bets, { bets, raw: f3.raw });
// river: our next-hand stack says whether they called
const riverHand = (g, nextStack) => {
  const b2 = B.createBrain({});
  const t = base({ gameId: g, heroCards: ['AS', 'AD'], board: ['2D', '7C', '9H', 'KS', '3C'], pot: 40, toCall: 0, heroStack: 180,
    players: seats(s => ({ inHand: s === 3 })), history: [{ street: 'preflop', heroBet: 0, bets: { 1: 1, 2: 2, 3: 6 }, live: [1, 2, 3], hero: { action: 'RAISE', amount: 20 } }] });
  const d = b2.decide(t);
  b2.finish(nextStack);
  return { d, raw: b2.tracker.estimate('Player3').raw };
};
let rv = riverHand('r1', 220); // won exactly the pot: they folded
check('river: winning just the pot → fold recorded', rv.d.action !== 'CHECK' ? rv.raw.foldToBet === 1 : true, rv);
rv = riverHand('r2', 180 + 40 + 2 * (rv.d.amount || 20)); // they called and lost
check('river: winning more than the pot → no fold recorded', rv.raw.foldToBet === 0, rv.raw);

console.log('\nNames');
brain = B.createBrain({});
brain.decide(base({ gameId: 'n1', heroCards: ['QS', 'JS'], board: [], pot: 11, toCall: 6,
  players: seats(s => ({ name: s === 3 ? 'FishKing99' : 'Player' + s, bet: s === 1 ? 1 : s === 2 ? 2 : s === 3 ? 6 : 0, inHand: [1, 2, 3].includes(s) })), history: [] }));
brain.decide(base({ gameId: 'n2', heroCards: ['QS', 'JS'], board: [], pot: 11, toCall: 6,
  players: seats(s => ({ name: s === 4 ? 'FishKinq99' : 'Player' + s, bet: s === 1 ? 1 : s === 2 ? 2 : s === 4 ? 6 : 0, inHand: [1, 2, 4].includes(s) })), history: [] }));
brain.finish();
check('one misread letter is matched to the same player', brain.tracker.estimate('FishKing99').hands === 2 && !brain.tracker.players().includes('FishKinq99'), brain.tracker.players());
check('unreadable names fall back to seat labels and are not tracked', !brain.tracker.players().some(n => /^Seat/.test(n)));
const noName = B.nameOf({ players: [{ seat: 2, name: '#' }] }, 2);
check('junk OCR becomes a seat label', noName === 'Seat2', noName);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
