/**
 * FILE: server/dropbox.mjs
 * PURPOSE: The drop box: people on the same Wi-Fi (guests at the ranch) send photos and videos from their phone
 *          straight to this computer. No app, no account, and none of their cloud storage is used.
 * OVERVIEW: A second, small web server that listens on the local network only while the owner has it open (Footage ›
 *           Collect footage), and closes itself after the hours chosen. It serves one page and one upload route under a
 *           secret path (/d/<token>), answers only private-network addresses, takes only photo and video files, and
 *           writes each one to <data>/inbox/<date>_<name>/. The studio's main server stays on 127.0.0.1.
 * DEPENDENCIES: node:http, node:fs, node:os, node:crypto; server/health.mjs (free disk space).
 */
import { createServer } from "node:http";
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join, extname, basename } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { freeDiskBytes } from "./health.mjs";

export const DROP_PORT = Number(process.env.STUDIO_DROP_PORT || 4319);
/** Photo and video formats phones and cameras make (the studio catalogs these). */
export const DROP_TYPES = [".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", ".dng", ".mp4", ".mov", ".m4v", ".3gp", ".mts", ".avi", ".insv", ".insp"];
const MAX_FILE = 8 * 1024 ** 3;       // one file at most 8 GB (a long 4K video)
const KEEP_FREE = 5 * 1024 ** 3;      // never fill the disk the studio renders on: keep 5 GB free after a file

/** 10.x, 172.16-31.x, 192.168.x, link-local, loopback and IPv6 private ranges: people on this network, not the internet. */
export function isPrivate(addr = "") {
  const a = String(addr).replace(/^::ffff:/, "");
  if (/^(10|127)\./.test(a) || /^192\.168\./.test(a) || /^169\.254\./.test(a)) return true;
  const m = /^172\.(\d+)\./.exec(a); if (m && +m[1] >= 16 && +m[1] <= 31) return true;
  return a === "::1" || /^f[cd][0-9a-f]{2}:/i.test(a) || /^fe80:/i.test(a);
}
/** This computer's address on the local network (what phones on the same Wi-Fi open). */
export function lanAddress() {
  const all = Object.values(networkInterfaces()).flat().filter((x) => x && x.family === "IPv4" && !x.internal && isPrivate(x.address));
  // Prefer the usual home / ranch router ranges over virtual adapters (WSL, Hyper-V use 172.x).
  return (all.find((x) => x.address.startsWith("192.168.")) || all.find((x) => x.address.startsWith("10.")) || all[0])?.address || null;
}
/** A file name safe on Windows: letters, digits, dot, dash, underscore, Japanese; nothing that walks out of the folder. */
export function safeName(name = "") {
  // The last part after any / or \ (not path.basename: on Windows it reads "a:" as a drive and drops it).
  const last = String(name).split(/[\\/]/).pop() || "";
  const base = last.normalize("NFC").replace(/[\u0000-\u001f<>:"|?*]+/g, "_").replace(/^\.+/, "").slice(0, 120);
  return base || "file";
}
const slugWho = (who = "") => String(who).normalize("NFC").replace(/[\u0000-\u001f<>:"/\\|?*.\s]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "guest";
const sameToken = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

let server = null, state = null;

export function dropState() {
  if (!state) return { open: false };
  const { token, until, received, bytes, folders, lastAt, host } = state;
  return { open: true, until: new Date(until).toISOString(), url: host ? `http://${host}:${DROP_PORT}/d/${token}` : null, host, port: DROP_PORT, received, bytes, folders: [...folders], lastAt };
}

/** Open the drop box for `hours` (1-12). inbox: the folder files go to. onFiles(): called once uploads go quiet. */
export function openDrop({ hours = 3, inbox, onFiles, place = "" }) {
  const h = Math.max(1, Math.min(12, Math.round(Number(hours) || 3)));
  const host = lanAddress();
  if (!host) throw Object.assign(new Error("This computer is not on a local network (Wi-Fi or cable), so phones cannot reach it."), { status: 409 });
  mkdirSync(inbox, { recursive: true });
  if (state) { state.until = Date.now() + h * 3600e3; clearTimeout(state.timer); state.timer = setTimeout(closeDrop, h * 3600e3); return dropState(); }
  state = { token: randomBytes(9).toString("base64url"), until: Date.now() + h * 3600e3, received: 0, bytes: 0, folders: new Set(), lastAt: null, host, inbox, onFiles, quiet: null,
    page: dropPage(place) };
  state.timer = setTimeout(closeDrop, h * 3600e3);
  server = createServer((req, res) => handle(req, res).catch(() => { if (!res.headersSent) send(res, 500, "error"); }));
  server.requestTimeout = 0;  // a big video over Wi-Fi takes a while; the socket's own timeout below still applies
  server.on("error", () => closeDrop());
  server.listen(DROP_PORT, "0.0.0.0");
  return dropState();
}
export function closeDrop() {
  if (!state) return dropState();
  clearTimeout(state.timer); clearTimeout(state.quiet);
  const done = state.received ? state.onFiles : null;
  state = null;
  try { server?.close(); server?.closeAllConnections?.(); } catch { /* already closed */ }
  server = null;
  if (done) done();
  return dropState();
}

const HEAD = { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; form-action 'none'; frame-ancestors 'none'; base-uri 'none'" };
function send(res, code, body, type = "text/plain; charset=utf-8") { res.writeHead(code, { ...HEAD, "content-type": type }); res.end(body); }

async function handle(req, res) {
  if (!state || !isPrivate(req.socket.remoteAddress)) return send(res, 403, "This drop box is only for people on the same Wi-Fi.");
  const url = new URL(req.url, "http://drop");
  const m = /^\/d\/([A-Za-z0-9_-]{6,40})(\/[a-z.]*)?$/.exec(url.pathname);
  if (!m || !sameToken(m[1], state.token)) return send(res, 404, "Not found. Ask for the current link or QR code.");
  const sub = m[2] || "";
  if (req.method === "GET" && (sub === "" || sub === "/")) return send(res, 200, state.page, "text/html; charset=utf-8");
  if (req.method === "GET" && sub === "/app.js") return send(res, 200, APP, "text/javascript; charset=utf-8");
  if (req.method === "POST" && sub === "/up") return upload(req, res, url);
  return send(res, 404, "Not found.");
}

/* Save one streamed file into <inbox>/<folder>/<name> (a new name if taken, never overwriting): photo and video types
   only, at most 8 GB, refused when the disk would be left nearly full; written as .part and renamed when complete.
   onSaved({ name, bytes, folder }) runs after the answer is sent. Used by the drop box (phones) and by the studio's
   own page (files dropped on Footage). */
export function saveUpload(req, res, { inbox, name: rawName, folder, onSaved, reply }) {
  const answer = reply || ((code, msg) => send(res, code, msg));
  const name = safeName(rawName || "");
  const ext = extname(name).toLowerCase();
  if (!DROP_TYPES.includes(ext)) return answer(415, `Only photos and videos (${DROP_TYPES.join(" ")}).`);
  const size = Number(req.headers["content-length"] || 0);
  if (!size) return answer(411, "No file.");
  if (size > MAX_FILE) return answer(413, "That file is over 8 GB.");
  const free = freeDiskBytes(inbox);
  if (free != null && free - size < KEEP_FREE) return answer(507, "This computer is nearly full.");
  const dir = join(inbox, folder);
  mkdirSync(dir, { recursive: true });
  /* Each upload writes its own .part; the final name is picked when it is complete. Two phones sending IMG_0001.JPG at
     once shared one .part before (13 Nov review): the photo was corrupted and the second rename threw, ending the studio. */
  const freeName = () => {
    let out = join(dir, name), n = 1;
    while (existsSync(out)) out = join(dir, `${basename(name, extname(name))}-${n++}${extname(name)}`);
    return out;
  };
  const part = join(dir, `.${randomBytes(6).toString("hex")}-${name}.part`);
  const ws = createWriteStream(part);
  let got = 0, failed = false;
  req.setTimeout(10 * 60e3);
  const fail = (code, msg) => { if (failed) return; failed = true; ws.destroy(); try { rmSync(part, { force: true }); } catch { /* gone */ } if (!res.headersSent) answer(code, msg); };
  req.on("data", (c) => { got += c.length; if (got > size || got > MAX_FILE) { fail(413, "Bigger than it said."); req.destroy(); } });
  req.on("aborted", () => fail(400, "The upload stopped."));
  req.on("error", () => fail(400, "The upload stopped."));
  req.pipe(ws);
  ws.on("error", () => fail(500, "Could not save the file."));
  ws.on("finish", () => {
    if (failed) return;
    if (got !== size) return fail(400, "The upload stopped part way. Try that one again.");
    let out;
    try { out = freeName(); renameSync(part, out); } catch { return fail(500, "Could not save the file."); }
    send(res, 200, JSON.stringify({ ok: true, name: basename(out), bytes: got }), "application/json");
    onSaved?.({ name: basename(out), bytes: got, folder });
  });
}

async function upload(req, res, url) {
  const day = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
  const folderName = `${day}_${slugWho(url.searchParams.get("who") || "")}`;
  saveUpload(req, res, { inbox: state.inbox, name: url.searchParams.get("name") || "", folder: folderName, reply: (code, msg) => send(res, code, code === 507 ? "This computer is nearly full. Tell the owner." : msg),
    onSaved: ({ bytes }) => {
      if (!state) return;
      state.received += 1; state.bytes += bytes; state.folders.add(folderName); state.lastAt = new Date().toISOString();
      // Catalog once things go quiet (a minute after the last file), not after every photo.
      clearTimeout(state.quiet); const cb = state.onFiles; state.quiet = setTimeout(() => cb?.(), 60e3);
    } });
}

const escHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
/* The page phones see: Japanese first, then English. Pick, send, see each file arrive. `place` is the open project's
   name (the owner's place or brand); without one the page says "this computer". */
export function dropPage(place = "") {
  const p = escHtml(String(place).trim().slice(0, 40));
  return PAGE.replace("{PLACE_HEAD}", p ? ` · ${p}` : "")
    .replace("{PLACE_JA}", p ? `${p}のパソコン` : "このパソコン").replace("{PLACE_EN}", p ? `${p}'s computer` : "this computer")
    .replace("{USE_JA}", p ? `${p}のショート動画` : "ショート動画").replace("{USE_EN}", p ? `${p}'s short videos` : "short videos");
}
const PAGE = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lazycow Studio · 写真と動画を送る</title>
<style>
:root { --bg:#fbfaf5; --ink:#1d1e19; --fg:#fcfcfa; --y:#be9737; --g:#7ca925; --c:#3da1ed; --p:#fc6f52; }
* { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.5 system-ui, "Hiragino Sans", "Yu Gothic UI", sans-serif; }
header { background:var(--ink); color:var(--fg); padding:14px 16px; font:700 13px/1.3 ui-monospace, Consolas, monospace; letter-spacing:.06em; }
header b { color:var(--y); }
main { padding:16px; max-width:560px; margin:0 auto; display:grid; gap:14px; }
h1 { font-size:22px; margin:4px 0 0; } p { margin:0; } .en { color:#55584c; font-size:14px; }
label { display:grid; gap:4px; font-weight:600; } input[type=text] { font:inherit; padding:12px; border:1px solid var(--ink); border-radius:0; background:#fff; }
.pick { display:block; text-align:center; padding:22px 12px; background:var(--ink); color:var(--fg); font-weight:800; font-size:18px; border:0; width:100%; }
.pick small { display:block; font-weight:500; font-size:13px; color:#c6c5bc; margin-top:4px; }
input[type=file] { position:absolute; width:1px; height:1px; opacity:0; }
ul { list-style:none; padding:0; margin:0; display:grid; gap:6px; } li { border:1px solid var(--ink); padding:8px 10px; display:grid; gap:4px; background:#fff; }
li .n { font:600 13px/1.3 ui-monospace, Consolas, monospace; overflow-wrap:anywhere; } .bar { height:8px; background:#e6e4da; } .bar i { display:block; height:100%; width:0; background:var(--c); }
li.ok .bar i { background:var(--g); } li.bad .bar i { background:var(--p); width:100%; } .st { font-size:13px; }
.sum { font:700 14px/1.4 ui-monospace, Consolas, monospace; background:var(--ink); color:var(--fg); padding:10px 12px; } .sum b { color:var(--g); }
</style></head><body>
<header><b>LAZYCOW STUDIO</b>{PLACE_HEAD}</header>
<main>
  <h1>写真と動画を送ってください</h1>
  <p>このWi-Fiから、スマホの写真・動画をそのまま{PLACE_JA}に送れます。アプリもアカウントも不要で、あなたの容量は使いません。</p>
  <p class="en">Send your photos and videos straight to {PLACE_EN} over this Wi-Fi. No app, no account, and none of your storage is used.</p>
  <label>お名前（任意） <span class="en">Your name (optional)</span><input type="text" id="who" maxlength="40" autocomplete="name"></label>
  <label class="pick" for="files">写真・動画を選ぶ<small>Choose photos and videos · 何枚でも</small></label>
  <input type="file" id="files" accept="image/*,video/*" multiple>
  <div class="sum" id="sum" hidden></div>
  <ul id="list"></ul>
  <p class="en">送った写真・動画は、{USE_JA}に使わせていただくことがあります。 Sent photos and videos may be used in {USE_EN}.</p>
</main><script src="app.js"></script></body></html>`;

const APP = `"use strict";
const list = document.getElementById("list"), sum = document.getElementById("sum"), who = document.getElementById("who");
try { who.value = localStorage.getItem("who") || ""; } catch (e) {}
who.addEventListener("change", () => { try { localStorage.setItem("who", who.value); } catch (e) {} });
let queue = [], busy = false, ok = 0, okBytes = 0;
const mb = (n) => (n / 1048576).toFixed(n > 104857600 ? 0 : 1) + " MB";
document.getElementById("files").addEventListener("change", (e) => {
  for (const f of e.target.files) {
    const li = document.createElement("li");
    li.innerHTML = '<span class="n"></span><span class="bar"><i></i></span><span class="st">待機中 · waiting</span>';
    li.querySelector(".n").textContent = f.name + " · " + mb(f.size);
    list.prepend(li); queue.push({ f, li });
  }
  e.target.value = ""; next();
});
function next() {
  if (busy || !queue.length) return;
  busy = true;
  const { f, li } = queue.shift(), x = new XMLHttpRequest(), bar = li.querySelector(".bar i"), st = li.querySelector(".st");
  x.open("POST", "up?name=" + encodeURIComponent(f.name) + "&who=" + encodeURIComponent(who.value.trim()));
  x.upload.onprogress = (ev) => { if (ev.lengthComputable) { bar.style.width = (100 * ev.loaded / ev.total).toFixed(1) + "%"; st.textContent = "送信中 · sending " + Math.round(100 * ev.loaded / ev.total) + "%"; } };
  x.onload = () => {
    if (x.status === 200) { li.className = "ok"; bar.style.width = "100%"; st.textContent = "届きました · received"; ok += 1; okBytes += f.size; sum.hidden = false; sum.innerHTML = "<b>" + ok + "</b> 件届きました · received (" + mb(okBytes) + ")。ありがとうございます!"; }
    else { li.className = "bad"; st.textContent = x.responseText || ("error " + x.status); }
    busy = false; next();
  };
  x.onerror = () => { li.className = "bad"; st.textContent = "送れませんでした。Wi-Fiを確認して、もう一度選んでください。 Could not send: check the Wi-Fi and pick it again."; busy = false; next(); };
  x.send(f);
}`;
