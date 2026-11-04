// Run with: node test-engine.js
const E = require('./poker-engine.js');
let pass = 0, fail = 0;
function check(name, cond, info = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (info ? '  →  ' + info : '')); }
}
const ev = s => E.evaluate(E.parseCards(s));
const near = (x, target, tol) => Math.abs(x - target) <= tol;

console.log('\nEvaluator');
check('Royal flush is a straight flush', E.handName(ev('AsKsQsJsTs')) === 'Straight flush');
check('Wheel straight (A-5)', E.handName(ev('As2d3c4h5s9dKc')) === 'Straight');
check('6-high straight beats wheel', ev('2d3c4h5s6s') > ev('As2d3c4h5s'));
check('Straight flush beats quads', ev('9h8h7h6h5h') > ev('AsAdAcAhKs'));
check('Two trips = full house', E.handName(ev('KsKdKc7s7d7cAh')) === 'Full house');
check('KKK77 beats 777KK', ev('KsKdKc7s7d2c3h') > ev('7s7d7cKsKd2c3h'));
check('Flush beats straight', ev('As9s7s4s2s') > ev('9d8c7h6s5d'));
check('Three pairs: best two + best kicker', ev('AsAdKsKd2s2dQc') === ev('AhAcKhKcQd3s4s'));
check('Kicker decides pairs', ev('AsAd Kc 9d 7s 3h 2c') > ev('AhAc Qd 9h 7d 3s 2d'));
check('Exact tie on board play', ev('AsKsQsJsTs2d3d') === ev('AsKsQsJsTs4c5c'));
check('7-card flush picks top five', ev('As Ks 9s 7s 5s 3s 2d') > ev('As Ks 9s 7s 4s 3s 2d'));

console.log('\nRanges');
check('22+ = 78 combos', E.parseRange('22+').length === 78);
check('AKs = 4, AKo = 12, AK = 16', E.parseRange('AKs').length === 4 && E.parseRange('AKo').length === 12 && E.parseRange('AK').length === 16);
check('A2s+ = 48 combos', E.parseRange('A2s+').length === 48);
check('T9s-65s = 20 combos', E.parseRange('T9s-65s').length === 20);
check('22-55 = 24 combos', E.parseRange('22-55').length === 24);
check('A2s-A5s = 16 combos', E.parseRange('A2s-A5s').length === 16);
check('Duplicates removed', E.parseRange('AA, AA, QQ+').length === 18);
check('Explicit combo AsKs', E.parseRange('AsKs').length === 1);
check('handClass', E.handClass(E.parseCards('Kd As')) === 'AKo' && E.handClass(E.parseCards('7h7c')) === '77');
for (const p of Object.keys(E.RFI_RANGES)) {
  console.log(`    RFI ${p.padEnd(3)} ${(E.rangePercent(E.rfiRange(p)) * 100).toFixed(1)}%`);
}
check('BTN opens wider than LJ', E.rfiRange('BTN').length > E.rfiRange('LJ').length);
check('A5s in BTN range', E.inRange(E.parseCards('As5s'), E.rfiRange('BTN')));
check('72o not in CO range', !E.inRange(E.parseCards('7d2c'), E.rfiRange('CO')));

console.log('\nEquity (Monte Carlo, ±1.5%)');
let t = Date.now();
const r1 = E.equity({ hero: 'AsAh', villains: ['KK'], iterations: 30000 });
check('AA vs KK ≈ 82%', near(r1.equity, 0.82, 0.015), (r1.equity * 100).toFixed(1) + '%');
const r2 = E.equity({ hero: 'AsAh', villains: [null], iterations: 30000 });
check('AA vs random ≈ 85%', near(r2.equity, 0.852, 0.015), (r2.equity * 100).toFixed(1) + '%');
const r3 = E.equity({ hero: 'AhKh', villains: ['QQ'], iterations: 30000 });
check('AKs vs QQ ≈ 46%', near(r3.equity, 0.46, 0.015), (r3.equity * 100).toFixed(1) + '%');
const r4 = E.equity({ hero: 'AsAh', villains: [null, null, null], iterations: 30000 });
check('AA vs 3 random ≈ 64%', near(r4.equity, 0.64, 0.02), (r4.equity * 100).toFixed(1) + '%');
const r5 = E.equity({ hero: 'AhKh', board: 'Qh7h2c', villains: ['QQ+,AQs,KQs'], iterations: 30000 });
check('Flush draw vs strong range on flop gives hand name', r5.handName === 'High card', r5.handName);
console.log(`    AKhh on Qh7h2c vs {QQ+,AQs,KQs}: ${(r5.equity * 100).toFixed(1)}%`);
const r6 = E.equity({ hero: '7s7d', board: '7h2c2d', villains: ['22+'], iterations: 20000 });
check('Full house on board-paired flop shows name', r6.handName === 'Full house');
console.log(`    5 equity runs in ${Date.now() - t} ms`);

let threw = false;
try { E.equity({ hero: 'AsAh', board: 'As2c3d', villains: [null] }); } catch (e) { threw = true; }
check('Duplicate card is rejected', threw);

console.log('\nOdds & advice');
const po = E.potOdds(150, 50); // villain bet 50 into 100 → pot now 150, call 50
check('Pot odds: 50 to win 150 needs 25%', near(po.requiredEquity, 0.25, 1e-9) && po.ratio === '3.0:1');
check('Call EV positive at 35% equity', E.callEV(0.35, 150, 50) > 0);
check('MDF vs half-pot = 66.7%', near(E.mdf(50, 100), 2 / 3, 1e-9));
check('Bluff breakeven half-pot = 33.3%', near(E.bluffBreakeven(50, 100), 1 / 3, 1e-9));
check('Rule of 4: 9 outs ≈ 36%', near(E.outsToEquity(9, 2), 0.36, 1e-9));
check('Advise FOLD at 15% vs 25% needed', E.advise({ equity: 0.15, pot: 150, toCall: 50 }).action === 'FOLD');
check('Advise CALL at 35%', E.advise({ equity: 0.35, pot: 150, toCall: 50 }).action === 'CALL');
check('Advise RAISE at 80%', E.advise({ equity: 0.8, pot: 150, toCall: 50 }).action === 'RAISE');
check('Positions 6-handed', ['BTN', 'SB', 'BB', 'LJ', 'HJ', 'CO'].every((p, i) => E.positionFromSeat(i, 6) === p));
check('Positions 9-handed: seat 3 = EP', E.positionFromSeat(3, 9) === 'EP' && E.positionFromSeat(8, 9) === 'CO');

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
