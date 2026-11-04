# Live Poker Coach — Build Plan

**What it is:** a live coaching overlay that shows the information you tend to forget mid-hand: your equity, pot odds, the equity you need to call, and opponents' likely ranges, with a plain-English recommendation. **It only shows information and never clicks or acts for you.** You make every decision.

**Why build it:** a learning tool, and a portfolio piece for data analytics roles. It covers probability, Bayesian modelling, data pipelines, SQL, and judging decisions by expected value (EV) instead of results. It isn't a business: GTO Wizard, PokerTracker and Hold'em Manager already own that market.

**Status (4 Nov 2026, evening):** Phases 1 and 2 are done. The Torn table reader (`torn-adapter.js`) was built from 6 real table snapshots and reads cards, board, pot, amount to call, seats, dealer, positions and the action log. The overlay shows the action, equity, needed equity, pot odds, call EV, SPR and per-opponent ranges, narrowed by preflop and postflop actions. 96 tests pass (engine 51, adapter 45), plus a full overlay run against every snapshot.

**Update (4 Nov, later):** a decision layer (`strategy.js`, overlay v0.3) now tells you the exact action and size, such as "RAISE to $90", "BET $30 (⅓ pot)" or "ALL-IN".
- **Preflop:** position charts (open, iso-raise over limpers, limp behind, 3-bet for value or as a bluff, set-mine calls, BB defence by equity, 4-bet, fold) and push/fold at 12bb or less.
- **Postflop:** the EV of every option (fold, check, call, 4 bet sizes, raises, all-in) using ranges and a fold-equity model. Each recommendation is tagged VALUE / PROTECTION / SEMI-BLUFF / BLUFF, and bluffs show the fold % needed vs the fold % expected.
- **Tests:** 120 pass (engine 51, adapter 45, strategy 24 textbook spots), plus the overlay on every snapshot.

**Update (4 Nov, night) — Phase 3 done (overlay v0.4):** `tracker.js` learns each opponent from finished hands.
- **What it tracks:** VPIP, PFR, 3-bet %, aggression, fold-to-bet, went-to-showdown and shown hands.
- **Small samples:** blended towards the average casual player until there are enough hands.
- **Player types:** Calling Station / Maniac / Fish / Nit / Rock / TAG / LAG / Average, after 15+ hands.
- **What it changes:**
  - Preflop ranges come from the player's own stats, using a 169-hand strength ranking (`topRange(pct)` in the engine).
  - Postflop bluff and float shares follow their aggression and fold-to-bet.
  - Their own fold-to-bet feeds the bluff EV.
- **Panel:** shows type, VPIP / PFR / F2B / hands for each opponent, plus a "vs <type>" tip when heads-up.
- **Stats storage:** saved in localStorage, with console helpers for export, import and reset.
- **Tests:** 138 pass (engine 51, adapter 45, strategy 24, tracker 18). The same river spot with nothing → check vs a calling station, bluff vs a nit.

**Update (5 Nov) — hand logger (overlay v0.5):** `logger.js` records every hand you're dealt into.
- **What it records:** each decision point (coach's action, size, tag and EV vs your actual action), followed yes/no, size OK, EV lost, and the result.
- **How the result is worked out:** from the game log, cross-checked against your stack at the next hand (the stack wins when you went all-in).
- **The panel** now has **Coach | Report** tabs. The Report shows session or all-time hands, result, bb/100, follow rate, EV lost (total and per 100 hands), hands where you followed vs deviated, your habit patterns ("Coach FOLD → you CALL ×N · −$X EV"), your costliest decisions, and bb/100 by position.
- **CSV export:** one row per decision, for SQL/Excel analysis.
- **Storage:** localStorage, up to 2,500 hands.
- **Tests:** 163 pass (engine 51, adapter 45, strategy 24, tracker 18, logger 25), plus the overlay on every snapshot and a Report-tab UI test.

**Next:** play sessions, check the Report, tell Claude about any spots where the advice felt wrong. Options after that:
- a 13×13 range grid in the panel
- the Claude review connector (MCP over the CSV/hand log)
- the PokerNow adapter for the friends' game

**Torn table facts (verified from snapshots):**
- URL `torn.com/page.php?sid=holdem`
- Tables come in 2, 4, 6 and 9 seats, plus tournaments
- Hero = slot 0, opponents = `playerPositioner-1..8` clockwise, and action goes in ascending slot order
- The dealer marker is `dealer___ position-N` and bets are `player-pot-N`, using the same numbering
- `POT:` includes current-street bets
- The game log has every action as text, and each hand starts with a "Game <id> started" line
- Class names have hashes that change on redeploy, so the adapter matches on prefixes only

---

## Decisions made

| Decision | Choice | Why |
|---|---|---|
| First platform | **Torn** | Runs in the browser, so a Tampermonkey script works. You already play there. Torn has passive-display advisor scripts (e.g. a blackjack strategy overlay) that make zero requests and take zero actions. |
| Friends' tournament platform | **A browser-based private-table site (e.g. PokerNow)**, not PokerStars and not PPPoker | PokerStars bans real-time assistance site-wide, whatever the table agrees, and confiscates balances. Its client is a desktop app, not a web page. PPPoker is a phone app, so it would need an emulator plus OCR. |
| Who decides | **Maths engine + preset strategy rules + opponent tracker.** Claude explains; it doesn't play. | Language models are weak at live poker maths and too slow for the moment of decision. The strongest poker AIs (Libratus, Pluribus) are game-theory solvers, not LLMs. |
| Where Claude fits | Explains spots on demand, reviews sessions afterwards through an MCP connector to the hand database, turns leaks into practice quizzes | Plays to Claude's strengths and keeps the live loop instant and local |
| GTO Wizard | **Don't scrape it** (their terms forbid it). Possible Phase 5 use: their Benchmarking API as a test opponent to score the strategy layer | Confirm the API exists on gtowizard.com. The terms page found was a mirror. |
| Language | **Plain JavaScript, no build step** | Drops straight into Tampermonkey. The same file runs in Node for testing. |

## Ground rules (compliance)

- **Torn:** read only the page you're viewing, make zero requests to Torn, never click or act. Re-read Torn's official scripting rules before using it at real tables, because poker is against other players, not the house.
- **Friends' tournament:** fine because everyone has agreed. The platform's own terms still apply, though, so pick a site that won't ban you for it.
- **Never use it on PokerStars, GGPoker or any real-money site.** Real-time assistance (RTA) is banned there, actively detected, and punished with account closure and seized balances.

---

## Architecture

```
            ┌──────────────── site adapters (the "eyes") ────────────────┐
 Torn DOM ─▶│ TornAdapter.readState()     PokerNowAdapter (later)         │
            └───────────────────────────┬─────────────────────────────────┘
                                        ▼  TableState (same shape for every site)
                        ┌──────────── poker-engine.js (the "brain") ───────────┐
                        │ evaluator · ranges · equity · pot odds · RFI · advise │
                        └──────┬────────────────────────────────┬──────────────┘
                               ▼                                ▼
                    Panel (live, local, instant)      Hand log → IndexedDB / SQL
                                                                 ▼
                                                     Opponent tracker (Phase 3)
                                                                 ▼
                                                    MCP connector → Claude review
```

**TableState** (what every adapter must return):
```js
{ heroCards: ['As','Kd'], board: ['Qs','7d','2c'], pot: 150, toCall: 50, heroStack: 1000,
  players: [{ name, seat, stack, inHand, isHero, isButton, lastAction, bet }], handId }
```

---

## Phases

| # | Phase | Deliverable | Est. (with Claude coding) | Status |
|---|---|---|---|---|
| 1 | **Core engine** | Hand evaluator, range parser, Monte Carlo equity, pot odds/EV/MDF/SPR, starter preflop ranges, `advise()` | 1 weekend | ✅ Done |
| 2 | **Torn overlay** | Tampermonkey script reads the table and shows a draggable panel (action, equity, needed equity, pot odds, call EV, SPR, positions, opponent ranges) | 1 weekend | ✅ Done; ready for live testing |
| 2.5 | **Decision layer** | Exact action and size. Preflop charts and push/fold. Postflop EV across fold/check/call/bet sizes/raise/all-in with a fold-equity model. VALUE / PROTECTION / SEMI-BLUFF / BLUFF tags. | 1 evening | ✅ Done |
| 3 | **Opponent tracker + range narrowing** | Per-player action log in IndexedDB. Stats: VPIP (how often they put money in voluntarily), PFR (how often they raise preflop), aggression, fold-to-c-bet. Start everyone at average casual-player stats and shift towards their own numbers as hands accumulate. Narrow ranges street by street. 13×13 range grid in the panel. | 1–2 weekends | ✅ Done (except the range grid) |
| 4 | **Solver integration** | Plug in an open-source solver (TexasSolver / postflop-solver; check they're still maintained). Cache common spots. Replace starter preflop ranges with solver charts. | 2–3 weekends | ⬜ |
| 5 | **Exploit + learning loop** | Node-locking against tracked opponents (tell the solver "this player never bluffs the river" and get the best counter). Log recommendation vs your action vs result. Measure by EV, not raw results. Dashboard. Optional GTO Wizard benchmark. | Ongoing | 🟡 Logging, EV-lost measurement and the Report dashboard are done; node-locking is still to do |
| + | **Claude layer** | MCP server over the hand DB: `session_summary`, `find_leaks`, `biggest_losing_hands`, `review_hand(id)`. Plus an "explain this spot" button. | 1 weekend (alongside 3+) | ⬜ |
| + | **PokerNow adapter** | Second adapter for the friends' tournament | ~1 day once the engine is stable | ⬜ |

Phases 1–3 alone put you well ahead of a casual table. Phases 4–5 are the impressive portfolio part.

---

## Source of truth

**Code lives on GitHub: https://github.com/kpanapabusiness-droid/Poker_Bot.** This project keeps only the plan and the README.

## Getting it running

1. Install **Tampermonkey** in Chrome, and turn on **Allow user scripts** for it (chrome://extensions → Tampermonkey → Details).
2. Open https://raw.githubusercontent.com/kpanapabusiness-droid/Poker_Bot/main/torn-poker-coach.user.js and Tampermonkey offers to install it.
3. Sit at a Torn poker table. The panel appears top-right and can be dragged anywhere.
4. After updates: Tampermonkey dashboard → the script → **Externals** → refresh, so it picks up the new engine and adapter.
5. Run all tests with `npm install && npm test`.

## Next action: live testing

Play a session with the panel on, and note anything that looks wrong: misread cards, wrong position, wrong to-call amount, odd advice. If something misreads, save a snapshot at that moment with the console snippet below and drop it in a chat. It becomes a new test fixture.

```js
(() => { const b = new Blob([document.documentElement.outerHTML], {type: 'text/html'}); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'torn-poker-' + Date.now() + '.html'; a.click(); })();
```

Snapshots contain other players' names. Before committing them, anonymise them the same way the existing fixtures were.

---

## Engine reference (poker-engine.js)

| Function | What it does |
|---|---|
| `equity({hero, board, villains, dead, iterations})` | Monte Carlo equity. `villains` is an array with one entry per opponent: range text (`'22+,ATs+'`), a combos array, or `null` for any two cards. About 75 ms for 30k iterations. |
| `advise({equity, pot, toCall})` | Returns RAISE / BET / CALL / CHECK / MARGINAL / FOLD with the reason, required equity, ratio and EV. Thresholds are starting points to tune. |
| `potOdds(pot, toCall)` | `pot` **includes** the villain's bet. Required equity = toCall / (pot + toCall). |
| `callEV`, `mdf`, `bluffBreakeven`, `spr`, `outsToEquity` | The usual maths |
| `parseRange(text)` | Supports `AA`, `AKs`, `AKo`, `AK`, `22+`, `A2s+`, `22-66`, `A2s-A5s`, `T9s-65s`, `AsKs` |
| `rfiRange(pos)` / `positionFromSeat(seatsFromBtn, n)` | Starter open-raise ranges: EP 13%, LJ 20%, HJ 25%, CO 34%, BTN 47%, SB 37%. **Approximations, not solver output.** |
| `evaluate(cards)` / `handName(score)` | 5–7 card evaluator. A higher score is a better hand. |

| `allCombos()` / `handFeatures(hand, board)` / `narrowRange(combos, board, action)` | Postflop narrowing. Flop bets and any calls keep pair-or-better plus draws. Turn and river bets keep top pair or better (plus draws on the turn). A share of weak hands is kept as bluffs (20%) or floats (33%). |

**Torn adapter (torn-adapter.js):** `readState(document)` → TableState. Also `positions(state, positionFromSeat)`, `preflopActions(state)` and `parseLogLine(actor, text)`.

**Known limits to fix later:**
- Equity is "showdown equity": it ignores future betting and implied odds.
- Preflop ranges are approximations.
- Narrowing ignores bet size. Since Phase 3 it does adjust bluff and float shares per player.
- `advise()` uses fixed thresholds.
- Tournaments (ICM) aren't modelled.

## Open questions

- Which browser site the friends' tournament will use.
- Tournament tables: check that the adapter reads them the same way as cash tables (take a snapshot).

## Decision layer reference (strategy.js)

- `decide(ctx)`: uses the preflop logic when there's no board, otherwise the postflop EV logic. It returns `{ action, amount, tag, reason, equity, eqWhenCalled, foldEst, foldNeeded, options[] }`.
- `describe(d)`: one line for display, e.g. "RAISE to $90" or "BET $30 (⅓ pot)".
- **How postflop EV works:**
  - check = equity × realisation × pot
  - call = equity × realisation × (pot + call) − call
  - bet/raise = P(all fold) × pot + P(called) × (equity vs their *continuing* range × final pot − amount)
  - When an opponent continues, they continue with the strongest part of their range.
- **Tunable `MODEL`:**
  - Fold rate = 26% + 30% × (bet ÷ pot), capped at 78%. Add 6% on the river and 6% when facing a raise.
  - Realisation: IP 0.95, OOP 0.85, river 1.0.
  - If a bet beats check/call by less than 2% of the pot, the coach prefers the simpler line.
- **Per-opponent hook:** `villain.foldOverride` sets that player's fold rate. Phase 3 feeds real fold-to-bet stats into it.
- **Known limits:**
  - It looks one street ahead only: no multi-street plans, implied odds or reverse implied odds.
  - It doesn't model re-raises after your bet.
  - Multiway pots are approximated.
  - Tournaments (ICM) aren't modelled.
  - The charts are starter approximations.
