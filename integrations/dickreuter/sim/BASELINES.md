# Simulator baselines

The coach's result against casual human-like players (`humans.py`), per table size, so a gain in one
format can't hide a loss in another. Re-run these after any strategy change and compare on the
same seed (the decks are identical, so compare deck by deck).

```
python run_sim.py --hands 800 --seats N --lineup humans --seed 21 --physical-seats 9 --no-learn
```

Try a setting without editing code: `POKER_COACH_MODEL='{"exploit":{"elastic":true}}' python run_sim.py ...`

Cash game, 100bb, stacks topped up every hand. Every deck is played once from every seat. With
`--physical-seats 9` the coach sees a 9-seat table where the spare seats are empty or sitting out
with chips, which tests the dealt-in / position logic as well.

## 6 Nov 2026 (branch dickreuter-brain)

| Table | Hands | Coach bb/100 | Opponents |
|---|---|---|---|
| Heads-up | 10,000 | **+54.4 ± 11.5** | rec |
| 3-handed | 2,400 | +59.3 ± 38.8 | rec, fish |
| 4-handed | 3,200 | +81.7 ± 35.4 | rec, fish, tag |
| 6-handed | 4,800 | +83.1 ± 37.0 | rec, fish, tag, nit, maniac |
| 9-handed | 7,200 | +153.7 ± 44.0 | two each of rec, fish, tag, nit + maniac, station |

## Changes tested (same decks, paired)

| Change | Table | Result | Kept? |
|---|---|---|---|
| Hand-aware equity realisation (out of position) | 6-handed | −5.9 ± 27.0 | off |
| No betting into the preflop raiser out of position | 6-handed | −19.7 ± 26.7 | off |
| Both together | 6-handed | −22.3 ± 27.5 | off |
| Heads-up button opens 80% (was the 47% 6-max button range) | heads-up | **+17.8 ± 13.1** | on |
| 9-handed UTG opens 10% (was 13%) | 9-handed | −3.2 ± 43.3 (no change) | on |

| Each player's fold rate rises with bet size by their own fold-to-bet (callers barely change) | 6-handed, learning on | −23.0 ± 31.2 | off (`exploit.elastic`) |
| 1.5× pot overbets added | 6-handed, learning on | −25.4 ± 32.4 | off (`exploit.overbets`) |
| Unknown players fold only a little more to bigger bets (fold slope 0.30 → 0.15) | 6-handed, 100bb | +13.4 ± 23.9 | on |
| Stack depth preflop (fold small suited connectors to raises ≤ 40bb; call more of them in position ≥ 150bb) | 6-handed, 40bb / 200bb | +5.9 ± 11.5 / +24.4 ± 40.3 | on |
| Both together | 6-handed 100bb / heads-up / 9-handed | +0.5 ± 24.6 / +8.7 ± 17.5 / +4.3 ± 39.7 | on |

### Stack depth (6-handed, same table, 4,800 hands each)

| Everyone's stack | Coach bb/100 |
|---|---|
| 40bb | +33 ± 17 |
| 100bb | +66 ± 34 |
| 200bb | +116 ± 53 |

Deeper is better against weaker players (more room for their mistakes), with bigger swings.

### Better measuring (6 Nov, later)

- All-in-before-the-river hands are scored by equity (`--luck ev`, the default): each player gets
  their share of the pot over every way the board could have come.
- The coach's equity sampling and the humans' dice are seeded by the deck and the spot, so two
  versions face identical decisions until their play differs.
- `--workers N` splits the decks across CPU cores. `compare.py a.csv b.csv` compares two runs.

The same coach run twice now differs by ±0.3 bb/100 (it used to be up to ±20). Two different
versions at 1,500 decks (9,000 hands): about ±8 bb/100 at 100bb, ±4 at 40bb, ±17 at 200bb,
roughly 3× tighter than before, so about 9× fewer hands for the same certainty.

Re-tests with it (6-handed, 1,500 decks):

| Change | Result | Verdict |
|---|---|---|
| Fold slope 0.30 → 0.15 (kept earlier at +13.4 ± 23.9) | −1.2 ± 8.0 | no real effect; the earlier gain was luck |
| Stack-depth preflop at 40bb | −0.4 ± 3.6 | no effect at 40bb |
| Stack-depth preflop at 200bb | +10.9 ± 17.2 | probably helps; kept |

**The old noise floor (before the change above):** about ±20 bb/100 even at 15,000 hands, because two versions stop playing
identical hands after their first different decision. Changes smaller than that can't be proven
here. The two kept changes never lost at any table size and match standard poker theory, so they
stay on; they aren't proven gains.

The out-of-position ideas lost against humans: casual players don't c-bet reliably, so checking to
them gives free cards. They lost money against dickreuter's own bot too before, for other reasons.
Both stay in `strategy.js` (`MODEL.realiseHand.on`, `MODEL.noDonk`) for later tuning.

The human styles are guesses from what's written about low-stakes player pools. Once the tracker
has 40+ hands on enough Torn players, `humans.calibrate_from_tracker()` turns their real numbers
into a "torn" style.

## Fixes from Torn hands (6 Nov, evening)

Two big losses at 25k blinds: Q9 trips shoved over a river lead (−252 bb; calling was right) and
88 turned into a river bluff-raise of a small bet (−32 bb). Changes:

- `mdfCap` 1.5: folds to a bet are capped at 1.5 × bet/(pot after the bet), so a small bet or raise
  isn't expected to fold out a quarter of hands.
- `raiseCallShare` 0.6 on the river (`raiseCallStreets`): when we raise someone who bet the river,
  their calls come from the strongest 60% of what the straight fold cut would keep.
- `bluffMargin` 0.10: a raise that's really a bluff must beat calling by 10% of the pot.

| Test (6-handed unless noted, 1,500 decks, same seed) | Change vs without |
|---|---|
| All three, tighter calls on every street | −15.3 ± 15.9 (heads-up −3.1 ± 9.2, 9-handed −13.6 ± 14.2) |
| mdfCap alone | −3.1 ± 9.6 |
| raiseCallShare alone, every street | −11.7 ± 12.9 |
| bluffMargin alone | −2.9 ± 9.7 |
| **All three, tighter calls on the river only (kept)** | **−3.9 ± 11.4** |

Neutral in the simulator and both real hands now play right. The simulated humans call raises
with top pair a lot, which is why tighter calling ranges on earlier streets cost here.
