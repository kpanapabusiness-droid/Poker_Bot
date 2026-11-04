# Poker Coach

A live poker coaching overlay. It shows the numbers you forget mid-hand: equity, pot odds, the equity you need to call, and opponent ranges, plus a plain-English recommendation.

**It only displays information. It never clicks or acts for you.** Built as a learning tool, starting with Torn City poker.

## Files

| File | What it is |
|---|---|
| `poker-engine.js` | Core maths: hand evaluator, range parser, Monte Carlo equity, pot odds / EV / MDF / SPR, starter preflop ranges, `advise()`. No dependencies. Runs in Node and the browser. |
| `test-engine.js` | Tests. Run `node test-engine.js` |
| `torn-poker-coach.user.js` | Tampermonkey overlay for Torn. The site adapter's selectors are still to be filled in. |
| `docs/poker-coach-plan.md` | Full build plan, decisions, phases and next steps |

## Quick start

```bash
node test-engine.js
```

```js
const E = require('./poker-engine.js');
E.equity({ hero: 'AhKh', board: 'Qh7h2c', villains: ['QQ+,AQs,KQs'] });
// → { equity: ~0.41, win, tie, lose, handName: 'High card', ... }
E.advise({ equity: 0.41, pot: 150, toCall: 50 });
// → { action: 'CALL', reason: "Equity beats the price you're getting", ... }
```

## Using the overlay

1. Install Tampermonkey in Chrome.
2. Create a new script and paste in `torn-poker-coach.user.js`. Its header loads the engine via:
   `// @require https://raw.githubusercontent.com/kpanapabusiness-droid/Poker_Bot/main/poker-engine.js`
3. See `docs/poker-coach-plan.md` for testing the panel before the Torn adapter is wired up.

## Ground rules

Use only where permitted: Torn (passive display only, with no requests and no automation) and private games where everyone has agreed. **Never use it on real-money sites.** Real-time assistance is banned there and punished with bans and seized balances.
