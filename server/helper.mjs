/*
FILE: server/helper.mjs
PURPOSE: The browser helper. For networks the studio cannot post to by itself (LinkedIn, Threads,
         TikTok, X, Pinterest, Google Maps, LINE...), it opens the network's upload page in a Chrome
         window the studio drives, puts the reel's video in, and writes the post text, so the person
         only checks and presses Post.
OVERVIEW: One Chrome window with its own profile (STUDIO_HOME/browser), so sign-ins are remembered
          after the first time. `prepare({network, url, file, text})` opens a tab, catches the site's
          file picker (no dialog appears) and gives it the file straight from disk, then fills the
          first text box it can find and also leaves the text on the clipboard.
          In `prepare()` the final Post / Schedule press is left to the person.
          `schedule({network, file, text, at})` goes further for X, TikTok and Google Maps (the owner's
          standing approval, approved reels only): it sets the date and time, checks what the site shows
          against what was asked, and only then presses Schedule, then checks the site took it.
          The pure parts (time conversion, the week planner, the refusal rules) are exported for tests.
DEPENDENCIES: playwright-core (npm), an installed Chrome or Edge.
USAGE: import { helperStatus, prepare, schedule, planWeek, scheduleRefusal } from "./helper.mjs";
NOTES: Each step that fails returns a plain sentence with what to do, never a stack trace.
       docs/helper.md says what each network's recipe does and its limits.
*/
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChromeBridge, chromeExecutable, chromeWindows, closeChromeWindows, EXTENSION_STORE, findExtensionProfile, openInChrome } from "./chrome-bridge.mjs";

/* Where to sign in, and the cookie a signed-in visitor carries (only its presence is read, never its value). */
export const SIGNIN = {
  pinterest: { url: "https://www.pinterest.com/login/", host: "pinterest.", cookie: null }, // its _auth cookie exists signed out too
  x: { url: "https://x.com/login", host: "x.com", cookie: "auth_token" },
  threads: { url: "https://www.threads.com/login", host: "threads.", cookie: "sessionid" },
  linkedin: { url: "https://www.linkedin.com/login", host: "linkedin.com", cookie: "li_at" },
  tiktok: { url: "https://www.tiktok.com/login", host: "tiktok.com", cookie: "sessionid" },
  facebook: { url: "https://www.facebook.com/login", host: "facebook.com", cookie: "c_user" },
  gbp: { url: "https://business.google.com/locations", host: "google.com", cookie: "SID" },
  "line-voom": { url: "https://manager.line.biz/", host: "line.biz", cookie: null },
  "line-oa": { url: "https://manager.line.biz/", host: "line.biz", cookie: null },
};

/* Per network: where the composer is, what to click to get a file picker, and where the text goes.
   Anything missing falls back to the generic search below, so a site redesign degrades to
   "the page is open, the text is on the clipboard" instead of breaking. */
export const RECIPES = {
  bluesky: { url: (text) => `https://bsky.app/intent/compose?text=${encodeURIComponent(text)}`, textInUrl: true,
    pick: [/メディアを追加|Add media/i], signin: /bsky\.app\/?$|\/login/ },
  x: { url: () => "https://x.com/compose/post", text: '[data-testid="tweetTextarea_0"]', input: '[data-testid="fileInput"]', signin: /\/login|\/i\/flow|\/i\/jf\/onboarding/ },
  threads: { url: () => "https://www.threads.com/", open: [/^(作成|Create|新しいスレッド|New thread)$/], pick: [/メディアを添付|Attach media/i], signin: /login/ },
  linkedin: { open: [/^(投稿を開始|Start a post|Create)$/], pick: [/動画|メディアを追加|Add media|Video/i], signin: /\/login|\/uas\/|authwall/ },
  tiktok: { url: () => "https://www.tiktok.com/tiktokstudio/upload", text: '[contenteditable="true"]', signin: /\/login/ },
  pinterest: { url: () => "https://www.pinterest.com/pin-creation-tool/", signin: /\/login|\/signup/ },
  facebook: { url: () => "https://business.facebook.com/latest/reels_composer", pick: [/^Add Video$|^動画を追加$/], signin: /login/ },
  youtube: { url: () => "https://www.youtube.com/upload", signin: /accounts\.google\.com/ },
  gbp: { url: () => "https://business.google.com/locations", signin: /accounts\.google\.com/ },
  "line-voom": { url: () => "https://manager.line.biz/", signin: /access\.line\.me|account\.line\.biz\/login/ },
  /* LINE broadcast: open the account's "create message" page, write the text in the first bubble, add a second
     bubble, switch it to video and open LINE's upload box; the file box inside that box takes the video. Nothing
     is sent: the person checks it and presses 配信 (or sets a time) there. */
  "line-oa": { url: () => "https://manager.line.biz/", text: "textarea", signin: /access\.line\.me|account\.line\.biz\/login/,
    before: async (page, text) => {
      const acct = await page.locator('a[href*="/account/@"]').first().getAttribute("href", { timeout: 8000 }).catch(() => null);
      const id = acct?.match(/\/account\/(@[^/?#]+)/)?.[1];
      if (!id) return;
      await page.goto(`https://manager.line.biz/account/${id}/broadcast/create`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.locator("textarea").first().waitFor({ timeout: 15000 });
      await page.locator("textarea").first().fill(text);
      // "追加" (add a bubble) does not answer a pointer click from the helper; a direct click on the visible one does.
      const added = await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => x.innerText.trim() === "追加" && x.offsetParent); b?.click(); return !!b; });
      if (!added) throw Object.assign(new Error("LINE: the 追加 button to add the video bubble was not found."), { plain: true });
      await page.waitForTimeout(800);
      // The type buttons carry their name as a tooltip (title / data-original-title), not as text.
      await page.evaluate(() => [...document.querySelectorAll("button")]
        .filter((b) => (b.title || b.getAttribute("aria-label") || b.getAttribute("data-original-title")) === "動画").pop()?.click());
      await page.waitForTimeout(800);
      await page.getByText("動画をアップロード", { exact: true }).last().click({ timeout: 5000 });
      await page.waitForTimeout(1200);
    } },
};
const GENERIC_PICK = /^(Upload|Select (video|file)s?|Add (video|media|photo)s?|Choose file|動画を(選択|追加|アップロード)|ファイルを選択|アップロード|メディアを追加)$/i;
const GENERIC_OPEN = /^(Create|New post|Post|作成|投稿|新規投稿)$/i;

let ctx = null, opening = null, lib = null;

async function loadLib() {
  if (lib) return lib;
  try { lib = await import("playwright-core"); return lib; }
  catch { return null; }
}

/* ---------- which browser: the owner's own Chrome (through the Playwright extension) or the helper's own window ----------
   STUDIO_HELPER_BROWSER: "extension" (your Chrome), "own" (a separate window, signed in to nothing until you sign in
   there), or empty = your Chrome when the extension is installed. PLAYWRIGHT_MCP_EXTENSION_TOKEN (copied from the
   extension's connect page) skips the one "Allow" click. server/chrome-bridge.mjs is the relay; docs/helper.md. */
const browserMode = { want: "auto", token: "", using: null, note: "", bridge: null, anchors: new Set(), pending: null, lastError: null };
/* How long a connect window waits for "Allow & select" before the helper gives up (jobs wait as long). */
const CONNECT_WAIT_MS = 10 * 60e3;
const PENDING_MESSAGE = {
  click: "A Chrome window titled \"Welcome\" opened (Playwright Extension). Press \"Allow & select\" next to its own tab, once. The helper then works in that window, beside your signed-in sessions. To skip this click next time, copy the PLAYWRIGHT_MCP_EXTENSION_TOKEN line shown there into the studio's .env.",
  token: "Connecting to your Chrome (no click needed: the token in .env is used).",
};
/** Called once by the server with its settings. The token is kept in memory only and never returned. */
export function configureHelper({ browser, token } = {}) {
  const b = String(browser || "").trim().toLowerCase();
  browserMode.want = b === "own" || b === "extension" ? b : "auto";
  if (typeof token === "string") browserMode.token = token.trim();
}
/** The Chrome link key, saved from Settings (kept in memory only, never returned). Empty turns auto-connect off. */
export function setExtensionToken(token) { browserMode.token = String(token || "").trim(); }
/** With the key saved, connect to Chrome with no click: at studio start and whenever the link drops. */
let reconnectTimer = null;
let linkWanted = () => true;
/** When should the link be held open by itself? (the server says: only when the open project posts through Chrome) */
export function setLinkWanted(fn) { linkWanted = fn; }
export function autoReconnect(delayMs = 4000) {
  if (!browserMode.token || ctx || browserMode.pending || reconnectTimer) return;
  try { if (!linkWanted()) return; } catch { /* unknown: link as before */ }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!browserMode.token || ctx || browserMode.pending) return;
    beginConnect().catch((e) => { browserMode.lastError = { at: new Date().toISOString(), message: String(e.message || e).split("\n")[0] }; });
  }, delayMs);
}
/* Where the person signs in, in plain words, for the browser the helper is using. */
const where = () => (browserMode.using === "extension" ? "in your Chrome (the tab is open)" : "in the helper window once (it remembers you)");
/** Is the Playwright extension usable on this computer? {ok, why, profile, exe}. */
function extensionAvailable() {
  const exe = chromeExecutable();
  if (!exe) return { ok: false, why: "Google Chrome is not installed in its usual place" };
  const profile = findExtensionProfile();
  if (!profile) return { ok: false, why: "the Playwright extension is not installed in Chrome" };
  return { ok: true, profile, exe };
}
/** What the Accounts page shows about the helper's browser (never the token). */
export function browserState() {
  const ext = extensionAvailable();
  const mode = browserMode.using || (browserMode.want !== "own" && ext.ok ? "extension" : "own");
  const p = browserMode.pending;
  return { mode, setting: browserMode.want, connected: !!ctx, extensionInstalled: ext.ok, extensionStore: EXTENSION_STORE,
    autoConnect: !!browserMode.token,
    pending: p ? { since: new Date(p.since).toISOString(), until: p.wait ? new Date(p.since + p.wait).toISOString() : null, message: p.message } : null,
    lastError: browserMode.lastError,
    error: browserMode.lastError?.message || null,
    note: browserMode.note || (browserMode.want !== "own" && !ext.ok ? `Using the helper's own window: ${ext.why}.`
      : ctx && browserMode.using === "extension" ? "Connected to your Chrome. Keep its \"Welcome\" window open (minimizing is fine): closing it disconnects the helper." : "") };
}
/** The extension to use (your Chrome), or null when the helper uses its own window. */
function wantsExtension() {
  const ext = extensionAvailable();
  return browserMode.want !== "own" && ext.ok ? ext : null;
}
/* The helper's connect windows, by window handle, kept across restarts: a new connect closes the old one, so Chrome
   does not fill up with dead "Welcome" windows (2026-11-09: eleven were open). */
const WINDOWS_FILE = join(tmpdir(), "lazycow-helper-windows.json");
function openConnectWindow(url, ext) {
  let old = [];
  try { old = JSON.parse(readFileSync(WINDOWS_FILE, "utf8")); } catch { /* none yet */ }
  try { closeChromeWindows(old); } catch { /* best effort */ }
  const before = new Set(chromeWindows().map((w) => w.hwnd));
  openInChrome(url, { profile: ext.profile, exe: ext.exe, newWindow: true });
  setTimeout(() => {
    try {
      const fresh = chromeWindows().filter((w) => !before.has(w.hwnd)).map((w) => w.hwnd);
      if (fresh.length) writeFileSync(WINDOWS_FILE, JSON.stringify(fresh));
    } catch { /* best effort */ }
  }, 3000);
}
/** Start connecting to your Chrome and return at once: a small "Welcome" window opens there for the one Allow click
    (none with the token). While it waits, browserState().pending says so; jobs wait for the same connection.
    reopen: open the window again (the person closed or missed it). Never blocks on the click. */
export async function beginConnect({ reopen = false } = {}) {
  if (ctx) return browserState();
  const ext = wantsExtension();
  if (!ext) return browserState();
  const was = browserMode.pending;
  if (was) {
    if (reopen) { try { openConnectWindow(was.bridge.connectUrl(), ext); } catch { /* the state says it is waiting */ } }
    return browserState();
  }
  const pw = await loadLib();
  if (!pw) throw Object.assign(new Error("The browser helper is not installed yet: press Install helper (one time, about 10 MB)."), { status: 400 });
  const bridge = new ChromeBridge({ token: browserMode.token, clientName: "Lazycow Studio" });
  await bridge.start();
  // No click deadline: the relay stays up until Allow or Cancel, so the Welcome page never points at a dead relay
  // ("Failed to connect to MCP relay: WebSocket error" was a page whose relay had already timed out, 2026-11-09).
  const wait = browserMode.token ? 30000 : 0;
  const pending = { since: Date.now(), wait, bridge, message: browserMode.token ? PENDING_MESSAGE.token : PENDING_MESSAGE.click };
  browserMode.pending = pending;
  browserMode.lastError = null;
  pending.promise = (async () => {
    // Its own window: a new tab in your window could land inside another client's collapsed tab group, out of sight.
    openConnectWindow(bridge.connectUrl(), ext);
    try {
      await (wait ? bridge.waitForExtension(wait) : bridge.ready);
    } catch (e) {
      if (pending.cancelled) throw Object.assign(new Error("Connecting to your Chrome was cancelled."), { status: 409, plain: true });
      throw Object.assign(new Error(browserMode.token
        ? "Your Chrome did not accept the helper within 30 seconds. The token in .env (PLAYWRIGHT_MCP_EXTENSION_TOKEN) may be old: copy it again from the Playwright \"Welcome\" window, then try again."
        : `The Welcome page let go before connecting (${String(e.message || e).split("\n")[0]}). Press Connect again; a new window opens.`), { status: 409, plain: true, cause: e });
    }
    const browser = await pw.chromium.connectOverCDP(bridge.cdpUrl(), { isLocal: true, timeout: 0, noDefaults: true });
    const c = browser.contexts()[0];
    if (!c) throw new Error("the extension gave no browser context");
    // The tab you allowed stays yours: the helper never closes or navigates a tab it did not open.
    browserMode.anchors = new Set(c.pages());
    browserMode.bridge = bridge;
    browserMode.using = "extension";
    browserMode.note = "";
    const gone = () => {
      if (ctx === c) {
        ctx = null;
        // Closing the "Welcome" window (its last tab) ends the extension's connection for this client.
        browserMode.lastError = { at: new Date().toISOString(), message: "The helper's Chrome window (\"Welcome\") was closed, so the helper let go of your Chrome. Press Connect to connect again." };
      }
      if (browserMode.bridge === bridge) browserMode.bridge = null;
      bridge.stop();
      autoReconnect();  // with the Chrome link key saved, the studio links up again on its own
    };
    browser.on("disconnected", gone);
    bridge.onclose = gone;
    ctx = c;
    return c;
  })();
  pending.promise.then(() => { browserMode.lastError = null; }, (e) => {
    bridge.stop();
    browserMode.lastError = { at: new Date().toISOString(), message: String(e.message || e).split("\n")[0] };
  }).finally(() => { if (browserMode.pending === pending) browserMode.pending = null; });
  return browserState();
}
/** Stop waiting for the Allow click (the Welcome window can be closed by hand). */
export function cancelConnect() {
  const p = browserMode.pending;
  if (p) { p.cancelled = true; p.bridge.stop(); }
  return browserState();
}

export async function helperStatus(home) {
  const pw = await loadLib();
  const browser = browserState();
  let s = home ? signins(home) : {};
  if (browser.mode === "extension") {
    // Your Chrome: only what it says right now counts; the helper's old window does not.
    s = Object.fromEntries(Object.keys(SIGNIN).map((n) => [n, null]));
    if (ctx) s = { ...s, ...(await liveSignins(ctx).catch(() => ({}))) };
  }
  return { installed: !!pw, open: !!ctx, pages: ctx ? ctx.pages().map((pg) => pg.url().split("?")[0]) : [], signins: s, browser };
}

/** Sign-in state from the connected browser's cookie jar: cookie NAMES only, values are never read out. */
async function liveSignins(c) {
  const nets = Object.entries(SIGNIN).filter(([, s]) => s.cookie);
  const urls = [...new Set(nets.map(([, s]) => new URL(s.url).origin))];
  const names = (list) => list.map((k) => ({ name: k.name, domain: String(k.domain || "") }));
  let jar;
  try {
    jar = names(await c.cookies(urls));
  } catch {
    // The relay forwards browser-wide calls through one tab; if that is refused, ask a tab of our own.
    const page = await c.newPage();
    try {
      const cdp = await c.newCDPSession(page);
      jar = names((await cdp.send("Network.getCookies", { urls })).cookies || []);
      await cdp.detach().catch(() => {});
    } finally { await page.close().catch(() => {}); }
  }
  return Object.fromEntries(nets.map(([n, s]) => [n, jar.some((k) => k.name === s.cookie && k.domain.includes(s.host))]));
}

/* What the helper last saw per network (true = signed in), so sites without a known cookie still show a state. */
const stateFile = (home) => join(home, "helper-state.json");
function lastSeen(home) {
  try { return JSON.parse(readFileSync(stateFile(home), "utf8")); } catch { return {}; }
}
function remember(home, network, signedIn) {
  try {
    const s = lastSeen(home); s[network] = { signedIn, at: new Date().toISOString() };
    writeFileSync(stateFile(home), JSON.stringify(s, null, 2));
  } catch { /* the badge is a convenience; never fail a post over it */ }
}

/** Per network: true (signed in), false (not), or null (cannot tell yet), for the helper's own window. */
export function signins(home) {
  const out = Object.fromEntries(Object.keys(SIGNIN).map((n) => [n, null]));
  const seen = lastSeen(home);
  for (const [n, v] of Object.entries(seen)) if (n in out) out[n] = !!v.signedIn;
  const db = ["Default/Network/Cookies", "Default/Cookies"].map((p) => join(home, "browser", p)).find((p) => existsSync(p));
  if (!db) return out;
  // Chrome keeps the file open while the window is up: read a copy.
  const copy = join(tmpdir(), `lazycow-cookies-${process.pid}.db`);
  try {
    copyFileSync(db, copy);
    const { DatabaseSync } = globalThis.process.getBuiltinModule("node:sqlite");
    const sql = new DatabaseSync(copy, { readOnly: true });
    const rows = sql.prepare("SELECT host_key, name FROM cookies").all();
    sql.close();
    for (const [n, s] of Object.entries(SIGNIN)) {
      if (!s.cookie) continue;
      const has = rows.some((r) => r.name === s.cookie && String(r.host_key).includes(s.host));
      // A missing cookie means signed out; a present one wins unless the helper saw a sign-in page since.
      out[n] = has ? (seen[n]?.signedIn === false ? false : true) : false;
    }
  } catch { /* no sqlite or locked file: fall back to what the helper last saw */ }
  finally { rmSync(copy, { force: true }); }
  return out;
}

/** Open the sign-in page of each network asked for (or every one not signed in yet) in the helper window. */
/* Which sign-in tabs to open in your own Chrome. A network asked for by name gets its tab unless it is known to be signed
   in: LINE has no sign-in cookie to read, so a check-by-cookie alone never opened it ("I don't see LINE on any tab",
   12 Nov). With no names, only the networks whose cookie shows them signed out. */
export function signinTabs(table, now, networks) {
  if (networks?.length) return networks.filter((n) => table[n] && now[n] !== true);
  return Object.keys(table).filter((n) => table[n].cookie && now[n] === false);
}

export async function openSignin({ home, networks }) {
  // Your Chrome, not connected yet: start connecting and answer at once; the page polls /api/helper (browser.pending).
  if (!ctx && wantsExtension()) {
    const browser = await beginConnect({ reopen: true });
    return { opened: [], pending: true, message: browser.pending?.message || "Connecting to your Chrome.", browser };
  }
  const c = await context(home);
  // Your Chrome: connecting is the point; only sites it is really signed out of get a sign-in tab.
  const now = browserMode.using === "extension" ? { ...signins(home), ...(await liveSignins(c).catch(() => ({}))) } : signins(home);
  if (browserMode.using === "extension") {
    const out = signinTabs(SIGNIN, now, networks);
    for (const n of out) {
      const page = await c.newPage();
      await page.goto(SIGNIN[n].url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    }
    return { opened: out, signins: now, browser: browserState() };
  }
  const list = (networks?.length ? networks : Object.keys(SIGNIN).filter((n) => now[n] !== true && n !== "line-oa"))
    .filter((n) => SIGNIN[n]);
  for (const n of list) {
    const page = await c.newPage();
    await page.goto(SIGNIN[n].url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  }
  const first = c.pages().find((p) => p.url() !== "about:blank");
  await first?.bringToFront().catch(() => {});
  return { opened: list };
}

async function context(home) {
  if (ctx) return ctx;
  // Your Chrome: wait (a job may) for the one connection, started here or by the Connect button.
  if (wantsExtension()) {
    if (!browserMode.pending) await beginConnect();
    const p = browserMode.pending;
    if (ctx) return ctx;
    if (!p) throw Object.assign(new Error(browserMode.lastError?.message || "Could not connect to your Chrome."), { status: 409, plain: true });
    // A job waits up to 10 minutes for the click; the Welcome page keeps waiting after that (until Allow or Cancel).
    let t;
    const late = new Promise((_, fail) => { t = setTimeout(() => fail(Object.assign(new Error("Nobody pressed \"Allow & select\" in the Chrome window titled \"Welcome\" within 10 minutes, so this job stopped. The window still waits: press Allow there, then run the job again."), { status: 409, plain: true })), CONNECT_WAIT_MS); });
    return Promise.race([p.promise, late]).finally(() => clearTimeout(t));
  }
  if (opening) return opening;
  const pw = await loadLib();
  if (!pw) throw Object.assign(new Error("The browser helper is not installed yet: press Install helper (one time, about 10 MB)."), { status: 400 });
  opening = (async () => {
    const ext = extensionAvailable();
    // The old way, only when your Chrome cannot be used: a separate window that remembers its own sign-ins.
    browserMode.note = browserMode.want === "own" ? "" : `Using the helper's own window, because ${ext.why}. Sign in there once, or install the Playwright extension (${EXTENSION_STORE}) to use your own Chrome.`;
    browserMode.using = "own";
    return launchOwn(pw, home);
  })();
  try {
    ctx = await opening;
    ctx.on("close", () => { ctx = null; });
    return ctx;
  } finally { opening = null; }
}

/** The helper's browser context (connecting or launching it first). For readers in this file and checks. */
/** True while the helper is connected to your own Chrome (no connect page, no click needed for the next job). */
export const extensionConnected = () => !!ctx && browserMode.using === "extension";

function launchOwn(pw, home) {
  const dir = join(home, "browser");
  mkdirSync(dir, { recursive: true });
  const launch = (channel) => pw.chromium.launchPersistentContext(dir, {
    channel, headless: false, viewport: null, acceptDownloads: false,
    args: ["--start-maximized", "--no-first-run", "--no-default-browser-check"],
  });
  return launch("chrome").catch(() => launch("msedge")).catch(() => {
    throw Object.assign(new Error("Could not open Chrome or Edge for the helper. Install Google Chrome, then try again."), { status: 400 });
  });
}

/* Your Chrome (through the extension) may not read files from disk: Chrome blocks that unless the extension's
   "Allow access to file URLs" switch is on. So the bytes go to the page instead (Playwright builds the File there,
   up to 50 MB). Bigger files try the path and, if Chrome refuses, say which switch to turn on. Own window: the path. */
const MIME = { ".mp4": "video/mp4", ".mov": "video/quicktime", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
export const BUFFER_LIMIT = 48e6;
/** What to hand a file input: the path (own window, or a big file) or {name, mimeType, buffer} (your Chrome). */
export function filePayload(file, { extension, size }) {
  if (!extension || size > BUFFER_LIMIT) return file;
  const name = file.split(/[\\/]/).pop();
  const ext = (name.match(/\.[^.]+$/) || [""])[0].toLowerCase();
  return { name, mimeType: MIME[ext] || "application/octet-stream", buffer: readFileSync(file) };
}
async function attachFile(target, file) {
  const set = (v, o) => (typeof target.setInputFiles === "function" ? target.setInputFiles(v, o) : target.setFiles(v, o));
  const extension = browserMode.using === "extension";
  const v = filePayload(file, { extension, size: statSync(file).size });
  if (typeof v !== "string") return set(v, { timeout: 180000 });
  if (!extension) return set(v);
  try { return await set(v, { timeout: 30000 }); }
  catch {
    throw Object.assign(new Error("The file is over 48 MB, and Chrome does not let the Playwright extension read files from disk. In Chrome open chrome://extensions, Playwright Extension, Details, turn on \"Allow access to file URLs\", then try again."), { plain: true });
  }
}

async function clickByName(page, patterns, timeout = 4000) {
  for (const rx of patterns) {
    const el = page.getByRole("button", { name: rx }).or(page.getByRole("link", { name: rx })).or(page.getByText(rx)).first();
    try { await el.click({ timeout }); return true; } catch { /* try the next name */ }
  }
  return false;
}

async function attach(page, recipe, file) {
  // 1. A file box already on the page (most composers keep one hidden).
  const sel = recipe.input || 'input[type="file"]';
  const inputs = page.locator(sel);
  const n = await inputs.count().catch(() => 0);
  for (let i = n - 1; i >= 0; i--) {
    const accept = (await inputs.nth(i).getAttribute("accept").catch(() => "")) || "";
    if (!accept || /video|\*/.test(accept)) {
      try { await attachFile(inputs.nth(i), file); return true; } catch { /* next */ }
    }
  }
  // 2. A button that opens the site's file picker: catch the picker and answer it ourselves.
  const chooser = page.waitForEvent("filechooser", { timeout: 8000 }).catch(() => null);
  const clicked = await clickByName(page, [...(recipe.pick || []), GENERIC_PICK], 2500);
  const fc = clicked ? await chooser : null;
  if (fc) { await attachFile(fc, file); return true; }
  return false;
}

async function writeText(page, recipe, text) {
  if (recipe.textInUrl) return true;
  const box = page.locator(recipe.text || '[contenteditable="true"], textarea').first();
  try {
    await box.click({ timeout: 4000 });
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) await page.keyboard.insertText(lines[i]);
      if (i < lines.length - 1) await page.keyboard.press("Shift+Enter");
    }
    return true;
  } catch { return false; }
}

/* A sign-in page: the site sent us to its login address, or shows a password / username box. */
async function signedOut(page, recipe) {
  if (recipe.signin && recipe.signin.test(page.url())) return true;
  const box = page.locator('input[type="password"], input[autocomplete="username"], input[name="session_key"]');
  return (await box.count().catch(() => 0)) > 0 && (await box.first().isVisible().catch(() => false));
}

/** Open the composer with the file and text in place. Returns {state, message} in plain words. */
export async function prepare({ home, network, url, file, text, name }) {
  // Your Chrome, not connected yet: start connecting and answer at once (this is a button press, not a job).
  if (!ctx && wantsExtension()) {
    const b = await beginConnect({ reopen: true });
    return { state: "connect", message: `${b.pending?.message || "Connecting to your Chrome."} Then press Open in helper again.`, browser: b };
  }
  const c = await context(home);
  const recipe = RECIPES[network] || {};
  const target = recipe.url ? recipe.url(text) : url;
  if (!target) throw Object.assign(new Error(`There is no upload page saved for ${name || network}; add one under Accounts.`), { status: 400 });
  const page = await c.newPage();
  await c.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(target).origin }).catch(() => {});
  await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.bringToFront();
  await page.waitForTimeout(3500);
  await page.evaluate((t) => navigator.clipboard?.writeText(t).catch(() => {}), text).catch(() => {});
  const out = await signedOut(page, recipe);
  remember(home, network, !out);
  if (out) {
    return { state: "signin", message: `Sign in to ${name || network} ${where()}, then press Open in helper again.` };
  }
  if (recipe.open?.length || !recipe.url) await clickByName(page, [...(recipe.open || []), GENERIC_OPEN], 2500);
  await page.waitForTimeout(1500);
  if (recipe.before) await recipe.before(page, text).catch((e) => console.error(`[helper] ${network} setup: ${e.message}`));
  const filed = await attach(page, recipe, file);
  await page.waitForTimeout(1500);
  const texted = recipe.before ? await page.locator(recipe.text).first().inputValue().then((v) => v.trim() === text.trim()).catch(() => false) : await writeText(page, recipe, text);
  const parts = [];
  parts.push(filed ? "the video is attached" : "drag the video in (the page did not offer a file box)");
  parts.push(texted ? "the text is written" : "paste the text (Ctrl+V, it is on the clipboard)");
  return {
    state: filed && texted ? "ready" : "partial",
    message: `${name || network}: ${parts.join(", ")}. Check it in the helper window and press Post or Schedule there.`,
  };
}

/* ====================================================================================================
   Scheduling: the helper sets the date and time and presses Schedule itself (X, TikTok, Google Maps).
   ==================================================================================================== */

/** Networks the helper can schedule end to end. */
export const SCHEDULERS = ["x", "tiktok", "gbp", "line-oa", "linkedin"];
/** Days ahead each site accepts a scheduled post (TikTok: 10 days; the others far more). */
export const MAX_DAYS_AHEAD = { x: 365, tiktok: 10, gbp: 180, "line-oa": 180, linkedin: 90 };
/** A post time must carry its zone, so "19:00" never means the wrong 19:00. */
export const AT_RX = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?(Z|[+-]\d{2}:\d{2})$/;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (n) => String(n).padStart(2, "0");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* Statuses that hold a slot in the posting log (a dropped or failed post frees it). */
const HOLDS = new Set(["planned", "queued", "scheduled", "posted"]);

function parts(year, month, day, hour, minute, timeZone) {
  const weekday = WD[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return { year, month, day, hour, minute, weekday, hour12: hour % 12 || 12, ampm: hour < 12 ? "am" : "pm", timeZone };
}

/** The wall clock of an instant (ISO with an offset) in an IANA time zone, e.g. what the browser's own clock shows. */
export function localParts(at, timeZone) {
  if (!(at instanceof Date) && !AT_RX.test(String(at))) throw new Error(`The time needs a zone, e.g. 2026-11-13T19:00+09:00 (got ${at}).`);
  const d = at instanceof Date ? at : new Date(at);
  const f = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return parts(+p.year, +p.month, +p.day, +p.hour % 24, +p.minute, timeZone);
}

/** The wall clock the time was written in (its own offset): a Google listing schedules in the listing's zone. */
export function wallClock(at) {
  const m = AT_RX.exec(String(at));
  if (!m) throw new Error(`The time needs a zone, e.g. 2026-11-13T19:00+09:00 (got ${at}).`);
  return parts(+m[1], +m[2], +m[3], +m[4], +m[5], m[6] === "Z" ? "+00:00" : m[6]);
}

/** "+09:00" for Asia/Tokyo at that instant. */
export function zoneOffset(date, timeZone) {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(date).find((p) => p.type === "timeZoneName")?.value || "GMT";
  return name === "GMT" ? "+00:00" : name.slice(3);
}

/** "2026-11-13" + "19:00" in Asia/Tokyo -> "2026-11-13T19:00+09:00". */
export function zonedIso(ymd, hhmm, timeZone) {
  const first = zoneOffset(new Date(`${ymd}T${hhmm}:00Z`), timeZone);
  const second = zoneOffset(new Date(`${ymd}T${hhmm}${first}`), timeZone);  // a DST edge settles on the second look
  return `${ymd}T${hhmm}${second}`;
}

/** The calendar day (YYYY-MM-DD) an instant falls on in a zone. A time without a zone is this computer's. */
export function dayIn(at, timeZone) {
  const p = localParts(new Date(at instanceof Date ? at.getTime() : Date.parse(at)), timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);

/** What each site shows once the time is set, so the helper can check it before pressing. */
export function xLabel(p) {
  return `Will send on ${p.weekday}, ${MON[p.month - 1]} ${p.day}, ${p.year} at ${p.hour12}:${pad(p.minute)} ${p.ampm.toUpperCase()}`;
}
export function tiktokLabels(p) {
  return { date: `${p.year}年${p.month}月${p.day}日`, time: `${pad(p.hour)}:${pad(p.minute)}` };
}
export function gbpLabels(p) {
  return { date: `${pad(p.day)}/${pad(p.month)}/${p.year}`, time: `${pad(p.hour)}:${pad(p.minute)}`, listed: `Scheduled ${p.day} ${MON[p.month - 1]}` };
}

/** Trailing lines made only of #tags, split off (TikTok wants each tag typed and closed with a space). */
export function splitTags(text) {
  const lines = String(text).replace(/\s+$/, "").split("\n");
  const tags = [];
  while (lines.length && /^\s*(#[^\s#]+\s*)+$/.test(lines[lines.length - 1])) tags.unshift(...lines.pop().trim().split(/\s+/));
  return { body: lines.join("\n").replace(/\s+$/, ""), tags };
}

/** The file, text and extras for one network from a reel's manifest (/api/reel): the music cut, never the
    no-music one; for Google Maps the 1200x900 cover, and the "ボタン：… → URL" line becomes the Book button. */
export function postFor(manifest, network) {
  const BORROW = { "line-oa": ["line-voom", "facebook"] };
  // Your Chrome takes a file of up to BUFFER_LIMIT from the helper: prefer a cut that fits, else the first one.
  const fits = (c) => (c.videos || []).some((v) => { try { return statSync(join(c.dir, v.file)).size <= BUFFER_LIMIT; } catch { return false; } });
  const cands = [network, ...(BORROW[network] || [])].map((n) => (manifest?.channels || []).find((c) => c.name === n && c.dir && c.videos?.length)).filter(Boolean);
  const ch = cands.find(fits) || cands[0] || (manifest?.channels || []).find((c) => c.name === network);
  if (!ch?.dir) return null;
  let text = String(ch.post || "").replace(/utm_source=[a-z-]+/g, `utm_source=${network}`).replace(/\s+$/, "");
  const extra = {};
  let file;
  if (network === "gbp") {
    const files = ch.files || [];
    file = files.find((f) => /^cover_1200x900\.jpe?g$/i.test(f)) || files.find((f) => /^cover_.*\.jpe?g$/i.test(f));
    const lines = text.split("\n");
    const i = lines.findLastIndex((l) => /^\s*ボタン\s*[:：]/.test(l));
    if (i >= 0) {
      const u = /(https:\/\/\S+)/.exec(lines[i]);
      if (u) extra.url = u[1];
      lines.splice(i, 1);
    }
    text = lines.join("\n").replace(/\s+$/, "");
  } else {
    file = (ch.videos || []).map((v) => v.file).find((f) => /\.mp4$/i.test(f) && !/no-music/i.test(f));
  }
  if (!file) return null;
  return { file: join(ch.dir, file), text, extra, headline: headlineOf(manifest, ch) };
}
/** The line a viewer reads first: the reel's title, else the post's first line. */
export function headlineOf(manifest, ch) {
  const t = String(manifest?.title || "").trim();
  if (t) return t;
  return String(ch?.post || "").split("\n").map((l) => l.trim()).find(Boolean) || "";
}

/** Why the helper must not schedule this (a plain sentence), or null when it may.
    Approved reels only; a time with a zone, ahead of now and inside the site's window; never a second
    copy of the same reel on the same network at the same time; never while the same one is in flight. */
export function scheduleRefusal({ status, slug, network, at, posts = [], now = Date.now(), busy = false }) {
  if (!SCHEDULERS.includes(network)) return `The helper schedules on ${SCHEDULERS.map((n) => NAMES[n] || n).join(", ")} only; ${network} is not one of them.`;
  if (!status) return `There is no review record for ${slug}, so it cannot be confirmed as approved. Only approved reels are scheduled.`;
  if (status !== "approved") return `${slug} is "${status}", not approved. Approve it in the studio first; only approved reels are scheduled.`;
  if (!AT_RX.test(String(at || ""))) return "The time needs a date, a time and a zone, e.g. 2026-11-13T19:00+09:00.";
  const t = Date.parse(at);
  if (t < now + 15 * 60e3) return "That time is past or less than 15 minutes away: pick a later time.";
  const most = MAX_DAYS_AHEAD[network];
  if (t > now + most * 86400e3) return `${network === "tiktok" ? "TikTok" : network} schedules at most ${most} days ahead: pick a nearer day.`;
  const same = posts.find((r) => r.slug === slug && r.network === network && HOLDS.has(r.status) && r.at && Date.parse(r.at) === t);
  if (same) return `${slug} is already ${same.status} on ${network} at that time (post ${same.id}); it is not scheduled twice.`;
  if (busy) return `${slug} is already being scheduled on ${network}; wait for that job to finish.`;
  return null;
}

/** Spread approved reels over the next days: one post per network per day at 19:00 in the audience's zone
    (Google Maps 12:00 on Fridays and Saturdays only), skipping days a network already has a post, never the
    same reel twice on one network, and never the same headline on one network on two days in a row.
    reels: [{slug, headline, networks}] (approved, with files for those networks). Returns {plan, skipped}. */
export function planWeek({ reels = [], networks = SCHEDULERS, posts = [], start, days = 7, timeZone = "Asia/Tokyo", now = Date.now(), limits = MAX_DAYS_AHEAD }) {
  // limits: days ahead per network; the Chrome networks by default, more (Facebook, Bluesky, YouTube) from server/autoplan.mjs.
  const nets = networks.filter((n) => n in limits);
  const first = start || addDays(dayIn(new Date(now), timeZone), 1);
  const headlineBy = new Map(reels.map((r) => [r.slug, String(r.headline || "").trim()]));
  const off = new Set(posts.filter((r) => r.network === "all" && r.status === "skipped").map((r) => r.slug));
  const held = (r) => HOLDS.has(r.status) && r.at;
  // Per network: which days hold a post (and its headline), and which reels it has already had.
  const days_ = Object.fromEntries(nets.map((n) => [n, new Map()]));
  const used = Object.fromEntries(nets.map((n) => [n, new Set()]));
  for (const r of posts) {
    if (!nets.includes(r.network) || !held(r)) continue;
    used[r.network].add(r.slug);
    days_[r.network].set(dayIn(r.at, timeZone), headlineBy.get(r.slug) ?? `#${r.slug}`);
  }
  const plan = [], skipped = [], count = new Map();
  for (let i = 0; i < days; i++) {
    const day = addDays(first, i);
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    for (const net of nets) {
      if (net === "gbp" && weekday !== 5 && weekday !== 6) continue;  // Maps: Fri and Sat only
      // LINE messages land in people's chats: one a week, Saturday 10:00 (shared/playbooks.json "line-oa").
      // LinkedIn: one post a week, Sunday 19:00 (playbook "linkedin": cadencePerWeek 1).
      const weekly = { "line-oa": 6, linkedin: 0 };
      if (net in weekly && weekday !== weekly[net]) continue;
      if (net in weekly && [...days_[net].keys()].some((d) => Math.abs(Date.parse(`${d}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) < 7 * 86400e3)) {
        skipped.push({ day, network: net, why: `${net === "linkedin" ? "LinkedIn already has a post" : "LINE already has a message"} within 7 days` }); continue;
      }
      const at = zonedIso(day, net === "gbp" ? "12:00" : net === "line-oa" ? "10:00" : "19:00", timeZone);
      const t = Date.parse(at);
      if (t < now + 15 * 60e3) { skipped.push({ day, network: net, why: "already past" }); continue; }
      if (t > now + limits[net] * 86400e3) { skipped.push({ day, network: net, why: `too far ahead for ${net}` }); continue; }
      if (days_[net].has(day)) { skipped.push({ day, network: net, why: "already has a post that day" }); continue; }
      const near = [days_[net].get(addDays(day, -1)), days_[net].get(addDays(day, 1))].filter(Boolean);
      const pick = reels
        .filter((r) => !off.has(r.slug) && (r.networks || []).includes(net) && !used[net].has(r.slug) && !near.includes(String(r.headline || "").trim()))
        .map((r, k) => ({ r, k }))
        .sort((a, b) => (count.get(a.r.slug) || 0) - (count.get(b.r.slug) || 0) || a.k - b.k)[0]?.r;
      if (!pick) { skipped.push({ day, network: net, why: "no approved reel left that it has not had, with a different headline from the day before and after" }); continue; }
      plan.push({ slug: pick.slug, network: net, at, day, headline: String(pick.headline || "").trim() });
      used[net].add(pick.slug);
      days_[net].set(day, String(pick.headline || "").trim());
      count.set(pick.slug, (count.get(pick.slug) || 0) + 1);
    }
  }
  plan.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.network.localeCompare(b.network));
  return { start: first, days, timeZone, plan, skipped };
}

/* One helper job at a time: two jobs typing into the same Chrome would trip over each other. */
let lane = Promise.resolve();
/** Run fn after every helper job queued before it; returns fn's result. */
export function inLane(fn) {
  const run = lane.then(fn, fn);
  lane = run.catch(() => {});
  return run;
}
/* A time limit for read-only helper work (reading post numbers): past it the promise rejects, so the lane moves on
   and the job ends with a message instead of holding every later Chrome job (swaps, bookings) for hours. Never used
   for posting or booking: a slow video upload must not be cut off halfway. */
export function withLimit(work, ms, what = "the helper") {
  let timer;
  const stop = new Promise((_, fail) => { timer = setTimeout(() => fail(new Error(`${what} took over ${Math.round(ms / 60000)} minutes and was stopped; it runs again on the next round`)), ms); });
  return Promise.race([Promise.resolve(work), stop]).finally(() => clearTimeout(timer));
}

/* ---------- browser steps shared by the recipes ---------- */
async function pageText(target) {
  return target.evaluate(() => document.body?.innerText || "").catch(() => "");
}
/* Text a page shows, or carries in an aria-label (upload states often live only there). */
async function shows(target, s) {
  return target.evaluate((s) => (document.body?.innerText || "").includes(s)
    || [...document.querySelectorAll("[aria-label]")].some((e) => (e.getAttribute("aria-label") || "").includes(s)), s).catch(() => false);
}
async function until(check, timeout, every = 1000) {
  const end = Date.now() + timeout;
  for (;;) {
    if (await Promise.resolve().then(check).catch(() => false)) return true;
    if (Date.now() >= end) return false;
    await sleep(every);
  }
}
/* A <select>: pick the option whose value or label is one of the wanted ones. */
async function chooseOption(page, sel, wants) {
  const el = page.locator(sel).first();
  const opts = await el.evaluate((s) => [...s.options].map((o) => ({ value: o.value, label: (o.textContent || "").trim() })));
  const norm = (x) => String(x).trim().toLowerCase();
  const hit = opts.find((o) => wants.some((w) => norm(o.value) === norm(w))) || opts.find((o) => wants.some((w) => norm(o.label) === norm(w)));
  if (!hit) throw Object.assign(new Error(`the time picker has no ${wants[0]}`), { plain: true });
  await el.selectOption(hit.value);
}
async function typeLines(page, lines, { closeTags = false } = {}) {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]) await page.keyboard.insertText(lines[i]);
    if (i < lines.length - 1) {
      // A line ending in #tag has a suggestion list open; a space closes it so Enter is a new line, not a pick.
      if (closeTags && /#[^\s#]+$/.test(lines[i])) await page.keyboard.insertText(" ");
      await page.keyboard.press("Enter");
    }
  }
}
const fail = (message, proof = null) => ({ state: "failed", message, proof });
const NAMES = { x: "X", tiktok: "TikTok", gbp: "Google Maps", pinterest: "Pinterest", linkedin: "LinkedIn", "line-oa": "LINE" };

/* ---------- X: https://x.com/compose/post ---------- */
async function scheduleX(page, { file, text, at, timeZone, rehearse, step }) {
  const p = localParts(at, timeZone);
  const want = xLabel(p);
  // X nests two [role=dialog] elements (an invisible wrapper and the box): wait on the text box itself and use
  // the innermost dialog that holds it (the last in document order).
  await page.locator('[role="dialog"] [data-testid="tweetTextarea_0"]').first().waitFor({ state: "visible", timeout: 30000 });
  const dlg = page.locator('[role="dialog"]').filter({ has: page.locator('[data-testid="tweetTextarea_0"]') }).last();
  step("attaching the video", 2);
  await attachFile(dlg.locator('[data-testid="fileInput"]').first(), file);
  step("writing the text", 3);
  await dlg.locator('[data-testid="tweetTextarea_0"]').first().click();
  await typeLines(page, text.split("\n"), { closeTags: true });
  const firstLine = text.split("\n").find((l) => l.trim())?.trim().slice(0, 20) || "";
  const typed = await dlg.locator('[data-testid="tweetTextarea_0"]').first().innerText().catch(() => "");
  if (firstLine && !typed.includes(firstLine)) return fail("X: the text did not land in the post box, so nothing was scheduled. The window stays open; check it there.");
  step(`setting ${want.replace("Will send on ", "")}`, 4);
  await page.locator('[role="dialog"] [data-testid="scheduleOption"]').first().dispatchEvent("click");
  await page.locator("#SELECTOR_1").waitFor({ timeout: 15000 });
  await chooseOption(page, "#SELECTOR_1", [String(p.month), MONTH[p.month - 1], MON[p.month - 1]]);
  await chooseOption(page, "#SELECTOR_2", [String(p.day), pad(p.day)]);
  await chooseOption(page, "#SELECTOR_3", [String(p.year)]);
  await chooseOption(page, "#SELECTOR_4", [String(p.hour12), pad(p.hour12)]);
  await chooseOption(page, "#SELECTOR_5", [String(p.minute), pad(p.minute)]);
  await chooseOption(page, "#SELECTOR_6", [p.ampm, p.ampm.toUpperCase()]);
  await sleep(500);
  const dialogs = async () => (await page.locator('[role="dialog"]').allInnerTexts().catch(() => [])).join("\n");
  if (!(await dialogs()).includes(want)) return fail(`X did not show "${want}" after the time was set, so nothing was scheduled. The window stays open.`);
  await page.locator('[data-testid="scheduledConfirmationPrimaryAction"]').first().dispatchEvent("click");
  step("waiting for the video to upload", 5);
  const name = file.split(/[\\/]/).pop();
  if (!(await until(() => shows(page, `${name}: Ready`), 5 * 60e3, 2000))) return fail("X: the video did not finish uploading within 5 minutes, so nothing was scheduled. The window stays open.");
  const btn = page.locator('[role="dialog"] [data-testid="tweetButton"]').first();
  const label = (await btn.innerText().catch(() => "")).trim();
  if (!/^schedule$/i.test(label)) return fail(`X's button says "${label || "nothing"}", not "Schedule", so it was not pressed (it would post now). The window stays open.`);
  if (!(await dialogs()).includes(want)) return fail(`X no longer shows "${want}", so it was not pressed. The window stays open.`);
  if (rehearse) return { state: "rehearsed", message: `X: ready to schedule for ${want.replace("Will send on ", "")} (your time). Rehearsal: Schedule was not pressed.`, proof: { shown: want } };
  step("pressing Schedule", 6);
  await btn.dispatchEvent("click");
  const gone = await until(async () => (await page.locator('[role="dialog"] [data-testid="tweetTextarea_0"]').count()) === 0, 90000);
  if (!gone) return fail("X: Schedule was pressed but the post box is still open, so it may not have been scheduled. Check the helper window before trying again.");
  step("checking the scheduled list", 7);
  const proofUrl = "https://x.com/compose/post/unsent/scheduled";
  await page.goto(proofUrl, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  const seen = firstLine ? await until(() => shows(page, firstLine.slice(0, 12)), 15000) : false;
  return { state: "scheduled", message: `X: scheduled for ${want.replace("Will send on ", "")} (this computer's time).`, proof: { url: proofUrl, shown: want, seen } };
}

/* ---------- TikTok: https://www.tiktok.com/tiktokstudio/upload (Japanese UI) ---------- */
async function dismissTour(page) {
  for (const rx of [/^(OK|了解|わかりました|Got it|閉じる)$/]) {
    const b = page.getByRole("button", { name: rx });
    const n = await b.count().catch(() => 0);
    for (let i = 0; i < n; i++) if (await b.nth(i).isVisible().catch(() => false)) await b.nth(i).click({ timeout: 2000 }).catch(() => {});
  }
}
async function tiktokPickDay(page, p) {
  const days = page.locator(".DatePicker__day").filter({ hasText: new RegExp(`^\\s*${p.day}\\s*$`) });
  const n = await days.count();
  const ok = [];
  for (let i = 0; i < n; i++) {
    const cls = (await days.nth(i).getAttribute("class").catch(() => "")) || "";
    if (!/disabled|invalid|outside|other/i.test(cls)) ok.push(days.nth(i));
  }
  const el = ok.length > 1 ? (p.day <= 15 ? ok[0] : ok[ok.length - 1]) : ok[0];
  if (!el) return false;
  await el.click({ force: true });
  return true;
}
async function scheduleTikTok(page, { file, text, at, timeZone, rehearse, step }) {
  const p = localParts(at, timeZone);
  const want = tiktokLabels(p);
  await dismissTour(page);
  step("attaching the video", 2);
  await attachFile(page.locator('input[type="file"]').first(), file);
  if (!(await until(() => shows(page, "アップロード完了"), 10 * 60e3, 2000))) return fail("TikTok: the video did not finish uploading within 10 minutes, so nothing was scheduled. The window stays open.");
  // The cover loads after the upload and resets the description to the file name: wait it out first.
  await until(async () => !(await shows(page, "読み込み中")), 3 * 60e3, 1500);
  await sleep(1500);
  await dismissTour(page);
  step("writing the text", 3);
  const { body, tags } = splitTags(text);
  const editor = page.locator(".public-DraftEditor-content").first();
  await editor.evaluate((el) => {
    el.focus();
    const r = document.createRange(); r.selectNodeContents(el);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  });
  await page.keyboard.press("Backspace");
  await typeLines(page, body.split("\n"));
  if (tags.length) {
    await page.keyboard.press("Enter"); await page.keyboard.press("Enter");
    for (const tag of tags) { await page.keyboard.insertText(tag); await sleep(1100); await page.keyboard.press("Space"); await sleep(300); }
  }
  const typed = await editor.innerText().catch(() => "");
  const firstLine = body.split("\n").find((l) => l.trim())?.trim().slice(0, 20) || "";
  if ((firstLine && !typed.includes(firstLine)) || tags.some((t) => !typed.includes(t))) return fail("TikTok: the description did not come out as written, so nothing was scheduled. The window stays open; check it there.");
  step(`setting ${want.date} ${want.time}`, 4);
  await page.locator('input[type="radio"][value="schedule"]').first().dispatchEvent("click");
  await sleep(1500);
  await dismissTour(page);
  // Scoped to the 投稿のタイミング section: the video preview also shows times like 00:13.
  const section = () => page.locator("div").filter({ hasText: "投稿のタイミング" }).filter({ has: page.getByText(/^\d{4}年\d{1,2}月\d{1,2}日$/) }).last();
  const dateBox = () => section().getByText(/^\d{4}年\d{1,2}月\d{1,2}日$/).first();
  const timeBox = () => section().getByText(/^\d{2}:\d{2}$/).first();
  for (let attempt = 0; attempt < 2; attempt++) {
    await dateBox().click({ force: true });
    await sleep(600);
    if (attempt === 1) {  // the next month: its arrow is the last one in the picker
      const arrows = page.locator('[class*="DatePicker"] [class*="arrow"], [class*="DatePicker"] [class*="Arrow"]');
      const n = await arrows.count();
      if (n) await arrows.nth(n - 1).click({ force: true }).catch(() => {});
      await sleep(500);
    }
    await tiktokPickDay(page, p);
    await sleep(600);
    if ((await dateBox().innerText().catch(() => "")).trim() === want.date) break;
  }
  await timeBox().click({ force: true });
  await sleep(600);
  await page.locator(".TimePicker__item").filter({ hasText: new RegExp(`^\\s*${pad(p.hour)}\\s*$`) }).first().click({ force: true });
  await sleep(300);
  // "00".."23" also sit in the hour column, so the minute is the second match for those.
  await page.locator(".TimePicker__item").filter({ hasText: new RegExp(`^\\s*${pad(p.minute)}\\s*$`) }).nth(p.minute <= 23 ? 1 : 0).click({ force: true });
  await sleep(300);
  await page.keyboard.press("Escape");
  await sleep(600);
  step("checking the date and time", 5);
  const shownDate = (await dateBox().innerText().catch(() => "")).trim(), shownTime = (await timeBox().innerText().catch(() => "")).trim();
  if (!(await shows(page, "投稿のタイミング")) || shownDate !== want.date || shownTime !== want.time) {
    return fail(`TikTok shows ${shownDate || "no date"} ${shownTime || ""}, not ${want.date} ${want.time}, so nothing was scheduled. Set it in the helper window, or try again.`);
  }
  const btn = page.locator('[data-e2e="post_video_button"]').first();
  const label = (await btn.innerText().catch(() => "")).trim();
  if (!/投稿予約|Schedule/i.test(label)) return fail(`TikTok's button says "${label || "nothing"}", not 投稿予約する, so it was not pressed (it would post now). The window stays open.`);
  if (rehearse) return { state: "rehearsed", message: `TikTok: ready to schedule for ${want.date} ${want.time} (your time). Rehearsal: 投稿予約する was not pressed.`, proof: { shown: `${want.date} ${want.time}` } };
  step("pressing 投稿予約する", 6);
  await btn.dispatchEvent("click");
  const done = await until(async () => {
    if (/\/tiktokstudio\/content/.test(page.url())) return true;
    // A confirm box, if TikTok asks: only ever its schedule button, never "post now".
    const confirm = page.locator('[role="dialog"]').getByRole("button", { name: /^(投稿予約する|予約する|Schedule)$/ });
    if (await confirm.count().catch(() => 0)) await confirm.first().click({ timeout: 2000 }).catch(() => {});
    return false;
  }, 3 * 60e3, 1500);
  step("checking TikTok took it", 7);
  if (!done) return fail("TikTok: 投稿予約する was pressed but TikTok did not move on to its content list, so it may not have been scheduled. Check the helper window before trying again.");
  return { state: "scheduled", message: `TikTok: scheduled for ${want.date} ${want.time} (this computer's time).`, proof: { url: "https://www.tiktok.com/tiktokstudio/content", shown: `${want.date} ${want.time}`, seen: true } };
}

/* ---------- Google Maps (Business Profile): business.google.com/posts/l/<location id> ---------- */
const stateValue = (home, key) => lastSeen(home)._values?.[key] ?? null;
function keepValue(home, key, value) {
  try {
    const s = lastSeen(home); s._values = { ...(s._values || {}), [key]: value };
    writeFileSync(stateFile(home), JSON.stringify(s, null, 2));
  } catch { /* a convenience */ }
}
async function gbpLocation(page, home, given) {
  if (given) return String(given);
  const kept = stateValue(home, "gbpLocation");
  if (kept) return kept;
  // One listing: its id is in every link on the locations page.
  await page.goto("https://business.google.com/locations", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  await sleep(4000);
  if (/accounts\.google\.com/.test(page.url())) return "signin";
  const html = await page.content().catch(() => "");
  const ids = [...new Set([...html.matchAll(/\/l\/(\d{6,})/g)].map((m) => m[1]))];
  if (ids.length === 1) { keepValue(home, "gbpLocation", ids[0]); return ids[0]; }
  return null;
}
async function gbpFrame(page, timeout) {
  let frame = null;
  await until(async () => {
    for (const f of page.frames()) {
      if (!/\/promote\/updates\/add/.test(f.url())) continue;
      if (await f.getByText("Schedule this post").count().catch(() => 0)) { frame = f; return true; }
    }
    return false;
  }, timeout, 1500);
  return frame;
}
async function scheduleGbp(page, { home, file, text, at, extra, rehearse, step }) {
  const p = wallClock(at);  // the listing's own zone: 12:00 means 12:00 at the ranch
  const want = gbpLabels(p);
  const id = await gbpLocation(page, home, extra.location);
  if (id === "signin") return { state: "signin" };
  if (!id) return fail("Google Maps: the helper could not tell which listing to post to. Put its id in .env as STUDIO_GBP_LOCATION (business.google.com/locations shows it), then try again.");
  await page.goto(`https://business.google.com/posts/l/${id}`, { waitUntil: "domcontentloaded", timeout: 45000 });
  if (/accounts\.google\.com/.test(page.url())) return { state: "signin" };
  let f = await gbpFrame(page, 30000);
  if (!f) {
    await clickByName(page, [/^(Add update|Add post|Add a post|最新情報を追加|投稿を追加)$/i], 3000);
    f = await gbpFrame(page, 30000);
  }
  if (!f) return fail("Google Maps: the Add post box did not open, so nothing was scheduled. The window stays open.");
  step("attaching the cover", 2);
  await attachFile(f.locator('input[type="file"]').first(), file);
  await sleep(4000);
  step("writing the text and the Book button", 3);
  await f.locator("textarea").first().fill(text);
  if (extra.url) {
    // Older box: a "Button" chip, then the BOOK item. Since 2026-11 the button is a dropdown that reads "None".
    let booked = await f.locator('li[value="BOOK"]').first().click({ timeout: 2500 }).then(() => true, () => false);
    if (!booked) {
      await f.getByText("Button", { exact: true }).first().click({ timeout: 2500 }).catch(() => {});
      booked = await f.locator('li[value="BOOK"]').first().click({ timeout: 2500 }).then(() => true, () => false);
    }
    if (!booked) {
      const dropdown = f.getByRole("combobox").or(f.getByRole("listbox")).or(f.getByText(/^None$/)).last();
      await dropdown.click({ timeout: 5000 }).catch(() => {});
      await sleep(600);
      // The list opens outside the post box's frame: look in every frame for the item that reads exactly "Book".
      for (const fr of [f, ...page.frames()]) {
        if (booked) break;
        booked = await fr.getByRole("option", { name: /^\s*Book\s*$/ }).first().click({ timeout: 1500 }).then(() => true, () => false)
          || await fr.locator('li, [role="option"], [role="menuitem"]').filter({ hasText: /^\s*Book\s*$/ }).first().click({ timeout: 1500 }).then(() => true, () => false);
      }
    }
    if (!booked) return fail("Google Maps: the Book button could not be added to the post, so nothing was posted. The window stays open.");
    await sleep(600);
    await f.locator('input[type="url"]').first().fill(extra.url);
  }
  step(`setting ${want.date} ${want.time}`, 4);
  const sw = f.getByRole("switch").first();
  if ((await sw.getAttribute("aria-checked").catch(() => null)) !== "true") await sw.click();
  await sleep(800);
  const dates = async () => f.evaluate(() => [...document.querySelectorAll("input")].map((i) => i.value).filter((v) => /^\d{2}\/\d{2}\/\d{4}$/.test(v))).catch(() => []);
  const before = (await dates())[0];
  await f.getByRole("button", { name: /Open calendar/i }).first().click();
  await sleep(600);
  if (before) {  // the calendar opens on the date in the box: step forward to the right month
    const [, mm, yyyy] = before.split("/").map(Number);
    for (let k = 0; k < (p.year * 12 + p.month) - (yyyy * 12 + mm); k++) {
      await f.getByRole("button", { name: /Next month/i }).first().click().catch(() => {});
      await sleep(300);
    }
  }
  await f.getByRole("gridcell").filter({ hasText: new RegExp(`^\\s*${p.day}\\s*$`) }).first().click();
  await f.getByRole("button", { name: /^OK$/ }).first().click();
  await sleep(500);
  await f.locator('input[aria-label="Time"]').first().click();
  await sleep(500);
  const h12 = `${p.hour12}:${pad(p.minute)} ${p.ampm.toUpperCase()}`;
  const opt = f.getByRole("option", { name: new RegExp(`^\\s*(${want.time}|${h12}|${pad(p.hour12)}:${pad(p.minute)} ${p.ampm.toUpperCase()})\\s*$`, "i") }).first();
  await opt.click();
  await sleep(600);
  step("checking the date and time", 5);
  const shownDates = await dates();
  const shownTime = await f.locator('input[aria-label="Time"]').first().inputValue().catch(() => "");
  const timeOk = shownTime.trim() === want.time || shownTime.trim().toUpperCase() === h12;
  const bodyOk = (await f.locator("textarea").first().inputValue().catch(() => "")).trim() === text.trim();
  const urlOk = !extra.url || (await f.locator('input[type="url"]').first().inputValue().catch(() => "")) === extra.url;
  const switchOk = (await sw.getAttribute("aria-checked").catch(() => null)) === "true";
  if (!shownDates.includes(want.date) || !timeOk || !bodyOk || !urlOk || !switchOk) {
    return fail(`Google Maps shows ${shownDates[0] || "no date"} ${shownTime || ""}${bodyOk ? "" : ", a different text"}${urlOk ? "" : ", a different button link"}, not ${want.date} ${want.time}, so nothing was posted. The window stays open.`);
  }
  if (rehearse) return { state: "rehearsed", message: `Google Maps: ready to schedule for ${want.date} ${want.time} (the listing's time). Rehearsal: Post was not pressed.`, proof: { shown: `${want.date} ${want.time}` } };
  step("pressing Post", 6);
  await f.getByRole("button", { name: /^Post$/ }).last().click();
  const closed = await until(async () => f.isDetached() || !(await f.getByText("Schedule this post").count().catch(() => 0)), 90000, 1500);
  step("checking the post list", 7);
  if (!closed) return fail("Google Maps: Post was pressed but the box is still open, so it may not have been scheduled. Check the helper window before trying again.");
  const seen = await until(async () => {
    for (const fr of page.frames()) if ((await pageText(fr)).includes(want.listed)) return true;
    return false;
  }, 20000, 2000);
  return { state: "scheduled", message: `Google Maps: scheduled for ${want.date} ${want.time} (the listing's time)${seen ? `; the list shows "${want.listed}"` : ""}.`, proof: { url: `https://business.google.com/posts/l/${id}`, shown: `${want.date} ${want.time}`, seen } };
}


/* LINE: a message to everyone who follows the account, at a set time. The text bubble, then the video bubble;
   予約配信 with the date and time in the browser's clock (LINE shows the computer's zone), checked, then 配信 and
   the confirm box. Proof: the message list shows it as scheduled. */
async function scheduleLine(page, { home, file, text, at, timeZone, rehearse, step }) {
  const recipe = RECIPES["line-oa"];
  // A failed step leaves a picture of the page in STUDIO_HOME/helper-shots, so the cause can be seen afterwards.
  const shot = async (name) => { try { mkdirSync(join(home, "helper-shots"), { recursive: true }); await page.screenshot({ path: join(home, "helper-shots", `line-${name}.png`), fullPage: true }); } catch { /* best effort */ } };
  step("writing the text and adding the video bubble", 2);
  await recipe.before(page, text);
  if (!/\/broadcast\/create/.test(page.url())) return fail("LINE: the message page did not open, so nothing was scheduled. The window stays open.");
  step("attaching the video", 3);
  if (!(await attach(page, recipe, file))) return fail("LINE: the video could not be attached, so nothing was scheduled. The window stays open.");
  const uploaded = await until(async () => !(await page.getByText("ここにファイルをドラッグ", { exact: false }).count().catch(() => 1)), 180000, 2000);
  if (!uploaded) return fail("LINE: the video is still uploading after 3 minutes, so nothing was scheduled. The window stays open.");
  await sleep(2000);
  const p = localParts(at, timeZone);
  const date = `${p.year}/${pad(p.month)}/${pad(p.day)}`, time = `${pad(p.hour)}:${pad(p.minute)}`;
  step(`setting ${date} ${time}`, 4);
  await page.locator('input[type="radio"]').nth(1).check({ force: true });
  await sleep(500);
  await page.locator('input[name="datepicker"]').fill(date);
  await page.keyboard.press("Escape").catch(() => {});
  await page.locator('input[name="timepicker"]').fill(time);
  await page.keyboard.press("Escape").catch(() => {});
  await page.locator("h1, h2").first().click().catch(() => {});
  await sleep(800);
  step("checking the message, the video and the time", 5);
  const shownDate = await page.locator('input[name="datepicker"]').inputValue().catch(() => "");
  const shownTime = await page.locator('input[name="timepicker"]').inputValue().catch(() => "");
  const scheduled = await page.locator('input[type="radio"]').nth(1).isChecked().catch(() => false);
  const bodyOk = (await page.locator("textarea").first().inputValue().catch(() => "")).trim() === text.trim();
  const videoOk = await page.evaluate(() => !!document.querySelector("video, [class*=video] img, [style*=thumbnail]")).catch(() => false);
  if (shownDate !== date || shownTime !== time || !scheduled || !bodyOk || !videoOk) {
    return fail(`LINE shows ${scheduled ? "a scheduled send" : "send now"} ${shownDate} ${shownTime}${bodyOk ? "" : ", a different text"}${videoOk ? "" : ", no video"}, not ${date} ${time}, so nothing was sent. The window stays open.`);
  }
  if (rehearse) return { state: "rehearsed", message: `LINE: ready to send to all friends at ${date} ${time} (this computer's time). Rehearsal: 配信 was not pressed.`, proof: { shown: `${date} ${time}` } };
  step("pressing 配信", 6);
  // Never send now by mistake: the scheduled-send option must still be on, with the checked time, right before the press.
  const stillScheduled = await page.locator('input[type="radio"]').nth(1).isChecked().catch(() => false)
    && (await page.locator('input[name="timepicker"]').inputValue().catch(() => "")) === time;
  if (!stillScheduled) { await shot("time"); return fail("LINE: the scheduled time changed before 配信 was pressed, so nothing was sent. The window stays open."); }
  // LINE keeps 配信 switched off while it is still processing the video: wait for it (up to 3 minutes).
  await until(async () => page.evaluate(() => [...document.querySelectorAll("button")].some((x) => /^配信(予約)?$/.test(x.textContent.trim()) && !x.disabled && x.getBoundingClientRect().width > 0)).catch(() => false), 180000, 2000);
  // With a time set, LINE names the button 配信予約. Its buttons do not answer a pointer click from the helper;
  // a direct click on the visible one does (as 追加).
  const pressed = await page.evaluate(() => { const shown = (x) => { const r = x.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(x).visibility !== "hidden"; };
    const b = [...document.querySelectorAll("button")].find((x) => /^配信(予約)?$/.test(x.textContent.trim()) && shown(x) && !x.disabled); b?.click(); return !!b; });
  if (!pressed) { await shot("send"); return fail("LINE: the 配信 button was not found, so nothing was sent. The window stays open."); }
  // LINE's confirm box: 「このメッセージは予約され、YYYY/MM/DD HH:MMにすべての友だちに配信されます。配信しますか？」.
  // Press its own 配信 only when the box names the same date and time (never a button outside the box).
  const confirmed = await until(async () => page.evaluate(({ date, time }) => {
    const shown = (x) => { const r = x.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const ask = [...document.querySelectorAll("p, div, span")].filter((x) => shown(x) && /配信しますか/.test(x.textContent))
      .sort((x, y) => x.textContent.length - y.textContent.length)[0];  // the smallest block that holds the question
    if (!ask || !ask.textContent.includes(`${date} ${time}`)) return false;
    let box = ask; for (let i = 0; i < 8 && box && !box.querySelector("button"); i++) box = box.parentElement;
    for (let i = 0; i < 4 && box && ![...box.querySelectorAll("button")].some((b) => /キャンセル/.test(b.textContent)); i++) box = box.parentElement;
    const ok = box && [...box.querySelectorAll("button")].find((b) => b.textContent.trim() === "配信" && shown(b) && !b.disabled);
    ok?.click();
    return !!ok;
  }, { date, time }).catch(() => false), 15000, 500);
  if (!confirmed) { await shot("confirm"); return fail(`LINE: the confirm box for ${date} ${time} did not appear, so nothing was sent. The window stays open.`); }
  void confirmed;
  const left = await until(async () => !/\/broadcast\/create/.test(page.url()), 30000, 1000);
  if (!left) { await shot("after"); return fail("LINE: 配信 was pressed but the page did not move on, so it may not have been scheduled. Check the window before trying again."); }
  await sleep(3000);
  const listText = await pageText(page);
  const seen = /予約/.test(listText) && listText.includes(time);
  return { state: "scheduled", message: `LINE: scheduled to all friends for ${date} ${time} (this computer's time)${seen ? "; the message list shows it" : ""}.`, proof: { url: page.url(), shown: `${date} ${time}`, seen } };
}
/* After a scheduling run the helper closes the page it opened (nothing is left open in your Chrome); a failed or
   rehearsed run first saves a picture of it to STUDIO_HOME/helper-shots/<network>-<state>.png. */
async function keepPictureAndClose(page, home, network, state) {
  if (state !== "scheduled") {
    try { mkdirSync(join(home, "helper-shots"), { recursive: true }); await page.screenshot({ path: join(home, "helper-shots", `${network}-${state}.png`), fullPage: true }); } catch { /* best effort */ }
  }
  await page.close({ runBeforeUnload: false }).catch(() => {});
}


/* LinkedIn: the company page's own post box (STUDIO_LINKEDIN_PAGE, its number), never the person's feed: that box
   opens the person's saved draft. Add media → the video → Next; the text; the clock → the day picked in LinkedIn's
   calendar (a typed date is ignored, 2026-11-09) and the time typed in this computer's clock → Next. The box then
   reads "Posting Tue, Nov 10 at 6:00 PM" and its button "Schedule": both are checked before it is pressed. */
const liDialog = (page) => page.locator('[role="dialog"]').filter({ has: page.locator('[contenteditable="true"]') }).last();
async function liPressNext(page) {
  const b = page.locator('[role="dialog"] button').filter({ hasText: /^\s*(Next|Done|次へ|完了)\s*$/ });
  for (let i = (await b.count().catch(() => 0)) - 1; i >= 0; i--) {
    if ((await b.nth(i).isVisible().catch(() => false)) && (await b.nth(i).isEnabled().catch(() => false))) { await b.nth(i).click(); return true; }
  }
  return false;
}
/** "Tue, Nov 10 at 6:00 PM": what LinkedIn's post box says once a time is set (en-US UI). */
export function linkedinLabel(p) {
  return `${p.weekday}, ${MON[p.month - 1]} ${p.day} at ${p.hour12}:${pad(p.minute)} ${p.ampm.toUpperCase()}`;
}
async function scheduleLinkedIn(page, { file, text, at, extra, timeZone, rehearse, step }) {
  const pageId = String(extra?.linkedinPage || "").replace(/\D/g, "");
  if (!pageId) return fail("LinkedIn: no company page is set (STUDIO_LINKEDIN_PAGE in .env, the number in linkedin.com/company/<number>/admin), so nothing was scheduled.");
  const p = localParts(at, timeZone);
  const time = `${p.hour12}:${pad(p.minute)} ${p.ampm.toUpperCase()}`;
  const want = linkedinLabel(p);
  const dayLabel = `${MONTH[p.month - 1]} ${p.day}, ${p.year}`;
  step("opening the company page's post box", 2);
  await page.goto(`https://www.linkedin.com/company/${pageId}/admin/page-posts/published/`, { waitUntil: "domcontentloaded", timeout: 45000 });
  await sleep(4000);
  if (/\/login|authwall|\/uas\//.test(page.url())) return { state: "signin", message: "", proof: null };
  await page.getByRole("button", { name: /^(Start a post|投稿を開始)/ }).first().click({ timeout: 20000 });
  const box = liDialog(page);
  await box.waitFor({ state: "visible", timeout: 20000 });
  const before = (await box.locator('[contenteditable="true"]').first().innerText().catch(() => "")).trim();
  if (before || (await box.locator("video").count().catch(() => 0))) {
    return fail("LinkedIn: the company page's post box already holds a draft, so nothing was changed or scheduled. Post or discard that draft on LinkedIn, then schedule again.");
  }
  step("attaching the video", 3);
  const chooser = page.waitForEvent("filechooser", { timeout: 15000 }).catch(() => null);
  await box.getByRole("button", { name: /^(Add media|メディアを追加|Add a video|動画を追加)/ }).first().click();
  let fc = await chooser;
  if (!fc) {  // a media dialog first: its own upload button opens the picker
    const c2 = page.waitForEvent("filechooser", { timeout: 15000 }).catch(() => null);
    await clickByName(page, [/Upload from computer|コンピューターからアップロード|Upload/i], 5000);
    fc = await c2;
  }
  if (fc) await attachFile(fc, file);
  else {
    const input = page.locator('[role="dialog"] input[type="file"]').last();
    if (!(await input.count().catch(() => 0))) return fail("LinkedIn: no way to attach the video was found, so nothing was scheduled. The window stays open.");
    await attachFile(input, file);
  }
  // The media step ends with Next (or Done) back in the post box; LinkedIn may still be processing the video.
  const back = await until(async () => {
    if ((await liDialog(page).isVisible().catch(() => false)) && (await liDialog(page).locator("video").count().catch(() => 0))) return true;
    await liPressNext(page);
    return false;
  }, 5 * 60e3, 3000);
  if (!back) return fail("LinkedIn: the video did not come back into the post box within 5 minutes, so nothing was scheduled. The window stays open.");
  step("writing the text", 4);
  const ed = liDialog(page).locator('[contenteditable="true"]').first();
  await ed.click();
  await typeLines(page, text.split("\n"), { closeTags: true });
  await sleep(600);
  const firstLine = text.split("\n").find((l) => l.trim())?.trim().slice(0, 20) || "";
  if (!(await liDialog(page).isVisible().catch(() => false))) return fail("LinkedIn: the post box closed while writing, so nothing was scheduled.");
  if (firstLine && !(await ed.innerText().catch(() => "")).includes(firstLine)) return fail("LinkedIn: the text did not land in the post box, so nothing was scheduled. The window stays open.");
  step(`setting ${want}`, 5);
  await liDialog(page).getByRole("button", { name: /^(Schedule post|投稿を予約)$/ }).first().click();
  const sched = page.locator('[role="dialog"]').filter({ has: page.locator("#share-post__scheduled-time") }).last();
  await sched.waitFor({ state: "visible", timeout: 15000 });
  let picked = false;
  // The calendar's days exist only while the date box is open (2026-11-09: a click on a hidden day timed out).
  await sched.locator("#share-post__scheduled-date").click();
  await sleep(600);
  for (let i = 0; i < 13 && !picked; i++) {
    const day = sched.locator(`button[aria-label*="${dayLabel}"]`).first();
    if (await day.isVisible().catch(() => false)) { await day.click(); picked = true; break; }
    await sched.getByRole("button", { name: /^(Next month|翌月)$/ }).first().click().catch(() => {});
    await sleep(300);
  }
  if (!picked) return fail(`LinkedIn's calendar has no ${dayLabel}, so nothing was scheduled. The window stays open.`);
  await sched.locator("#share-post__scheduled-time").fill(time);
  await page.keyboard.press("Enter").catch(() => {});
  await sleep(800);
  const summary = await sched.innerText().catch(() => "");
  if (!summary.includes(`${MON[p.month - 1]} ${p.day},`) || !summary.includes(time)) {
    return fail(`LinkedIn shows "${(summary.split("\n").find((l) => /AM|PM/.test(l)) || "another time").trim()}", not ${want}, so nothing was scheduled. The window stays open.`);
  }
  // The time list can sit over Next and swallow the press (2026-11-09): close it, press, and wait for the panel to go.
  await sched.getByText(/^(Schedule post|投稿を予約)$/).first().click().catch(() => {});
  let moved = false;
  for (let i = 0; i < 3 && !moved; i++) {
    await sched.getByRole("button", { name: /^(Next|次へ)$/ }).first().click({ timeout: 5000 }).catch(() => {});
    moved = await until(async () => !(await sched.isVisible().catch(() => false)), 4000, 400);
  }
  if (!moved) return fail("LinkedIn: the schedule panel did not close after Next, so nothing was scheduled. The window stays open.");
  await sleep(1200);
  const shown = (await liDialog(page).innerText().catch(() => "")).replace(/\s+/g, " ");
  const btn = liDialog(page).getByRole("button", { name: /^(Schedule|予約)$/ }).first();
  if (!shown.includes(`Posting ${want}`) || !(await btn.count().catch(() => 0))) {
    return fail(`LinkedIn's post box does not say "Posting ${want}" with a Schedule button, so it was not pressed (it might post now). The window stays open.`);
  }
  if (rehearse) {
    // Leave nothing behind: close the box and discard it (a kept draft would block the next run).
    await liDialog(page).getByRole("button", { name: /^(Dismiss|閉じる)$/ }).first().click().catch(() => {});
    await page.getByRole("button", { name: /^(Discard|破棄)$/ }).first().click({ timeout: 5000 }).catch(() => {});
    return { state: "rehearsed", message: `LinkedIn: ready to schedule on the company page for ${want} (this computer's time). Rehearsal: Schedule was not pressed.`, proof: { shown: want } };
  }
  step("pressing Schedule", 6);
  await btn.click();
  const gone = await until(async () => !(await liDialog(page).isVisible().catch(() => false)), 90000);
  if (!gone) return fail("LinkedIn: Schedule was pressed but the post box is still open, so it may not have been scheduled. Check the window before trying again.");
  step("checking", 7);
  return { state: "scheduled", message: `LinkedIn: scheduled on the company page for ${want} (this computer's time).`, proof: { url: page.url(), shown: want } };
}
const SCHEDULE_URL = { x: "https://x.com/compose/post", tiktok: "https://www.tiktok.com/tiktokstudio/upload", "line-oa": "https://manager.line.biz/", linkedin: "https://www.linkedin.com/feed/" };

/** Schedule one post end to end. at: ISO with its zone (e.g. 2026-11-13T19:00+09:00). X and TikTok are set in
    the browser's own clock (the helper converts), Google Maps in the listing's (the time as written).
    rehearse: do everything but the final press. onStep(label, stage, stages) reports progress.
    Returns {state: "scheduled"|"rehearsed"|"signin"|"failed", message, proof}. */
export async function schedule({ home, network, file, text, at, extra = {}, rehearse = false, onStep = () => {} }) {
  const name = NAMES[network] || network;
  if (!SCHEDULERS.includes(network)) return fail(`The helper schedules on X, TikTok, Google Maps, LINE and LinkedIn only, not ${network}.`);
  if (!AT_RX.test(String(at || ""))) return fail("The time needs a date, a time and a zone, e.g. 2026-11-13T19:00+09:00.");
  if (!file || !existsSync(file)) return fail(`${name}: the file to post is missing; press Prepare files on the reel, then try again.`);
  const step = (label, stage) => { try { onStep(label, stage, 7); } catch { /* progress is a convenience */ } };
  if (!ctx && wantsExtension()) step("waiting for you to press \"Allow & select\" in the Chrome window titled \"Welcome\"", 1);
  const c = await context(home);
  step(`opening ${name}`, 1);
  const page = await c.newPage();
  const recipe = RECIPES[network] || {};
  try {
    await page.bringToFront().catch(() => {});
    if (network !== "gbp") {
      await page.goto(SCHEDULE_URL[network], { waitUntil: "domcontentloaded", timeout: 45000 });
      await sleep(3500);
      const out = await signedOut(page, recipe);
      remember(home, network, !out);
      if (out) return { state: "signin", message: `Sign in to ${name} ${where()}, then schedule again.`, proof: null };
    }
    const timeZone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone).catch(() => null)
      || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const args = { home, file, text: String(text || "").replace(/\s+$/, ""), at, extra, timeZone, rehearse, step };
    const r = network === "x" ? await scheduleX(page, args) : network === "tiktok" ? await scheduleTikTok(page, args)
      : network === "line-oa" ? await scheduleLine(page, args) : network === "linkedin" ? await scheduleLinkedIn(page, args) : await scheduleGbp(page, args);
    if (r.state === "signin") {
      remember(home, network, false);
      return { state: "signin", message: `Sign in to ${name} ${where()}, then schedule again.`, proof: null };
    }
    if (network === "gbp" && r.state !== "failed") remember(home, network, true);
    if (r.state !== "signin") await keepPictureAndClose(page, home, network, r.state);  // a sign-in page stays for the person
    return r;
  } catch (err) {
    const why = err.plain ? err.message : String(err.message || err).split(/\r?\n/)[0].replace(/^\w*Error: /, "");
    await keepPictureAndClose(page, home, network, "failed");
    return fail(`${name}: the helper stopped (${why}). The page stays open: check there whether anything was scheduled before trying again.`);
  }
}

/* ----------------------------------------------------------------------------------------------------
   Taking one booking back off a site (to replace it with a newer render). The studio books one post per
   network per day, so a booking is found by its exact time slot; anything but exactly one match is refused.
   X: the Scheduled list (compose/post/unsent/scheduled) › Edit › tick the one row › Delete › confirm.
   ---------------------------------------------------------------------------------------------------- */
export const UNSCHEDULERS = ["x", "tiktok"];
/* Sites load slowly at times (TikTok Studio often takes over 45 s): one more try before giving up. */
async function gotoTwice(page, url) {
  try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }); }
  catch { await sleep(3000); await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 }); }
}
const escRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
async function unscheduleX(page, { at, timeZone, step }) {
  const list = "https://x.com/compose/post/unsent/scheduled";
  const want = xLabel(localParts(at, timeZone));
  const rowRx = new RegExp("^" + escRx(want) + "\\s");
  step(`finding the post for ${want.replace("Will send on ", "")}`, 2);
  await gotoTwice(page, list);
  await page.getByRole("button", { name: /^Edit$|^編集$/ }).first().waitFor({ timeout: 20000 }).catch(() => {});
  await sleep(1500);
  const rows = await page.getByRole("button", { name: rowRx }).count();
  if (rows === 0) return { state: "gone", message: `X: nothing is scheduled for ${want.replace("Will send on ", "")}; nothing to remove.` };
  if (rows > 1) return fail(`X: ${rows} posts are scheduled for ${want.replace("Will send on ", "")}, so none was removed. Remove the right one on X.`);
  step("selecting it", 3);
  await page.getByRole("button", { name: /^Edit$|^編集$/ }).first().click();
  const box = page.getByRole("checkbox", { name: rowRx });
  await box.first().waitFor({ timeout: 15000 });
  if ((await box.count()) !== 1) return fail("X: the post could not be singled out in the list, so nothing was removed.");
  await box.first().click();
  step("deleting it", 4);
  const del = page.getByRole("button", { name: /^(Delete|削除)$/ });
  await del.first().waitFor({ timeout: 10000 });
  await del.first().click();
  const confirm = page.locator('[data-testid="confirmationSheetConfirm"]');
  if (await confirm.first().waitFor({ timeout: 8000 }).then(() => true, () => false)) await confirm.first().click();
  step("checking the list", 5);
  await sleep(2000);
  await gotoTwice(page, list);
  await sleep(3000);
  const left = await page.getByRole("button", { name: rowRx }).count();
  if (left) return fail(`X: the post for ${want.replace("Will send on ", "")} is still listed after Delete; check X before booking again.`);
  return { state: "removed", message: `X: removed the post scheduled for ${want.replace("Will send on ", "")}.`, proof: { url: list, shown: want } };
}
/* TikTok Studio › 投稿 (tiktokstudio/content): each scheduled post is a row with its time ("11月13日 午後6:00 (GMT+8)
   Singapore", or the Tokyo zone it was booked in) and a menu button whose menu has 削除. The row is the smallest element
   that holds that time, a /video/ link and a button. */
function tiktokRowLabels(at) {
  const out = [];
  for (const [tz, gmt] of [[Intl.DateTimeFormat().resolvedOptions().timeZone, null], ["Asia/Singapore", "GMT+8"], ["Asia/Tokyo", "GMT+9"]]) {
    const p = localParts(at, tz);
    out.push(`${p.month}月${p.day}日 ${p.ampm.toUpperCase() === "PM" ? "午後" : "午前"}${p.hour12}:${pad(p.minute)}` + (gmt ? ` (${gmt})` : ""));
  }
  return [...new Set(out)];
}
async function unscheduleTikTok(page, { at, step }) {
  const list = "https://www.tiktok.com/tiktokstudio/content";
  step("finding the post", 2);
  await gotoTwice(page, list);
  await page.locator('a[href*="/video/"]').first().waitFor({ timeout: 30000 }).catch(() => {});
  await sleep(2000);
  const labels = tiktokRowLabels(at).filter((l) => /GMT/.test(l));
  const rowFor = (label) => page.locator(`xpath=//*[contains(normalize-space(.), "${label}") and .//a[contains(@href, "/video/")] and .//button][not(.//*[contains(normalize-space(.), "${label}") and .//a[contains(@href, "/video/")] and .//button])]`);
  let row = null, hits = 0;
  for (const l of labels) { const n = await rowFor(l).count(); if (n) { hits += n; row = rowFor(l).first(); } }
  if (!hits) return { state: "gone", message: `TikTok: nothing is scheduled at ${labels.join(" / ")}; nothing to remove.` };
  if (hits > 1) return fail(`TikTok: ${hits} posts are scheduled at that time, so none was removed. Remove the right one in TikTok Studio.`);
  step("deleting it", 3);
  await row.locator("button").last().click();
  const del = page.getByText("削除", { exact: true }).last();
  await del.waitFor({ timeout: 10000 });
  await del.click();
  const confirm = page.getByRole("button", { name: /^削除$|^Delete$/ }).last();
  if (await confirm.waitFor({ timeout: 8000 }).then(() => true, () => false)) await confirm.click();
  step("checking the list", 4);
  await sleep(3000);
  await gotoTwice(page, list);
  await page.locator('a[href*="/video/"]').first().waitFor({ timeout: 30000 }).catch(() => {});
  await sleep(2000);
  let left = 0;
  for (const l of labels) left += await rowFor(l).count();
  if (left) return fail("TikTok: the post is still listed after 削除; check TikTok Studio before booking again.");
  return { state: "removed", message: `TikTok: removed the post scheduled for ${labels[0]}.`, proof: { url: list } };
}
export async function unschedule({ home, network, at, onStep = () => {} }) {
  const name = NAMES[network] || network;
  if (!UNSCHEDULERS.includes(network)) return fail(`${name}: taking a booking back is not automated yet. Remove it on ${name}, then book the new version.`);
  if (!AT_RX.test(String(at || ""))) return fail("The time needs a date, a time and a zone.");
  const step = (label, stage) => { try { onStep(label, stage, 5); } catch { /* progress only */ } };
  const c = await context(home);
  step(`opening ${name}`, 1);
  const page = await c.newPage();
  try {
    await page.bringToFront().catch(() => {});
    await gotoTwice(page, network === "tiktok" ? "https://www.tiktok.com/tiktokstudio/content" : SCHEDULE_URL[network]);
    await sleep(2500);
    if (await signedOut(page, RECIPES[network] || {})) return { state: "signin", message: `Sign in to ${name} ${where()}, then try again.`, proof: null };
    const timeZone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone).catch(() => null) || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const r = network === "tiktok" ? await unscheduleTikTok(page, { at, step }) : await unscheduleX(page, { at, timeZone, step });
    await page.close().catch(() => {});
    return r;
  } catch (err) {
    const why = String(err.message || err).split(/\r?\n/)[0].replace(/^\w*Error: /, "");
    return fail(`${name}: the helper stopped while removing (${why}). The page stays open: check there before booking again.`);
  }
}

/* ====================================================================================================
   Performance readers: numbers read off each network's own pages in your Chrome. Read only: they open pages,
   read text and the site's own data responses, and close their tabs. They never click Post, like or follow.
   ==================================================================================================== */

/** Networks the helper can read numbers for (the ones without an API reader in py/studio/perf.py). */
// LINE has no numbers to read, but the message list says whether a booked message was sent: "found" (server/review.mjs).
export const PERF_NETWORKS = ["tiktok", "x", "pinterest", "gbp", "linkedin", "line-oa"];

/** "1,234" / "1.2K" / "3.4M" / "1.5万" / "2億" / "12" -> a number; null when it is not one. */
export function countOf(s) {
  const m = /^\s*([\d.,]+)\s*([KkMmBb万億千]?)\s*$/.exec(String(s ?? ""));
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const mult = { k: 1e3, K: 1e3, m: 1e6, M: 1e6, b: 1e9, B: 1e9, 千: 1e3, 万: 1e4, 億: 1e8 }[m[2]] || 1;
  return Math.round(n * mult);
}

/** X's action bar label on a post -> Numbers. English ("3 replies, 2 reposts, 10 likes, 1 bookmark, 456 views")
    or Japanese ("3 件の返信、2 件のリポスト、10 件のいいね、1 件のブックマーク、456 件の表示"). Reposts count as shares. */
export function parseXLabel(label) {
  const s = String(label || "");
  const grab = (en, ja) => {
    const a = new RegExp(`([\\d.,]+[KkMm万]?)\\s*${en}`, "i").exec(s) || new RegExp(`([\\d.,]+[KkMm万]?)\\s*件の${ja}`).exec(s) || new RegExp(`${ja}\\s*([\\d.,]+[KkMm万]?)`).exec(s);
    return a ? countOf(a[1]) : null;
  };
  const out = { comments: grab("repl(?:y|ies)", "返信"), shares: grab("reposts?", "リポスト"), likes: grab("likes?", "いいね"),
    saves: grab("bookmarks?", "ブックマーク"), views: grab("views?", "表示") };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== null));
}

/* Synonyms seen in sites' own JSON for each Numbers field (lower case, no _ ). Impressions go to reach. */
const SYN = {
  views: ["playcount", "viewcount", "views", "videoviews", "videoviewcount", "plays", "totalplay", "vv"],
  likes: ["likecount", "diggcount", "likes", "reactioncount", "numlikes", "totalreactioncount"],
  comments: ["commentcount", "comments", "replycount", "numcomments"],
  shares: ["sharecount", "shares", "retweetcount", "repostcount", "numshares", "reshares"],
  // TikTok Studio's favorite_count is saves (verified 2026-11-09 on /tiktok/creator/manage/item_list/v1/).
  saves: ["savecount", "saves", "collectcount", "favoritecount", "bookmarkcount", "favouritecount", "repincount"],
  reach: ["impressioncount", "impressions", "reach", "numimpressions", "impression"],
  avg_view_s: ["avgwatchtime", "averagewatchtime", "avgplaytime", "averageviewduration"],
  completion_pct: ["finishrate", "fullwatchedrate", "completionrate", "watchedfullvideorate"],
};
const ID_KEYS = ["itemid", "awemeid", "id", "idstr", "restid", "pinid", "urn", "postid"];
// When it went (goes) out comes first: TikTok's create_time is the upload, its post_time / schedule_time the post.
const TIME_KEYS = ["posttime", "scheduletime", "publishtime", "publishedat", "createtime", "createdat", "createdtime", "timestamp"];
const TEXT_KEYS = ["desc", "description", "text", "fulltext", "title", "caption", "commentary", "summary"];
const norm = (k) => String(k).toLowerCase().replace(/[^a-z]/g, "");
function timeOf(v) {
  if (typeof v === "number" || /^\d{9,13}$/.test(String(v))) { const n = Number(v); return n < 1e11 ? n * 1000 : n; }
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}
/** Every object in a site's data that looks like one post: an id or a time, and at least one count. */
export function postObjects(tree, limit = 2000) {
  const out = [];
  const seen = new Set();
  const visit = (o, depth) => {
    if (!o || typeof o !== "object" || depth > 12 || out.length >= limit || seen.has(o)) return;
    seen.add(o);
    if (!Array.isArray(o)) {
      const flat = {};
      // A post's counts often sit one level down (statistics / stats / metrics / insights).
      for (const [k, v] of Object.entries(o)) {
        if (v && typeof v === "object" && !Array.isArray(v) && /stat|metric|insight|count|analytic|engagement/i.test(k)) for (const [k2, v2] of Object.entries(v)) flat[norm(k2)] ??= v2;
        flat[norm(k)] ??= v;
      }
      const numbers = {};
      for (const [field, keys] of Object.entries(SYN)) {
        const k = keys.find((x) => flat[x] !== undefined && flat[x] !== null && (typeof flat[x] === "number" || countOf(flat[x]) !== null));
        if (k) numbers[field] = typeof flat[k] === "number" ? flat[k] : countOf(flat[k]);
      }
      if (numbers.completion_pct !== undefined && numbers.completion_pct <= 1) numbers.completion_pct = Math.round(numbers.completion_pct * 1000) / 10;
      const idKey = ID_KEYS.find((x) => typeof flat[x] === "string" || typeof flat[x] === "number");
      const timeKey = TIME_KEYS.find((x) => flat[x] !== undefined && timeOf(flat[x]) !== null);
      const textKey = TEXT_KEYS.find((x) => typeof flat[x] === "string" && flat[x].trim());
      if (Object.keys(numbers).length && (idKey || timeKey)) {
        out.push({ id: idKey ? String(flat[idKey]) : null, time: timeKey ? timeOf(flat[timeKey]) : null, text: textKey ? flat[textKey].slice(0, 300) : "", numbers });
      }
    }
    for (const v of Object.values(o)) if (v && typeof v === "object") visit(v, depth + 1);
  };
  visit(tree, 0);
  return out;
}

/** The candidate that is this log entry: the same id; else posted within 20 minutes of its time (the closest,
    and among equals the one whose text starts like ours); else the only one whose text starts like ours. */
export function matchPost(cands, { at, text, remoteId }) {
  if (remoteId) { const hit = cands.find((c) => c.id && c.id === String(remoteId)); if (hit) return hit; }
  const head = String(text || "").split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 12) || "";
  const t = at ? Date.parse(at) : NaN;
  const texty = (c) => head && String(c.text || "").includes(head);
  if (Number.isFinite(t)) {
    const near = cands.filter((c) => c.time && Math.abs(c.time - t) <= 20 * 60e3)
      .sort((a, b) => (texty(b) - texty(a)) || Math.abs(a.time - t) - Math.abs(b.time - t));
    if (near.length) return near[0];
  }
  const byText = head ? cands.filter(texty) : [];
  return byText.length === 1 ? byText[0] : null;
}

/** Numbers written as "label  123" or "123  label" in a page's text (an analytics panel), for the given labels. */
export function labelledNumbers(text, labels) {
  const lines = String(text || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const out = {};
  for (const [field, rx] of Object.entries(labels)) {
    for (let i = 0; i < lines.length && out[field] === undefined; i++) {
      if (!rx.test(lines[i])) continue;
      const same = /([\d.,]+[KkMm万]?)\s*$/.exec(lines[i].replace(rx, " ")) || /^\s*([\d.,]+[KkMm万]?)/.exec(lines[i].replace(rx, " "));
      const n = same ? countOf(same[1]) : null;
      const near = n ?? countOf(lines[i + 1]) ?? countOf(lines[i - 1]);
      if (near !== null && near !== undefined) out[field] = near;
    }
  }
  return out;
}

/* Collect a page's own JSON responses (the data its list or chart is drawn from) while it loads. */
function captureJson(page) {
  const bodies = [];
  const on = async (r) => {
    try {
      if (bodies.length > 80 || !/json/.test(r.headers()["content-type"] || "")) return;
      const b = await r.json().catch(() => null);
      if (b && typeof b === "object") bodies.push(b);
    } catch { /* a response that went away */ }
  };
  page.on("response", on);
  return { bodies, stop: () => page.off("response", on) };
}
async function scrollSome(page, times = 3) {
  for (let i = 0; i < times; i++) { await page.mouse.wheel(0, 1600).catch(() => {}); await sleep(1500); }
}
const PERF_LABELS = {
  pinterest: { reach: /^(impressions|インプレッション)/i, saves: /^(saves|保存数?)/i, views: /^(video views|動画の再生)/i, comments: /^(comments|コメント)/i },
  gbp: { views: /^(views|表示回数|閲覧数)/i, reach: /^(impressions)/i },
  linkedin: { reach: /^(impressions|インプレッション)/i, likes: /^(reactions|リアクション)/i, comments: /^(comments|コメント)/i, shares: /^(reposts|再投稿)/i },
  tiktok: { views: /^(video views|動画視聴数|視聴数|再生数)/i, likes: /^(likes|いいね)/i, comments: /^(comments|コメント)/i, shares: /^(shares|シェア)/i, saves: /^(saves|保存)/i },
};

/* X: the post's own page when the log has its link; else the profile timeline, matched by time and text. */
async function readX(page, items) {
  const out = [];
  let handle = null;
  const findHandle = async () => {
    if (handle) return handle;
    await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 45000 });
    await sleep(3000);
    const href = await page.locator('[data-testid="AppTabBar_Profile_Link"]').first().getAttribute("href").catch(() => null);
    handle = href ? href.replace(/^\//, "") : null;
    return handle;
  };
  const articles = () => page.evaluate(() => [...document.querySelectorAll("article")].map((a) => {
    const link = [...a.querySelectorAll('a[href*="/status/"]')].find((l) => l.querySelector("time"));
    return { href: link?.getAttribute("href") || "", time: link?.querySelector("time")?.getAttribute("datetime") || "",
      text: a.querySelector('[data-testid="tweetText"]')?.innerText || "", label: a.querySelector('[role="group"][aria-label]')?.getAttribute("aria-label") || "" };
  }));
  for (const it of items) {
    try {
      const id = /\/status\/(\d+)/.exec(it.url || "")?.[1] || (/^\d{10,}$/.test(String(it.remote_id || "")) ? String(it.remote_id) : null);
      let hit = null;
      if (id) {
        await page.goto(`https://x.com/i/status/${id}`, { waitUntil: "domcontentloaded", timeout: 45000 });
        await until(async () => (await articles()).some((a) => a.href.includes(id) && a.label), 20000);
        const a = (await articles()).find((x) => x.href.includes(id));
        if (a) hit = { id, href: a.href, label: a.label };
      } else {
        const h = await findHandle();
        if (!h) { out.push({ ...it, state: "failed", message: "X: could not tell which account is signed in." }); continue; }
        await page.goto(`https://x.com/${h}`, { waitUntil: "domcontentloaded", timeout: 45000 });
        await until(async () => (await articles()).length > 0, 20000);
        let seen = new Map();
        for (let i = 0; i < 6 && !hit; i++) {
          for (const a of await articles()) if (a.href.startsWith(`/${h}/status/`)) seen.set(a.href, a);
          const cands = [...seen.values()].map((a) => ({ id: /\/status\/(\d+)/.exec(a.href)?.[1], time: Date.parse(a.time) || null, text: a.text, a }));
          const m = matchPost(cands, { at: it.at, text: it.hint });
          if (m) hit = { id: m.id, href: m.a.href, label: m.a.label };
          else await scrollSome(page, 1);
        }
      }
      if (!hit) { out.push({ ...it, state: "missing", message: "X: the post was not found on the profile (deleted, or older than the first few screens)." }); continue; }
      const numbers = parseXLabel(hit.label);
      // Found but no counts yet: it is out (studio.live confirms it), its numbers come on the next round.
      if (!Object.keys(numbers).length) { out.push({ ...it, state: "found", remote_id: hit.id, page: `https://x.com${hit.href.replace(/\/analytics$/, "")}`, message: "X: found; no counts yet." }); continue; }
      out.push({ ...it, state: "read", numbers, remote_id: hit.id, page: `https://x.com${hit.href.replace(/\/analytics$/, "")}` });
    } catch (err) { out.push({ ...it, state: "failed", message: `X: ${String(err.message || err).split("\n")[0]}` }); }
  }
  return out;
}

/* A list page whose own data holds every post (TikTok Studio's content list, LinkedIn's page posts, Google's
   posts): load it once, collect its JSON, match each log entry; a single-post page falls back to its text. */
async function readFromData(page, network, listUrl, items, { perPostUrl } = {}) {
  const cap = captureJson(page);
  const out = [];
  try {
    if (listUrl) {
      await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
      await sleep(5000);
      await scrollSome(page, 3);
    }
    for (const it of items) {
      let cands = cap.bodies.flatMap((b) => postObjects(b));
      let hit = matchPost(cands, { at: it.at, text: it.hint, remoteId: it.remote_id });
      let pageUrl = listUrl;
      if (!hit && perPostUrl?.(it)) {
        pageUrl = perPostUrl(it);
        const before = cap.bodies.length;
        await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
        await sleep(6000);
        cands = cap.bodies.slice(before).flatMap((b) => postObjects(b));
        const own = cands.filter((c) => c.id && pageUrl.includes(c.id));
        hit = own.sort((a, b) => Object.keys(b.numbers).length - Object.keys(a.numbers).length)[0] || null;
        if (!hit) {
          const nums = labelledNumbers(await pageText(page), PERF_LABELS[network] || {});
          if (Object.keys(nums).length) hit = { id: it.remote_id || null, numbers: nums };
        }
      }
      if (!hit) { out.push({ ...it, state: "missing", message: `${NAMES[network] || network}: the post was not found on its page.` }); continue; }
      out.push({ ...it, state: "read", numbers: hit.numbers, remote_id: hit.id || it.remote_id || null, page: pageUrl?.startsWith("https://") ? pageUrl : null });
    }
  } finally { cap.stop(); }
  return out;
}

/* Pinterest: the pin's own data (PinResource, what the pin page itself asks for), read from inside the pin's page.
   It holds saves, comments and shares; impressions live only in Pinterest's analytics area. Verified 2026-11-09. */
async function readPinterest(page, items) {
  const out = [];
  for (const it of items) {
    const id = /\/pin\/(\d+)/.exec(it.url || "")?.[1] || (/^\d{6,}$/.test(String(it.remote_id || "")) ? String(it.remote_id) : null);
    if (!id) { out.push({ ...it, state: "missing", message: "Pinterest: the posting log has no pin link for this post. Add it (the pin's address) so it can be read." }); continue; }
    try {
      const url = `https://www.pinterest.com/pin/${id}/`;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      await sleep(2500);
      const d = await page.evaluate(async (id) => {
        const q = `/resource/PinResource/get/?source_url=${encodeURIComponent(`/pin/${id}/`)}&data=${encodeURIComponent(JSON.stringify({ options: { id, field_set_key: "detailed" }, context: {} }))}`;
        const r = await fetch(q, { headers: { accept: "application/json", "x-pinterest-pws-handler": "www/pin/[id].js" } });
        const p = (await r.json())?.resource_response?.data || {};
        return { id: String(p.id || ""), saves: p.aggregated_pin_data?.aggregated_stats?.saves ?? p.repin_count, comments: p.comment_count, shares: p.share_count };
      }, id);
      if (d.id !== id) { out.push({ ...it, state: "missing", message: "Pinterest: the pin did not answer (deleted, or not this account's)." }); continue; }
      const numbers = Object.fromEntries(Object.entries({ saves: d.saves, comments: d.comments, shares: d.shares }).filter(([, v]) => Number.isFinite(v)));
      out.push({ ...it, state: "read", numbers, remote_id: id, page: url });
    } catch (err) { out.push({ ...it, state: "failed", message: `Pinterest: ${String(err.message || err).split("\n")[0]}` }); }
  }
  return out;
}

const PERF_LIST = {
  tiktok: () => "https://www.tiktok.com/tiktokstudio/content",
  linkedin: (it) => (/linkedin\.com\/company\/\d+\/admin/.test(it.url || "") ? it.url : null),
  gbp: (it, home) => { const id = stateValue(home, "gbpLocation"); return id ? `https://business.google.com/posts/l/${id}` : null; },
};
const PERF_POST = {
  pinterest: (it) => (/pinterest\.[a-z.]+\/pin\/\d+/.test(it.url || "") ? it.url : null),
  tiktok: (it) => (/^\d{15,}$/.test(String(it.remote_id || "")) ? `https://www.tiktok.com/tiktokstudio/analytics/${it.remote_id}` : null),
};

/** Read the numbers of these log entries off their networks' own pages, in your Chrome. Read only.
    items: [{post_id, network, at, url, remote_id, hint (the post's first line)}].
    Returns [{...item, state: "read"|"missing"|"signin"|"failed", numbers?, page?, remote_id?, message?}]. */
export async function readPerf({ home, items, onStep = () => {} }) {
  if (!ctx && wantsExtension()) { try { onStep("waiting for you to press \"Allow & select\" in the Chrome window titled \"Welcome\"", 0, 1); } catch { /* progress only */ } }
  const c = await context(home);
  const out = [];
  const nets = [...new Set(items.map((i) => i.network))].filter((n) => PERF_NETWORKS.includes(n));
  let k = 0;
  for (const net of nets) {
    const mine = items.filter((i) => i.network === net);
    try { onStep(`reading ${NAMES[net] || net} (${mine.length})`, ++k, nets.length); } catch { /* progress only */ }
    const page = await c.newPage();
    try {
      if (SIGNIN[net]?.cookie && browserMode.using === "extension") {
        const live = await liveSignins(c).catch(() => ({}));
        if (live[net] === false) { out.push(...mine.map((it) => ({ ...it, state: "signin", message: `Sign in to ${NAMES[net] || net} ${where()}, then read again.` }))); continue; }
      }
      if (net === "x") out.push(...(await readX(page, mine)));
      else if (net === "pinterest") out.push(...(await readPinterest(page, mine)));
      else if (net === "line-oa") out.push(...(await readLine(page, mine, home)));
      else {
        const list = PERF_LIST[net]?.(mine[0], home) || null;
        out.push(...(await readFromData(page, net, list, mine, { perPostUrl: PERF_POST[net] })));
      }
    } catch (err) {
      out.push(...mine.map((it) => ({ ...it, state: "failed", message: `${NAMES[net] || net}: ${String(err.message || err).split("\n")[0]}` })));
    } finally { await page.close().catch(() => {}); }
  }
  // "unreadable", not "missing": a network the helper cannot read says nothing about whether the post is out.
  for (const it of items.filter((i) => !PERF_NETWORKS.includes(i.network))) out.push({ ...it, state: "unreadable", message: `The helper cannot read ${it.network} yet.` });
  return out;
}

/* LINE: the account's message list (manager.line.biz/account/<id>/broadcast) shows each message with its date and
   time (this computer's clock, as when it was booked) and a state: 配信済み (sent) or 予約済み (booked). Read only.
   A list that shows no dated messages at all is "failed" (a changed page), never "missing", so a redesign cannot
   raise false alarms. */
/* The list row for a booking: its exact time first, else a row within 5 minutes of it. LINE shows when a message was
   delivered, which can be a minute after the booked time (12 Nov: sent 18:01 for an 18:00 booking was called "not
   shown" twice, and the post stayed unconfirmed). p: the booking's local year, month, day, hour, minute. */
export function lineRowFor(rows, p) {
  const when = `${p.year}/${pad(p.month)}/${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
  const exact = rows.find((r) => r.text.includes(when));
  if (exact) return exact;
  const want = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  const near = (t) => {
    const m = /(\d{4})\/(\d{2})\/(\d{2}) (\d{1,2}):(\d{2})/.exec(t);
    return m && Math.abs(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - want) <= 5 * 60e3;
  };
  return rows.find((r) => (r.text.match(/\d{4}\/\d{2}\/\d{2} \d{1,2}:\d{2}/g) || []).some(near)) || null;
}

async function readLine(page, items, home) {
  const list = items.map((i) => String(i.url || "")).find((u) => /^https:\/\/manager\.line\.biz\/account\/[^/]+\/broadcast/.test(u));
  if (!list) return items.map((it) => ({ ...it, state: "failed", message: "LINE: this booking has no message-list address, so it cannot be checked here." }));
  await page.goto(list, { waitUntil: "domcontentloaded", timeout: 45000 });
  await sleep(5000);
  if (RECIPES["line-oa"].signin.test(page.url())) {
    remember(home, "line-oa", false);
    return items.map((it) => ({ ...it, state: "signin", message: `Sign in to LINE ${where()}, then read again.` }));
  }
  remember(home, "line-oa", true);
  // Each row of the list carries a coloured pin with its state (manager.line.biz, 2026-11; the legend above the table
  // names them): badge-info 配信予約中 (booked), badge-warning 下書き (draft), badge-success 配信済み (sent), and
  // badge-danger 配信エラー (error). The row also holds the delivery time in this computer's clock.
  const readRows = async () => {
    await scrollSome(page, 2);
    return page.evaluate(() => [...document.querySelectorAll("tr, [role=row]")].map((e) => {
      const text = (e.innerText || "").replace(/\s+/g, " ").trim();
      const pin = (e.querySelector(".badge-pin, .badge") || {}).className || "";
      const state = /badge-success/.test(pin) ? "sent" : /badge-danger/.test(pin) ? "error" : /badge-info/.test(pin) ? "booked" : /badge-warning/.test(pin) ? "draft" : "unknown";
      return { state, text, pin: String(pin).slice(0, 120) };
    }).filter((r) => /\d{4}\/\d{2}\/\d{2} \d{1,2}:\d{2}/.test(r.text))).catch(() => []);
  };
  // The list opens on 配信予約中 (booked); sent messages are on the 配信済み tab and failed ones on 配信エラー. Each tab is
  // read, and a row with no state pin takes its tab's (12 Nov: only the booked tab was read, so a sent message was never
  // seen, and the pins had stopped carrying a state).
  const asTab = (list, state) => list.map((r) => (r.state === "unknown" ? { ...r, state } : r));
  let rows = asTab(await readRows(), "booked");
  const seen = new Set(rows.map((r) => r.text));
  for (const [label, state] of [["配信済み", "sent"], ["配信エラー", "error"]]) {
    // The tab itself (a link or tab whose whole text is the label), not any text that contains it.
    const tab = page.locator("a, button, [role=tab], li").filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) }).first();
    if (!(await tab.count().catch(() => 0))) continue;
    await tab.click().catch(() => {});
    await sleep(3500);
    // Only rows the tab brought: a click that left the table as it was must never relabel booked rows as sent.
    const fresh = (await readRows()).filter((r) => !seen.has(r.text));
    for (const r of fresh) seen.add(r.text);
    rows = rows.concat(asTab(fresh, state));
  }
  // What the reader saw, kept so a verdict can be checked by a person (the rows' text only; no message is opened).
  try { writeFileSync(join(home, "line-list.json"), JSON.stringify({ read: new Date().toISOString(), url: page.url(), rows }, null, 1)); } catch { /* best effort */ }
  if (!rows.length) {
    // Kept for a person (or a fix) to see what the page showed: the list's text only, no messages are opened.
    try { writeFileSync(join(home, "line-list.txt"), (await pageText(page)).slice(0, 6000)); } catch { /* best effort */ }
    return items.map((it) => ({ ...it, state: "failed", message: "LINE: the message list showed no dated messages (the page may have changed); its text is in line-list.txt in the studio's home folder." }));
  }
  const zone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone).catch(() => null) || Intl.DateTimeFormat().resolvedOptions().timeZone;
  return items.map((it) => {
    const p = localParts(it.at, zone);
    const when = `${p.year}/${pad(p.month)}/${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
    const row = lineRowFor(rows, p);
    // Not in the list says nothing for sure (the list may not show every sent message), so it is never "missing".
    if (!row) return { ...it, state: "unreadable", message: `LINE: the message list does not show ${when}; check it in LINE (line-list.json has what was read).` };
    if (row.state === "sent") return { ...it, state: "found", page: page.url(), message: `LINE: sent (${when}).` };
    if (row.state === "error") return { ...it, state: "missing", message: `LINE: the list shows a delivery error for ${when}.` };
    if (row.state === "booked" || row.state === "draft") return { ...it, state: "missing", message: `LINE: still ${row.state === "draft" ? "a draft" : "booked"}, not sent (${when}).` };
    return { ...it, state: "unreadable", message: `LINE: the row for ${when} shows no state the helper knows.` };
  });
}

export async function closeHelper() {
  if (ctx && browserMode.using === "extension") {
    // Your Chrome: close only the tabs the helper opened, then let go of it (the relay refuses Browser.close anyway).
    for (const p of ctx.pages()) if (!browserMode.anchors.has(p)) await p.close().catch(() => {});
    browserMode.bridge?.stop();
    browserMode.bridge = null;
    ctx = null;
    return;
  }
  if (ctx) await ctx.close().catch(() => {});
  ctx = null;
}
