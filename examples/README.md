# Example responses

Real payloads, not hand-written. The raw files are unmodified DraftKings
responses trimmed to a single event; the normalized ones are what this app
serves, generated from the fixtures in `test/fixtures/`.

Read them in pairs — the point is the difference between them.

| File | |
|---|---|
| `draftkings-raw-nfl.json` | What DraftKings returns. Three flat arrays joined by id, odds as strings. |
| `api-odds-response.json` | What `GET /api/odds?league=nfl` returns for the same kind of game. |
| `draftkings-raw-mlb.json` | Same, for MLB — note the handicap market is **`Run Line`**, not `Spread`. |
| `api-odds-response-live.json` | An in-progress game, so it also carries `period`, `score`, and a price that moved (`prevOdds` / `prevLine` / `changedAt`). |

## What the mapping does

```
DraftKings                              this app
─────────────────────────────────────   ─────────────────────────────────
events[]  markets[]  selections[]       games[] -> markets -> sides
  joined by eventId / marketId            already nested
"american": "−112"   (string, U+2212)   "odds": -112   (number)
+ decimal, fractional, percentage,      dropped
  trueOdds, sortOrder, tags,
  participants, subscriptionKey
~119 KB per response                    ~8 KB
```

Three things worth noticing in the raw files:

1. **Nothing is nested.** A selection points at a market by `marketId`, and that
   market points at an event by `eventId`. You do the joining.
2. **`"american": "−112"` uses U+2212 MINUS SIGN**, not an ASCII hyphen.
   `Number("−112")` is `NaN`, which silently deletes every favourite from the
   board. There is a regression test for exactly this.
3. **The handicap market is named per sport.** NFL says `Spread`, MLB says
   `Run Line`, NHL says `Puck Line`. Matching only on `"Spread"` leaves MLB
   rendering a blank column that looks like DraftKings not offering the market —
   and nothing throws.

The full untrimmed responses live in `test/fixtures/` and back the end-to-end
suite, which runs offline against a stand-in DraftKings.
