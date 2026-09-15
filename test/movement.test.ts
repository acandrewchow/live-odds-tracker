import { test } from "node:test";
import assert from "node:assert/strict";
import { movement, toDecimal } from "../lib/movement.ts";
import type { Side } from "../lib/types.ts";

const side = (o: Partial<Side>): Side => ({ label: "X", odds: -110, ...o });

test("a shortening favourite moves down, a drifting one moves up", () => {
  // -320 -> -300 is a longer price: better for the bettor, so "up".
  assert.equal(movement(side({ odds: -300, prevOdds: -320 })), "up");
  assert.equal(movement(side({ odds: -320, prevOdds: -300 })), "down");
});

test("underdog prices follow the same rule", () => {
  assert.equal(movement(side({ odds: 200, prevOdds: 150 })), "up");
  assert.equal(movement(side({ odds: 150, prevOdds: 200 })), "down");
});

test("direction is correct across the sign boundary", () => {
  // -105 -> +105 is a genuine lengthening, not an artefact of the sign flip.
  assert.equal(movement(side({ odds: 105, prevOdds: -105 })), "up");
  assert.equal(movement(side({ odds: -105, prevOdds: 105 })), "down");
});

test("numeric order of American odds matches decimal price order", () => {
  const ladder = [-320, -300, -250, -200, -150, -110, -105, -100, 100, 105, 150, 200, 300];
  for (let i = 1; i < ladder.length; i++) {
    assert.ok(
      toDecimal(ladder[i]) >= toDecimal(ladder[i - 1]),
      `${ladder[i - 1]} -> ${ladder[i]} broke monotonicity`,
    );
  }
});

test("no movement reported when nothing changed", () => {
  assert.equal(movement(side({ odds: -110 })), null);
  assert.equal(movement(side({ odds: -110, prevOdds: -110 })), null);
});

test("a line move is reported even when the price held", () => {
  // Total 44.5 -> 45.5, both sides still -110.
  assert.equal(movement(side({ odds: -110, prevOdds: -110, line: 45.5, prevLine: 44.5 })), "up");
  assert.equal(movement(side({ odds: -110, prevOdds: -110, line: 44.5, prevLine: 45.5 })), "down");
});

test("the price takes precedence over the line when both moved", () => {
  const s = side({ odds: -105, prevOdds: -115, line: 3.5, prevLine: 4.5 });
  assert.equal(movement(s), "up");
});
