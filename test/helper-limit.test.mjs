// A read-only helper job that hangs (a page that never answers) must end and free the lane, not hold every later
// Chrome job (swaps, bookings) for hours: server/helper.mjs withLimit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withLimit, inLane } from "../server/helper.mjs";

test("a hung read is stopped at its limit and the next helper job still runs", async () => {
  const hung = inLane(() => withLimit(new Promise(() => {}), 150, "Reading the numbers"));
  await assert.rejects(hung, /Reading the numbers took over 0 minutes and was stopped/);
  assert.equal(await inLane(async () => "next job ran"), "next job ran");
  assert.equal(await withLimit(Promise.resolve(3), 1000), 3, "work that finishes in time is untouched");
});
