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

console.log('\nSituational stats count only real opportunities (7 Nov)');
{
  const t3 = T.create({});
  const act = (type, actor, extra = {}) => ({ type, actor, ...extra });
  const log = [];
  // hand 1: Ann opens, Bob 3-bets, Ann folds (fold to 3-bet); Cy faced the 3-bet (a 4-bet chance, not a 3-bet chance)
  log.push({ type: 'start', handId: 'h1', size: 6 }, act('raise', 'Ann'), act('raise', 'Bob'), act('fold', 'Cy'), act('fold', 'Ann'));
  // hand 2: Ann opens, Bob calls; flop Ann c-bets, Bob folds (fold to c-bet, fold on the flop)
  log.push({ type: 'start', handId: 'h2', size: 6 }, act('raise', 'Ann'), act('call', 'Bob'), { type: 'street', street: 'flop' }, act('bet', 'Ann'), act('fold', 'Bob'));
  // hand 3: Bob opens, Ann calls; river Ann bets, Bob raises, Ann folds (fold to raise after betting)
  log.push({ type: 'start', handId: 'h3', size: 2 }, act('raise', 'Bob'), act('call', 'Ann'), { type: 'street', street: 'flop' }, act('check', 'Ann'), act('check', 'Bob'),
    { type: 'street', street: 'turn' }, act('check', 'Ann'), act('check', 'Bob'), { type: 'street', street: 'river' }, act('bet', 'Ann'), act('raise', 'Bob'), act('fold', 'Ann'));
  log.push({ type: 'start', handId: 'h4' });
  t3.ingest(log);
  const ann = t3.estimate('Ann').raw, bob = t3.estimate('Bob').raw, cy = t3.estimate('Cy').raw;
  check('fold to 3-bet: Ann had 1 chance and folded', ann.f3bOpp === 1 && ann.f3b === 1, ann);
  check('3-bet: Bob had chances in hands 1 and 2, 3-bet once', bob.tbOpp === 2 && bob.tb === 1, bob);
  check('facing a 3-bet is a 4-bet chance, not a 3-bet chance (Cy)', cy.fbOpp === 1 && cy.tbOpp === 0, cy);
  check('c-bet: Ann had 1 chance and c-bet', ann.cbetOpp === 1 && ann.cbet === 1, ann);
  check('fold to c-bet: Bob faced 1 and folded', bob.fcbOpp === 1 && bob.fcb === 1, bob);
  check('fold to raise after betting: Ann 1 of 1', ann.ftrOpp === 1 && ann.ftr === 1, ann);
  check('a checked-around street is no fold-to-bet chance', ann.facedFlop === 0 && ann.facedTurn === 0, ann);
  const e = t3.estimate('Ann', { tableSize: 2 });
  check('table-size estimate uses the heads-up hands, shrunk toward the overall numbers', e.sizeBand === 'hu' && e.sizeHands === 1, e.sizeBand);
  check('estimates stay probabilities after shrinkage', ['fourBet', 'foldTo3bet', 'cbet', 'foldToCbet', 'foldToRaise'].every(k => e[k] > 0 && e[k] < 1) && e.f2bStreet.river > 0, e);
}

console.log('\nLearning how far our fold predictions are off, per player (7 Nov)');
{
  const t4 = T.create({});
  for (let i = 0; i < 40; i++) t4.noteFold('Sticky', 'river', 0.6, i % 5 === 0);  // we predicted 60%, they folded 20%
  for (let i = 0; i < 3; i++) t4.noteFold('Fresh', 'river', 0.6, false);
  const st = t4.estimate('Sticky').foldBias.river, fr = t4.estimate('Fresh').foldBias.river;
  check('a player who folds far less than predicted gets a clear negative bias', st < -0.25, st);
  check('three hands only move the bias a little (shrinkage)', fr > -0.15 && fr < 0, fr);
  check('no data → no bias', t4.estimate('Nobody').foldBias.turn === 0);
  // a player who used to fold a lot and now calls everything
  const t5 = T.create({});
  for (let i = 0; i < 40; i++) t5.noteFold('Changer', 'flop', 0.4, i % 10 < 8);  // folded 80% (we said 40%)
  const before = t5.estimate('Changer').foldBias.flop;
  for (let i = 0; i < 40; i++) t5.noteFold('Changer', 'flop', 0.4, false);      // now never folds
  const after = t5.estimate('Changer').foldBias.flop;
  check('when a player starts calling, the correction swings from "folds more" to "folds less"', before > 0.2 && after < -0.1, { before, after });
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
