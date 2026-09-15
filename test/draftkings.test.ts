import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type IncomingHttpHeaders } from "node:http";
import { dkUrl, fetchOdds } from "../lib/draftkings.ts";
import type { League } from "../lib/leagues.ts";

const league: League = { slug: "nfl", id: "88808", name: "NFL", spreadLabel: "Spread" };

const body = JSON.stringify({
  events: [
    {
      id: "1",
      startEventDate: "2026-09-14T17:00:00Z",
      status: "NOT_STARTED",
      participants: [
        { name: "KC Chiefs", venueRole: "Home", metadata: { shortName: "KC" } },
        { name: "DEN Broncos", venueRole: "Away", metadata: { shortName: "DEN" } },
      ],
    },
  ],
  markets: [{ id: "m1", eventId: "1", name: "Moneyline" }],
  selections: [
    { id: "s1", marketId: "m1", label: "DEN Broncos", outcomeType: "Away", displayOdds: { american: "+110" } },
    { id: "s2", marketId: "m1", label: "KC Chiefs", outcomeType: "Home", displayOdds: { american: "−130" } },
  ],
});

let server: Server;
let received: IncomingHttpHeaders = {};
let mode: "ok" | "503" | "html" | "slow" = "ok";

before(async () => {
  server = createServer((req, res) => {
    received = req.headers;
    if (mode === "503") return void res.writeHead(503).end("down");
    if (mode === "html") return void res.writeHead(200, { "Content-Type": "text/html" }).end("<html/>");
    if (mode === "slow") return; // never responds — exercises the abort timeout
    res.writeHead(200, { "Content-Type": "application/json" }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, r));
  process.env.DK_ODDS_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
});

after(async () => {
  delete process.env.DK_ODDS_URL;
  await new Promise<void>((r) => server.close(() => r()));
});

test("sends the headers that get past Akamai", async () => {
  mode = "ok";
  await fetchOdds(league);
  assert.equal(received.origin, "https://sportsbook.draftkings.com");
  assert.equal(received.referer, "https://sportsbook.draftkings.com/");
  assert.equal(received["sec-fetch-dest"], "empty");
  assert.equal(received["sec-fetch-mode"], "cors");
  assert.equal(received["sec-fetch-site"], "same-site");
  assert.match(String(received["accept-language"]), /en-US/);
  assert.match(String(received["user-agent"]), /Mozilla/);
});

test("sends no cookie, because none is required", async () => {
  mode = "ok";
  await fetchOdds(league);
  assert.equal(received.cookie, undefined);
});

test("returns normalized games and a measured duration", async () => {
  mode = "ok";
  const { games, fetchMs } = await fetchOdds(league);
  assert.equal(games.length, 1);
  assert.equal(games[0].away, "DEN Broncos");
  assert.deepEqual(
    games[0].markets.moneyline?.sides.map((s) => s.odds),
    [110, -130],
  );
  assert.ok(fetchMs >= 0 && fetchMs < 5_000, `implausible fetchMs ${fetchMs}`);
});

test("a non-200 throws with the status in the message", async () => {
  mode = "503";
  await assert.rejects(() => fetchOdds(league), /HTTP 503/);
});

test("a 200 carrying HTML is treated as a failure, not empty odds", async () => {
  mode = "html";
  await assert.rejects(() => fetchOdds(league), /non-JSON/);
});

test("a hanging upstream aborts instead of blocking forever", async () => {
  mode = "slow";
  const started = Date.now();
  await assert.rejects(() => fetchOdds(league));
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 6_000, `took ${elapsed}ms — the abort timeout did not fire`);
});

test("dkUrl carries the league through, override or not", async () => {
  const withOverride = dkUrl("84240");
  assert.match(withOverride, /league=84240/);

  delete process.env.DK_ODDS_URL;
  const real = dkUrl("84240");
  assert.match(real, /sportsbook-nash\.draftkings\.com/);
  assert.match(real, /\/leagues\/84240$/);
  process.env.DK_ODDS_URL = withOverride.split("?")[0];
});
