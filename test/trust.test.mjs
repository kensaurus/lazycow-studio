/**
 * FILE: test/trust.test.mjs
 * PURPOSE: The studio's request-trust rules (server/trust.mjs): loopback Host, same-origin writes, no GET side
 *          effects from another site's page, bounded JSON bodies, slugs that can never become an option, byte
 *          ranges, the folder allow-list and the approval gate.
 * USAGE: npm test
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { join, resolve } from "node:path";
import test from "node:test";
import { approvalRefusal, insideRoots, isNet, isSlug, pathKey, parseRange, readJson, refusal, strayPath, tokenOk, TOKEN_COOKIE, trustRules } from "../server/trust.mjs";

const rules = trustRules(4317);
const req = (method, headers) => ({ method, headers: { host: "127.0.0.1:4317", ...headers } });

test("only a loopback Host on this port gets in (DNS rebinding sends its own name)", () => {
  assert.equal(refusal(req("GET", {}), rules), null);
  assert.equal(refusal(req("GET", { host: "localhost:4317" }), rules), null);
  assert.equal(refusal(req("GET", { host: "[::1]:4317" }), rules), null);
  for (const host of ["evil.example:4317", "127.0.0.1:4318", "127.0.0.1", "127.0.0.1.evil.example:4317", ""]) {
    assert.equal(refusal(req("GET", { host }), rules), "host", host);
  }
});

test("a POST needs the studio's own Origin, or same-origin when no Origin is sent; a local script sends neither", () => {
  assert.equal(refusal(req("POST", { origin: "http://127.0.0.1:4317" }), rules), null);
  assert.equal(refusal(req("POST", { origin: "http://localhost:4317" }), rules), null);
  assert.equal(refusal(req("POST", { origin: "https://evil.example" }), rules), "origin");
  assert.equal(refusal(req("POST", { origin: "null" }), rules), "origin");  // a sandboxed frame or a file:// page
  assert.equal(refusal(req("POST", { origin: "http://127.0.0.1:3000" }), rules), "origin");  // another local app
  assert.equal(refusal(req("POST", { "sec-fetch-site": "cross-site" }), rules), "cross-site");
  assert.equal(refusal(req("POST", { "sec-fetch-site": "same-site" }), rules), "cross-site");
  assert.equal(refusal(req("POST", { "sec-fetch-site": "same-origin" }), rules), null);
  assert.equal(refusal(req("POST", {}), rules), null);  // curl, server/mcp.mjs before it sent an Origin
  assert.equal(refusal(req("DELETE", { origin: "https://evil.example" }), rules), "origin");
});

test("another site's page cannot make the studio work through a GET, but may link to it", () => {
  for (const mode of ["no-cors", "cors", "same-origin", undefined]) {
    assert.equal(refusal(req("GET", { "sec-fetch-site": "cross-site", "sec-fetch-mode": mode }), rules), "cross-site", `mode ${mode}`);
  }
  assert.equal(refusal(req("GET", { "sec-fetch-site": "same-site", "sec-fetch-mode": "no-cors" }), rules), "cross-site");
  assert.equal(refusal(req("HEAD", { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors" }), rules), "cross-site");
  // Google sending the browser back to /oauth/youtube, a bookmark, the studio's own page.
  assert.equal(refusal(req("GET", { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" }), rules), null);
  assert.equal(refusal(req("GET", { "sec-fetch-site": "none", "sec-fetch-mode": "navigate" }), rules), null);
  assert.equal(refusal(req("GET", { "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" }), rules), null);
});

test("a slug or network id can never be read as a command-line option", () => {
  for (const s of ["fire-1110", "a", "0day", "story-fire-1110"]) assert.ok(isSlug(s), s);
  for (const s of ["--due", "-h", "-", "", "Fire", "fire_1", "../x", "a b", "a".repeat(121), null, 5]) assert.ok(!isSlug(s), String(s));
  for (const n of ["x", "youtube-shorts", "line-oa"]) assert.ok(isNet(n), n);
  for (const n of ["--due", "-x", "", "X", "x1"]) assert.ok(!isNet(n), n);
});

/* A request stand-in: emits the chunks, then end. */
function fakeReq(chunks, headers = {}) {
  const r = new EventEmitter();
  r.headers = headers;
  r.resume = () => {};
  setImmediate(() => { for (const c of chunks) r.emit("data", Buffer.from(c)); r.emit("end"); });
  return r;
}

test("a JSON body is an object, and a runaway body stops at the limit with 413", async () => {
  assert.deepEqual(await readJson(fakeReq(['{"slug":', '"fire-1"}'])), { slug: "fire-1" });
  assert.deepEqual(await readJson(fakeReq(["not json"])), {});
  assert.deepEqual(await readJson(fakeReq(["null"])), {});  // used to crash a route reading b.slug
  assert.deepEqual(await readJson(fakeReq(["[1,2]"])), {});
  assert.deepEqual(await readJson(fakeReq([])), {});
  await assert.rejects(readJson(fakeReq(["x".repeat(600), "x".repeat(600)]), 1000), (e) => e.status === 413);  // chunked, no length
  await assert.rejects(readJson(fakeReq([], { "content-length": "5000" }), 1000), (e) => e.status === 413);  // declared too big
});

test("byte ranges: whole file, a slice, the tail, and 416 past the end instead of a negative length", () => {
  assert.equal(parseRange(undefined, 100), null);
  assert.equal(parseRange("items=0-5", 100), null);
  assert.deepEqual(parseRange("bytes=0-", 100), { start: 0, end: 99 });
  assert.deepEqual(parseRange("bytes=10-19", 100), { start: 10, end: 19 });
  assert.deepEqual(parseRange("bytes=90-500", 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange("bytes=-10", 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange("bytes=-500", 100), { start: 0, end: 99 });
  assert.equal(parseRange("bytes=100-", 100), "unsatisfiable");
  assert.equal(parseRange("bytes=999999999999-", 100), "unsatisfiable");
  assert.equal(parseRange("bytes=20-10", 100), "unsatisfiable");
  assert.equal(parseRange("bytes=-0", 100), "unsatisfiable");
  assert.equal(parseRange("bytes=0-", 0), null);  // an empty file is sent whole
});

test("the folder allow-list: inside a root only, however the path is spelled", () => {
  const roots = [pathKey("C:/studio-data/renders")];
  assert.ok(insideRoots("C:/studio-data/renders/story-a/a.mp4", roots));
  if (process.platform === "win32") assert.ok(insideRoots("C:\\Studio-Data\\RENDERS\\a.mp4", roots));  // Windows: any case, either slash
  if (process.platform === "linux") assert.ok(!insideRoots("C:/studio-data/RENDERS/a.mp4", roots));  // Linux: a different folder
  assert.ok(insideRoots("C:/studio-data/renders", roots));
  assert.ok(!insideRoots("C:/studio-data/renders/../secrets/youtube.bin", roots));
  assert.ok(!insideRoots("C:/studio-data/renders-old/a.mp4", roots));  // a sibling sharing the prefix
  assert.ok(!insideRoots("C:/studio-data/secrets", roots));
  assert.ok(!insideRoots(join("C:/studio-data/renders", "a\0.mp4"), roots));
  assert.ok(!insideRoots("", roots) && !insideRoots(null, roots));
});

test("the approval gate: only an approved review record lets a reel out", () => {
  const rows = [{ slug: "story-fire-1", status: "approved" }, { slug: "story-view-1", status: "rendered" }, { slug: "old", status: "approved" }];
  assert.equal(approvalRefusal(rows, "fire-1"), null);
  assert.equal(approvalRefusal(rows, "story-fire-1"), null);
  assert.equal(approvalRefusal(rows, "old"), null);
  assert.match(approvalRefusal(rows, "view-1"), /"rendered", not approved/);
  assert.match(approvalRefusal(rows, "nope"), /no review record/);
  assert.match(approvalRefusal([], "fire-1"), /no review record/);  // the review list could not be read: refused
  assert.match(approvalRefusal(null, "fire-1"), /no review record/);
});

test("with an API token set, every caller must carry it (a header or the page's cookie); none set changes nothing", () => {
  const locked = trustRules(4317, "s3cret-token");
  const at = (method, headers, url = "/api/overview") => ({ method, url, headers: { host: "127.0.0.1:4317", ...headers } });
  // Origin and Sec-Fetch headers are no proof: any program on the computer can send them.
  assert.equal(refusal(at("GET", { "sec-fetch-site": "same-origin" }), locked), "token");
  assert.equal(refusal(at("POST", { origin: "http://127.0.0.1:4317" }), locked), "token");
  assert.equal(refusal(at("POST", { origin: "http://127.0.0.1:4317", authorization: "Bearer s3cret-token" }), locked), null);
  assert.equal(refusal(at("GET", { cookie: `a=1; ${TOKEN_COOKIE}=s3cret-token` }), locked), null);
  assert.equal(refusal(at("GET", { authorization: "Bearer s3cret-tokeX" }), locked), "token");
  assert.equal(refusal(at("GET", { authorization: "Bearer s3cret" }), locked), "token");  // a prefix is not the token
  assert.equal(refusal(at("GET", {}, "/api/health"), locked), null);  // only says whether the studio runs
  assert.equal(refusal(at("GET", {}, "/api/healthz"), locked), "token");
  // The token never weakens the other rules.
  assert.equal(refusal(at("POST", { origin: "https://evil.example", authorization: "Bearer s3cret-token" }), locked), "origin");
  assert.equal(refusal(at("GET", { host: "evil.example:4317", authorization: "Bearer s3cret-token" }), locked), "host");
  // Off by default.
  assert.equal(refusal(at("GET", {}), rules), null);
  assert.equal(tokenOk({}, ""), true);
  assert.equal(tokenOk({ cookie: `${TOKEN_COOKIE}=%E0` }, "x"), false);  // a broken cookie is no token, not a crash
});

test("an imported reel may not point at a network share or outside the footage folder (review 13 Nov)", () => {
  // Looking at \\host\share makes Windows sign in to that host with the owner's account.
  assert.equal(strayPath({ shots: [{ src: "\\\\attacker.example\\s\\a.mp4" }] }), true);
  assert.equal(strayPath({ shots: [{ src: "//attacker.example/s/a.mp4" }] }), true);
  assert.equal(strayPath({ layers: [{ path: "\\\\host\\x.png" }] }), true);
  assert.equal(strayPath({ cover: "\\\\host\\c.jpg" }), true, "a share under any key");
  assert.equal(strayPath({ shots: [{ src: "C:\\Users\\me\\secret.jpg" }] }), true);
  assert.equal(strayPath({ shots: [{ src: "/etc/passwd" }] }), true);
  assert.equal(strayPath({ shots: [{ src: "2026/../../x.mp4" }] }), true);
  assert.equal(strayPath({ shots: [{ src: "2026-11/deck/IMG_1.MOV" }, { src: "a..b.mp4" }], beats: [{ en: "Up the hill / down .. again" }] }), false);
});
