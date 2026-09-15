import { test } from "node:test";
import assert from "node:assert/strict";
import { LEAGUES, findLeague } from "../lib/leagues.ts";
import { normalize } from "../lib/draftkings.ts";

const payloadWithHandicap = (marketName: string) => ({
  events: [
    {
      id: "1",
      startEventDate: "2026-09-14T17:00:00Z",
      status: "NOT_STARTED",
      participants: [
        { name: "Home Team", venueRole: "Home", metadata: { shortName: "HOM" } },
        { name: "Away Team", venueRole: "Away", metadata: { shortName: "AWY" } },
      ],
    },
  ],
  markets: [{ id: "m1", eventId: "1", name: marketName }],
  selections: [
    { id: "s1", marketId: "m1", label: "Away Team", outcomeType: "Away", points: 1.5, displayOdds: { american: "−110" } },
    { id: "s2", marketId: "m1", label: "Home Team", outcomeType: "Home", points: -1.5, displayOdds: { american: "−110" } },
  ],
});

test("every registered league resolves by its own slug", () => {
  for (const league of LEAGUES) {
    assert.equal(findLeague(league.slug), league, league.slug);
  }
});

test("unknown slugs resolve to nothing rather than a default", () => {
  for (const slug of ["nhl", "random", "", null, undefined, "NFL"]) {
    assert.equal(findLeague(slug), undefined, JSON.stringify(slug));
  }
});

test("slugs and DraftKings ids are unique", () => {
  assert.equal(new Set(LEAGUES.map((l) => l.slug)).size, LEAGUES.length, "duplicate slug");
  assert.equal(new Set(LEAGUES.map((l) => l.id)).size, LEAGUES.length, "duplicate league id");
});

test("every league's spreadLabel is a name the normalizer maps to a spread", () => {
  for (const league of LEAGUES) {
    const [game] = normalize(payloadWithHandicap(league.spreadLabel));
    assert.ok(
      game?.markets.spread,
      `${league.slug}: "${league.spreadLabel}" does not normalize to a spread market`,
    );
  }
});

test("league ids are numeric strings, as DraftKings' paths require", () => {
  for (const league of LEAGUES) {
    assert.match(league.id, /^\d+$/, `${league.slug} id "${league.id}"`);
  }
});
