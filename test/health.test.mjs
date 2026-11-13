/**
 * FILE: test/health.test.mjs
 * PURPOSE: The system check says the right thing on weak, average and strong machines, and the ETA is sane.
 * USAGE: npm test
 */
import assert from "node:assert/strict";
import test from "node:test";
import { etaSeconds, guessBuildSeconds, judgeSystem, medianSeconds } from "../server/health.mjs";

const strong = {
  threads: 32, cpuModel: "x", ramGb: 32, freeRamGb: 20, diskFreeGb: 400, reelGb: 0.5, dataDir: "E:\\studio",
  python: true, ffmpeg: true, dataWritable: true, mediaReachable: true, helper: "ready", hardware: ["AMD"],
  buildSeconds: 396, buildSecondsSource: "measured",
};

test("a strong desktop passes every check", () => {
  const r = judgeSystem(strong);
  assert.equal(r.verdict, "ok");
  assert.ok(r.checks.every((c) => c.level === "ok"), JSON.stringify(r.checks.filter((c) => c.level !== "ok")));
  assert.match(r.checks.find((c) => c.id === "disk").found, /room for about 800 more reels/);
});

test("a 4-thread, 8 GB laptop works but is told it is slow, with a fix for each", () => {
  const r = judgeSystem({ ...strong, threads: 4, ramGb: 8, freeRamGb: 2 });
  assert.equal(r.verdict, "slow");
  for (const id of ["cpu", "ram"]) {
    const c = r.checks.find((x) => x.id === id);
    assert.equal(c.level, "slow");
    assert.ok(c.fix.length > 10, `${id} needs advice`);
  }
});

test("a 2-thread machine, a full disk or a missing engine blocks rendering", () => {
  assert.equal(judgeSystem({ ...strong, threads: 2 }).verdict, "blocked");
  assert.equal(judgeSystem({ ...strong, diskFreeGb: 1.2 }).verdict, "blocked");
  assert.equal(judgeSystem({ ...strong, python: false }).verdict, "blocked");
  const down = judgeSystem({ ...strong, helper: "down", helperError: "boom" });
  assert.equal(down.checks.find((c) => c.id === "helper").found, "stopped: boom");
  assert.equal(down.verdict, "ok", "a stopped helper restarts by itself: it must not read as an underpowered computer");
  assert.equal(down.service, "slow");
});

test("an unplugged footage drive warns as a service problem, not a weak computer", () => {
  const r = judgeSystem({ ...strong, mediaReachable: false });
  assert.equal(r.verdict, "ok");
  assert.equal(r.service, "slow");
});

test("the hardware encoder line is information, never a failure", () => {
  assert.equal(judgeSystem({ ...strong, hardware: [] }).verdict, "ok");
});

test("median and ETA use real history and stay positive", () => {
  const rows = [300, 400, 500, 9999].map((s, i) => ({ kind: "build", status: i === 3 ? "error" : "done", seconds: s }));
  assert.equal(medianSeconds(rows, "build"), 400);
  assert.equal(medianSeconds(rows, "remix"), null);
  assert.equal(etaSeconds({ elapsed: 100, pct: 0, typical: 400 }), 300);
  assert.equal(etaSeconds({ elapsed: 200, pct: 50, typical: 400 }), 200);
  assert.ok(etaSeconds({ elapsed: 600, pct: 90, typical: 400 }) > 0, "past the typical time, progress decides");
  assert.equal(etaSeconds({ elapsed: 5, pct: 0, typical: null }), null);
});

test("a machine with no history gets a longer guess the fewer threads it has", () => {
  assert.ok(guessBuildSeconds(4) > guessBuildSeconds(16));
  assert.equal(guessBuildSeconds(32), 400);
});
