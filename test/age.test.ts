import { test } from "node:test";
import assert from "node:assert/strict";
import { computeAge } from "../lib/age.ts";

const SERVER_AGE = 400; 

test("adds time elapsed since the frame arrived", () => {
  assert.equal(computeAge(SERVER_AGE, 1_000, 1_000), 400);
  assert.equal(computeAge(SERVER_AGE, 1_000, 1_600), 1_000);
});

test("a browser clock stepping backwards cannot make data look fresher", () => {
  // Without the clamp this would report 400 - 5000 = -4600ms.
  assert.equal(computeAge(SERVER_AGE, 10_000, 5_000), 400);
});

test("nothing received yet is maximally stale, not fresh", () => {
  assert.equal(computeAge(undefined, undefined, 1_000), Infinity);
  assert.equal(computeAge(SERVER_AGE, undefined, 1_000), Infinity);
  assert.equal(computeAge(-1, 1_000, 1_000), Infinity);
});

test("crosses the stale threshold at the right moment", () => {
  const STALE_AFTER_MS = 10_000;
  const receivedAt = 1_000;
  assert.ok(computeAge(0, receivedAt, receivedAt + 9_999) < STALE_AFTER_MS);
  assert.ok(computeAge(0, receivedAt, receivedAt + 10_001) > STALE_AFTER_MS);
});
