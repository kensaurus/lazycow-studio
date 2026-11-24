/**
 * FILE: test/tiles.test.mjs
 * PURPOSE: The map tile proxy (server/tiles.mjs) keeps to OpenStreetMap's tile policy: it names itself, keeps a tile
 *          at least 7 days (longer when the server says so), downloads a tile once however many ask at once, only
 *          zoom 3-17, and serves the kept copy when the tile server cannot be reached.
 * USAGE: npm test
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTileProxy, keepSeconds, validTemplate, DEFAULT_TILE_URL } from "../server/tiles.mjs";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const DAY = 86400;

function stub(answers) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, headers: opts.headers });
    const a = typeof answers === "function" ? answers(calls.length) : answers;
    if (a instanceof Error) throw a;
    return new Response(a.body === undefined ? PNG : a.body, { status: a.status || 200, headers: a.headers || { "content-type": "image/png" } });
  };
  return { calls, fetchImpl };
}

test("a tile is kept for the server's max-age, never under 7 days", () => {
  assert.equal(keepSeconds(new Headers({ "cache-control": "max-age=60" })), 7 * DAY);
  assert.equal(keepSeconds(new Headers({ "cache-control": "public, max-age=1209600" })), 14 * DAY);
  assert.equal(keepSeconds(new Headers({ "cache-control": "s-maxage=2000000, max-age=10" })), 2000000);
  const now = Date.parse("2026-11-24T00:00:00Z");
  assert.equal(keepSeconds(new Headers({ expires: "Wed, 16 Dec 2026 00:00:00 GMT" }), now), 22 * DAY);
  assert.equal(keepSeconds(new Headers({})), 7 * DAY);
  assert.ok(validTemplate(DEFAULT_TILE_URL) && validTemplate("https://{s}.tile.example.org/{z}/{x}/{y}.png"));
  assert.ok(!validTemplate("file:///etc/{z}/{x}/{y}") && !validTemplate("https://tiles.example.org/{z}/{x}.png"));
});

test("the first view downloads with the studio's name; the next is served from disk until it expires", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tiles-"));
  try {
    let t = Date.parse("2026-11-24T00:00:00Z");
    const { calls, fetchImpl } = stub({ headers: { "content-type": "image/png", "cache-control": "max-age=604800", etag: '"abc"' } });
    const p = createTileProxy({ dir, userAgent: "LazycowStudio/0.26.0 (+https://github.com/kensaurus/lazycow-studio)", fetchImpl, now: () => t });
    const a = await p.get(12, 3639, 1612);
    assert.equal(a.status, 200);
    assert.deepEqual(a.body, PNG);
    assert.equal(a.headers["x-tile"], "fetched");
    assert.equal(calls[0].url, "https://tile.openstreetmap.org/12/3639/1612.png");
    assert.match(calls[0].headers["user-agent"], /^LazycowStudio\/[\d.]+ \(\+https:\/\/github\.com\//);
    assert.ok(JSON.parse(readFileSync(join(dir, "12", "3639", "1612.json"), "utf8")).expires >= t + 7 * DAY * 1000);
    const b = await p.get(12, 3639, 1612);
    assert.equal(b.headers["x-tile"], "cache");
    assert.equal(calls.length, 1, "no second download inside the week");
    t += 8 * DAY * 1000;  // expired: asks again, with the etag
    const { calls: c2, fetchImpl: f2 } = stub({ status: 304, body: null, headers: { "cache-control": "max-age=604800" } });
    const p2 = createTileProxy({ dir, userAgent: "x", fetchImpl: f2, now: () => t });
    const c = await p2.get(12, 3639, 1612);
    assert.equal(c.headers["x-tile"], "revalidated");
    assert.deepEqual(c.body, PNG);
    assert.equal(c2[0].headers["if-none-match"], '"abc"');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the same tile asked for at once is downloaded once, and at most two download together", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tiles-"));
  try {
    let open = 0, most = 0, n = 0;
    const fetchImpl = async () => {
      n++; open++; most = Math.max(most, open);
      await new Promise((r) => setTimeout(r, 15));
      open--;
      return new Response(PNG, { headers: { "content-type": "image/png" } });
    };
    const p = createTileProxy({ dir, userAgent: "x", fetchImpl });
    const same = await Promise.all([p.get(10, 1, 1), p.get(10, 1, 1), p.get(10, 1, 1)]);
    assert.equal(n, 1);
    assert.ok(same.every((r) => r.status === 200));
    await Promise.all([1, 2, 3, 4, 5, 6].map((x) => p.get(10, x + 10, 2)));
    assert.equal(most, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("outside zoom 3-17 or the world is refused; offline serves the kept copy, else a plain error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tiles-"));
  try {
    let t = 0;
    const { fetchImpl, calls } = stub((i) => (i === 1 ? {} : new Error("offline")));
    const p = createTileProxy({ dir, userAgent: "x", fetchImpl, now: () => t });
    for (const [z, x, y] of [[2, 0, 0], [18, 0, 0], [5, 32, 0], [5, 0, -1], [5.5, 0, 0]]) assert.equal((await p.get(z, x, y)).status, 400, `${z}/${x}/${y}`);
    assert.equal(calls.length, 0, "nothing asked of the tile server");
    assert.equal((await p.get(5, 1, 1)).status, 200);
    t += 30 * DAY * 1000;
    const old = await p.get(5, 1, 1);
    assert.equal(old.status, 200);
    assert.equal(old.headers["x-tile"], "stale");
    const none = await p.get(5, 2, 2);
    assert.equal(none.status, 502);
    const { fetchImpl: f404 } = stub({ status: 404, body: "no", headers: { "content-type": "text/plain" } });
    assert.equal((await createTileProxy({ dir, userAgent: "x", fetchImpl: f404 }).get(6, 1, 1)).status, 404);
    const { fetchImpl: fHtml } = stub({ body: "<html>blocked</html>", headers: { "content-type": "text/html" } });
    assert.equal((await createTileProxy({ dir, userAgent: "x", fetchImpl: fHtml }).get(6, 2, 1)).status, 502, "a page instead of a picture is not kept");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
