# Poker Coach

A live poker coaching overlay. It shows the numbers you forget mid-hand: equity, pot odds, the equity you need to call, and opponent ranges, plus a plain-English recommendation.

**It only displays information. It never clicks or acts for you.** Built as a learning tool, starting with Torn City poker.

## Files

| File | What it is |
|---|---|
| `poker-engine.js` | Core maths: hand evaluator, range parser, Monte Carlo equity, pot odds / EV / MDF / SPR, starter preflop ranges, `advise()`. No dependencies. Runs in Node and the browser. |
| `torn-adapter.js` | Reads Torn's poker table: your cards, board, pot, amount to call, seats, dealer, and the action log. Read-only. |
| `torn-poker-coach.user.js` | Tampermonkey overlay: shows the action, equity, needed equity, pot odds, call EV, SPR, positions and each opponent's estimated range. |
| `test-engine.js`, `test/` | Tests. `test/fixtures/` holds real (anonymised) Torn table snapshots. |
| `docs/poker-coach-plan.md` | Full build plan, decisions, phases and next steps |

## Quick start

```bash
npm install   # only needed for the adapter/overlay tests (jsdom)
npm test      # engine + Torn adapter + full overlay against real snapshots
```

```js
const E = require('./poker-engine.js');
E.equity({ hero: 'AhKh', board: 'Qh7h2c', villains: ['QQ+,AQs,KQs'] });
// → { equity: ~0.41, win, tie, lose, handName: 'High card', ... }
E.advise({ equity: 0.41, pot: 150, toCall: 50 });
// → { action: 'CALL', reason: "Equity beats the price you're getting", ... }
```

## Using the overlay

1. Install Tampermonkey in Chrome, and turn on **Allow user scripts** for it (chrome://extensions → Tampermonkey → Details).
2. Open https://raw.githubusercontent.com/kpanapabusiness-droid/Poker_Bot/main/torn-poker-coach.user.js and Tampermonkey will offer to install it. Its header loads `poker-engine.js` and `torn-adapter.js` from this repo.
3. Go to Torn poker and sit at a table. The panel appears top-right and can be dragged anywhere; it remembers where you put it.

**Updating:** Tampermonkey caches `@require` files. After an update, open the script in the Tampermonkey dashboard → Externals tab and refresh, or bump `@version`.

**How ranges work (for now):** each opponent starts from what they did preflop (opened, 3-bet, called a raise, limped). The range then narrows on every bet, raise or call after the flop. These are starter heuristics; Phase 3 adds per-player stats.

## Ground rules

Use only where permitted: Torn (passive display only, with no requests and no automation) and private games where everyone has agreed. **Never use it on real-money sites.** Real-time assistance is banned there and punished with bans and seized balances.
