# Example responses

| File | Shows |
|---|---|
| `api-odds-response.json` | `GET /api/odds?league=nfl` — a scheduled game. The base shape. |
| `api-odds-response-live.json` | `GET /api/odds?league=mlb` — an in-progress game, so it also carries `period`, `score`, and a price that has moved (`prevOdds` / `prevLine` / `changedAt`). |

Both are trimmed to the first game or two. Real response carries the whole
slate. Regenerate them by pointing `DK_ODDS_URL` at a server that serves the
fixtures and reading `/api/odds`.
