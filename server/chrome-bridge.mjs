/*
FILE: server/chrome-bridge.mjs
PURPOSE: "Use my Chrome": lets the browser helper drive the owner's real, signed-in Chrome through the
         Playwright extension (the "Playwright MCP Bridge", id mmlmfjhmonkocbjadbfplnigmagldckm), instead of
         launching a separate Chrome profile that is signed in to nothing.
OVERVIEW: A small relay on 127.0.0.1, ported from playwright-core 1.65.0 (Apache-2.0):
            src/tools/mcp/cdpRelay.ts      (the relay: one WebSocket path for the extension, one for Playwright)
            src/tools/mcp/cdpRelayV2.ts    (protocol v2 handshake: "extension.initialized")
            src/tools/mcp/browserModel.ts  (tabs <-> CDP sessions over chrome.debugger)
            src/tools/utils/extension.ts   (the extension id; finding the Chrome profile it is installed in)
          The extension's connect page (chrome-extension://<id>/connect.html?mcpRelayUrl=ws://127.0.0.1:<port>/extension/<uuid>)
          is opened in Chrome. The owner presses "Allow & select" once, or, when the extension's token is set
          (PLAYWRIGHT_MCP_EXTENSION_TOKEN, copied from that page), it connects with no click. Playwright then
          connects over CDP to ws://127.0.0.1:<port>/cdp/<uuid> and sees only this connection's own tabs (its own
          coloured "Playwright · Lazycow Studio" tab group): the extension keeps each client to its own tabs,
          so it sits beside another Playwright MCP client without touching that client's tabs.
          Commands that could close the owner's browser are refused here, never forwarded.
DEPENDENCIES: playwright-core (its bundled ws), an installed Chrome with the Playwright extension.
USAGE: const bridge = new ChromeBridge({ token }); await bridge.start(); openConnectPage(bridge.connectUrl());
       await bridge.waitForExtension(ms); const browser = await chromium.connectOverCDP(bridge.cdpUrl(), ...);
NOTES: The token is a secret: it is put only in the connect URL handed to Chrome, never logged or returned.
*/
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";

export const EXTENSION_ID = "mmlmfjhmonkocbjadbfplnigmagldckm";
export const EXTENSION_STORE = `https://chromewebstore.google.com/detail/playwright-extension/${EXTENSION_ID}`;
export const PROTOCOL_VERSION = 2;
/* Browser-level commands that would end the owner's session: answered here, never sent to Chrome. */
const REFUSED = new Set(["Browser.close", "Browser.crash", "Browser.crashGpuProcess", "Target.disposeBrowserContext"]);

/** Chrome's user data folder on this computer (Windows, macOS, Linux). */
export function chromeUserData() {
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "User Data");
  if (process.platform === "darwin") return join(process.env.HOME || "", "Library", "Application Support", "Google", "Chrome");
  return join(process.env.HOME || "", ".config", "google-chrome");
}

/** The Chrome profile folder ("Default", "Profile 1", …) that has the extension, last-used first; null if none. */
export function findExtensionProfile(userData = chromeUserData()) {
  let names = [];
  try { names = readdirSync(userData).filter((e) => e === "Default" || /^Profile \d+$/.test(e)); } catch { return null; }
  names.sort((a, b) => (a === "Default" ? -1 : +a.slice(8)) - (b === "Default" ? -1 : +b.slice(8)));
  let last = null;
  try { last = JSON.parse(readFileSync(join(userData, "Local State"), "utf8"))?.profile?.last_used || null; } catch { /* optional */ }
  const ordered = last && names.includes(last) ? [last, ...names.filter((n) => n !== last)] : names;
  return ordered.find((p) => hasExtension(join(userData, p))) || null;
}
function hasExtension(profileDir) {
  if (existsSync(join(profileDir, "Extensions", EXTENSION_ID))) return true;
  for (const f of ["Preferences", "Secure Preferences"]) {
    try {
      const rec = JSON.parse(readFileSync(join(profileDir, f), "utf8"))?.extensions?.settings?.[EXTENSION_ID];
      if (rec && typeof rec === "object" && Object.keys(rec).length) return true;
    } catch { /* next */ }
  }
  return false;
}

/** The installed Chrome (stable) executable, or null. */
export function chromeExecutable() {
  const c = process.platform === "win32"
    ? [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean).map((d) => join(d, "Google", "Chrome", "Application", "chrome.exe"))
    : process.platform === "darwin" ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"] : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"];
  return c.find((p) => existsSync(p)) || null;
}

/** Chrome's arguments to open a URL in the running Chrome. newWindow: in a window of its own. A plain new tab goes
    next to the active tab, and when that tab sits in another Playwright client's (collapsed) tab group the new
    tab joins that group, out of sight; that is how a connect page "never appeared" (2026-11-09). */
export function chromeArgs(url, { profile, newWindow = false } = {}) {
  return [...(profile ? [`--profile-directory=${profile}`] : []), ...(newWindow ? ["--new-window"] : []), url];
}
/** Open a URL in the owner's running Chrome, in the profile that has the extension. Shown, never hidden. */
export function openInChrome(url, { profile, exe = chromeExecutable(), newWindow = false } = {}) {
  if (!exe) throw new Error("Google Chrome is not installed in its usual place");
  spawn(exe, chromeArgs(url, { profile, newWindow }), { detached: true, stdio: "ignore", windowsHide: false, shell: false }).unref();
}

/* ---------- the helper's own Chrome windows (Windows): remembered, so a new connect closes the old one ---------- */
const WIN_PS = String.raw`
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic; using System.Diagnostics;
public class LcWin { public delegate bool P(IntPtr h, IntPtr l);
[DllImport("user32.dll")] static extern bool EnumWindows(P f, IntPtr l);
[DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
[DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
public static string List() { var r = new List<string>(); EnumWindows((h, l) => { if (!IsWindowVisible(h)) return true; uint pid; GetWindowThreadProcessId(h, out pid);
  string name = ""; try { name = Process.GetProcessById((int)pid).ProcessName; } catch {} if (name != "chrome") return true;
  var sb = new StringBuilder(512); GetWindowText(h, sb, 512); if (sb.Length == 0) return true;
  r.Add(h.ToInt64() + "\t" + sb.ToString().Replace("\t", " ")); return true; }, IntPtr.Zero); return string.Join("\n", r); } }
"@
`;
function powershell(script) {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 20000, windowsHide: true });
  return r.status === 0 ? String(r.stdout || "") : "";
}
/** Chrome's visible top-level windows: [{hwnd, title}] (empty off Windows). */
export function chromeWindows() {
  if (process.platform !== "win32") return [];
  return powershell(`${WIN_PS}\n[LcWin]::List()`).split(/\r?\n/).map((l) => l.split("\t")).filter((x) => /^\d+$/.test(x[0])).map(([hwnd, title]) => ({ hwnd, title: title || "" }));
}
/** Ask Chrome to close these windows (never one whose title is not the connect page's: a window the person browsed in stays). */
export function closeChromeWindows(hwnds, { onlyTitle = /^Welcome - Google Chrome$/ } = {}) {
  if (process.platform !== "win32" || !hwnds?.length) return 0;
  const open = new Map(chromeWindows().map((w) => [w.hwnd, w.title]));
  const doomed = hwnds.filter((h) => /^\d+$/.test(String(h)) && open.has(String(h)) && onlyTitle.test(open.get(String(h))));
  if (!doomed.length) return 0;
  powershell(`${WIN_PS}\n${doomed.map((h) => `[void][LcWin]::PostMessage([IntPtr]${h}, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)`).join("\n")}`);
  return doomed.length;
}

/** The connect page address the extension answers. The token (secret) is added only when given. */
export function connectPageUrl({ relayUrl, clientName = "Lazycow Studio", token = "", tabGroup = true }) {
  const u = new URL(`chrome-extension://${EXTENSION_ID}/connect.html`);
  u.searchParams.set("mcpRelayUrl", relayUrl);
  u.searchParams.set("client", JSON.stringify({ name: clientName }));
  u.searchParams.set("protocolVersion", String(PROTOCOL_VERSION));
  if (!tabGroup) u.searchParams.set("tabGroup", "false");
  if (token) u.searchParams.set("token", token);
  return u.toString();
}

/* ---------- the tab model (browserModel.ts): our tabs <-> the CDP sessions Playwright sees ---------- */
class TabModel {
  constructor(toExtension) {
    this.toExtension = toExtension;
    this.emitTo = null;           // set once Playwright is connected
    this.known = new Map();       // tabId -> tab, as the extension reported them (only this connection's tabs)
    this.sessions = new Map();    // tabId -> {tabId, sessionId, targetInfo, children}
    this.autoAttach = false;
    this.next = 1;
  }
  emit(msg) { this.emitTo?.(msg); }
  onTabCreated(tab) {
    if (tab?.id === undefined) return;
    this.known.set(tab.id, tab);
    if (this.autoAttach) this.attach(tab.id).catch(() => {});
  }
  onTabRemoved(tabId) { this.known.delete(tabId); this.detach(tabId); }
  onDebuggerEvent(source, method, params) {
    const s = source?.tabId !== undefined && this.sessions.get(source.tabId);
    if (!s) return;
    const child = params?.sessionId;
    if (method === "Target.attachedToTarget" && child) s.children.add(child);
    else if (method === "Target.detachedFromTarget" && child) s.children.delete(child);
    this.emit({ sessionId: source.sessionId || s.sessionId, method, params });
  }
  async enableAutoAttach() {
    this.autoAttach = true;
    await Promise.all([...this.known.keys()].map((id) => this.attach(id).catch(() => {})));
  }
  async createTarget(url) {
    const tab = await this.toExtension("chrome.tabs.create", [{ url }]);
    if (tab?.id === undefined) throw new Error("Failed to create tab");
    this.known.set(tab.id, tab);
    const s = await this.attach(tab.id);
    return { targetId: s.targetInfo?.targetId };
  }
  async closeTarget(targetId) {
    const s = [...this.sessions.values()].find((x) => x.targetInfo?.targetId === targetId);
    if (!s) return { success: false };  // never a tab this connection does not hold
    await this.toExtension("chrome.tabs.remove", [s.tabId]);
    return { success: true };
  }
  targetInfo(sessionId) { return [...this.sessions.values()].find((x) => x.sessionId === sessionId)?.targetInfo; }
  async browserCommand(method, params) {
    const s = this.sessions.values().next().value;
    if (!s) throw new Error(`No attached tab to forward browser-level command: ${method}`);
    return this.toExtension("chrome.debugger.sendCommand", [{ tabId: s.tabId }, method, params]);
  }
  async command(sessionId, method, params) {
    let s = [...this.sessions.values()].find((x) => x.sessionId === sessionId), child;
    if (!s) { s = [...this.sessions.values()].find((x) => x.children.has(sessionId)); child = sessionId; }
    if (!s) throw new Error(`No tab found for sessionId: ${sessionId}`);
    return this.toExtension("chrome.debugger.sendCommand", [{ tabId: s.tabId, sessionId: child }, method, params]);
  }
  async attach(tabId) {
    const have = this.sessions.get(tabId);
    if (have) return have;
    await this.toExtension("chrome.debugger.attach", [{ tabId }, "1.3"]);
    const r = await this.toExtension("chrome.debugger.sendCommand", [{ tabId }, "Target.getTargetInfo"]);
    const s = { tabId, sessionId: `lc-tab-${this.next++}`, targetInfo: r?.targetInfo, children: new Set() };
    this.sessions.set(tabId, s);
    this.emit({ method: "Target.attachedToTarget", params: { sessionId: s.sessionId, targetInfo: { ...s.targetInfo, attached: true }, waitingForDebugger: false } });
    return s;
  }
  detach(tabId) {
    const s = this.sessions.get(tabId);
    if (!s) return;
    this.sessions.delete(tabId);
    this.emit({ method: "Target.detachedFromTarget", params: { sessionId: s.sessionId, targetId: s.targetInfo?.targetId } });
  }
}

/* ---------- the relay (cdpRelay.ts) ---------- */
export class ChromeBridge {
  constructor({ token = "", clientName = "Lazycow Studio" } = {}) {
    this.token = token;
    this.clientName = clientName;
    const id = randomUUID();
    this.cdpPath = `/cdp/${id}`;
    this.extPath = `/extension/${id}`;
    this.ext = null; this.cdp = null;
    this.calls = new Map(); this.lastId = 0;
    this.model = new TabModel((method, params) => this.toExtension(method, params));
    this.ready = new Promise((ok, fail) => { this._ready = ok; this._fail = fail; });
    this.ready.catch(() => {});
    this.onclose = null;
  }
  async start() {
    const req = createRequire(import.meta.url);
    const { wsServer: WSS } = req("playwright-core/lib/utilsBundle");
    this.wss = new WSS({ noServer: true });
    this.http = createServer((q, s) => { s.statusCode = 404; s.end(); });
    this.http.on("upgrade", (request, socket, head) => {
      const path = new URL(request.url, "http://127.0.0.1").pathname;
      const origin = request.headers.origin;
      // The extension connects from its own origin; Playwright (this process) sends none. A web page cannot get in.
      const ok = (path === this.extPath && origin === `chrome-extension://${EXTENSION_ID}`) || (path === this.cdpPath && !origin);
      if (!ok) { socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); return socket.destroy(); }
      this.wss.handleUpgrade(request, socket, head, (ws) => (path === this.cdpPath ? this.onPlaywright(ws) : this.onExtension(ws)));
    });
    await new Promise((ok, fail) => { this.http.once("error", fail); this.http.listen(0, "127.0.0.1", ok); });
    this.port = this.http.address().port;
  }
  relayUrl() { return `ws://127.0.0.1:${this.port}${this.extPath}`; }
  cdpUrl() { return `ws://127.0.0.1:${this.port}${this.cdpPath}`; }
  connectUrl() { return connectPageUrl({ relayUrl: this.relayUrl(), clientName: this.clientName, token: this.token }); }
  get connected() { return !!this.ext && this.ext.readyState === 1; }

  /** Resolves once the extension has connected and said it is initialized; rejects after ms. */
  waitForExtension(ms) {
    let t;
    const timeout = new Promise((_, fail) => { t = setTimeout(() => fail(new Error("timeout")), ms); });
    return Promise.race([this.ready, timeout]).finally(() => clearTimeout(t));
  }
  onExtension(ws) {
    if (this.ext) return ws.close(1000, "Another extension connection already established");
    this.ext = ws;
    ws.on("message", (data) => {
      let m;
      try { m = JSON.parse(data.toString()); } catch { return ws.close(); }
      if (m.id && this.calls.has(m.id)) {
        const c = this.calls.get(m.id); this.calls.delete(m.id);
        return m.error ? c.fail(new Error(typeof m.error === "string" ? m.error : m.error.message || "extension error")) : c.ok(m.result);
      }
      if (m.id) return;
      this.onExtensionEvent(m.method, m.params || []);
    });
    ws.on("close", (_code, reason) => {
      for (const c of this.calls.values()) c.fail(new Error("extension disconnected"));
      this.calls.clear();
      this._fail(new Error(`extension disconnected: ${reason}`));
      if (this.cdp?.readyState === 1) this.cdp.close(1000, "Extension disconnected");
      this.onclose?.();
    });
    ws.on("error", () => {});
  }
  onExtensionEvent(method, params) {
    if (method === "extension.initialized") return this._ready();
    if (method === "chrome.tabs.onCreated") return this.model.onTabCreated(params[0]);
    if (method === "chrome.tabs.onRemoved") return this.model.onTabRemoved(params[0]);
    if (method === "chrome.debugger.onEvent") return this.model.onDebuggerEvent(params[0], params[1], params[2]);
    if (method === "chrome.debugger.onDetach") return this.model.detach(params[0]?.tabId);
  }
  toExtension(method, params) {
    if (!this.connected) return Promise.reject(new Error("Extension not connected"));
    const id = ++this.lastId;
    this.ext.send(JSON.stringify({ id, method, params }));
    return new Promise((ok, fail) => this.calls.set(id, { ok, fail }));
  }
  onPlaywright(ws) {
    if (!this.connected) return ws.close(1000, "Extension not connected");
    if (this.cdp) return ws.close(1000, "Another CDP client already connected");
    this.cdp = ws;
    this.model.emitTo = (msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
    ws.on("message", async (data) => {
      let m;
      try { m = JSON.parse(data.toString()); } catch { return; }
      const { id, sessionId, method, params } = m;
      try {
        const result = await this.cdpCommand(method, params, sessionId);
        this.model.emit({ id, sessionId, result });
      } catch (e) {
        this.model.emit({ id, sessionId, error: { message: e.message } });
      }
    });
    ws.on("close", () => { this.cdp = null; this.ext?.close(1000, "Playwright client disconnected"); });
    ws.on("error", () => {});
  }
  async cdpCommand(method, params, sessionId) {
    if (REFUSED.has(method)) return {};
    if (method === "Browser.getVersion") return { protocolVersion: "1.3", product: "Chrome/Extension-Bridge", userAgent: "CDP-Bridge-Server/1.0.0" };
    if (method === "Browser.setDownloadBehavior") return {};
    if (method === "Target.setAutoAttach" && !sessionId) { await this.model.enableAutoAttach(); return {}; }
    if (method === "Target.createTarget") return this.model.createTarget(params?.url);
    if (method === "Target.closeTarget") return this.model.closeTarget(params?.targetId);
    if (method === "Target.getTargetInfo") return this.model.targetInfo(sessionId);
    return sessionId ? this.model.command(sessionId, method, params) : this.model.browserCommand(method, params);
  }
  stop() {
    this._fail(new Error("stopped"));  // anyone still waiting for the Allow click hears it ended (no-op once connected)
    try { this.cdp?.close(1000, "stopped"); } catch { /* gone */ }
    try { this.ext?.close(1000, "stopped"); } catch { /* gone */ }
    try { this.wss?.close(); } catch { /* gone */ }
    try { this.http?.close(); } catch { /* gone */ }
  }
}
