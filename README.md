# Live Odds Tracker

Live **NFL** and **MLB** odds — moneyline, spread/run line and total, fetched
from DraftKings and pushed to the browser as the lines move.

- **Live:** https://live-odds-tracker.onrender.com
- **Repo:** https://github.com/acandrewchow/live-odds-tracker

> The server polls DraftKings' `sportscontent` API once a second and pushes
> changes to the browser over SSE. A line moves at DraftKings and it is on the
> page in **~0.6 s**. No auth of any kind is involved: the Akamai gate is on
> request *shape*, so six headers turn a 403 into a 200, and there is no token
> that can expire

---

## Running it locally

```bash
npm install
npm run dev      # http://localhost:3000 -> /league/nfl
npm test       
npm run test:e2e 
```

Navigate to `http://localhost:3000` to view the Odds Board


| Variable | Default | |
|---|---|---|
| `DK_JURISDICTION` | `dkcaon` | Which of DraftKings' 31 licensed books to read |
| `DK_POLL_MS` | `1000` | Upstream poll interval. Lower is genuinely fresher, at proportionally more load. |
| `DK_ODDS_URL` | — | Overrides the endpoint, so the failure handling can be pointed at a deliberately broken server. |

---

## How it works

```
   DraftKings sportscontent API
        │  HTTP GET, 1/sec, browser-shaped headers
        │  full snapshot every time (~100 KB)
        ▼
   lib/draftkings.ts   fetch + tolerant mapping; skips bad records
        ▼
   lib/store.ts        per-league state
                       ├── single-flight   N callers -> 1 request
                       ├── 750 ms TTL      bounds the request rate
                       ├── price history   what moved, and when
                       └── backoff         1s→2s→5s→10s→15s
        ▼
   app/api/stream      SSE — push a frame ONLY when a price moved
   app/api/odds        snapshot — Refresh button + polling fallback
        ▼
   /league/nfl  ·  /league/mlb
```

DraftKings sends a full snapshot with no indication of what changed, so the difference
is ours. Thje store keeps the last price for every side and compares each poll.

| Route | |
|---|---|
| `/league/nfl`, `/league/mlb` | the board — prerendered, one per league |
| `/` | redirects to the first league in the registry |
| `/league/<anything else>` | **404** |
| `/api/odds?league=<slug>` | snapshot; `&force=1` for Refresh |
| `/api/stream?league=<slug>` | SSE |

```
app/
  league/[slug]/page.tsx    server: resolves slug, 404s on unknown
  league/[slug]/OddsBoard.tsx   client: table, arrows, staleness UI
  hooks/useOdds.ts          SSE subscription, polling fallback, age maths
  api/odds  ·  api/stream   snapshot and stream endpoints
lib/
  leagues.ts    registry — id, name, handicap-market label
  draftkings.ts upstream fetch + tolerant normalization
  store.ts      per-league cache, change detection, backoff
  movement.ts   which way a price moved
  age.ts        staleness without comparing clocks
```

### What DraftKings gives us, and what we return

Draftkings data response:

```jsonc
{ "events":     [{ "id": "34118255", ... }],
  "markets":    [{ "id": "2_84695698", "eventId": "34118255", "name": "Spread" }],
  "selections": [{ "marketId": "2_84695698", "label": "DEN Broncos",
                   "displayOdds": { "american": "−112", "decimal": "1.89", ... },
                   "points": 2.5, "outcomeType": "Away", "tags": [...] }] }
```

```jsonc
{
  "league": "nfl",
  "games": [{
    "home": "KC Chiefs", "away": "DEN Broncos",
    "status": "NOT_STARTED", "live": false,
    "markets": {
      "moneyline": { "sides": [
        { "label": "DEN Broncos", "odds": 110 },
        { "label": "KC Chiefs",   "odds": -130 }]},
      "spread": { "sides": [
        { "label": "DEN Broncos", "odds": -112, "line": 2.5 },
        { "label": "KC Chiefs",   "odds": -108, "line": -2.5 }]}
    }
  }],
  "fetchMs": 121,   // how long the last upstream pull took
  "ageMs": 3,       // age at serialization, server clock only
  "failures": 0     // > 0 means these are last-known-good prices
}
```

A live game adds `period`, `score`, and — on any side that moved — `prevOdds`
and `changedAt`.

[`examples/`](examples/) holds both sides of this: real DraftKings responses
(`draftkings-raw-nfl.json`, `draftkings-raw-mlb.json`) next to what the app
serves for the same games, so the mapping is legible without running anything.

---

## Why this approach

### The endpoint

```
https://sportsbook-nash.draftkings.com/api/sportscontent/{jurisdiction}/v1/leagues/{id}
```

The same endpoint DraftKings' own web client calls. The widely-cited legacy path
`/sites/US-SB/api/v5/eventgroups/88808` is dead — 403.

Its default response contains all 3 market selections that are needed (moneyline, spread, total
)
### Getting a successful request

A bare request returns a 403 `AkamaiGHost` page. These headers turn it into a
200:

```http
Origin: https://sportsbook.draftkings.com
Referer: https://sportsbook.draftkings.com/
Accept-Language: en-US,en;q=0.9
Sec-Fetch-Dest: empty   Sec-Fetch-Mode: cors   Sec-Fetch-Site: same-site
```

Gate is on a request shape, no cookie/token needed. DraftKings does set a `ak_bmsc` (Akami
bot Manager) ont he response, but we don't need it and it still receives 200s

No rate limit found. I ramped to 20 req/sec sustained and 30 concurrent — 230
requests, zero non-200s. That bounds any limit above 20× what this app does; it
does not prove there is none.

### SSE to the browser

SSE is an HTTP response that never ends. The server polls every second either
way, then pushes a frame **only when a price actually changed**. Real traffic:

```
+  0.0s  event: odds
+  0.0s  data: {"league":"nfl","games":[...]}   (8301 bytes)
+ 16.2s  : keep-alive
+ 31.9s  : keep-alive
+ 46.9s  : keep-alive
```

47 seconds: one 8.3 KB frame and three 14-byte comments. Client polling over the
same window would have sent ~47 requests and ~390 KB to say "nothing changed" 46
times.

A a page polling `/api/odds` every second would be nearly as fresh. It is one-directional, which is the shape of
this problem (the browser has nothing to say), it is plain HTTP so proxies pass
it through, and `EventSource` reconnects for free. A WebSocket would need a
protocol upgrade and hand-written reconnect logic to do less.

### One poller, many viewers

There is no rate limiter, just one timestamp and three gates. Upstream load is
flat in viewer count:

| Viewers | 0 | 1 | 2 | 5 | 20 |
|---|---|---|---|---|---|
| **req/s upstream** | **0** | 0.71 | 0.97 | 0.96 | 0.92 |

Twenty viewers cost the same as two, and an unwatched page costs nothing — the
poll interval only exists while an SSE client is connected.

Single-flight collapses *concurrent* callers onto one fetch; a 750 ms TTL stops
*sequential* ones. Both are needed, which a bug proved: `?force=1` originally
skipped the TTL, so hammering Refresh for 11 seconds issued **70,419 upstream
requests**. `force` now lowers the freshness bar to 500 ms instead of removing
it — same hammering now costs **20**.

### Render, not Vercel

It was on Vercel first. DraftKings blocks it.

```
local machine  ->  DraftKings    HTTP 200, 84,851 bytes
Vercel        ->  DraftKings    HTTP 403
Render        ->  DraftKings    HTTP 200, 16 games, 0 failures
```

Same code, same headers, same minute. The 403 body is Akamai's **edge ACL** page
— a flat refusal by IP range — not a bot-manager challenge. The block is on
*where the request comes from*: cloud egress ranges are denylisted, residential
ones are not. Fetching from the browser instead is not an option either, since
DraftKings replies `access-control-allow-origin: https://sportsbook.draftkings.com`

---

## How fresh the odds are

Measured against a live game, 60 consecutive polls at 1 Hz:

| | |
|---|---|
| Upstream fetch | **p50 108 ms**, p95 337 ms |
| **Age on screen** | **~0.6 s average, ~1.3 s worst** |
| Failures in 60 polls | 0 |
| Odds changes observed | 11 in 60 s |

```
  DraftKings reprices  ●
                       │  0–1000 ms   waiting for the next poll tick  ← ~90%
                       │  ~110 ms     fetch + parse + normalize
                       │  <1 ms       diff, push only if something moved
                       ▼
  on screen            ●  ~0.6 s
```

The response carries `cache-control: max-age=1`, which looks like a one-second floor. I
polled at 10 Hz through a live 4th quarter and bucketed responses by the second
in their `date` header:

```
seconds observed:                             21
seconds containing >1 distinct price state:    6   <- prices change WITHIN a second
```

Responses are origin-fresh per request, and `DK_POLL_MS=500` halves
the age on screen at roughly double the load. Tested at 1 Hz because doubling
upstream traffic to save 0.25 s is a poor trade, and a lower rate keeps distance
from the bot protection above.

A a live "updated 0.4s ago" counter and the measured upstream round-trip. That age is
computed without ever comparing the server's clock to the browser's — the server
sends how old the data was when it serialized, the client adds how long since it
arrived, and skew cancels. The naive version (`Date.now() - lastSuccessAt`) puts
a viewer whose clock is a minute fast under a permanent stale banner over
perfectly fresh odds.

---

## When DraftKings misbehaves

| Upstream behavior | What happens |
|---|---|
| Unreachable / DNS failure | Last good prices stay up under a banner naming the error |
| Non-200 (403, 5xx) | Same, plus backoff 1s→2s→5s→10s→15s |
| 200 with HTML or truncated JSON | Treated as failure, same degraded path |
| Valid JSON, unexpected records | Bad records skipped individually — one broken game costs that game, not the slate |
| No games offered | Explicit empty state |
| Stream drops | `EventSource` reconnects; after 3 failures, falls back to polling |

Every mode above was tested against the running app by pointing
`DK_ODDS_URL` at a deliberately broken server

---
