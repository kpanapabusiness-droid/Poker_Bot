// Tracker tests: real snapshot log + simulated player types. Run with: node test/test-tracker.js
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const A = require('../torn-adapter.js');
const T = require('../tracker.js');
const S = require('../strategy.js');
const E = require('../poker-engine.js');
E.setSeed(11);

let pass = 0, fail = 0;
function check(name, cond, info = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (info !== '' ? '  →  ' + JSON.stringify(info) : '')); }
}
const memStore = () => { let d = null; return { load: () => d, save: x => { d = JSON.parse(JSON.stringify(x)); }, peek: () => d }; };

console.log('\nReal snapshot log');
const doc = new JSDOM(fs.readFileSync(path.join(__dirname, 'fixtures', 'snap6.html'), 'utf8')).window.document;
const log = A.readLog(doc);
const hands = T.splitHands(log);
check('2 hands found, first complete, second still running', hands.length === 2 && hands[0].complete && !hands[1].complete, hands.map(h => h.complete));
const st = memStore();
const t = T.create(st);
check('ingests the 1 completed hand', t.ingest(log) === 1);
check('re-ingesting the same log adds nothing', t.ingest(log) === 0);
const p6 = t.estimate('Player6').raw, p1 = t.estimate('Player1').raw, p4 = t.estimate('Player4').raw;
check('Player6: BB check (no VPIP), raised flop + bet river (aggr 2), went to showdown', p6.vpip === 0 && p6.aggr === 2 && p6.wtsd === 1, p6);
check('Player1: limped (VPIP, no PFR), 1 bet + 2 calls postflop', p1.vpip === 1 && p1.pfr === 0 && p1.aggr === 1 && p1.calls === 2, p1);
check('Player4: completed SB, folded to the flop bet (F2B 1/1)', p4.vpip === 1 && p4.facedBet === 1 && p4.foldToBet === 1, p4);
check('Showdown hands recorded (Player1 showed Qc 6h)', p1.shows[0] && p1.shows[0].cards.join('') === 'Qc6h', p1.shows);
check('Saved to storage and reloads', T.create(st).estimate('Player1').raw.hands === 1);
check('1 hand barely moves estimates off the prior (VPIP stays < 50%)', t.estimate('Player1').vpip < 0.5, t.estimate('Player1').vpip);

console.log('\nSimulated player types (40 hands each)');
// Build fake hands: one villain "V" with a given style vs "Hero".
function hand(id, villainPre, villainPost) {
  const a = [{ type: 'start', handId: id }, { type: 'street', street: 'preflop', cards: [] },
    { type: 'post', actor: 'Hero', blind: 'SB', amount: 5 }, { type: 'post', actor: 'X', blind: 'BB', amount: 10 }];
  if (villainPre === 'fold') { a.push({ type: 'fold', actor: 'V' }); a.push({ type: 'fold', actor: 'Hero' }); a.push({ type: 'win', actor: 'X', amount: 15, cards: [] }); return a; }
  a.push(villainPre === 'raise' ? { type: 'raise', actor: 'V', amount: 20, to: 30 } : { type: 'call', actor: 'V', amount: 10 });
  a.push({ type: 'call', actor: 'Hero', amount: 25 }); a.push({ type: 'fold', actor: 'X' });
  a.push({ type: 'street', street: 'flop', cards: ['Ah', '7c', '2d'] });
  a.push({ type: 'bet', actor: 'Hero', amount: 20 });
  if (villainPost === 'fold') { a.push({ type: 'fold', actor: 'V' }); a.push({ type: 'win', actor: 'Hero', amount: 80, cards: [] }); return a; }
  a.push(villainPost === 'raise' ? { type: 'raise', actor: 'V', amount: 40, to: 60 } : { type: 'call', actor: 'V', amount: 20 });
  if (villainPost === 'raise') a.push({ type: 'call', actor: 'Hero', amount: 40 });
  a.push({ type: 'street', street: 'turn', cards: ['5s'] });
  a.push({ type: 'street', street: 'river', cards: ['Kd'] });
  a.push({ type: 'show', actor: 'V', cards: ['9h', '9d'], desc: 'Pair of Nines' });
  a.push({ type: 'win', actor: 'Hero', amount: 200, cards: ['Ac', 'Kc'] });
  return a;
}
function simulate(styleFn, n = 40) {
  const tr = T.create(memStore());
  const lg = [];
  for (let i = 0; i < n; i++) lg.push(...hand('h' + i, ...styleFn(i)));
  lg.push({ type: 'start', handId: 'next' });
  tr.ingest(lg);
  return tr.estimate('V');
}
const station = simulate(i => [i % 10 < 7 ? 'call' : 'fold', i % 10 < 9 ? 'call' : 'fold']);   // plays 70%, never raises, rarely folds
const nit = simulate(i => [i % 10 < 1 ? 'raise' : i % 20 === 5 ? 'call' : 'fold', 'fold']);   // plays ~15%, folds to bets
const maniac = simulate(i => [i % 10 < 7 ? 'raise' : 'call', i % 3 === 0 ? 'call' : 'raise']); // raises everything
console.log(`    station: ${JSON.stringify({ vpip: station.vpip.toFixed(2), af: station.af.toFixed(2), f2b: station.f2b.toFixed(2), type: station.type.label })}`);
console.log(`    nit:     ${JSON.stringify({ vpip: nit.vpip.toFixed(2), af: nit.af.toFixed(2), f2b: nit.f2b.toFixed(2), type: nit.type.label })}`);
console.log(`    maniac:  ${JSON.stringify({ vpip: maniac.vpip.toFixed(2), af: maniac.af.toFixed(2), f2b: maniac.f2b.toFixed(2), type: maniac.type.label })}`);
check('Calling station identified', station.type.label === 'Calling Station', station.type);
check('Nit identified', ['Nit', 'Rock'].includes(nit.type.label), nit.type);
check('Maniac identified', maniac.type.label === 'Maniac', maniac.type);
check('Station folds to bets far less than the nit', station.f2b < nit.f2b - 0.3, [station.f2b, nit.f2b]);
check('Fewer than 15 hands → Unknown', simulate(() => ['call', 'call'], 10).type.label === 'Unknown');

console.log('\nStats change the advice');
const air = { hero: E.parseCards('6s5s'), board: E.parseCards('AhKd9c2hQc'), pot: 100, toCall: 0, heroStack: 1000, heroBet: 0, bb: 10, position: 'BTN', inPosition: true, actions: [] };
const vs = est => S.decide({ ...air, villains: [{ name: 'V', position: 'BB', stack: 1000, bet: 0, combos: null, foldOverride: est.f2b }] });
const dStation = vs(station), dNit = vs(nit);
console.log(`    river air vs station → ${S.describe(dStation)} (${dStation.tag}); vs nit → ${S.describe(dNit)} (${dNit.tag})`);
check('No river bluff vs the calling station', dStation.action === 'CHECK', dStation.action);
check('River bluff vs the nit', dNit.action === 'BET' && dNit.tag === 'BLUFF', [dNit.action, dNit.tag]);

console.log('\nExport / import / reset');
const data = t.exportData();
const t2 = T.create(memStore()); t2.importData(data);
check('Import restores players', t2.players().length === t.players().length);
t2.reset();
check('Reset clears everything', t2.players().length === 0);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
