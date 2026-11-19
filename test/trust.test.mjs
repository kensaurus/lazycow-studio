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
import { approvalRefusal, AUTH_LIMIT, authFailLine, authLimiter, clientIp, COOKIE_DAYS, insideRoots, isNet, isSlug, MIN_TOKEN, overHttps, pathKey, proxyPeer, parseRange, readJson, refusal, serverMode, strayPath, tokenAttempt, tokenCookie, tokenOk, TOKEN_COOKIE, trustRules } from "../server/trust.mjs";

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

test("server mode: off by default, and never open beyond loopback without a long token (docs/self-host.md)", () => {
  const token = "t".repeat(MIN_TOKEN);
  assert.deepEqual(serverMode({}, ""), { bind: "127.0.0.1", extra: [], remote: false, error: null }, "the desktop default is unchanged");
  assert.match(serverMode({ STUDIO_HOST: "0.0.0.0", STUDIO_ALLOWED_HOSTS: "*" }, "").error, /STUDIO_API_TOKEN must be set/);
  assert.match(serverMode({ STUDIO_HOST: "0.0.0.0", STUDIO_ALLOWED_HOSTS: "*" }, "short").error, /at least 24/);
  assert.match(serverMode({ STUDIO_ALLOWED_HOSTS: "studio.example.ts.net" }, "").error, /STUDIO_API_TOKEN/, "a proxy name opens it too");
  assert.match(serverMode({ STUDIO_HOST: "0.0.0.0" }, token).error, /STUDIO_ALLOWED_HOSTS is empty/, "nothing would be answered");
  assert.deepEqual(serverMode({ STUDIO_HOST: "0.0.0.0", STUDIO_ALLOWED_HOSTS: " Studio.Example.ts.net , 192.168.1.20:4317 " }, token),
    { bind: "0.0.0.0", extra: ["studio.example.ts.net", "192.168.1.20:4317"], remote: true, error: null });
});

test("server mode: an allowed host gets in with the token, a rebinding name still does not", () => {
  const token = "t".repeat(MIN_TOKEN);
  const r = trustRules(4317, token, ["studio.example.ts.net", "192.168.1.20:4317"]);
  const auth = { authorization: `Bearer ${token}` };
  assert.equal(refusal({ method: "GET", url: "/api/overview", headers: { host: "studio.example.ts.net", ...auth } }, r), null);
  assert.equal(refusal({ method: "GET", url: "/api/overview", headers: { host: "192.168.1.20:4317", ...auth } }, r), null);
  assert.equal(refusal({ method: "GET", url: "/api/overview", headers: { host: "127.0.0.1:4317", ...auth } }, r), null, "loopback still works");
  assert.equal(refusal({ method: "GET", url: "/api/overview", headers: { host: "evil.example:4317", ...auth } }, r), "host");
  assert.equal(refusal({ method: "GET", url: "/api/overview", headers: { host: "studio.example.ts.net.evil.example", ...auth } }, r), "host", "no prefix match");
  assert.equal(refusal({ method: "GET", url: "/api/overview", headers: { host: "studio.example.ts.net" } }, r), "token");
  assert.equal(refusal({ method: "POST", url: "/api/publish", headers: { host: "studio.example.ts.net", origin: "https://studio.example.ts.net", ...auth } }, r), null);
  assert.equal(refusal({ method: "POST", url: "/api/publish", headers: { host: "studio.example.ts.net", origin: "https://evil.example", ...auth } }, r), "origin");
  const any = trustRules(4317, token, ["*"]);
  assert.equal(refusal({ method: "GET", url: "/api/overview", headers: { host: "10.0.0.5:4317", ...auth } }, any), null, "* accepts any name, with the token");
  assert.equal(refusal({ method: "GET", url: "/api/overview", headers: { host: "10.0.0.5:4317" } }, any), "token");
  assert.equal(refusal({ method: "GET", url: "/api/overview", headers: { host: "evil.example" } }, trustRules(4317)), "host", "the default never takes another name");
});

test("wrong tokens: which token a request presents, counted once per wrong value, never the token itself", () => {
  const t = "s3cret-token-of-24-chars";
  assert.deepEqual(tokenAttempt({}, "", t), { state: "none" }, "nothing presented is not a failure");
  assert.deepEqual(tokenAttempt({ authorization: "Bearer wrong" }, "", ""), { state: "none" }, "no token set: nothing to fail");
  assert.deepEqual(tokenAttempt({ authorization: `Bearer ${t}` }, "", t), { state: "ok" });
  assert.deepEqual(tokenAttempt({ cookie: `${TOKEN_COOKIE}=${t}` }, "", t), { state: "ok" });
  assert.deepEqual(tokenAttempt({}, t, t), { state: "ok" }, "/?token=");
  assert.deepEqual(tokenAttempt({ cookie: `${TOKEN_COOKIE}=old`, authorization: `Bearer ${t}` }, "", t), { state: "ok" }, "one right one is enough");
  for (const [h, q] of [[{ authorization: "Bearer guess" }, ""], [{ authorization: "Basic Zm9vOmJhcg==" }, ""], [{ cookie: `${TOKEN_COOKIE}=%E0` }, ""], [{}, "guess"]]) {
    const r = tokenAttempt(h, q, t);
    assert.equal(r.state, "wrong", JSON.stringify(h) + q);
    assert.match(r.key, /^[0-9a-f]{16}$/);
  }
  assert.equal(tokenAttempt({ authorization: "Bearer a" }, "", t).key, tokenAttempt({ authorization: "Bearer a" }, "", t).key, "the same wrong value, the same key");
  assert.notEqual(tokenAttempt({ authorization: "Bearer a" }, "", t).key, tokenAttempt({ authorization: "Bearer b" }, "", t).key);
  const at = new Date("2026-11-19T01:02:03Z");
  assert.equal(authFailLine("203.0.113.9", "GET", "/api/about", at), "2026-11-19T01:02:03.000Z lazycow auth failed ip=203.0.113.9 method=GET path=/api/about");
  const forged = authFailLine("203.0.113.9", "GET", "/api/x\nlazycow auth failed ip=1.1.1.1 ", at);
  assert.equal(forged.split("\n").length, 1, "a path cannot add a line");
  assert.match(forged, /^2026-11-19T01:02:03\.000Z lazycow auth failed ip=203\.0\.113\.9 method=GET path=\S+$/, "nor a space a fail2ban pattern could read");
  assert.equal(authFailLine("::1", "PO ST\n", "/", at), "2026-11-19T01:02:03.000Z lazycow auth failed ip=::1 method=POST path=/");
});

test("wrong tokens: a per-address pause after 10 in 10 minutes; others and successes are untouched; memory stays bounded", () => {
  assert.deepEqual([AUTH_LIMIT.tries, AUTH_LIMIT.windowMs], [10, 600_000]);
  const lim = authLimiter();
  const t0 = 1_000_000;
  for (let i = 0; i < 9; i++) assert.equal(lim.fail("203.0.113.9", `k${i}`, t0 + i), true);
  assert.equal(lim.fail("203.0.113.9", "k0", t0 + 20), false, "the same wrong value again (an old cookie) is not counted or logged twice");
  assert.equal(lim.wait("203.0.113.9", t0 + 30), 0, "9 different wrong values: still allowed");
  assert.equal(lim.fail("203.0.113.9", "k9", t0 + 40), true);
  assert.equal(lim.wait("203.0.113.9", t0 + 40), 600, "the 10th: paused until the window from the first failure ends");
  assert.equal(lim.wait("203.0.113.9", t0 + 599_000), 1);
  assert.equal(lim.wait("198.51.100.7", t0 + 40), 0, "another address is not paused");
  assert.equal(lim.wait("203.0.113.9", t0 + 600_000), 0, "the window passed");
  assert.equal(lim.fail("203.0.113.9", "k0", t0 + 600_001), true, "a new window counts from zero");
  const small = authLimiter({ tries: 2, windowMs: 1000, maxIps: 3 });
  for (let i = 0; i < 50; i++) small.fail(`10.0.0.${i}`, "k", i);
  assert.ok(small.size() <= 3, `kept ${small.size()} addresses`);
  for (let i = 0; i < 50; i++) small.fail("10.9.9.9", `k${i}`, 100);
  small.fail("10.9.9.10", "k", 5000);
  assert.ok(small.size() <= 3);
});

test("the client's address is the TCP peer, and forwarded headers count only from a trusted proxy", () => {
  const r = (remoteAddress, headers = {}, encrypted) => ({ socket: { remoteAddress, encrypted }, headers });
  assert.equal(clientIp(r("::ffff:203.0.113.9")), "203.0.113.9");
  assert.equal(clientIp(r("2001:db8::1")), "2001:db8::1");
  assert.equal(clientIp(r("127.0.0.1", { "x-forwarded-for": "198.51.100.7" })), "127.0.0.1", "not trusted: a client writes that header itself");
  assert.equal(clientIp(r("127.0.0.1", { "x-forwarded-for": "6.6.6.6, 198.51.100.7" }), true), "198.51.100.7", "trusted: the address the nearest proxy added");
  assert.equal(clientIp(r("127.0.0.1", { "x-forwarded-for": "1.1.1.1 ip=2.2.2.2" }), true), "unknown", "never anything a log line could be bent by");
  assert.equal(clientIp(r(undefined)), "unknown");
  assert.equal(overHttps(r("127.0.0.1", {}, true)), true, "a TLS socket");
  assert.equal(overHttps(r("127.0.0.1", { "x-forwarded-proto": "https" })), false, "not trusted");
  assert.equal(overHttps(r("127.0.0.1", { "x-forwarded-proto": "https" }), true), true);
  assert.equal(overHttps(r("127.0.0.1", { "x-forwarded-proto": "http" }), true), false);
});

test("the token cookie lasts 30 days, HttpOnly and SameSite=Lax, and is Secure over HTTPS", () => {
  assert.equal(COOKIE_DAYS, 30);
  assert.equal(tokenCookie("a b"), `${TOKEN_COOKIE}=a%20b; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
  assert.equal(tokenCookie("t", true), `${TOKEN_COOKIE}=t; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure`);
});

test("STUDIO_TRUST_PROXY trusts only a proxy next to the studio: loopback or a private network", () => {
  const r = (remoteAddress) => ({ socket: { remoteAddress }, headers: {} });
  for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "10.0.0.5", "172.18.0.1", "172.31.255.1", "192.168.1.20", "::ffff:192.168.1.20", "fd12:3456::1", "fc00::2"])
    assert.equal(proxyPeer(r(ip)), true, ip);
  for (const ip of ["203.0.113.9", "172.32.0.1", "172.15.0.1", "8.8.8.8", "2001:db8::1", "::ffff:8.8.8.8", "fe80::1", "", undefined])
    assert.equal(proxyPeer(r(ip)), false, String(ip));
});
