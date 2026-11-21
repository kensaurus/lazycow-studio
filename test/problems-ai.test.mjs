/**
 * FILE: test/problems-ai.test.mjs
 * PURPOSE: An AI service out of credit: when some blocks have no other service, the Needs-you strip sends the person to
 *          choose one (not to "try again", which leads nowhere); when every block has a backup, "try again" stays.
 * USAGE: npm test
 */
import assert from "node:assert/strict";
import test from "node:test";
import { aiHealthProblems } from "../server/problems.mjs";

const health = (noBackup) => ({
  providers: [{ id: "fal", name: "fal.ai" }, { id: "stability", name: "Stability AI" }],
  problems: [{ provider: "fal", name: "fal.ai", kind: "out_of_credit", level: noBackup.length ? "red" : "amber", caps: ["upscale", "music"],
    noBackup, backups: ["stability"], billing: "https://fal.ai/dashboard/billing" }],
});

test("red: blocks with no other service lead to choosing one, with Top up beside it", () => {
  const [p] = aiHealthProblems(health(["upscale"]));
  assert.equal(p.level, "red");
  assert.equal(p.fix.label, "Choose another service");
  assert.equal(p.fix.href, "#/keys/blocks");
  assert.equal(p.fix.action, undefined);
  assert.equal(p.also.label, "Top up");
  assert.equal(p.ja.fix, "ほかのサービスを選ぶ");
  assert.match(p.detail, /choose another service for them, give one a key, or turn them off/);
});

test("amber: every block has a backup, so trying the service again is the action", () => {
  const [p] = aiHealthProblems(health([]));
  assert.equal(p.level, "amber");
  assert.equal(p.fix.label, "Try fal.ai again");
  assert.deepEqual(p.fix.action, { ai: "retry", provider: "fal" });
});
