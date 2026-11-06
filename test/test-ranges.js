// Weighted ranges, board-relative strength, card removal, multiway EV and visible fallbacks.
const E = require('../poker-engine.js');
const S = require('../strategy.js');
let pass = 0, fail = 0;
const check = (name, ok, detail) => { ok ? pass++ : fail++; console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ' ' + JSON.stringify(detail)}`); };
const h = E.parseCards;
const key = (a, b) => { const [x, y] = h(a + b); return x < y ? x * 52 + y : y * 52 + x; };

console.log('\nBoard-relative strength');
{
  const hs = E.strengthPercentiles(h('Qc5c6h4dQd'));
  check('on Q-Q-6-5-4, 6x ("two pair" to the evaluator) ranks below a queen', hs.get(key('6s', '2d')) < hs.get(key('Qh', '9d')), [hs.get(key('6s', '2d')), hs.get(key('Qh', '9d'))]);
  check('a straight ranks above trips', hs.get(key('7s', '3d')) > hs.get(key('Kh', 'Qs')));
  check('percentiles stay within 0..1', [...hs.values()].every(v => v >= 0 && v <= 1));
}

console.log('\nWeighted range updates');
{
  const b = h('Qc5c6h4dQd');
  let r = E.topRange(0.45);
  const n0 = E.rangeSize(r);
  r = E.weightRange(r, b.slice(0, 3), 'call');
  r = E.weightRange(r, b.slice(0, 4), 'call');
  const beforeBet = E.rangeSize(r);
  const bet = E.weightRange(r, b, 'bet');
  check('each action narrows the range (weights shrink)', E.rangeSize(bet) < beforeBet && beforeBet < n0, [n0, beforeBet, E.rangeSize(bet)]);
  const share = (rr, pred) => rr.filter(c => pred(c)).reduce((t, c) => t + c[2], 0) / E.rangeSize(rr);
  const hasQ = c => (c[0] >> 2) === 10 || (c[1] >> 2) === 10;
  check('after calling twice and betting the river, queens make up much more of the range', share(bet, hasQ) > 1.5 * share(r, hasQ), [share(r, hasQ), share(bet, hasQ)]);
  check('known board cards are removed from every holding', bet.every(([x, y]) => !b.includes(x) && !b.includes(y)));
  const chk = E.weightRange(r, b, 'check');
  check('a check moves weight away from strong hands (they would usually bet)', share(chk, hasQ) < share(r, hasQ));
  let threw = false;
  try { E.weightRange([[h('Qc')[0], h('2d')[0]]], b, 'bet'); } catch (e) { threw = e instanceof RangeError; }
  check('a range left empty throws instead of becoming random hands', threw);
}

console.log('\nWeighted sampling and card removal in equity');
{
  E.setSeed(3);
  const hero = h('AhAd'), board = h('2c7d9s');
  const strong = [[...h('KsKc'), 1], [...h('7s7c'), 0.0001]];
  const weak = [[...h('KsKc'), 0.0001], [...h('7s7c'), 1]];
  const a = E.equity({ hero, board, villains: [strong], iterations: 4000 }).equity;
  const c = E.equity({ hero, board, villains: [weak], iterations: 4000 }).equity;
  check('weights steer sampling (AA vs mostly KK beats AA vs mostly a set)', a > 0.85 && c < 0.25, [a, c]);
  let threw = false;
  try { E.equity({ hero, board, villains: [[h('AhKs')]], iterations: 100 }); } catch (e) { threw = true; }
  check('a villain holding one of our cards is impossible: error, not a random hand', threw);
  const two = E.equity({ hero, board, villains: [[...[h('KsKc')]], [...[h('KdKh')]]], iterations: 3000 });
  check('two villains never share a card (KK and KK use all four kings)', two.iterations === 3000 && two.equity > 0.75, two);
  E.setSeed(null);
}

console.log('\nMultiway EV uses every combination of callers');
{
  E.setSeed(5);
  const board = h('Ks9d4c');
  const mk = (name, f) => ({ name, position: 'BB', stack: 1000, bet: 0, foldOverride: f });
  const ctx = { hero: h('AsKd'), board, pot: 100, toCall: 0, heroStack: 1000, heroBet: 0, bb: 10, position: 'BTN', street: 'flop', inPosition: true, heroName: 'Hero', actions: [], villains: [mk('A', 0.4), mk('B', 0.4), mk('C', 0.4)] };
  const d = S.decide(ctx);
  const bet = d.options.find(o => o.action === 'BET');
  check('a bet into three players is valued', bet && Number.isFinite(bet.ev), d.options);
  const full = S.postflop(ctx).options.find(o => o.action === 'BET' && o.amount === bet.amount);
  check('caller combinations are recorded for diagnostics', full && Array.isArray(full.callerCases) && full.callerCases.length > 0, full);
  const ps = (full.callerCases || []).map(c => c.p);
  check('caller-combination probabilities are valid', ps.every(p => p > 0 && p <= 1));
  E.setSeed(null);
}

console.log('\nRaise EV only counts chips the caller can match');
{
  const board = h('Qc5c6h4dQd');
  const ctx = { hero: h('QhKd'), board, pot: 1000, toCall: 500, heroStack: 100000, heroBet: 0, bb: 10, position: 'BTN', street: 'river', inPosition: true, heroName: 'Hero', actions: [],
    villains: [{ name: 'V', position: 'BB', stack: 300, bet: 500, combos: E.topRange(0.3) }] };
  const d = S.postflop(ctx);
  const shove = d.options.find(o => o.action === 'ALL-IN');
  // they can put in at most 800 total; our 100k shove can win at most pot + their 300 more
  check('all-in EV is bounded by what the short stack can call', shove && shove.ev <= 1000 + 300 + 1, shove);
}

console.log('\nFallbacks are visible');
{
  const ctx = { hero: h('AsKd'), board: h('Ks9d4c'), pot: 100, toCall: 50, heroStack: 1000, heroBet: 0, bb: 10, position: 'BTN', street: 'flop', inPosition: true, heroName: 'Hero', actions: [],
    villains: [{ name: 'V', position: 'BB', stack: 1000, bet: 50, combos: [h('AsKs')] }] };  // impossible: shares our A♠
  const d = S.decide(ctx);
  check('an impossible villain range is flagged in the decision', Array.isArray(d.warnings) && d.warnings.some(w => /fallback|empty/.test(w)), d.warnings);
}

console.log('\nEquity against our perceived range is over the runouts (7 Nov)');
{
  const flop = h('Js8s3d');
  const theirs = [[...h('AsKs'), 1], [...h('QhQd'), 1], [...h('7c6c'), 1]];  // nut flush draw, overpair, gutshot
  const ours = E.topRange(0.08).map(c => [c[0], c[1], 1]);
  const exact = E.rangeEquityVs(theirs, ours, flop, { exact: true });
  E.setSeed(9); const sampled = E.rangeEquityVs(theirs, ours, flop, { samples: 400 }); E.setSeed(null);
  check('sampled flop equity matches exact enumeration (±4%)', [...exact].every((x, i) => Math.abs(x - sampled[i]) < 0.04), { exact: [...exact], sampled: [...sampled] });
  const nowOnly = E.strengthPercentiles(flop);
  check('a flush draw has real equity before the river (not just its current high-card strength)', exact[0] > 0.3, exact[0]);
  // turn: exact by construction; check against brute force with E.equity on one holding
  const turn = h('Js8s3d2c');
  const one = E.rangeEquityVs([[...h('AsKs'), 1]], [[...h('QhQd'), 1]], turn)[0];
  E.setSeed(2); const mc = E.equity({ hero: h('AsKs'), board: turn, villains: [[h('QhQd')]], iterations: 20000 }).equity; E.setSeed(null);
  check('turn equity (all river cards) agrees with Monte Carlo equity (±2%)', Math.abs(one - mc) < 0.02, { one, mc });
  const blk = E.rangeEquityVs([[...h('AsKs'), 1]], [[...h('AsQs'), 1], [...h('QhQd'), 1]], turn)[0];
  check('blockers: our A♠Q♠ can\'t exist with their A♠K♠, so it doesn\'t count', Math.abs(blk - one) < 1e-9, { blk, one });
  E.setSeed(5); const a1 = E.rangeEquityVs(theirs, ours, flop); E.setSeed(5); const a2 = E.rangeEquityVs(theirs, ours, flop); E.setSeed(null);
  check('same seed → identical equities', [...a1].every((x, i) => x === a2[i]));
}

console.log('\nMultiway EV is reproducible and side pots are split correctly (7 Nov)');
{
  const board = h('2c7d9s');
  const mk = () => ({ hero: h('AsAd'), board, pot: 100, toCall: 0, heroStack: 300, heroBet: 0, bb: 10, position: 'BTN', street: 'flop', inPosition: true, heroName: 'Hero', actions: [],
    villains: [{ name: 'A', position: 'SB', stack: 100, bet: 0, foldOverride: 0, combos: [h('KsKc')] }, { name: 'B', position: 'BB', stack: 1000, bet: 0, foldOverride: 0, combos: [h('QsQc')] }] });
  E.setSeed(1); const d1 = S.postflop(mk()); E.setSeed(1); const d2 = S.postflop(mk()); E.setSeed(null);
  check('identical seeds → identical EVs', d1.options.every((o, i) => o.ev === d2.options[i].ev));
  const shove = d1.options.find(o => o.action === 'ALL-IN');
  // A can only put in 100: main pot 100 dead + 3×100 (≈83% vs both), side pot 2×200 vs B only (≈91%)
  const approx = 0.95 * (0.83 * 400 + 0.91 * 400) - 300;
  check('side pot: shove EV ≈ main pot vs both + side pot vs the deep stack', Math.abs(shove.ev - approx) < 25, { ev: shove.ev, approx });
  const five = { ...mk(), heroStack: 1000, villains: 'ABCDEF'.split('').map(n => ({ name: n, position: 'BB', stack: 1000, bet: 0, foldOverride: 0.5 })) };
  E.setSeed(3); const m1 = S.postflop(five); E.setSeed(3); const m2 = S.postflop(five); E.setSeed(null);
  check('six opponents: exact caller enumeration, reproducible', m1.options.every((o, i) => o.ev === m2.options[i].ev));
  const b6 = m1.options.find(o => o.action === 'BET');
  check('caller-combination probabilities never exceed 1', (b6.callerCases || []).reduce((t, c) => t + c.p, 0) <= 1 + 1e-9 && b6.foldEst > 0, b6);
}

console.log('\nBet sizing changes the range update (7 Nov)');
{
  const b = h('Kd8c4h2s9d');
  const r0 = E.weightRange(E.softRange(0.4), b.slice(0, 3), 'call');
  const small = E.weightRange(r0, b, 'bet', { size: 0.25 }), big = E.weightRange(r0, b, 'bet', { size: 1.5 });
  const hs = E.strengthPercentiles(b);
  const k = c => (c[0] < c[1] ? c[0] * 52 + c[1] : c[1] * 52 + c[0]);
  const share = (r, f) => r.filter(c => f(hs.get(k(c)))).reduce((t, c) => t + c[2], 0) / E.rangeSize(r);
  check('a 150% pot bet carries fewer medium hands than a 25% bet', share(big, x => x > 0.4 && x < 0.8) < share(small, x => x > 0.4 && x < 0.8), { big: share(big, x => x > 0.4 && x < 0.8), small: share(small, x => x > 0.4 && x < 0.8) });
  check('and more of its weight is at the top (polarized)', share(big, x => x >= 0.9) > share(small, x => x >= 0.9));
  const callSmall = E.weightRange(r0, b, 'call', { size: 0.25 }), callBig = E.weightRange(r0, b, 'call', { size: 1.5 });
  check('calling a big bet keeps a stronger range than calling a small one', E.rangeSize(callBig) < E.rangeSize(callSmall));
  const usualBig = E.weightRange(r0, b, 'bet', { size: 1.5, relSize: 1 });
  check('a big bet from a player who always bets big says less (closer to a normal bet)', Math.abs(share(usualBig, x => x >= 0.9) - share(E.weightRange(r0, b, 'bet'), x => x >= 0.9)) < Math.abs(share(big, x => x >= 0.9) - share(E.weightRange(r0, b, 'bet'), x => x >= 0.9)));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
