import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { AppServer, FakeDraftKings, readSse } from "./harness.ts";
import type { Game, Side, Snapshot } from "../../lib/types.ts";

async function getJson<T>(url: string): Promise<T> {
  return (await fetch(url)) .json() as Promise<T>;
}

const dk = new FakeDraftKings();
const app = new AppServer();
let base = "";

before(async () => {
  await dk.start();
  await app.start({
    DK_ODDS_URL: `http://127.0.0.1:${dk.port}/`,
    DK_POLL_MS: "1000",
  });
  base = app.base;
}, { timeout: 90_000 });

after(async () => {
  await app.stop();
  await dk.stop();
});

describe("routing", () => {
  test("/ redirects to the first league", async () => {
    const res = await fetch(`${base}/`, { redirect: "manual" });
    assert.equal(res.status, 307);
    assert.match(res.headers.get("location") ?? "", /\/league\/nfl$/);
  });

  test("each league route renders its own page", async () => {
    for (const [slug, name] of [["nfl", "NFL"], ["mlb", "MLB"]]) {
      const res = await fetch(`${base}/league/${slug}`);
      assert.equal(res.status, 200, slug);
      const html = await res.text();
      assert.match(html, new RegExp(`<title>[^<]*${name}[^<]*</title>`), slug);
    }
  });

  test("an unknown league is a 404, not a silent fallback", async () => {
    for (const slug of ["nhl", "unknowon_league"]) {
      assert.equal((await fetch(`${base}/league/${slug}`)).status, 404, slug);
    }
  });
});

describe("api contract", () => {
  test("league is required", async () => {
    const res = await fetch(`${base}/api/odds`);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string; supported: string[] };
    assert.match(body.error, /Missing required/);
    assert.deepEqual(body.supported, ["nfl", "mlb"]);
  });

  test("an unknown league is rejected rather than defaulted", async () => {
    const res = await fetch(`${base}/api/odds?league=nhl`);
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /Unknown league/);
  });

  test("a snapshot has the shape the UI needs", async () => {
    const res = await fetch(`${base}/api/odds?league=nfl`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");

    const snap = (await res.json()) as Snapshot;
    assert.equal(snap.league, "nfl");
    assert.equal(snap.failures, 0);
    assert.ok(snap.games.length > 0, "expected games");
    assert.ok(snap.ageMs >= 0, "ageMs must be server-computed, not negative");

    const game = snap.games[0];
    assert.ok(game.home && game.away, "teams");
    assert.ok(Date.parse(game.startsAt), "parseable start time");
    for (const kind of ["moneyline", "spread", "total"] as const) {
      const market = game.markets[kind];
      assert.ok(market, `missing ${kind}`);
      assert.equal(market.sides.length, 2, `${kind} should have two sides`);
      for (const side of market.sides) {
        assert.equal(typeof side.odds, "number");
        assert.ok(Number.isFinite(side.odds), `non-finite odds in ${kind}`);
      }
    }
  });

  test("MLB's Run Line lands in the spread column", async () => {
    const snap = await getJson<Snapshot>(`${base}/api/odds?league=mlb`);
    assert.equal(snap.league, "mlb");
    const missing = snap.games.filter((g: Game) => !g.markets.spread);
    assert.equal(missing.length, 0, "every MLB game should have a run line");
  });

  test("moneyline has no handicap, spread and total do", async () => {
    const snap = await getJson<Snapshot>(`${base}/api/odds?league=nfl`);
    const g = snap.games[0];
    assert.ok(g.markets.moneyline?.sides.every((s: Side) => s.line === undefined));
    assert.ok(g.markets.spread?.sides.every((s: Side) => typeof s.line === "number"));
    assert.ok(g.markets.total?.sides.every((s: Side) => typeof s.line === "number"));
  });
});

describe("streaming", () => {
  test("the stream serves event-stream and delivers a snapshot", async () => {
    const { frames, contentType } = await readSse(`${base}/api/stream?league=nfl`, { want: 1 });
    assert.match(contentType ?? "", /text\/event-stream/);
    assert.equal(frames.length, 1);
    assert.equal((frames[0] as Snapshot).league, "nfl");
  });

  test("streams are per league and do not cross over", async () => {
    const [nfl, mlb] = await Promise.all([
      readSse(`${base}/api/stream?league=nfl`, { want: 1 }),
      readSse(`${base}/api/stream?league=mlb`, { want: 1 }),
    ]);
    assert.equal((nfl.frames[0] as Snapshot).league, "nfl");
    assert.equal((mlb.frames[0] as Snapshot).league, "mlb");
  });

  test("the stream requires a league too", async () => {
    assert.equal((await fetch(`${base}/api/stream`)).status, 400);
  });
});

describe("upstream load is bounded", () => {
  test("concurrent callers collapse onto one upstream request", async () => {
    const mark = dk.mark();
    await Promise.all(
      Array.from({ length: 20 }, () => fetch(`${base}/api/odds?league=nfl`)),
    );
    assert.ok(
      dk.since(mark) <= 1,
      `20 concurrent requests caused ${dk.since(mark)} upstream fetches`,
    );
  });

  test("hammering Refresh cannot amplify load upstream", async () => {
    const mark = dk.mark();
    const started = Date.now();
    let clicks = 0;
    while (Date.now() - started < 3000) {
      await fetch(`${base}/api/odds?league=nfl&force=1`);
      clicks++;
    }
    const seconds = (Date.now() - started) / 1000;
    const upstream = dk.since(mark);

    assert.ok(clicks > 100, `expected a real hammering, got ${clicks} clicks`);
    // force floor is 500ms at DK_POLL_MS=1000, so at most ~2/sec plus slack.
    assert.ok(
      upstream <= Math.ceil(seconds / 0.5) + 2,
      `${clicks} clicks produced ${upstream} upstream requests in ${seconds}s`,
    );
  });

  test("polling one league does not fetch the other", async () => {
    await fetch(`${base}/api/odds?league=mlb`); // prime
    const mark = dk.mark();
    for (let i = 0; i < 5; i++) {
      await fetch(`${base}/api/odds?league=nfl`);
      await new Promise((r) => setTimeout(r, 200));
    }
    const nflSnap = await getJson<Snapshot>(`${base}/api/odds?league=nfl`);
    const mlbSnap = await getJson<Snapshot>(`${base}/api/odds?league=mlb`);
    assert.ok(dk.since(mark) > 0, "sanity: NFL should have refetched");
    // Separate cache clocks prove the stores are genuinely independent.
    assert.notEqual(nflSnap.lastSuccessAt, mlbSnap.lastSuccessAt);
  });
});

describe("degrades instead of breaking the entire system", () => {
  const resetToHealthy = async () => {
    dk.mode = "ok";
    const deadline = Date.now() + 30_000;
    let snap = await getJson<Snapshot>(`${base}/api/odds?league=nfl`);
    while (snap.failures > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      snap = await getJson<Snapshot>(`${base}/api/odds?league=nfl&force=1`);
    }
    assert.equal(snap.failures, 0, "could not return the store to a healthy state");
    return snap;
  };

  /** Break the upstream and wait until the app has actually observed it. */
  const whenUpstream = async (mode: typeof dk.mode) => {
    dk.mode = mode;
    const deadline = Date.now() + 20_000;
    let snap = await getJson<Snapshot>(`${base}/api/odds?league=nfl&force=1`);
    while (snap.failures === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 400));
      snap = await getJson<Snapshot>(`${base}/api/odds?league=nfl&force=1`);
    }
    return snap;
  };

  after(() => {
    dk.mode = "ok";
  });

  for (const [mode, expected] of [
    ["503", /HTTP 503/],
    ["html", /non-JSON/],
    ["truncated", /non-JSON/],
  ] as const) {
    test(`upstream ${mode}: still 200, last good prices kept, error surfaced`, async () => {
      const before = await resetToHealthy();
      assert.ok(before.games.length > 0, "sanity: primed with real data");

      const snap = await whenUpstream(mode);
      assert.ok(snap.failures > 0, `expected failures for ${mode}`);
      assert.ok(snap.error, "a failing upstream must surface an error string");
      assert.match(snap.error, expected, `wrong error for mode "${mode}": ${snap.error}`);
      // The whole point: the page keeps showing what it had.
      assert.equal(snap.games.length, before.games.length, "last good data lost");
      assert.equal(snap.lastSuccessAt, before.lastSuccessAt, "success clock moved on failure");

      dk.mode = "ok";
    });
  }

  test("backoff stops a dead upstream from being hammered", async () => {
    await resetToHealthy();
    dk.mode = "503";
    await fetch(`${base}/api/odds?league=nfl&force=1`); 

    const mark = dk.mark();
    const started = Date.now();
    while (Date.now() - started < 3000) {
      await fetch(`${base}/api/odds?league=nfl&force=1`);
    }
    assert.ok(
      dk.since(mark) <= 4,
      `backoff let ${dk.since(mark)} requests through in 3s`,
    );
    dk.mode = "ok";
  });

  test("recovers once the upstream comes back", async () => {
    await resetToHealthy();
    const broken = await whenUpstream("503");
    assert.ok(broken.failures > 0, "sanity: upstream should be failing");

    const snap = await resetToHealthy();
    assert.equal(snap.error, undefined);
    assert.ok(snap.games.length > 0);
  });
});
