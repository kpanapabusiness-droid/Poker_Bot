// Logger tests: replay real snapshots in order, then simulated hands. Run with: node test/test-logger.js
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const A = require('../torn-adapter.js');
const L = require('../logger.js');

let pass = 0, fail = 0;
function check(name, cond, info = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (info !== '' ? '  →  ' + JSON.stringify(info) : '')); }
}
const mem = () => { let d = null; return { load: () => d, save: x => { d = JSON.parse(JSON.stringify(x)); }, peek: () => d }; };
const snap = n => A.readState(new JSDOM(fs.readFileSync(path.join(__dirname, 'fixtures', `snap${n}.html`), 'utf8')).window.document);

console.log('\nReplay real snapshots (one hand: preflop → flop → turn → river)');
let clock = 1_000_000;
const lg = L.create({ ...mem(), now: () => clock });
const recCall = (amount, ev = 5) => ({ action: 'CALL', amount, tag: 'CALL', ev, equity: 0.4,
  options: [{ action: 'CALL', amount, ev }, { action: 'FOLD', amount: 0, ev: 0 }, { action: 'RAISE', amount: amount * 3, ev: ev - 20 }] });
lg.observe(snap(2), null, { position: 'HJ', bb: 10 }); clock += 5000;
lg.observe(snap(4), recCall(10), { position: 'HJ', bb: 10 }); clock += 5000;     // flop: hero to act, coach says CALL
lg.observe(snap(5), recCall(170, 40), { position: 'HJ', bb: 10 }); clock += 5000; // turn: hero called flop → resolves; now facing 170
lg.observe(snap(6), recCall(255, 230), { position: 'HJ', bb: 10 });              // river: hero called turn → resolves
const live = lg.hands();
check('Hand not finished yet → not stored', live.length === 0, live.length);
// finish the hand: add hero's river call and a win line to the last state
const s6 = snap(6);
const finished = { ...s6, isHeroTurn: false, actions: [...s6.actions,
  { type: 'call', actor: 'Hero', amount: 255 }, { type: 'show', actor: 'Player1', cards: ['Kc', 'Qc'], desc: 'Flush' },
  { type: 'win', actor: 'Player1', amount: 1275, cards: ['Kc', 'Qc'] }] };
lg.observe(finished, null, { position: 'HJ', bb: 10 });
const h = lg.hands()[0];
check('Hand stored after the winner is posted', lg.hands().length === 1);
check('3 decisions recorded (flop, turn, river)', h && h.decisions.length === 3, h && h.decisions.map(d => d.street));
check('All followed (coach said CALL, hero called)', h && h.decisions.every(d => d.followed), h && h.decisions.map(d => d.followed));
check('No EV lost when following', h && h.decisions.every(d => d.evLost === 0), h && h.decisions.map(d => d.evLost));
// Hero: posted 10, raised to 20 (+10), called 10 flop, called 170 turn, called 255 river = 455 in, won 0
check('Result from the log: −$455', h && h.net === -455, h && h.net);
check('Cards + board saved', h && h.cards.join('') === 'Ts3h' && h.board.length === 5, h && [h.cards, h.board]);

console.log('\nResult maths');
const r1 = L.heroResult([
  { type: 'post', actor: 'H', amount: 5 }, { type: 'raise', actor: 'V', amount: 20, to: 30 }, { type: 'raise', actor: 'H', amount: 60, to: 90 },
  { type: 'call', actor: 'V', amount: 60 }, { type: 'street', street: 'flop' }, { type: 'bet', actor: 'H', amount: 100 },
  { type: 'fold', actor: 'V' }, { type: 'win', actor: 'H', amount: 280 }], 'H');
check('3-bet then c-bet, opponent folds: in 190, won 280 → +90', r1.committed === 190 && r1.net === 90, r1);
const r2 = L.heroResult([{ type: 'post', actor: 'H', amount: 10 }, { type: 'fold', actor: 'H' }], 'H');
check('Fold the big blind: −10', r2.net === -10, r2);

console.log('\nFollowed vs deviated + EV lost');
const rec = { action: 'BET', amount: 50, options: [{ action: 'BET', amount: 50, ev: 40 }, { action: 'CHECK', amount: 0, ev: 25 }, { action: 'BET', amount: 100, ev: 30 }] };
check('Bet 55 when told bet 50 → followed, size ok', L.compare(rec, { type: 'bet', amount: 55 }).followed && L.compare(rec, { type: 'bet', amount: 55 }).sizeOk);
check('Bet 100 when told bet 50 → followed, size off', L.compare(rec, { type: 'bet', amount: 100 }).followed && !L.compare(rec, { type: 'bet', amount: 100 }).sizeOk);
check('Checked when told bet → not followed', !L.compare(rec, { type: 'check' }).followed);
check('EV lost for checking = 40 − 25 = 15', L.evLost(rec, { type: 'check' }) === 15);
check('EV lost for betting 100 = 10 (nearest size option)', L.evLost(rec, { type: 'bet', amount: 100 }) === 10);
check('EV lost is null preflop (no priced options)', L.evLost({ action: 'RAISE', amount: 30 }, { type: 'call' }) === null);

console.log('\nReport + CSV over simulated hands');
clock = 5_000_000;
const lg2 = L.create({ ...mem(), now: () => clock });
function playHand(id, heroCall, win) {
  const players = [{ isHero: true, name: 'H', slot: 0 }, { name: 'V', slot: 1 }];
  const base = { handId: id, heroInHand: true, heroCards: ['As', 'Kd'], board: ['Qs', '7d', '2c'], heroStack: 1000, heroBet: 0, players, street: 'flop', pot: 100, toCall: 50 };
  const pre = [{ type: 'post', actor: 'H', amount: 10 }, { type: 'street', street: 'flop' }, { type: 'bet', actor: 'V', amount: 50 }];
  const d = { action: 'FOLD', amount: 0, tag: 'FOLD', ev: 0, equity: 0.2, options: [{ action: 'FOLD', amount: 0, ev: 0 }, { action: 'CALL', amount: 50, ev: -20 }] };
  lg2.observe({ ...base, isHeroTurn: true, actions: pre }, d, { position: 'BTN', bb: 10 });
  const act = heroCall ? { type: 'call', actor: 'H', amount: 50 } : { type: 'fold', actor: 'H' };
  const end = win ? [{ type: 'win', actor: 'H', amount: 170 }] : [{ type: 'win', actor: 'V', amount: 170 }];
  lg2.observe({ ...base, isHeroTurn: false, actions: [...pre, act, ...end] }, null, { position: 'BTN', bb: 10 });
  clock += 60_000;
}
playHand('a', false, false); playHand('b', false, false); playHand('c', true, true); playHand('d', true, false);
const rep = lg2.report();
check('4 hands logged', rep.hands === 4, rep.hands);
check('Follow rate 50%', rep.followRate === 0.5, rep.followRate);
check('Net: −10 −10 +110 −60 = +30', rep.net === 30, rep.net);
check('EV lost = 2 × 20 = 40 (two bad calls)', rep.evLost === 40, rep.evLost);
check('Pattern found: "FOLD → you CALL" ×2', rep.patterns[0] && rep.patterns[0].pattern === 'FOLD → you CALL' && rep.patterns[0].count === 2, rep.patterns);
check('bb/100 computed', Math.round(rep.bb100) === 75, rep.bb100);
console.log(`    note: deviations won +$${rep.deviatedNet} in results but cost ${rep.evLost} in EV — luck vs decisions`);
const csv = lg2.toCSV().split('\n');
check('CSV has header + 4 decision rows', csv.length === 5 && csv[0].startsWith('hand_id,time,position'), csv.length);
check('CSV row has rec + actual', /FOLD,0,FOLD,0,CALL,50,false/.test(csv[3]), csv[3]);

console.log('\nSessions + persistence');
clock += 31 * 60 * 1000;
check('Idle 30+ min → new session is empty', lg2.report({ since: lg2.sessionSince() }).hands === 0);
const store = mem(); const lg3 = L.create(store); lg3.importData(lg2.exportData());
check('Export → import round-trip', L.create(store).hands().length === 4);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
