// ICM: tournament chip values.
const ICM = require('../icm.js');
let pass = 0, fail = 0;
const check = (name, ok, detail) => { ok ? pass++ : fail++; console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ' ' + JSON.stringify(detail)}`); };
const near = (a, b, t = 1e-3) => Math.abs(a - b) <= t;

console.log('\nICM equity');
{
  const e = ICM.equity([5000, 3000, 2000], [0.5, 0.3, 0.2]);
  check('shares add up to the whole pool', near(e.reduce((a, b) => a + b, 0), 1), e);
  // textbook Malmuth–Harville numbers for 50/30/20 with these stacks
  // worked by hand: P(1st) .5, P(2nd) .3·5/7 + .2·5/8 = .3393, P(3rd) .1607 → .25 + .1018 + .0321
  check('chip leader: 0.3839 (less than its 50% of the chips would suggest)', near(e[0], 0.3839, 1e-4), e[0]);
  check('short stack gets more than its 20% chip share', e[2] > 0.2 * 1 && e[2] < e[1], e);
  const eq = ICM.equity([1000, 1000, 1000, 1000], [0.5, 0.3, 0.2]);
  check('equal stacks → equal shares', eq.every(x => near(x, 0.25)), eq);
  const wta = ICM.equity([7000, 3000], [1]);
  check('winner-takes-all: chips are money (70/30)', near(wta[0], 0.7) && near(wta[1], 0.3), wta);
}

console.log('\nAll-in decisions under ICM');
{
  // bubble: 4 left, 3 paid. A medium stack facing an all-in from the big stack
  const stacks = [3000, 5000, 1500, 1500], payouts = [0.5, 0.3, 0.2];
  const v = ICM.allInValue({ stacks, payouts, hero: 0, villain: 1, risk: 3000, win: 3000, eq: 0.5 });
  check('on the bubble a coin flip is worth less than folding', v.allIn < v.fold, v);
  check('and calling needs well over 50% equity', v.requiredEquity > 0.55, v.requiredEquity);
  const cash = ICM.allInValue({ stacks: [3000, 5000], payouts: [1], hero: 0, villain: 1, risk: 3000, win: 3000, eq: 0.5 });
  check('winner-takes-all heads-up: a coin flip is break-even (50% needed)', near(cash.requiredEquity, 0.5, 1e-6), cash.requiredEquity);
  check('bubble factor > 1 on the bubble', ICM.bubbleFactor(stacks, payouts, 0, 1, 3000) > 1.2);
}

console.log('\nThe strategy uses ICM only in tournaments with payouts');
{
  const S = require('../strategy.js'), E = require('../poker-engine.js');
  E.setSeed(4);
  // bubble: 4 left, 3 paid. Big stack (V) shoves; we have AJo with 9bb; two short stacks would love us to bust
  const base = { hero: E.parseCards('AhJd'), board: [], position: 'BB', pot: 2100, toCall: 1800, heroStack: 1800, heroBet: 200, bb: 200, heroName: 'Hero',
    actions: [{ type: 'post', actor: 'X', amount: 100 }, { type: 'post', actor: 'Hero', amount: 200 }, { type: 'allin', actor: 'V', amount: 2000, to: 2000 }],
    villains: [{ name: 'V', position: 'BTN', stack: 0, bet: 2000, combos: E.topRange(0.45) }] };
  const cash = S.decide({ ...base });
  const tour = S.decide({ ...base, format: 'tournament', payouts: [0.5, 0.3, 0.2], stacksBehind: { Hero: 1800, V: 0, X: 1000, Y: 900 } });
  check('chip EV: AJo calls a wide big-stack shove', cash.action === 'ALL-IN' || cash.action === 'CALL', [cash.action, cash.reason]);
  check('ICM on the bubble: same hand folds', tour.action === 'FOLD' && tour.tag === 'ICM', [tour.action, tour.reason]);
  const nopay = S.decide({ ...base, format: 'tournament' });
  check('a tournament without payouts says it is using chip EV only (or decides as chip EV)', nopay.action === cash.action, [nopay.action, nopay.reason]);
  E.setSeed(null);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
