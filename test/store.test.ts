import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { fingerprint, getSnapshot } from "../lib/store.ts";
import type { League } from "../lib/leagues.ts";

let n = 0;
const freshLeague = (): League => ({
  slug: `test-${n++}` as League["slug"],
  id: String(1000 + n),
  name: "Test",
  spreadLabel: "Spread",
});

const prices = new Map<string, number>();
let hits = 0;
let server: Server;

const payload = (leagueId: string) => ({
  events: [
    {
      id: "1",
      startEventDate: "2026-09-14T17:00:00Z",
      status: "NOT_STARTED",
      participants: [
        { name: "Home", venueRole: "Home", metadata: { shortName: "H" } },
        { name: "Away", venueRole: "Away", metadata: { shortName: "A" } },
      ],
    },
  ],
  markets: [{ id: "m1", eventId: "1", name: "Moneyline" }],
  selections: [
    { id: "s1", marketId: "m1", label: "Away", outcomeType: "Away",
      displayOdds: { american: String(prices.get(leagueId) ?? -110) } },
    { id: "s2", marketId: "m1", label: "Home", outcomeType: "Home",
      displayOdds: { american: "+100" } },
  ],
});

before(async () => {
  server = createServer((req, res) => {
    hits++;
    const id = new URL(req.url ?? "", "http://x").searchParams.get("league") ?? "0";
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(payload(id)));
  });
  await new Promise<void>((r) => server.listen(0, r));
  process.env.DK_ODDS_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
});

after(async () => {
  delete process.env.DK_ODDS_URL;
  await new Promise<void>((r) => server.close(() => r()));
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const awayOdds = (s: Awaited<ReturnType<typeof getSnapshot>>) =>
  s.games[0].markets.moneyline!.sides[0];

test("concurrent callers share one upstream request", async () => {
  const league = freshLeague();
  const before = hits;
  await Promise.all(Array.from({ length: 20 }, () => getSnapshot(league)));
  assert.equal(hits - before, 1, "single-flight did not collapse the callers");
});

test("a second call inside the TTL is served from cache", async () => {
  const league = freshLeague();
  await getSnapshot(league);
  const before = hits;
  await getSnapshot(league);
  assert.equal(hits - before, 0, "refetched inside the TTL");
});

test("a forced refresh still respects a floor", async () => {
  const league = freshLeague();
  await getSnapshot(league, { force: true });
  const before = hits;
  // force lowers the freshness bar to 500ms; it does not remove it, or the
  // Refresh button becomes an unbounded load amplifier on DraftKings.
  for (let i = 0; i < 25; i++) await getSnapshot(league, { force: true });
  assert.equal(hits - before, 0, `${hits - before} forced refetches inside the floor`);
});

test("first sighting of a price is not reported as a move", async () => {
  const league = freshLeague();
  const snap = await getSnapshot(league);
  assert.equal(awayOdds(snap).prevOdds, undefined);
  assert.equal(awayOdds(snap).changedAt, undefined);
});

test("a moved price reports its previous value", async () => {
  const league = freshLeague();
  await getSnapshot(league);
  prices.set(league.id, -125);
  await sleep(800); // age past the TTL so the next call actually refetches
  const snap = await getSnapshot(league);
  assert.equal(awayOdds(snap).odds, -125);
  assert.equal(awayOdds(snap).prevOdds, -110);
  assert.ok((awayOdds(snap).changedAt ?? 0) > 0);
});

test("the previous price is carried forward, not dropped on the next poll", async () => {
  const league = freshLeague();
  await getSnapshot(league);
  prices.set(league.id, -125);
  await sleep(800);
  await getSnapshot(league); // the poll that observes the move
  await sleep(800);
  const later = await getSnapshot(league); // a poll where nothing changed
  // Without carry-forward "was -110" would be visible for a single second and
  // no viewer would ever see it.
  assert.equal(awayOdds(later).prevOdds, -110, "prevOdds dropped after one poll");
});

test("snapshots carry a server-computed age and no failures when healthy", async () => {
  const league = freshLeague();
  const snap = await getSnapshot(league);
  assert.equal(snap.league, league.slug);
  assert.equal(snap.failures, 0);
  assert.equal(snap.error, undefined);
  assert.ok(snap.ageMs >= 0 && snap.ageMs < 5_000, `implausible ageMs ${snap.ageMs}`);
});

test("fingerprint changes only when a price changes", async () => {
  const league = freshLeague();
  const first = fingerprint(await getSnapshot(league));
  await sleep(800);
  assert.equal(fingerprint(await getSnapshot(league)), first, "fingerprint moved on its own");

  prices.set(league.id, -140);
  await sleep(800);
  assert.notEqual(fingerprint(await getSnapshot(league)), first, "fingerprint missed a real move");
});

test("leagues keep separate state", async () => {
  const a = freshLeague();
  const b = freshLeague();
  prices.set(a.id, -200);
  prices.set(b.id, +300);
  const [sa, sb] = await Promise.all([getSnapshot(a), getSnapshot(b)]);
  assert.equal(awayOdds(sa).odds, -200);
  assert.equal(awayOdds(sb).odds, 300);
  assert.notEqual(sa.league, sb.league);
});
