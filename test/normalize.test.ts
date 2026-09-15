import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize } from "../lib/draftkings.ts";

const game = (over: Record<string, unknown> = {}) => ({
  events: [
    {
      id: "1",
      startEventDate: "2026-09-14T17:00:00Z",
      status: "NOT_STARTED",
      participants: [
        { name: "BUF Bills", venueRole: "Home", metadata: { shortName: "BUF" } },
        { name: "DET Lions", venueRole: "Away", metadata: { shortName: "DET" } },
      ],
    },
  ],
  markets: [{ id: "m1", eventId: "1", name: "Moneyline" }],
  selections: [
    { id: "s1", marketId: "m1", label: "DET Lions", outcomeType: "Away", displayOdds: { american: "+184" } },
    { id: "s2", marketId: "m1", label: "BUF Bills", outcomeType: "Home", displayOdds: { american: "−247" } },
  ],
  ...over,
});

test("maps a game to the clean shape", () => {
  const [g] = normalize(game());
  assert.equal(g.away, "DET Lions");
  assert.equal(g.home, "BUF Bills");
  assert.equal(g.awayShort, "DET");
  assert.deepEqual(
    g.markets.moneyline?.sides.map((s) => [s.label, s.odds]),
    [["DET Lions", 184], ["BUF Bills", -247]],
  );
});

test("parses DraftKings' U+2212 minus sign as a negative number", () => {
  const [g] = normalize(game());
  // A naive Number("−247") is NaN; the side would silently vanish.
  assert.equal(g.markets.moneyline?.sides[1].odds, -247);
});

test("orders away before home and over before under", () => {
  const flipped = game();
  flipped.selections.reverse();
  const [g] = normalize(flipped);
  assert.deepEqual(g.markets.moneyline?.sides.map((s) => s.label), ["DET Lions", "BUF Bills"]);
});

test("survives junk at the top level", () => {
  for (const junk of [null, undefined, {}, [], "nope", 42, { events: "nope" }]) {
    assert.deepEqual(normalize(junk), [], `failed on ${JSON.stringify(junk)}`);
  }
});

test("skips a malformed game instead of dropping the whole slate", () => {
  const mixed = game();
  mixed.events.unshift({ id: "bad" } as never); // no date, no participants
  const out = normalize(mixed);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "1");
});

test("skips a selection with unusable odds but keeps its siblings", () => {
  const broken = game();
  broken.selections[0].displayOdds = { american: "n/a" };
  const [g] = normalize(broken);
  assert.deepEqual(g.markets.moneyline?.sides.map((s) => s.label), ["BUF Bills"]);
});

test("keeps a game whose markets are all suspended", () => {
  const noMarkets = game({ markets: [], selections: [] });
  const [g] = normalize(noMarkets);
  assert.deepEqual(g.markets, {});
});

test("ignores markets that are not one of the three main ones", () => {
  const props = game();
  props.markets.push({ id: "m2", eventId: "1", name: "Anytime Touchdown Scorer" });
  props.selections.push({
    id: "s3", marketId: "m2", label: "Some Player",
    outcomeType: "Over", displayOdds: { american: "+250" },
  });
  const [g] = normalize(props);
  assert.deepEqual(Object.keys(g.markets), ["moneyline"]);
});
