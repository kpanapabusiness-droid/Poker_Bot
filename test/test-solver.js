// Tests for solver.js against spots with known game-theory answers. Run: node test/test-solver.js
const E = require('../poker-engine.js');
const R = require('../solver.js');
let pass = 0, fail = 0;
const check = (name, ok, detail) => { ok ? pass++ : fail++; console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ' ' + JSON.stringify(detail)}`); };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// Board with no straights or flushes possible for these hands: 2C 3D 8H 9S KC.
// Value hands: 88 (a set). Air: 76 (seven high). Bluff-catcher: QQ.
const board = E.parseCards('2C3D8H9SKC');
const combos = t => E.parseRange(t).filter(c => !c.some(x => board.includes(x)));
const value = combos('88'), air = combos('76'), qq = combos('QQ');
const prob = (r, label) => r.strategy.filter(s => s.label === label).reduce((a, s) => a + s.prob, 0);

console.log('\nPolarised river, pot 100, 100 behind');
let r = R.solveRiver({ board, hero: value[0], heroRange: [...value, ...air], villainRange: qq, pot: 100, heroStack: 100, villainStack: 100, heroFirst: true, iterations: 800, timeLimitMs: 8000, measure: true });
check('value hand bets (all-in)', prob(r, 'ALL-IN') > 0.95, r.strategy);
check('solution is close to equilibrium (exploitability < 1% of pot)', r.exploitability < 1, r.exploitability);
const bluff = R.solveRiver({ board, hero: air[0], heroRange: [...value, ...air], villainRange: qq, pot: 100, heroStack: 100, villainStack: 100, heroFirst: true, iterations: 800, timeLimitMs: 8000 });
const bluffCombos = prob(bluff, 'ALL-IN') * air.length;
// theory: a pot-sized bet should be 1/3 bluffs → bluffs = value combos / 2 = 1.5
check('bluffs: about half as many bluff combos as value combos (pot-size bet)', near(bluffCombos, value.length / 2, 0.35), { bluffCombos });

console.log('\nBluff-catcher facing a pot-sized all-in');
const balanced = [...value, ...air.map(c => [c[0], c[1], (value.length / 2) / air.length])];
r = R.solveRiver({ board, hero: qq[0], heroRange: qq, villainRange: balanced, pot: 100, heroStack: 100, villainStack: 100, facing: 100, iterations: 800, timeLimitMs: 8000 });
check('balanced range → indifferent, calls about half the time', near(prob(r, 'ALL-IN') + prob(r, 'CALL'), 0.5, 0.1), r.strategy);
check('…and both options are worth the same', near(r.strategy[0].ev, r.strategy[1].ev, 1.5), r.strategy);
r = R.solveRiver({ board, hero: qq[0], heroRange: qq, villainRange: [...value, ...air], pot: 100, heroStack: 100, villainStack: 100, facing: 100, iterations: 300 });
check('villain bluffs too much → always call', r.action === 'ALL-IN' || r.action === 'CALL', r.strategy);
r = R.solveRiver({ board, hero: qq[0], heroRange: qq, villainRange: value, pot: 100, heroStack: 100, villainStack: 100, facing: 100, iterations: 300 });
check('villain never bluffs → fold', r.action === 'FOLD', r.strategy);

console.log('\nCard removal and ties');
const b2 = E.parseCards('AHKHQHJHTH'); // royal flush on board: everyone splits
r = R.solveRiver({ board: b2, hero: E.parseCards('2C3D'), heroRange: E.topRange(0.3), villainRange: E.topRange(0.3), pot: 50, heroStack: 100, villainStack: 100, heroFirst: true, iterations: 100, timeLimitMs: 5000 });
check('board plays for everyone: every action worth half the pot', r.strategy.every(s => near(s.ev, 25, 0.5)), r.strategy);
r = R.solveRiver({ board, hero: E.parseCards('8C8D'), heroRange: [E.parseCards('8C8D')], villainRange: [E.parseCards('8C8S'), ...qq], pot: 100, heroStack: 100, villainStack: 100, heroFirst: true, iterations: 50 });
check('opponent hands that share our cards are removed', r.villainCombos === qq.length, r.villainCombos);

console.log('\nSpeed on realistic ranges');
const t0 = Date.now();
r = R.solveRiver({ board: E.parseCards('AH7D4S9CJD'), hero: E.parseCards('ASQS'), heroRange: E.topRange(0.25), villainRange: E.topRange(0.4), pot: 60, heroStack: 170, villainStack: 170, heroFirst: true, iterations: 150, timeLimitMs: 700, measure: true });
const ms = Date.now() - t0;
check(`stays within its time limit on a 25% vs 40% range spot (${ms} ms, ${r.iterations} iterations)`, ms < 1500, ms);
r = R.solveRiver({ board: E.parseCards('AH7D4S9CJD'), hero: E.parseCards('ASQS'), heroRange: E.topRange(0.25), villainRange: E.topRange(0.4), pot: 60, heroStack: 170, villainStack: 170, heroFirst: true, iterations: 150, timeLimitMs: 20000, measure: true });
check('150 iterations get within 1% of the pot of equilibrium', r.exploitability < 0.6, r.exploitability);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
