/**
 * FILE: test/chrome-bridge.test.mjs
 * PURPOSE: The "use my Chrome" relay (server/chrome-bridge.mjs) without Chrome: a fake Playwright extension
 *          speaks protocol v2 over a real WebSocket. Checks the connect page address, that only the extension's
 *          origin and this process can connect, the handshake, tab creation, and that the relay never forwards
 *          a command that could close the owner's browser or a tab it does not hold.
 * USAGE: npm test
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChromeBridge, chromeArgs, connectPageUrl, EXTENSION_ID, findExtensionProfile } from "../server/chrome-bridge.mjs";

test("the connect page opens in a window of its own, in the extension's profile (never a tab that could hide in a group)", () => {
  assert.deepEqual(chromeArgs("chrome-extension://x/connect.html?a=1&b=2", { profile: "Default", newWindow: true }),
    ["--profile-directory=Default", "--new-window", "chrome-extension://x/connect.html?a=1&b=2"]);
  assert.deepEqual(chromeArgs("https://example.com/", {}), ["https://example.com/"]);
});

const { ws: WebSocket } = createRequire(import.meta.url)("playwright-core/lib/utilsBundle");
const EXT_ORIGIN = `chrome-extension://${EXTENSION_ID}`;

function open(url, origin) {
  return new Promise((ok, fail) => {
    const s = new WebSocket(url, origin ? { origin } : {});
    s.once("open", () => ok(s));
    s.once("error", fail);
    s.once("unexpected-response", (_req, res) => fail(new Error(`HTTP ${res.statusCode}`)));
  });
}
/** A fake extension: answers chrome.* calls like the real one and records what it was asked. */
async function fakeExtension(bridge) {
  const asked = [];
  const s = await open(bridge.relayUrl(), EXT_ORIGIN);
  let nextTab = 100;
  s.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    asked.push(m.method);
    let result = {};
    if (m.method === "chrome.tabs.create") result = { id: nextTab++, url: m.params[0].url };
    if (m.method === "chrome.debugger.sendCommand" && m.params[1] === "Target.getTargetInfo") result = { targetInfo: { targetId: `T${m.params[0].tabId}`, type: "page", url: "about:blank" } };
    s.send(JSON.stringify({ id: m.id, result }));
  });
  // As the real extension does once the owner allows it: report the chosen tab, then say it is ready.
  s.send(JSON.stringify({ method: "chrome.tabs.onCreated", params: [{ id: 7, url: "chrome-extension://x/connect.html" }] }));
  s.send(JSON.stringify({ method: "extension.initialized", params: [] }));
  return { s, asked };
}
function cdpClient(sock) {
  let id = 0;
  const waiting = new Map(), events = [];
  sock.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } else events.push(m);
  });
  return { events, send: (method, params, sessionId) => new Promise((ok) => { const i = ++id; waiting.set(i, ok); sock.send(JSON.stringify({ id: i, method, params, sessionId })); }) };
}

test("the connect page address carries the relay, the client name and protocol v2; the token only when set", () => {
  const u = new URL(connectPageUrl({ relayUrl: "ws://127.0.0.1:5000/extension/abc", clientName: "Lazycow Studio" }));
  assert.equal(u.protocol + "//" + u.host, EXT_ORIGIN);
  assert.equal(u.pathname, "/connect.html");
  assert.equal(u.searchParams.get("mcpRelayUrl"), "ws://127.0.0.1:5000/extension/abc");
  assert.equal(JSON.parse(u.searchParams.get("client")).name, "Lazycow Studio");
  assert.equal(u.searchParams.get("protocolVersion"), "2");
  assert.equal(u.searchParams.has("token"), false);
  assert.equal(new URL(connectPageUrl({ relayUrl: "ws://127.0.0.1:1/extension/x", token: "t0k" })).searchParams.get("token"), "t0k");
});

test("relay: only the extension's origin and this process get in; a web page is refused", async () => {
  const bridge = new ChromeBridge();
  await bridge.start();
  try {
    assert.match(bridge.relayUrl(), /^ws:\/\/127\.0\.0\.1:\d+\/extension\/[0-9a-f-]{36}$/);
    await assert.rejects(open(bridge.relayUrl(), "https://evil.example"), /403/);
    await assert.rejects(open(bridge.cdpUrl(), "https://evil.example"), /403/);
    await assert.rejects(open(bridge.relayUrl().replace(/extension\/.*/, "extension/guess"), EXT_ORIGIN), /403/);
    await assert.rejects(bridge.waitForExtension(50), /timeout/);
    // Waiting with no deadline (the Welcome page waits until Allow or Cancel) ends when the relay is stopped.
    const waiting = bridge.ready;
    bridge.stop();
    await assert.rejects(waiting, /stopped/);
  } finally { bridge.stop(); }
});

test("relay: handshake, a new tab of its own, and nothing that could close the owner's browser or tabs", async () => {
  const bridge = new ChromeBridge();
  await bridge.start();
  const ext = await fakeExtension(bridge);
  try {
    await bridge.waitForExtension(2000);
    const cdp = cdpClient(await open(bridge.cdpUrl()));
    assert.equal((await cdp.send("Browser.getVersion")).result.product, "Chrome/Extension-Bridge");
    await cdp.send("Target.setAutoAttach", { autoAttach: true });
    assert.ok(ext.asked.includes("chrome.debugger.attach"), "the allowed tab is attached");
    const made = await cdp.send("Target.createTarget", { url: "about:blank" });
    assert.equal(made.result.targetId, "T100");
    assert.equal(ext.asked.filter((m) => m === "chrome.tabs.create").length, 1);
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(cdp.events.some((e) => e.method === "Target.attachedToTarget" && e.params.targetInfo.targetId === "T100"));

    const before = ext.asked.length;
    assert.deepEqual((await cdp.send("Browser.close")).result, {}, "answered here");
    assert.deepEqual((await cdp.send("Target.closeTarget", { targetId: "someone-elses-tab" })).result, { success: false });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(ext.asked.length, before, "neither was sent to Chrome");
    assert.deepEqual((await cdp.send("Target.closeTarget", { targetId: "T100" })).result, { success: true });
    assert.equal(ext.asked.at(-1), "chrome.tabs.remove");
  } finally { ext.s.close(); bridge.stop(); }
});

test("findExtensionProfile finds the profile with the extension, last-used first", () => {
  const dir = mkdtempSync(join(tmpdir(), "lazycow-chrome-"));
  try {
    for (const p of ["Default", "Profile 1", "Profile 2"]) mkdirSync(join(dir, p));
    assert.equal(findExtensionProfile(dir), null);
    mkdirSync(join(dir, "Profile 2", "Extensions", EXTENSION_ID), { recursive: true });
    writeFileSync(join(dir, "Profile 1", "Preferences"), JSON.stringify({ extensions: { settings: { [EXTENSION_ID]: { state: 1 } } } }));
    assert.equal(findExtensionProfile(dir), "Profile 1");
    writeFileSync(join(dir, "Local State"), JSON.stringify({ profile: { last_used: "Profile 2" } }));
    assert.equal(findExtensionProfile(dir), "Profile 2");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
