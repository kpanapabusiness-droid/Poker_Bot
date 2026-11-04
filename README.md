# Poker Coach

A live poker coaching overlay. It shows the numbers you forget mid-hand: equity, pot odds, the equity you need to call, and opponent ranges, plus a plain-English recommendation.

**It only displays information. It never clicks or acts for you.** Built as a learning tool, starting with Torn City poker.

## Files

| File | What it is |
|---|---|
| `poker-engine.js` | Core maths: hand evaluator, range parser, Monte Carlo equity, pot odds / EV / MDF / SPR, starter preflop ranges, `advise()`. No dependencies. Runs in Node and the browser. |
| `torn-adapter.js` | Reads Torn's poker table: your cards, board, pot, amount to call, seats, dealer, and the action log. Read-only. |
| `strategy.js` | The decision layer, which tells you exactly what to do and how much. Preflop it uses position charts (open, limp behind, 3-bet for value or as a bluff, call, 4-bet, fold) and switches to push/fold at 12bb or less. Postflop it compares the EV of fold, check, call, bet ⅓ / ½ / ¾ / pot, raise and all-in, using opponent ranges and a fold-equity model. Every recommendation is tagged VALUE, PROTECTION, SEMI-BLUFF or BLUFF. |
| `tracker.js` | Learns every opponent from finished hands in the game log. It tracks VPIP, PFR, 3-bet %, aggression, fold-to-bet, went-to-showdown and shown hands. Small samples are blended towards an average casual player. Players get labelled Calling Station / Maniac / Fish / Nit / Rock / TAG / LAG / Average. Stats are saved in your browser. |
| `logger.js` | Hand and decision logger. For every hand it records the coach's advice and what you did, whether you followed it, the **EV you lost** by deviating, and the result. It builds the Report view (session and all-time results, bb/100, follow rate, EV lost, your habits vs the coach, costliest decisions, results by position) and a CSV export. |
| `torn-poker-coach.user.js` | Tampermonkey overlay showing the exact action and size, why, the tag, fold needed vs expected (for bluffs), every option's EV, equity, SPR, IP/OOP, positions and each opponent's estimated range. |
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
2. Open https://raw.githubusercontent.com/kpanapabusiness-droid/Poker_Bot/main/torn-poker-coach.user.js and Tampermonkey will offer to install it. Its header loads `poker-engine.js`, `torn-adapter.js`, `strategy.js`, `tracker.js` and `logger.js` from this repo.
3. Go to Torn poker and sit at a table. The panel appears top-right and can be dragged anywhere; it remembers where you put it.

**Updating:** Tampermonkey caches `@require` files. After an update, open the script in the Tampermonkey dashboard → Externals tab and refresh, or bump `@version`.

**How it decides when to bluff:** a bluff works when the opponent folds often enough. A ½-pot bet needs folds 33% of the time to break even. The coach estimates how often a typical casual player folds to each bet size, works out what you win when they fold and your equity when they call, and only recommends a bluff when the maths says it's profitable. For strangers it uses default fold rates (`MODEL` in `strategy.js`). Once a player has been tracked, it uses their real fold-to-bet rate instead (see below).

**How it learns opponents (Phase 3):** every finished hand in the game log updates each player's stats. Their range is then sized to *their* tendencies: a 60% VPIP player who limps has a much wider range than a 15% player. The range narrows on each postflop action, and aggressive players are given more bluffs. Their own fold-to-bet rate drives the bluff maths, so it won't bluff calling stations and bluffs more against players who fold too much. Strangers start as an average casual player (VPIP 40%, PFR 12%, folds to bets 40%) and move towards their real numbers as hands accumulate. A player type label appears after about 15 hands.

**The Report tab:** click **Report** at the top of the panel to see how you're doing, for this session or all time. Watch **EV lost** more than the result. The result swings with luck, but EV lost is how much your deviations from the coach cost in the long run, so it measures decision quality. **⬇ CSV** downloads every decision, one row each, for Excel or SQL.

**Your data** (player stats and the hand log) lives in your browser on torn.com. In the console:
- `PokerCoach.report()` gives the all-time report object, and `PokerCoach.report(false)` this session only.
- `PokerCoach.downloadCSV()` and `PokerCoach.exportHands()` / `importHands(obj)` / `resetHands()` handle the hand log.
- `PokerCoach.players()` lists everyone tracked.
- `PokerCoach.stats('name')` shows one player's details.
- `PokerCoach.exportStats()` gives you a backup.
- `PokerCoach.importStats(obj)` restores a backup.
- `PokerCoach.resetStats()` clears everything.

## Ground rules

Use only where permitted: Torn (passive display only, with no requests and no automation) and private games where everyone has agreed. **Never use it on real-money sites.** Real-time assistance is banned there and punished with bans and seized balances.
