/**
 * FILE: test/review-token.test.mjs
 * PURPOSE: The real server (server/review.mjs) in server mode, with STUDIO_API_TOKEN: /api/health says only {ok: true}
 *          to a caller without the token, the browser cookie lasts 30 days, and wrong tokens are logged (never the
 *          token) and paused per address after 10 (docs/self-host.md).
 * OVERVIEW: Starts review.mjs on a free loopback port with a throwaway STUDIO_HOME and STUDIO_DATA, a Python that does
 *           not exist, a token and STUDIO_ALLOWED_HOSTS (server mode). The pause test runs last: it pauses 127.0.0.1.
 * USAGE: npm test
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../server/review.mjs", import.meta.url));
const TOKEN = "test-token-0123456789abcdef";
let child, port, data, home, log = "";

const freePort = () => new Promise((ok) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });

/** One request with exactly these headers; resolves {status, headers, body}. */
function call(method, path, headers = {}) {
  return new Promise((ok, fail) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers }, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    r.on("error", fail);
    r.setTimeout(20_000, () => r.destroy(new Error(`timeout on ${method} ${path}`)));
    r.end();
  });
}
const bearer = (t) => ({ authorization: `Bearer ${t}` });
const failLines = () => log.split(/\r?\n/).filter((l) => l.includes("lazycow auth failed"));
const settle = () => new Promise((ok) => setTimeout(ok, 150));  // stderr arrives just after the answer

before(async () => {
  port = await freePort();
  home = mkdtempSync(join(tmpdir(), "lazycow-home-"));
  data = mkdtempSync(join(tmpdir(), "lazycow-data-"));
  mkdirSync(join(data, "renders"), { recursive: true });
  const env = {
    PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, TEMP: process.env.TEMP, TMP: process.env.TMP,
    STUDIO_PORT: String(port), STUDIO_HOME: home, STUDIO_DATA: data, STUDIO_SOURCE: join(data, "footage"),
    STUDIO_PY: join(data, "no-python.exe"), STUDIO_TOOLS: join(data, "bin"), STUDIO_WATCH_MINUTES: "0", STUDIO_AUTO_DRAFTS: "0",
    PLAYWRIGHT_MCP_EXTENSION_TOKEN: "", STUDIO_API_TOKEN: TOKEN, STUDIO_ALLOWED_HOSTS: "studio.example.test",
  };
  child = spawn(process.execPath, [SERVER], { env, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((ok, fail) => {
    const t = setTimeout(() => fail(new Error(`review.mjs did not start: ${log}`)), 20_000);
    child.stdout.on("data", (c) => { log += c; if (log.includes(`127.0.0.1:${port}`)) { clearTimeout(t); ok(); } });
    child.stderr.on("data", (c) => { log += c; });
    child.on("exit", (code) => { clearTimeout(t); fail(new Error(`review.mjs exited ${code}: ${log}`)); });
  });
});
after(() => {
  child?.removeAllListeners("exit");
  child?.kill();
  for (const d of [home, data]) try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
});

test("/api/health: {ok: true} without the token, the whole report with it (a header or the cookie)", async () => {
  const bare = await call("GET", "/api/health");
  assert.equal(bare.status, 200, "the Docker health check needs a 200 without the token");
  assert.deepEqual(JSON.parse(bare.body), { ok: true }, "no version, build, processor, memory or disk");
  const full = JSON.parse((await call("GET", "/api/health", bearer(TOKEN))).body);
  assert.equal(full.ok, true);
  assert.equal(typeof full.build, "string");
  assert.equal(typeof full.machine?.threads, "number");
  assert.ok(Array.isArray(full.checks));
  const viaCookie = JSON.parse((await call("GET", "/api/health", { cookie: `lazycow_token=${TOKEN}` })).body);
  assert.equal(viaCookie.build, full.build);
  assert.equal((await call("GET", "/api/about")).status, 401, "everything else still needs the token");
});

test("/?token= sets a 30-day HttpOnly cookie; plain HTTP is not Secure, and X-Forwarded-Proto from anyone changes nothing", async () => {
  const r = await call("GET", `/?token=${TOKEN}`, { "x-forwarded-proto": "https" });
  assert.equal(r.status, 303);
  const cookie = String(r.headers["set-cookie"]);
  assert.match(cookie, /^lazycow_token=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/);
  assert.doesNotMatch(cookie, /Secure/);
});

test("a wrong token is one log line with the address, method and path, never the token; the same wrong value again is not", async () => {
  const before = failLines().length;
  const guess = "wrong-guess-ABCDEFGHIJKLMNOP";
  assert.equal((await call("GET", "/api/about", { ...bearer(guess), "x-forwarded-for": "198.51.100.7" })).status, 401);
  for (let i = 0; i < 3; i++) assert.equal((await call("GET", "/api/overview", { cookie: "lazycow_token=old-cookie-from-last-month" })).status, 401);
  assert.equal((await call("GET", `/?token=also-wrong-${"x".repeat(20)}`)).status, 401);
  assert.equal((await call("GET", "/api/about")).status, 401, "no token at all");
  await settle();
  const lines = failLines().slice(before);
  assert.equal(lines.length, 3, lines.join("\n"));
  assert.match(lines[0], /^\d{4}-\d\d-\d\dT[\d:.]+Z lazycow auth failed ip=127\.0\.0\.1 method=GET path=\/api\/about$/, "the TCP peer, not X-Forwarded-For");
  assert.match(lines[1], /ip=127\.0\.0\.1 method=GET path=\/api\/overview$/);
  assert.match(lines[2], /ip=127\.0\.0\.1 method=GET path=\/$/, "the path only, not ?token=");
  assert.doesNotMatch(log, /wrong-guess|old-cookie|also-wrong/, "no token value in the log");
  assert.equal((await call("GET", "/api/about", bearer(TOKEN))).status, 200, "the right token still works below the limit");
});

test("after 10 wrong tokens the address gets 429 with Retry-After, even with the right token; /api/health stays up", async () => {
  // 3 different wrong values so far (the test above); 7 more reach 10.
  for (let i = 0; i < 7; i++) assert.equal((await call("GET", "/api/about", bearer(`guess-${i}-${"y".repeat(20)}`))).status, 401);
  const paused = await call("GET", "/api/about", bearer(TOKEN));
  assert.equal(paused.status, 429);
  const wait = Number(paused.headers["retry-after"]);
  assert.ok(wait > 0 && wait <= 600, `Retry-After ${paused.headers["retry-after"]}`);
  assert.match(JSON.parse(paused.body).error, /too many wrong tokens/);
  assert.equal((await call("GET", `/?token=${TOKEN}`)).status, 429, "the token is not even looked at");
  const health = await call("GET", "/api/health", bearer(TOKEN));
  assert.equal(health.status, 200);
  assert.deepEqual(JSON.parse(health.body), { ok: true }, "while paused, only that the studio runs");
  await settle();
  assert.equal(failLines().length, 10, "429s are not logged as failures");
});
