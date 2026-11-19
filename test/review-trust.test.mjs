/**
 * FILE: test/review-trust.test.mjs
 * PURPOSE: The real server (server/review.mjs) applies its trust rules end to end: DNS rebinding and cross-site
 *          requests are refused, slugs that look like options never reach Python, unapproved reels are refused by
 *          every posting route, a runaway body gets 413, a range past the end gets 416, /file stays in its folders.
 * OVERVIEW: Starts review.mjs on a free port with a throwaway STUDIO_HOME and STUDIO_DATA and a Python that does
 *           not exist, so no catalog, account, footage or Chrome of this computer is touched.
 * USAGE: npm test
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../server/review.mjs", import.meta.url));
let child, port, data, home, file;

const freePort = () => new Promise((ok) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });

/** One request with exactly these headers; resolves {status, headers, body}. */
function call(method, path, { headers = {}, body } = {}) {
  return new Promise((ok, fail) => {
    const h = { host: `127.0.0.1:${port}`, ...headers };
    const data = body === undefined ? null : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    if (data && h["content-length"] === undefined) h["content-length"] = data.length;
    const r = request({ host: "127.0.0.1", port, method, path, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    r.on("error", fail);
    r.setTimeout(20_000, () => r.destroy(new Error(`timeout on ${method} ${path}`)));
    if (data) r.write(data);
    r.end();
  });
}
const own = () => ({ origin: `http://127.0.0.1:${port}`, "content-type": "application/json" });

before(async () => {
  port = await freePort();
  home = mkdtempSync(join(tmpdir(), "lazycow-home-"));
  data = mkdtempSync(join(tmpdir(), "lazycow-data-"));
  mkdirSync(join(data, "renders"), { recursive: true });
  file = join(data, "renders", "probe.json");
  writeFileSync(file, '{"ok":true}');
  writeFileSync(join(data, "secret.txt"), "not served");
  const env = {
    PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, TEMP: process.env.TEMP, TMP: process.env.TMP,
    STUDIO_PORT: String(port), STUDIO_HOME: home, STUDIO_DATA: data, STUDIO_SOURCE: join(data, "footage"),
    STUDIO_PY: join(data, "no-python.exe"), STUDIO_TOOLS: join(data, "bin"), STUDIO_WATCH_MINUTES: "0", STUDIO_AUTO_DRAFTS: "0",
    PLAYWRIGHT_MCP_EXTENSION_TOKEN: "",
  };
  child = spawn(process.execPath, [SERVER], { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
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

test("loopback page requests work; a DNS-rebinding Host and another site's subresource GETs are refused", async () => {
  assert.equal((await call("GET", "/api/about")).status, 200);
  assert.equal((await call("GET", "/api/about", { headers: { host: `rebind.example:${port}` } })).status, 403);
  const cross = await call("GET", "/api/events", { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors" } });
  assert.equal(cross.status, 403);
  assert.equal((await call("GET", `/file?p=${encodeURIComponent(file)}`, { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors" } })).status, 403);
  // A link or an OAuth return from another site is a navigation: it still lands.
  assert.equal((await call("GET", "/", { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" } })).status, 200);
});

test("desktop use without a token is unchanged: /api/health gives the whole report, and a stray Bearer is no failure", async () => {
  const h = JSON.parse((await call("GET", "/api/health")).body);
  assert.equal(typeof h.build, "string");
  assert.equal(typeof h.machine?.threads, "number");
  for (let i = 0; i < 12; i++) assert.equal((await call("GET", "/api/about", { headers: { authorization: `Bearer nope-${i}` } })).status, 200);
});

test("a POST from another origin, or cross-site with no Origin, is refused before anything runs", async () => {
  assert.equal((await call("POST", "/api/job/cancel", { headers: { origin: "https://evil.example", "content-type": "application/json" }, body: { slug: "a" } })).status, 403);
  assert.equal((await call("POST", "/api/job/cancel", { headers: { "sec-fetch-site": "cross-site" }, body: { slug: "a" } })).status, 403);
  assert.equal((await call("POST", "/api/job/cancel", { headers: own(), body: { slug: "a" } })).status, 200);
});

test("a slug or network that starts with a dash never reaches Python's command line", async () => {
  for (const [path, body] of [["/api/publish", { slug: "--due", network: "x" }], ["/api/publish", { slug: "fire-1", network: "--due" }],
    ["/api/youtube/upload", { slug: "--force" }], ["/api/remix", { slug: "--build" }], ["/api/approve", { slug: "-h" }], ["/api/helper/post", { slug: "-x", network: "x" }]]) {
    const r = await call("POST", path, { headers: own(), body });
    assert.equal(r.status, 400, `${path} ${JSON.stringify(body)} -> ${r.status} ${r.body}`);
  }
});

/* /api/helper/schedule refuses through scheduleRefusal (test/helper.test.mjs); with no Python here it stops earlier. */
test("every posting route refuses a reel with no approved review record", async () => {
  for (const [path, body] of [["/api/publish", { slug: "fire-1", network: "bluesky" }], ["/api/youtube/upload", { slug: "fire-1" }],
    ["/api/helper/post", { slug: "fire-1", network: "x" }]]) {
    const r = await call("POST", path, { headers: own(), body });
    assert.equal(r.status, 409, `${path} -> ${r.status} ${r.body}`);
    assert.match(JSON.parse(r.body).error, /approved/);
  }
});

test("a body over the limit is 413, not an ever-growing string", async () => {
  const r = await call("POST", "/api/job/cancel", { headers: { ...own(), "content-length": String(9 * 1024 * 1024) }, body: "{}" });
  assert.equal(r.status, 413);
});

test("/file serves its folders only, and a range past the end is 416", async () => {
  const p = encodeURIComponent(file);
  assert.equal((await call("GET", `/file?p=${p}`)).body, '{"ok":true}');
  const tail = await call("GET", `/file?p=${p}`, { headers: { range: "bytes=-5" } });
  assert.equal(tail.status, 206);
  assert.equal(tail.body, 'true}');
  const past = await call("GET", `/file?p=${p}`, { headers: { range: "bytes=999-" } });
  assert.equal(past.status, 416);
  assert.equal(past.headers["content-range"], "bytes */11");
  assert.equal((await call("GET", `/file?p=${encodeURIComponent(join(data, "renders", "..", "secret.txt"))}`)).status, 403);
  assert.equal((await call("GET", "/docs/..%2Fpackage.json")).status, 404);
  assert.equal((await call("GET", "/share/not-a-token/x.mp4")).status, 404);
});

test("no other site can frame the studio, and a project slug is never a path (review 13 Nov)", async () => {
  const page = await call("GET", "/");
  assert.equal(page.headers["x-frame-options"], "DENY");
  assert.match(page.headers["content-security-policy"] || "", /frame-ancestors 'none'/);
  assert.equal((await call("GET", "/api/about")).headers["x-frame-options"], "DENY");
  assert.equal((await call("GET", "/api/project?slug=..%2F..%2Fx")).status, 400);
});

test("a project keeps the person's word that everyone in its footage agreed to be filmed", async () => {
  const first = JSON.parse((await call("GET", "/api/workspaces")).body);
  assert.equal(first.list.find((w) => w.id === "main").consentAll, false);  // off until the person says so
  const on = await call("POST", "/api/workspaces/edit", { headers: own(), body: { id: "main", consentAll: true } });
  assert.equal(on.status, 200);
  assert.equal(JSON.parse(on.body).list.find((w) => w.id === "main").consentAll, true);
  const junk = await call("POST", "/api/workspaces/edit", { headers: own(), body: { id: "main", consentAll: "yes" } });
  assert.equal(JSON.parse(junk.body).list.find((w) => w.id === "main").consentAll, true);  // only a real boolean changes it
  const off = await call("POST", "/api/workspaces/edit", { headers: own(), body: { id: "main", consentAll: false } });
  assert.equal(JSON.parse(off.body).list.find((w) => w.id === "main").consentAll, false);
  assert.equal((await call("POST", "/api/workspaces/edit", { headers: { origin: "https://evil.example", "content-type": "application/json" }, body: { id: "main", consentAll: true } })).status, 403);
});

test("the helper starts once: a server that waited for its port does not start a second, orphaned one", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(SERVER, "utf8");
  const at = src.indexOf('server.once("listening"');
  const block = src.slice(at, src.indexOf("});", at));
  assert.match(block, /if \(!helper\) startHelper\(\);/);
  assert.doesNotMatch(block.replace(/if \(!helper\) startHelper\(\);/, ""), /startHelper\(\)/);
});

test("a cancelled build of a reel that no longer exists is not a card on the Reels page", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(SERVER, "utf8");
  const at = src.indexOf('url.pathname === "/api/overview"');
  assert.match(src.slice(at, at + 1200), /job\.status !== "cancelled"/);
});
