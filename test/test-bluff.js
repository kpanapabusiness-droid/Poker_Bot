// Bluff & exploit scenarios (the 10 from the intelligence plan). Ranges are built the way the brain
// builds them: soft preflop ranges narrowed by each action with weightRange.
const E = require('../poker-engine.js');
const S = require('../strategy.js');
let pass = 0, fail = 0;
const check = (name, ok, detail) => { ok ? pass++ : fail++; console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : '  ' + JSON.stringify(detail)}`); };
const h = E.parseCards;
E.setSeed(11);

/** A range from a preflop width and a list of [boardCards, action] steps. */
function rng(width, steps, minus = 0) {
  let r = E.softRange(width, { minus });
  for (const [b, a] of steps) r = E.weightRange(r, h(b), a);
  return r;
}
const V = (o = {}) => ({ name: 'V', position: 'BB', stack: 1000, bet: 0, hands: 60, ...o });
const ctxOf = o => ({ bb: 2, heroStack: 1000, heroBet: 0, position: 'BTN', inPosition: true, heroName: 'Hero', actions: [], ...o });
const decide = o => S.decide(ctxOf(o));
const isAggro = d => ['BET', 'RAISE', 'ALL-IN'].includes(d.action);

console.log('\n1. Bluffing with nothing when our line represents the nuts');
{ // we opened, bet flop and turn; the 4th spade lands on the river; they called twice with pairs/draws
  const board = 'Ks9s4d2c7s';
  const them = rng(0.4, [['Ks9s4d', 'call'], ['Ks9s4d2c', 'call'], [board, 'check']], 0.05);
  const us = rng(0.3, [['Ks9s4d', 'bet'], ['Ks9s4d2c', 'bet']]);
  const d = decide({ hero: h('QhJd'), board: h(board), pot: 60, toCall: 0, street: 'river', heroRange: us, villains: [V({ combos: them, foldOverride: 0.45 })] });
  check('Q-high with no spade bets the river (they fold one pair to a credible flush)', isAggro(d), [d.action, d.reason]);
}

console.log('\n2. Representing a high flush against a lower flush');
{
  const board = 'Ks9s4d2c7s';
  const them = rng(0.4, [['Ks9s4d', 'call'], ['Ks9s4d2c', 'call'], [board, 'check']], 0.05);
  const us = rng(0.3, [['Ks9s4d', 'bet'], ['Ks9s4d2c', 'bet']]);
  const withAce = S.decide(ctxOf({ hero: h('AsJd'), board: h(board), pot: 60, toCall: 0, street: 'river', heroRange: us, villains: [V({ combos: them })] }));
  const big = withAce.options.filter(o => o.action === 'BET').sort((a, b) => b.amount - a.amount)[0];
  check('a big bet is expected to fold a real share of their range', big && big.foldEst > 0.3, big);
}

console.log('\n3. Recognising when they are unlikely to fold a flush');
{ // the flush card comes on the river; one opponent called with lots of spade draws, another without
  const board = 'Ks9d4s2c7s';
  const us = rng(0.3, [['Ks9d4s', 'bet'], ['Ks9d4s2c', 'bet']]);
  const drawHeavy = rng(0.4, [['Ks9d4s', 'call'], ['Ks9d4s2c', 'call'], [board, 'check']]);
  const noDraws = drawHeavy.filter(c => !((c[0] & 3) === (h('As')[0] & 3) && (c[1] & 3) === (h('As')[0] & 3)));
  const fold = them => S.postflop(ctxOf({ hero: h('QhJd'), board: h(board), pot: 60, toCall: 0, street: 'river', heroRange: us, villains: [V({ combos: them })] }))
    .options.filter(o => o.action === 'BET').sort((a, b) => b.amount - a.amount)[0].foldEst;
  check('they are expected to fold less when their range holds the flushes', fold(drawHeavy) < fold(noDraws), { withFlushes: fold(drawHeavy), without: fold(noDraws) });
}

console.log('\n4. Bluffing missed draws against opponents who overfold');
{
  const board = 'Ah9c6d2s3h';
  const them = rng(0.5, [['Ah9c6d', 'check'], ['Ah9c6d2s', 'check'], [board, 'check']]);
  const us = rng(0.3, [['Ah9c6d', 'check'], ['Ah9c6d2s', 'check']]);
  const d = decide({ hero: h('8h7h'), board: h(board), pot: 40, toCall: 0, street: 'river', heroRange: us, villains: [V({ combos: them, foldOverride: 0.75 })] });
  check('missed straight/flush draw bets into a weak, checking, overfolding player', isAggro(d), [d.action, d.reason]);
}

console.log('\n5. Avoiding bluffs against calling stations');
{ // a station who called our flop bet (so holds pairs and draws), then checked it down
  const board = 'Ah9c6d2s3h';
  const them = rng(0.6, [['Ah9c6d', 'call'], ['Ah9c6d2s', 'check'], [board, 'check']]);
  const us = rng(0.3, [['Ah9c6d', 'bet'], ['Ah9c6d2s', 'check']]);
  const d = decide({ hero: h('8h7h'), board: h(board), pot: 40, toCall: 0, street: 'river', heroRange: us, villains: [V({ combos: them, foldOverride: 0.05 })] });
  check('a missed draw checks against a station who called the flop', d.action === 'CHECK', [d.action, d.reason]);
  const avg = decide({ hero: h('8h7h'), board: h(board), pot: 40, toCall: 0, street: 'river', heroRange: us, villains: [V({ combos: them, foldOverride: 0.4 })] });
  const ev = d0 => Math.max(...d0.options.filter(o => o.action === 'BET').map(o => o.ev));
  check('and a bluff is worth less against the station than against an average player', ev(d) < ev(avg), { station: ev(d), average: ev(avg) });
}

console.log('\n6. Blockers: holding a card of their strong hands makes a bluff work more often');
{
  const board = 'Ks9s4d2c7s';
  const them = rng(0.4, [['Ks9s4d', 'call'], ['Ks9s4d2c', 'call']]);
  const us = rng(0.3, [['Ks9s4d', 'bet'], ['Ks9s4d2c', 'bet']]);
  const f = hero => {
    const o = S.postflop(ctxOf({ hero: h(hero), board: h(board), pot: 60, toCall: 0, street: 'river', heroRange: us, villains: [V({ combos: them })] }))
      .options.filter(x => x.action === 'BET').sort((a, b) => b.amount - a.amount)[0];
    return o.foldEst;
  };
  const block = f('QsJd'), none = f('QhJd');  // Q♠ blocks some of their flushes
  check('with a spade blocker they fold at least as often', block >= none - 0.01, { block, none });
}

console.log('\n7. Sudden river aggression makes bluffing unattractive');
{ // we bet the river as a bluff and they raise
  const board = 'Ah9c6d2s3h';
  const them = rng(0.4, [['Ah9c6d', 'call'], ['Ah9c6d2s', 'call'], [board, 'raise']]);
  const d = decide({ hero: h('8h7h'), board: h(board), pot: 200, toCall: 60, heroBet: 40, street: 'river', villains: [V({ combos: them, bet: 100 })] });
  check('air facing a river raise folds (no re-bluff)', d.action === 'FOLD', [d.action, d.reason]);
}

console.log('\n8. Semi-bluffing strong draws');
{
  const board = 'Js8s3d';
  const them = rng(0.4, [[board, 'check']]);
  const d = decide({ hero: h('AsTs'), board: h(board), pot: 20, toCall: 0, street: 'flop', heroRange: rng(0.3, []), villains: [V({ combos: them })] });
  check('nut flush draw with overcard bets when checked to', isAggro(d), [d.action, d.tag, d.reason]);
}

console.log('\n9. Profitable bluff-catching');
{ // an aggressive player bets the river after checking turn; we have top pair
  const board = 'Kd8c4h2s9d';
  const them = rng(0.55, [['Kd8c4h', 'call'], ['Kd8c4h2s', 'check'], [board, 'bet']].map(([b, a]) => [b, a]));
  const d = decide({ hero: h('KhTc'), board: h(board), pot: 40, toCall: 20, street: 'river', inPosition: true, villains: [V({ combos: them, bet: 20, aggression: 3.5 })] });
  check('top pair does not fold to a half-pot river bet from a wide, aggressive range', d.action !== 'FOLD', [d.action, d.reason, d.equity]);
}

console.log('\n10. Bluffing less into players who fight back');
{ // same spot as 4, vs a player who rarely folds to our bets now (fold-to-bet observed low)
  const board = 'Ah9c6d2s3h';
  const them = rng(0.5, [['Ah9c6d', 'check'], ['Ah9c6d2s', 'check'], [board, 'check']]);
  const us = rng(0.3, [['Ah9c6d', 'check'], ['Ah9c6d2s', 'check']]);
  const ev = f2b => {
    const d = S.postflop(ctxOf({ hero: h('8h7h'), board: h(board), pot: 40, toCall: 0, street: 'river', heroRange: us, villains: [V({ combos: them, foldOverride: f2b })] }));
    return Math.max(...d.options.filter(o => o.action === 'BET').map(o => o.ev)) - d.options.find(o => o.action === 'CHECK').ev;
  };
  check('a bluff is worth less (vs checking) against a player whose fold rate dropped', ev(0.25) < ev(0.6), { low: ev(0.25), high: ev(0.6) });
}

console.log('\n11. Choosing which hands bluff (range-level selection, 7 Nov)');
{
  S.MODEL.bluffSelect.on = true;  // off by default; tested here
  const board = 'Ks9s4d2c7s';
  const them = rng(0.4, [['Ks9s4d', 'call'], ['Ks9s4d2c', 'call'], [board, 'check']], 0.05);
  const us = rng(0.3, [['Ks9s4d', 'bet'], ['Ks9s4d2c', 'bet']]);
  const sel = hero => decide({ hero: h(hero), board: h(board), pot: 60, toCall: 0, street: 'river', heroRange: us, villains: [V({ combos: them })] });
  const a = sel('QhJd'), b = sel('Qs3d');  // Q♠ blocks some of the flushes and K-high flushes that call
  const ra = a.explain.bluffSelection, rb = b.explain.bluffSelection;
  check('bluff selection is reported with a rank, a probability and the balanced number of bluffs', ra && ra.prob != null && ra.need > 0, ra);
  check('a blocker hand ranks at least as high as a non-blocker of similar strength', rb && ra && (rb.rank || 99) <= (ra.rank || 99), { blocker: rb, none: ra });
  const sdv = sel('9h8h');  // a pair of nines: real showdown value
  check('a hand with showdown value is not picked as a bluff (checks or value-bets instead)', !(sdv.tag === 'BLUFF'), [sdv.action, sdv.tag, sdv.explain.bluffSelection]);
  check('probabilities are between 0 and 1', [ra, rb].every(x => !x || (x.prob >= 0 && x.prob <= 1)));
  S.MODEL.bluffSelect.on = false;
}

console.log('\n12. Opponent adaptation');
{
  const board = 'Ah9c6d2s3h';
  const them = rng(0.5, [['Ah9c6d', 'check'], ['Ah9c6d2s', 'check'], [board, 'check']]);
  const us = rng(0.3, [['Ah9c6d', 'check'], ['Ah9c6d2s', 'check']]);
  const fe = o => S.postflop(ctxOf({ hero: h('8h7h'), board: h(board), pot: 40, toCall: 0, street: 'river', heroRange: us, villains: [V({ combos: them, ...o })] }))
    .options.filter(x => x.action === 'BET').sort((a, b) => b.amount - a.amount)[0].foldEst;
  check('an aggressive player is not assumed to fold more just for being aggressive', fe({ aggression: 4, foldOverride: 0.4 }) <= fe({ aggression: 1, foldOverride: 0.4 }) + 0.01);
  check('a learned "folds less than predicted" correction lowers the fold estimate', fe({ foldBias: -0.2 }) < fe({ foldBias: 0 }) - 0.05, { bias: fe({ foldBias: -0.2 }), none: fe({ foldBias: 0 }) });
  check('a learned "folds more" correction raises it', fe({ foldBias: 0.15 }) > fe({ foldBias: 0 }) + 0.01, { more: fe({ foldBias: 0.15 }), none: fe({ foldBias: 0 }) });
}

console.log('\n13. Bet size and EV of the chosen action');
{
  const board = 'Ks9s4d2c7s';
  const them = rng(0.4, [['Ks9s4d', 'call'], ['Ks9s4d2c', 'call'], [board, 'check']], 0.05);
  const us = rng(0.3, [['Ks9s4d', 'bet'], ['Ks9s4d2c', 'bet']]);
  const d = S.postflop(ctxOf({ hero: h('AsKd'), board: h(board), pot: 60, toCall: 0, street: 'river', heroRange: us, villains: [V({ combos: them })] }));
  const best = d.options.reduce((a, b) => (b.ev > a.ev ? b : a));
  check('the chosen action is the best-EV option or within the uncertainty margin of it', Math.abs(best.ev - d.options.find(o => o.action === d.action && (o.amount === d.amount || d.action === 'CHECK')).ev) <= 0.13 * 60 + 1e-9, { chosen: [d.action, d.amount], best });
  const bets = d.options.filter(o => o.action === 'BET').map(o => o.foldEst);
  check('bigger bets are expected to fold more (or equal)', bets.slice(1).every((x, i) => x <= bets[i] + 0.02), bets);
}

E.setSeed(null);
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
