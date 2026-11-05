# dickreuter/poker + Poker Coach brain

This plugs this project's decision layer (`strategy.js`, opponent ranges, EV of every bet size)
into [dickreuter/poker](https://github.com/dickreuter/poker), the "DeeperMind" bot. You keep
dickreuter's screen scraper, table mapping and mouse control. Only the decisions change.

**Use it only in the friends' tournament where everyone has agreed to AI play, and only on a site
whose terms allow it.** Never use it on PokerStars, GGPoker, PartyPoker or any real-money site.

## What changes

| | dickreuter's own logic | With the coach brain |
|---|---|---|
| Preflop | Excel sheet of call/raise probabilities by position | Position charts: open, iso-raise, 3-bet for value or as a bluff, set-mine, BB defence, push/fold at 12bb or less |
| Opponents | Not modelled; equity vs N random-ish hands | A range for each opponent from what they did (opened, called, 3-bet, limped), narrowed on every postflop bet |
| Bet sizing | Fixed thresholds pick one of: min, half pot, pot | Compares EV of check / call / ⅓ / ½ / ¾ / pot / raises / all-in, then clicks the closest button the table has |
| Bluffing | Bluff if equity sits in a min–max band | Bluffs only when the fold % needed is below the fold % expected for that size |
| Opponents' names and stacks | Not read during play (name reading is switched off, only your own stack is read) | Read from the name and stack areas you mark in the table setup. Each player's stats are learned across sessions (`~/poker/local-db/players.json`) and shape their range, bluff and fold estimates. One misread letter is matched to the same player |
| River play heads-up | Same thresholds as every other street | A CFR+ solver (`solver.js`) works out the balanced strategy for both ranges at 3 bet sizes plus all-in, then plays your hand's mix |
| Fast fold | Clicks Fold by itself for any preflop hand missing from its sheet, before the decision maker runs | Off, so the coach sees every hand |
| Card sharing ("collusion") | **On by default**: uploads your hole cards to the DeeperMind server and uses other bots' cards | **Forced off** by the installer |
| Where your data goes | Tables, screenshots, strategies and every round played are sent to dickreuter.com, and the bot won't start if that server says there's a newer version. A screenshot server on port 8005 lets deepermind-pokerbot.com fetch pictures of your screen from your browser | **Nothing leaves your PC.** `local_server.py` answers the same requests on 127.0.0.1 and keeps everything in `~/poker/local-db/pokerbot.sqlite` |
| Hand log | Uploaded to dickreuter.com | `~/poker/logs/coach_decisions.csv` (one row per decision) plus the results database; `report.py` summarises both |

If the brain errors (unreadable cards, Node missing), that one decision falls back to dickreuter's
original logic, so the bot never stalls.

The installer also fixes a crash in dickreuter itself: its curve fitting passes plain lists to lmfit,
which lmfit 1.3+ rejects, so every decision failed with "can only concatenate list".

## How it learns opponents

dickreuter only shows the table when it's your turn, so the brain rebuilds each hand from what it
saw at each of your turns: the chips in front of everyone, what you did, and who still had cards.
A player who had cards and later didn't, folded. If a hand ends right after your flop or turn bet,
whoever was left folded (a call would have given you another turn). On the river, your stack at
the start of the next hand tells a fold from a call. Each finished hand updates the player's VPIP,
PFR, 3-bet, aggression and fold-to-bet, the same stats as the Torn overlay's tracker.

For names to be read, mark **player_name_area** for each seat in dickreuter's table setup (and
**player_funds_area**, for their stacks). Without them everyone is "Seat 3" etc. and nothing is learned.

## Simulator: is it actually better?

`sim/run_sim.py` plays the coach against dickreuter's real decision maker at a 6-max table. Both
run dickreuter's full pipeline (table checks, Monte Carlo, Decision, buttons); only the decision
maker differs. Every deck is dealt twice with the players moved one seat, so both bots get the same
cards in the same spots.

```
python sim/run_sim.py --hands 1000                       # coach vs dickreuter
python sim/run_sim.py --hands 1000 --lineup coach,coachns  # river solver on vs off
python sim/run_sim.py --hands 500 --lineup coach,station   # vs a calling station
```

dickreuter's real strategies lived on its server, so its side plays the `Default` strategy from
`local_server.py` (thresholds chosen to be sensible, not tuned) plus its own preflop sheet.

## Install

On Windows, the easy way is `windows/setup.bat`: it installs everything, runs the tests and puts
**Start Poker Bot** and **Poker Bot Report** on your desktop. The manual steps:

1. Get dickreuter running first (Windows only, per their readme), with a table mapped for your site.
2. Install Node.js 18+ and clone this repo next to it.
3. Run the installer once:
   ```
   python integrations/dickreuter/install.py C:\path\to\dickreuter\poker
   set POKER_COACH_BRAIN=C:\path\to\poker_bot\integrations\dickreuter\brain.js
   ```
4. Start the local database (`python local_server.py --dickreuter C:\path\to\dickreuter\poker`), then
   start dickreuter. Leave **auto-act unticked** for the first session: it shows each decision and
   waits for Enter, so you can check the brain is reading the table correctly. The log shows lines like
   `Coach: RAISE to $6 [VALUE] — … → button Bet half pot`.

## Your data and the report

- `~/poker/local-db/pokerbot.sqlite`: table mappings, strategies, every round and every finished hand.
- `~/poker/logs/coach_decisions.csv`: every coach decision (cards, board, pot, action, size, tag, equity, EV, button clicked).
- `python report.py` (or **Poker Bot Report** on the desktop): hands, net result, bb/100, results by position,
  by street and by the coach's last action, the biggest losses, and `hands.csv` for Excel or SQL.

Set the blinds for your game in dickreuter's strategy editor (bigBlind / smallBlind): the coach reads them from there.

## Settings

- `POKER_COACH_POT_INCLUDES_BETS=0` if your table's "total pot" doesn't include the chips in front
  of players this street. Most clients' totals do (the default).
- `POKER_COACH_NODE` if `node` isn't on your PATH.

## Known limits

- dickreuter doesn't read an action log, so the action history is rebuilt from the chips in front of
  each player. Bet and raise sizes are right; a bet made after you last acted on an earlier street
  can be missed.
- Player names aren't read (dickreuter has name OCR switched off), so `tracker.js` can't learn
  individual opponents yet. Everyone is treated as an average casual player.
- Sizes are snapped to the table's buttons (min, ½ pot, pot, all-in). A ¾-pot plan becomes pot or ½ pot.
- Not yet measured head-to-head against dickreuter's own strategies.
- Tables start empty: there are no pre-made mappings, because those lived on dickreuter's server.

## Tests

```
python3 integrations/dickreuter/test_coach_decision.py   # bridge, logging, report, installer
python3 integrations/dickreuter/test_local_server.py     # dickreuter's real client code against the local database
```
Covers state conversion, decisions through `brain.js`, button mapping, the fallback, and the
installer against a real dickreuter checkout (set `DICKREUTER_DIR` if it isn't at `../dickreuter/poker`).
