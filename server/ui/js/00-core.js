/* ---------- basics ---------- */
const $ = (s) => document.querySelector(s);
const file = (p) => "/file?p=" + encodeURIComponent(p);
const thumb = (p, w) => file(p) + "&w=" + w;  // a small copy of a picture, for cards and rows
/* An e-mail address shortened on screen ("ke…@gmail.com"), the whole one on hover: screenshots and screen shares
   should not carry it. */
const maskMail = (a) => { const m = /^([^@\s]{1,2})[^@\s]*(@.+)$/.exec(String(a || "")); return m ? `${m[1]}…${m[2]}` : String(a || ""); };
const ico = (n, cls = "") => `<svg class="i ${cls}"><use href="#i-${n}"/></svg>`;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
/* A link from data (a post's address, a research source, a music page) as an href: web, mail and this page's own
   addresses only, so a javascript: or data: address that reached the data never runs on a click (security review 13 Nov). */
/* Lazy Kenji, in the pose that fits the moment: wave (hello), lounge (nothing to do; you only review), nap (nothing
   being made), work, thumbs (done), point (a tip), worried (nothing found), bust (the setup guide). */
const kenji = (pose) => `<img class="kenji" src="/brand/kenji-${pose}.png" alt="" width="128" height="128" decoding="async">`;
const escUrl = (u) => (/^(https?:\/\/|mailto:|#|\/(?!\/))/i.test(String(u ?? "").trim()) ? esc(String(u).trim()) : "#");
/* A render's last log line is for a developer ("remotion failed for x 9x16; see E:\\...\\raw_9x16.log"): people get
   a plain sentence, and the line stays one hover away (fresh-user review, 15 Nov). */
const TECH_RX = /[A-Za-z]:\\|\/[\w.-]+\/[\w.-]|Traceback|Error\b|\.log\b|remotion|ffmpeg|errno|exit (code )?\d/i;
const plainFail = (line) => (TECH_RX.test(String(line || "")) || !line ? tr("job.plain") : String(line));
/* A reel by its headline (what people see); the internal name stays in the hover title. */
/* The render's steps come from the server in English; in Japanese they are said in Japanese (fresh-user review: "waiting
   its turn" and "rendering words and picture at 9:16" on a Japanese screen). */
const JOB_JA = [[/^finished$/, "完了"], [/^waiting its turn$/, "順番待ち"],[/^waiting to mix sound$/, "音の仕上げ待ち"], [/^starting$/, "開始中"], [/^picking footage$/, "素材を選んでいます"],
  [/^grading the best moment of each clip$/, "各素材のいちばん良い瞬間を選んでいます"], [/^rendering words and picture at (\S+)$/, "$1で文字と映像を書き出しています"],
  [/^mixing music and sound effects$/, "音楽と効果音を合わせています"], [/^cutting a copy for every network$/, "SNSごとの版を作っています"],
  [/^writing the review sheet$/, "確認用のシートを作っています"], [/^ready to review$/, "確認できます"], [/^stopping$/, "止めています"], [/^cancelled$/, "取り消しました"],
  [/^finished$/, "完了"], [/^waiting for the helper$/, "ヘルパー待ち"], [/^stopped: some files may be half-made, render again before approving$/, "止めました：途中のファイルがあるかもしれません。承認の前に書き出し直してください"]];
const jobLabel = (l) => { const t = String(l || ""); if (lang !== "ja") return t; for (const [rx, ja] of JOB_JA) if (rx.test(t)) return t.replace(rx, ja); return t; };
let revOnly = null;  // a phone opened one reel: Review shows just that one
function reelName(slug) {
  const r = (typeof overview !== "undefined" && overview?.reels || []).find((x) => x.slug === slug);
  if (!r && /^\d{4}-\d{6}-\d{2}-[a-z]+-[a-z]+$/.test(slug || "")) {  // a photo post's Story (network photo-story)
    const s = (globalThis.PH_SETS || []).find((x) => x.id === slug);
    if (!globalThis.PH_SETS && !reelName.askedSets) {  // names live with the sets: read them once, then draw again
      reelName.askedSets = true;
      loadPhotos().then(() => { if (globalThis.PH_SETS && atHome()) renderHome(true); });
    }
    if (s) return `${lang === "ja" ? s.styleJa : s.styleEn} · ${lang === "ja" ? s.themeJa : s.themeEn}`;
    const [, , , st, th] = slug.split("-");
    return `${tr("nav.photos")} · ${st} · ${th}`;
  }
  return String(r?.title || "").replace(/\s+/g, " ").trim() || slug;
}
const fmt = (t) => { const m = Math.floor(t / 60); return String(m).padStart(2, "0") + ":" + (t % 60).toFixed(2).padStart(5, "0"); };
const GRID = 0.5, FPS = 30;
let MEDIA = "", MEDIA_MEZZ = "", AUD_TZ = "", WORKSPACE = "", CONNECT = null, RANCH_WS = true, TILE_CREDIT = "";
/* A label that says "ranch" in the ranch workspace and a neutral word in a project made in the studio (key + "Any"). */
const trR = (k, vars) => tr(RANCH_WS ? k : k + "Any", vars);
const trA = (k, vars) => tr(!RANCH_WS && I18N.en[k + "Any"] != null ? k + "Any" : k, vars);  // trR, for keys that may not have a neutral version
const DEVICE_ICON = { dji: "drone", phone: "phone", canon: "camera", gopro: "camera", insta360: "camera" };
const TAG_ICON = { snow: "snow", autumn: "leaf", night: "moon", sunset: "sun", flowers: "flower", fire: "flame", aerial: "drone", people: "user" };
const SEASON_ICON = { winter: "snow", autumn: "leaf", summer: "sun", spring: "flower" };
/* Each network: its brand mark (#n-… in the sprite; a letter where there is none) and brand colour. */
const CH_STYLE = { instagram: ["@instagram", "#c13584"], "instagram-story": ["@instagram", "#e1306c"], "photo-story": ["@instagram", "#e1306c"], threads: ["@threads", "#101010"], facebook: ["@facebook", "#1877f2"], "youtube-shorts": ["@youtube", "#e62117"], tiktok: ["@tiktok", "#101010"], x: ["@x", "#000"],
  linkedin: ["@linkedin", "#0a66c2"], line: ["@line", "#06c755"], "line-voom": ["@line", "#06c755"], "line-oa": ["@line", "#06c755"], gbp: ["@gbp", "#4285f4"], pinterest: ["@pinterest", "#e60023"], bluesky: ["@bluesky", "#0085ff"], note: ["@note", "#41c9b4"],
  kensaurus: ["k", "#4d6b52"], zenn: ["Z", "#3ea8ff"], xiaohongshu: ["@xiaohongshu", "#ff2442"] };
function netLogo(id, size = "") {
  const [mark, color] = CH_STYLE[id] || CH_STYLE[chOf(id)] || ["•", "#555"];
  const inner = mark.startsWith("@") ? `<svg class="ni" aria-hidden="true"><use href="#n-${mark.slice(1)}"/></svg>` : esc(mark);
  return `<span class="logo-ch ${size}" style="background:${color}" title="${esc(NET_NAME[id] || NET_NAME[netOf(id)] || id)}">${inner}</span>`;
}

let reels = [], reel = null, edit = null, saved = "", history = [], future = [];
let aspect = "9x16", pps = 70, snapOn = true, sel = null, ltab = "library";
let lib = { items: [], events: [] }, libQuery = "", libFilters = { ranch: true }, libSel = null, channelsSpec = null, playbooks = [];
/* The network's playbook (shared/playbooks.json), by channel id. */
const pbOf = (net) => playbooks.find((b) => b.id === chOf(net)) || null;
let mode = "rendered", t = 0, playing = false, lastTick = 0;
const player = $("#player"), pv = $("#pv"), pi = $("#pi");

/* A problem message that names its fix gets a "Fix it" button that goes straight there. */
const FIXES = [
  [/accounts ›|not connected|sign in with|signed? in again|connect (it|bluesky|facebook)|アカウント ›|未接続|サインイン/i, "accounts", () => goPage("accounts")],
  [/time zone|タイムゾーン/i, "tz", () => openWizard(startSteps().findIndex((x) => x.key === "setup.tz") + 1)],
  [/free space|disk|ffmpeg|render tools|空き容量|ディスク/i, "system", () => $("#sysBtn")?.click()],
  [/footage folder|no footage|素材フォルダ|素材がありません/i, "footage", () => goPage("footage")],
];
function fixFor(msg) {
  const text = String(msg).replace(/<[^>]+>/g, " ");
  if (!/alert|bad|error|not |cannot|can't|could not|ません|できません/i.test(String(msg))) return null;
  return FIXES.find(([rx]) => rx.test(text)) || null;
}
function toast(msg, ms = 2600) {
  const el = $("#toast"), fix = fixFor(msg);
  el.innerHTML = msg + (fix ? ` <button class="fixit" data-fixit="${fix[1]}">${ico("chev-r", "sm")}${tr("fix.it")}</button>` : "");
  el.style.pointerEvents = fix ? "auto" : "";
  el.style.display = "block"; clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.style.display = "none"), fix ? Math.max(ms, 10000) : ms);
}
document.addEventListener("click", (e) => {
  const b = e.target.closest?.("[data-fixit]"); if (!b) return;
  const fix = FIXES.find((f) => f[1] === b.dataset.fixit);
  $("#toast").style.display = "none";
  fix?.[2]();
});
/* The page list's fades (narrow screens): more pages to the left or right of what is showing. */
/* The page's own tab rows (Reels' and Posting's) get the same fades: on a phone "Words" was cut at the edge with no
   sign there was more to scroll to. */
const FADE_ROWS = ".topnav, .subtabs, .posttabs";
function navFades() {
  document.querySelectorAll(FADE_ROWS).forEach((nav) => {
    nav.classList.toggle("more-l", nav.scrollLeft > 2);
    nav.classList.toggle("more-r", nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 2);
  });
}
addEventListener("resize", () => navFades(), { passive: true });
document.addEventListener("scroll", (e) => { if (e.target?.matches?.(FADE_ROWS)) navFades(); }, { capture: true, passive: true });
/* Every call says what went wrong in words: the server's own {error}, or that the server is not answering.
   A request can fail while the studio is fine: a browser extension (an ad or privacy blocker) drops it. So before
   saying the studio is down, ask /api/health once; if that answers, only this one request was blocked. */
async function studioAnswers() {
  try { const r = await fetch("/api/health", { cache: "no-store" }); return r.ok; } catch { return false; }
}
async function api(path, opts) {
  let r;
  try { r = await fetch(path, opts); }
  catch {
    if (!path.startsWith("/api/health") && await studioAnswers()) {
      const err = new Error(tr("sys.blocked", { path: path.split("?")[0] })); err.blocked = true; throw err;
    }
    sys.offline(true); const err = new Error(tr("sys.noserver")); err.offline = true; throw err;
  }
  if (!r.ok) {
    const text = await r.text();
    let msg = text, data = null;
    try { data = JSON.parse(text); msg = data.error || text; } catch { /* plain text */ }
    if (r.status === 404 && msg === "no") msg = tr("sys.oldserver");
    // A refusal that names its fields (a product render's encoding: [{field, text}]) keeps them for the page.
    throw Object.assign(new Error(msg || `${r.status}`), Array.isArray(data?.errors) ? { errors: data.errors } : {});
  }
  return r.headers.get("content-type")?.includes("json") ? r.json() : r.text();
}
// A POST that starts work (a render, a batch, AI, scoring, a post or swap) re-reads the work list right after, so the
// board and the status bar show the new job even if its live event is late or was missed.
const STARTS_WORK = /^\/api\/(project|explainers\/(save|add|queue|preview)|autopilot|remix|ai\/run|perf\/score-all|posts\/(replace|autoreplace|plan)|publish|youtube\/upload|helper\/post|footage\/(scan|cameras)|gphotos)/;
/* The key actions the private usage counts keep (BL-120), by the call that does them: approve, book, make reels. */
const USAGE_ACTS = [[/^\/api\/approve$/, "review:approve"], [/^\/api\/(posts\/plan|publish|helper\/schedule|youtube\/upload)$/, "posting:book"], [/^\/api\/autopilot$/, "reels:make"]];
const post = (path, data) => api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) })
  .then((r) => {
    if (STARTS_WORK.test(path) && typeof loadJobs === "function") setTimeout(loadJobs, 400);
    const act = USAGE_ACTS.find(([rx]) => rx.test(path)); if (act && typeof uiCount === "function") uiCount(act[1]);
    return r;
  });
const mins = (s) => s == null ? "" : s < 60 ? tr("eta.sec") : tr("eta.min", { n: Math.round(s / 60) });  // time left
const span = (s) => s == null ? "" : s < 60 ? tr("dur.sec") : s < 5400 ? tr("dur.min", { n: Math.round(s / 60) }) : tr("dur.h", { n: (s / 3600).toFixed(1) });  // how long something takes

/* ---------- system: is the server up, current, and is this computer up to it? ---------- */
const sys = {
  health: null, build: null, browser: null, down: false, msgs: new Map(),
  closed: new Set(),
  say(key, cls, html, actions = "") {
    if (this.closed.has(key) && cls !== "bad") return;  // closed by the person: a warning or an "ok" note does not come back
    this.msgs.set(key, `<div class="sysmsg ${cls}" data-sys="${key}">${ico(cls === "bad" ? "alert" : cls === "warn" ? "alert" : "info", "sm")}<span>${html}</span>${actions}<button class="x" data-sysx="${key}" aria-label="${tr("src.close")}">${ico("x", "sm")}</button></div>`);
    $("#sysbar").innerHTML = [...this.msgs.values()].join("");
  },
  clear(key) { if (this.msgs.delete(key)) $("#sysbar").innerHTML = [...this.msgs.values()].join(""); },
  offline(on) {
    if (on === this.down) return;
    this.down = on;
    if (on) this.say("offline", "bad", tr("sys.offline"), "");
    else {
      this.clear("offline"); this.check();
      // Back: a page that failed while the studio was away kept "not answering" and "0 clips" until Try again.
      // Load it again by itself, unless an edit is open.
      if ($("#home")?.textContent.includes(tr("sys.noserver")) && !(reel && edit && isDirty())) setTimeout(() => location.reload(), 800);
    }
    this.paintDot();
  },
  paintDot() {
    // The dot also shows what is running (Drive, search helper); the banners only judge the computer.
    const order = ["ok", "unknown", "slow", "blocked"];
    const m = this.verdict(), s = this.health?.service || "ok";
    const v = this.down ? "offline" : order.indexOf(s) > order.indexOf(m) ? s : m;
    $("#sysDot").className = "sysdot " + v;
    $("#sysBtn").title = tr(VERDICT_KEY[v]);
  },
  verdict() {
    const order = ["ok", "unknown", "slow", "blocked"];
    const levels = [this.health?.verdict || "unknown", ...(this.browser || []).map((c) => c.level)];
    return levels.reduce((a, b) => (order.indexOf(b) > order.indexOf(a) ? b : a), "ok");
  },
  /* The words for a problem say where it is: the computer that renders, or only this browser / screen
     (a narrow window or a software GPU makes the editor clumsy; it does not slow a render). */
  msgKey() {
    const m = this.health?.verdict;
    if (m === "blocked") return "sys.blockedmsg";
    if (m === "slow") return "sys.slowmsg";
    return this.verdict() === "blocked" ? "sys.browserblocked" : "sys.browsermsg";
  },
  async check() {
    let r, h = {};
    try { r = await fetch("/api/health", { cache: "no-store" }); }
    catch { return this.offline(true); }
    if (this.down) this.offline(false);
    try { h = await r.json(); } catch { h = {}; }  // an older server has no /api/health
    // A server older than /api/health has no /api/restart either: only the terminal can restart it.
    if (!h.build) { this.say("old", "warn", tr("sys.oldserverterm"), ""); return; }
    this.health = h;
    if (this.build && this.build !== h.build) {
      // The studio was updated: an old page would keep showing old (or empty) data. Reload by itself unless an edit is open.
      if (!(reel && edit && isDirty())) { toast(`${ico("refresh", "sm")} ${tr("sys.autoreload")}`, 2500); setTimeout(() => location.reload(), 1500); return; }
      this.say("reload", "ok", tr("sys.newversion"), `<button class="primary" data-sysreload="1">${ico("refresh", "sm")}${tr("sys.reload")}</button>`);
    }
    this.build ??= h.build;
    // The page itself was updated (no server restart needed): reload into it, unless an edit is open.
    this.page ??= h.pageBuild;
    if (h.pageBuild && this.page !== h.pageBuild) {
      if (!(reel && edit && isDirty())) { toast(`${ico("refresh", "sm")} ${tr("sys.pagereload")}`, 2500); setTimeout(() => location.reload(), 1500); return; }
      this.say("reload", "ok", tr("sys.newversion"), `<button class="primary" data-sysreload="1">${ico("refresh", "sm")}${tr("sys.reload")}</button>`);
    }
    if (h.stale && h.restartPending) this.say("stale", "ok", tr("sys.restartlater"), "");
    else if (h.stale) this.say("stale", "warn", tr("sys.stale"), `<button data-sysrestart="1">${ico("refresh", "sm")}${tr("sys.restart")}</button>`);
    else this.clear("stale");
    this.browser ??= await browserChecks();
    const v = this.verdict();
    let seen = ""; try { seen = localStorage.getItem("studio.sysSeen") || ""; } catch { /* private mode */ }
    const screenOnly = v === "slow" && window.innerWidth < 900 && !document.body.classList.contains("in-editor");  // a phone browsing the pages is fine
    if ((v === "slow" || v === "blocked") && !screenOnly && seen !== v + h.build) this.say("machine", v === "blocked" ? "bad" : "warn", tr(this.msgKey()), `<button data-sysopen="1">${tr("sys.why")}</button>`);
    this.paintDot();
    if ($("#sysModal").classList.contains("on")) this.render();
  },
  render() {
    const h = this.health, v = this.verdict();
    const ja = (c, part) => (lang === "ja" ? SYS_JA[`${c.id}.${part}${part === "fix" ? "." + c.level : ""}`] : null);
    const row = (c) => { const fix = c.fix ? ja(c, "fix") || c.fix : ""; return `<div class="check ${c.level}"><span class="sysdot ${c.level}" style="margin-top:6px"></span><b>${esc(ja(c, "label") || c.label)}</b><span>${esc(c.found)}</span>${fix ? `<span class="fix">${esc(fix)}</span>` : ""}</div>`; };
    $("#sysBody").innerHTML = !h ? `<div class="skel skel-line"></div><div class="skel skel-line"></div>` : `
      <div class="verdict ${v}"><span class="sysdot ${v}"></span><div><b>${tr(VERDICT_KEY[v])}</b><span class="meta">${tr("sys.reeltime", { t: span(h.buildSeconds) })} · ${tr(h.buildSecondsSource === "measured" ? "sys.measured" : "sys.estimated")}</span></div></div>
      <h3>${ico("film", "sm")} ${tr("sys.thispc")}</h3><div class="checks">${h.checks.map(row).join("")}</div>
      <h3>${ico("globe", "sm")} ${tr("sys.thisbrowser")}</h3><div class="checks">${(this.browser || []).map(row).join("")}</div>
      <p class="meta">${esc(h.machine.cpu)} · ${h.machine.ramGb} GB · ${esc(h.machine.platform)} · ${tr("sys.build")} ${esc(h.build)}${h.version ? ` · v${esc(h.version)}` : ""}</p>`;
  },
};
/* The server's checks arrive in English (server/health.mjs); these are their Japanese labels and advice, by check id and level. */
/* Literal keys so the language test can see every label the page uses. */
const VERDICT_KEY = { ok: "sys.v.ok", unknown: "sys.v.unknown", slow: "sys.v.slow", blocked: "sys.v.blocked", offline: "sys.v.offline" };
const MATCH_KEY = { weak: "clip.weak", fair: "clip.fair", strong: "clip.strong" };
const SYS_JA = {
  "cpu.label": "プロセッサ", "ram.label": "メモリ", "disk.label": "書き出し用の空き容量", "python.label": "スタジオのエンジン（Python）",
  "ffmpeg.label": "動画ツール（ffmpeg）", "data.label": "スタジオのデータフォルダ", "media.label": "素材フォルダ", "helper.label": "素材検索", "gpu.label": "動画のエンコード",
  "cpu.fix.blocked": "1本の書き出しに30分以上かかります。4コア／8スレッド以上のパソコンを使ってください。", "cpu.fix.slow": "書き出しは遅めです。書き出し中はほかの重いアプリを閉じてください。",
  "ram.fix.blocked": "素材検索と書き出しで約4GB使います。8GB以上のパソコンを使ってください。", "ram.fix.slow": "何本もまとめて作る前に、ブラウザのタブやほかのアプリを閉じてください。",
  "disk.fix.blocked": "新しい書き出しを止めています。データフォルダのあるドライブの空きを増やすか、STUDIO_DATAを大きなドライブにしてください。", "disk.fix.slow": "空きが少なくなっています。投稿しない古い下書きを消してください。",
  "python.fix.blocked": "README の「First run」の手順で、スタジオ用の venv を作ってください。", "ffmpeg.fix.blocked": "ffmpeg.exe と ffprobe.exe を STUDIO_DATA\\bin に置いてください（README の「First run」）。",
  "data.fix.blocked": "STUDIO_DATA のフォルダが存在し、書き込める必要があります。", "media.fix.slow": "Googleドライブは起動・ログインしていますか？リールの編集はできますが、新しい素材は読めません。",
  "helper.fix.blocked": "次の検索で自動的に再起動します。止まり続ける場合は python -m studio service で原因を確認してください。",
};
/* What only the browser knows: screen room for the editor, a real GPU for smooth preview, H.264 playback. */
async function browserChecks() {
  const out = [];
  const add = (level, label, found, fix = "") => out.push({ level, label, found, fix });
  const w = window.screen?.availWidth || window.innerWidth;
  add(w >= 1280 ? "ok" : "slow", tr("sys.b.screen"), `${w} px`, w >= 1280 ? "" : tr("sys.b.screenfix"));
  let gpu = "";
  try { const gl = document.createElement("canvas").getContext("webgl"); const d = gl?.getExtension("WEBGL_debug_renderer_info"); gpu = d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl ? "WebGL" : ""; } catch { gpu = ""; }
  const software = !gpu || /swiftshader|llvmpipe|basic render|software/i.test(gpu);
  add(software ? "slow" : "ok", tr("sys.b.gpu"), gpu ? gpu.replace(/^ANGLE \(|\)$/g, "").replace(/\s*\(0x[0-9A-F]+\)/i, "").slice(0, 80) : tr("sys.b.nogpu"), software ? tr("sys.b.gpufix") : "");
  try {
    const info = await navigator.mediaCapabilities?.decodingInfo({ type: "file", video: { contentType: 'video/mp4; codecs="avc1.640028"', width: 1080, height: 1920, bitrate: 8e6, framerate: 30 } });
    add(info?.smooth ? "ok" : info?.supported ? "slow" : "blocked", tr("sys.b.video"), info ? tr(info.smooth ? "sys.b.smooth" : info.supported ? "sys.b.choppy" : "sys.b.cannot") : "?", info?.smooth ? "" : tr("sys.b.videofix"));
  } catch { add("unknown", tr("sys.b.video"), "?"); }
  const mem = navigator.deviceMemory;
  if (mem) add(mem >= 4 ? "ok" : "slow", tr("sys.b.mem"), `${mem}+ GB`, mem >= 4 ? "" : tr("sys.b.memfix"));
  return out;
}
document.addEventListener("click", async (e) => {
  const x = e.target.closest("[data-sysx]");
  if (x) { const k = x.dataset.sysx; if (k === "machine") { try { localStorage.setItem("studio.sysSeen", sys.verdict() + sys.health?.build); } catch { /* fine */ } } sys.closed.add(k); return sys.clear(k); }
  if (e.target.closest("#sysBtn") || e.target.closest("[data-sysopen]")) { $("#sysModal").classList.add("on"); sys.render(); return; }
  if (e.target.closest("#sysClose") || e.target === $("#sysModal")) { $("#sysModal").classList.remove("on"); return; }
  if (e.target.closest("#aboutBtn") || e.target.closest("[data-about]")) { openAbout(); return; }
  if (e.target.closest("#aboutClose, [data-aboutx]") || e.target === $("#aboutModal")) { $("#aboutModal").classList.remove("on"); return; }
  const doc = e.target.closest("[data-doc]");
  if (doc) { showDoc(doc.dataset.doc); return; }
  if (e.target.closest("#sysRecheck")) { sys.browser = null; sys.health = null; sys.render(); return sys.check(); }
  if (e.target.closest("[data-sysreload]")) { if (!(reel && edit && isDirty()) || confirm(tr("sys.leaveedits"))) location.reload(); return; }
  if (e.target.closest("[data-sysrestart]")) {
    const b = e.target.closest("[data-sysrestart]"); b.disabled = true;
    try {
      const r = await post("/api/restart", { whenIdle: true });
      if (r?.waiting) { sys.say("stale", "ok", tr("sys.restartlater"), ""); return; }  // a long job runs: it restarts by itself after it
    }
    catch (err) { if (!err.offline) { b.disabled = false; return toast(`${ico("alert", "sm")} ${esc(err.message)}`, 7000); } }  // offline = it already went down: wait for it
    sys.say("stale", "ok", tr("sys.restarting"), "");
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try { const h = await (await fetch("/api/health", { cache: "no-store" })).json(); if (h.build && !h.stale) { location.reload(); return; } } catch { /* still restarting */ }
    }
    sys.say("stale", "bad", tr("sys.restartfail"), "");
  }
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { $("#sysModal").classList.remove("on"); $("#newModal").classList.remove("on"); $("#aboutModal").classList.remove("on"); } });
setInterval(() => sys.check(), 20000);

/* ---------- boot ---------- */
let NAMES = { looks: {}, recipes: {} };  // look and recipe names (shared/looks.json), for Results' sentences
async function boot() {
  restoreLayout();
  applyLang();
  // Never a blank page while the first data comes: a busy machine (a render on every core) can take a while to answer
  if (!$("#home").children.length) {
    $("#home").innerHTML = `<div class="loading-block" role="status" aria-live="polite" id="bootwait"><span class="spin"></span><span>${esc(tr("boot.wait"))}</span></div>`;
    setTimeout(() => { const w = $("#bootwait"); if (w) w.lastElementChild.textContent = tr("boot.slow"); }, 6000);
  }
  sys.check();
  loadAbout();
  let cfg;
  try { cfg = await api("/api/config"); }
  catch (err) {
    $("#home").innerHTML = `<div class="empty" style="margin:40px auto;max-width:560px"><b>${ico("alert")} ${tr("sys.bootfail")}</b><span>${esc(err.message)}</span><span class="meta">${tr("sys.bootfix")}</span><button class="primary" onclick="location.reload()">${ico("refresh", "sm")}${tr("sys.reload")}</button></div>`;
    setTimeout(() => location.reload(), 8000);
    return;
  }
  MEDIA = cfg.media.replace(/[\\/]$/, "") + "\\";
  MEDIA_MEZZ = cfg.mezz;
  NAMES = { looks: cfg.looks || {}, recipes: cfg.recipes || {} };
  AUD_TZ = cfg.audienceTz || "";
  TILE_CREDIT = cfg.tiles?.credit || "";  // another map provider's credit line (STUDIO_TILE_CREDIT); empty = OpenStreetMap's
  WORKSPACE = cfg.workspace || "";
  CONNECT = cfg.connect || null;
  RANCH_WS = cfg.ranch !== false;
  if (cfg.workspace !== undefined) document.querySelectorAll(".workspace").forEach((el) => { el.textContent = WORKSPACE; el.hidden = !WORKSPACE; });  // an older server sends none: keep the page text
  uiLoad();  // simple or full, and the usage counts (BL-114, BL-120): redraws when it differs from the last value seen
  if (!/^#\/reel\//.test(location.hash)) route();  // draw the page now with placeholders; it fills in as data arrives
  channelsSpec = await api("/api/channels").catch(() => ({ channels: [] }));
  api("/api/playbooks").then((v) => { playbooks = v?.playbooks || []; if (atHome() && (page === "accounts" || page === "posting")) renderHome(true); }).catch(() => {});
  loadWorkspaces();
  themes = await api("/api/themes").catch(() => null);
  await Promise.all([loadOverview(), loadPosting()]).catch((err) => toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000));
  route();
  searchLibrary();
  loadAudio();
  const q = new URLSearchParams(location.search);
  if (q.get("connected")) toast(`${ico("check", "sm")} YouTube connected: ${esc(q.get("connected"))}`, 5000);
  if (q.get("gphotos")) { toast(`${ico("check", "sm")} Google Photos connected`, 5000); window.history.replaceState(null, "", "/" + location.hash); }
  if (q.get("ytError")) toast(`${ico("alert", "sm")} YouTube: ${esc(q.get("ytError"))}`, 8000);
  if (q.get("connected") || q.get("ytError")) window.history.replaceState(null, "", "/" + location.hash);
}
let overview = { reels: [] }, homeFilter = "all", audioLib = [], overviewLoaded = false;
/* "Synced 2 min ago" in the header: when the page last heard from the server, and a button to ask again. */
let lastSync = 0;
const jobWaiters = new Map();  // slug → resolve(job) when its job ends (the planner waits on YouTube uploads one by one)
function paintSync() {
  const el = $("#syncInfo"); if (!el) return;
  const s = lastSync ? Math.round((Date.now() - lastSync) / 1000) : null;
  el.textContent = s == null ? "…" : s < 10 ? tr("sync.now") : s < 60 ? tr("sync.sec", { n: s }) : tr("sync.min", { n: Math.round(s / 60) });
  $("#syncBtn").title = lastSync ? `${tr("sync.tip")} · ${new Date(lastSync).toLocaleTimeString()}` : tr("sync.tip");
  $("#syncBtn").classList.toggle("stale", !!s && s > 300);
}
setInterval(paintSync, 10000);
/* The status bar: what the studio is doing now (renders and their time left), what goes out next, and the keys for
   this screen. Repainted when data arrives and every few seconds. */
function paintStatus() {
  const st = $("#sbState"), nx = $("#sbNext"), ks = $("#sbKeys"); if (!st) return;
  const busy = overview.reels.filter((r) => typeof busyJob === "function" && busyJob(r));
  const run = busy.find((r) => r.job?.status === "running");
  const eta = busy.length ? Math.max(...busy.map((r) => r.job?.eta || 0)) : 0;
  const down = !!sys.down;
  const other = [...board.jobs.values()].filter((j) => isActive(j) && !RENDER_KINDS.includes(j.kind));
  const otherTxt = BOARD_GROUPS.map(([g]) => g).concat("other").map((g) => [g, other.filter((j) => groupOf(j) === g).length]).filter(([, n]) => n).map(([g, n]) => `${tr(GROUP_KEY[g])} ${n}`).join(" · ");
  st.className = "sb " + (down ? "m-down" : busy.length || other.length ? "m-busy" : "m-ready");
  if (busy.length || other.length) { st.dataset.goto = "making"; st.title = tr("sb.t.making"); } else { delete st.dataset.goto; st.removeAttribute("title"); }
  st.innerHTML = down ? `<b class="sbm"><i class="led down"></i>${esc(tr("sb.mode.down"))}</b><span>${esc(tr("sb.down"))}</span>`
    : busy.length ? `<b class="sbm"><i class="led busy"></i>${esc(tr("sb.mode.busy"))}</b><span>${esc(tr("sb.rendering", { n: busy.length, t: eta ? mins(eta) : "…" }))}${run ? `<span class="sbx"> · ${esc(tr("sb.now", { s: reelName(run.slug) }))}</span>` : ""}</span>`
    : other.length ? `<b class="sbm"><i class="led busy"></i>${esc(tr("sb.mode.work"))}</b><span>${esc(otherTxt)}</span>`
    : `<b class="sbm"><i class="led"></i>${esc(tr("sb.mode.ready"))}</b><span>${esc(tr("sb.ready"))}</span>`;
  if (busy.length && otherTxt) st.lastElementChild?.insertAdjacentHTML("beforeend", `<span class="sbx"> · ${esc(otherTxt)}</span>`);
  const next = typeof upcomingPosts === "function" && postsLoaded ? upcomingPosts(1)[0] : null;
  if (next) { nx.dataset.goto = "posting"; nx.title = tr("sb.t.next"); } else delete nx.dataset.goto;
  nx.innerHTML = next ? `<b class="sbm">${esc(tr("sb.mode.next"))}</b><span><em>${esc(NET_NAME[next.network] || next.network)}</em> ${esc(untilText(next.at))} · ${esc(reelName(next.slug))}</span>` : "";
  // "key|what · key|what": the key in a keycap, what it does beside it.
  const keys = atHome() ? (page === "review" ? tr("sb.keysreview") : tr("sb.keys")) : tr("sb.keyseditor");
  ks.dataset.helpkeys = "1"; ks.title = tr("sb.t.keys");
  ks.innerHTML = keys.split(" · ").map((x) => { const [k, w] = x.split("|"); return `<span class="kp"><kbd>${esc(k)}</kbd>${esc(w || "")}</span>`; }).join("");
  paintAiMonth();  // batch D: this month's AI spend, in the language of the moment
}
setInterval(paintStatus, 5000);
setTimeout(loadJobs, 1500);
/* ---------- Posting news: what goes out next, what just went out, what failed ----------
   The header shows the next post and counts down; the bell lists what happened (kept in this browser), and a post
   that goes live or fails pops a toast, plus a desktop notification when the tab is in the background and allowed. */
const NEWS_KEY = "studio.news", NEWS_SEEN = "studio.newsSeen", LAST_VISIT = "studio.lastVisit";
// lsGet / lsSet are defined further down; this first read runs at load, so it reads storage directly.
let news = []; try { news = JSON.parse(localStorage.getItem(NEWS_KEY) || "[]") || []; } catch { news = []; }
let postSnap = null, newsOpen = false;
// A row that was swapped for a new version, dropped or failed is history, not a post: it never counts as sent or booked.
const isHistory = (p) => ["replaced", "dropped", "failed"].includes(p.status);
const isLive = (p) => p.status === "posted" || (p.status === "scheduled" && p.at && new Date(p.at).getTime() <= Date.now());
function addNews(tone, text, href, notify = true) {
  news.unshift({ t: Date.now(), tone, text, href });
  news = news.slice(0, 40); lsSet(NEWS_KEY, JSON.stringify(news));
  if (notify) {
    toast(`${ico(tone === "bad" ? "alert" : tone === "ok" ? "check" : "cal", "sm")} ${esc(text)}${href ? ` <a href="${escUrl(href)}" target="${href.startsWith("#") ? "_self" : "_blank"}" rel="noopener">${tr("act.open")}</a>` : ""}`, 6000);
    if (document.hidden && "Notification" in window && Notification.permission === "granted") { try { new Notification("Lazycow Studio", { body: text, icon: "/brand/icon-192.png", tag: String(Date.now()) }); } catch { /* not allowed */ } }
  }
  paintNews();
}
/* Compare the posting log with what this page saw last time: a post that went live, failed, or was booked. */
function postNews(list) {
  const rows = list.filter((p) => p.network !== "all");
  const snap = new Map(rows.map((p) => [p.id, { status: p.status, live: isLive(p) }]));
  const name = (p) => NET_NAME[p.network] || p.network;
  if (postSnap) {
    for (const p of rows) {
      const was = postSnap.get(p.id), is = snap.get(p.id);
      if (!was) { if (["scheduled", "queued"].includes(p.status)) addNews("info", tr("news.booked", { s: p.slug, n: name(p), t: whenText(p.at) }), "#/posting", false); continue; }
      if (!was.live && is.live) addNews("ok", tr("news.live", { s: p.slug, n: name(p) }), p.url || "#/posting/sent");
      else if (was.status !== "failed" && p.status === "failed") addNews("bad", tr("news.failed", { s: p.slug, n: name(p), w: (p.note || "").slice(0, 120) }), "#/posting");
      else if (was.status !== "missing" && p.status === "missing") addNews("bad", tr("news.missing", { s: p.slug, n: name(p), w: String(p.note || "").split(" · ").pop().slice(0, 120) }), "#/posting");
    }
  } else {
    // First look since the last visit: one line for what went out meanwhile, and one for anything that failed.
    const since = +lsGet(LAST_VISIT, 0);
    if (since) {
      const went = rows.filter((p) => isLive(p) && p.at && new Date(p.at).getTime() > since);
      const bad = rows.filter((p) => ["failed", "missing"].includes(p.status) && (p.id || 0) && p.at && new Date(p.at).getTime() > since);
      if (went.length) addNews("ok", tr("news.away", { n: went.length, list: [...new Set(went.map(name))].join(", ") }), "#/posting/sent");
      if (bad.length) addNews("bad", tr("news.awaybad", { n: bad.length }), "#/posting");
    }
  }
  postSnap = snap; lsSet(LAST_VISIT, String(Date.now()));
  paintNews();
}
/* Every booking still to go out (planned, scheduled or queued, not out yet): Posting's "N posts coming up" and the
   Accounts map count the same rows (the map said 113 while Posting said 137: the 24 Instagram Stories). */
function bookedAhead() {
  return postsLog.filter((p) => ["planned", "scheduled", "queued"].includes(p.status) && p.network !== "all" && p.at)
    .map((p) => ({ ...p, raw: p.status, status: postState(p.slug)[p.network]?.status || p.status })).filter((p) => p.status !== "posted")
    .sort((a, b) => (a.at || "").localeCompare(b.at || ""));
}
function upcomingPosts(n = 5) {
  const now = Date.now();
  return postsLog.filter((p) => p.network !== "all" && ["scheduled", "queued", "planned"].includes(p.status) && p.at && new Date(p.at).getTime() > now)
    .sort((a, b) => new Date(a.at) - new Date(b.at)).slice(0, n);
}
function untilText(at) {
  const m = Math.max(0, Math.round((new Date(at).getTime() - Date.now()) / 60000));
  return m < 60 ? tr("news.inm", { m }) : m < 48 * 60 ? tr("news.inh", { h: Math.floor(m / 60), m: m % 60 }) : tr("news.ind", { d: Math.round(m / 1440) });
}
function paintNews() {
  const next = upcomingPosts(1)[0], label = $("#newsNext"); if (!label) return;
  label.textContent = !postsLoaded ? "…" : next ? tr("news.next", { n: NET_NAME[next.network] || next.network, t: untilText(next.at) }) : tr("news.none");
  // Track C (24 Nov): the bell is news only. What went wrong is counted once, in Needs you (the red button), so the
  // bell's dot counts what went out and never turns red (it showed 9+ beside the red 6 for the same failures).
  const unseen = news.filter((x) => x.t > +lsGet(NEWS_SEEN, 0) && x.tone === "ok").length;
  $("#newsDot").hidden = !unseen; $("#newsDot").textContent = unseen > 9 ? "9+" : unseen || "";
  $("#newsDot").className = "ndot";
  if (newsOpen) paintNewsPanel();
}
function paintNewsPanel() {
  const up = upcomingPosts(5);
  const perm = "Notification" in window ? Notification.permission : "unsupported";
  const probs = $("#probBtn")?.hidden ? 0 : +($("#probBtn")?.textContent || 0);  // the one inbox's count (WN.paintBtn)
  $("#newsPanel").innerHTML = `${probs ? `<button type="button" class="tc-bell-ib" data-probopen="1">${ico("alert", "sm")}<span>${esc(tr("tc.bell.inbox", { n: probs }))}</span> ›</button>` : ""}<h4>${ico("cal", "sm")} ${tr("news.upnext")}</h4>
    ${up.length ? up.map((p) => `<a class="nrow" href="#/reel/${esc(p.slug)}">${netLogo(chOf(p.network), "sm")}<span class="ntext"><b lang="ja" title="${esc(p.slug)}">${esc(reelName(p.slug))}</b><span class="meta">${esc(NET_NAME[p.network] || p.network)} · ${esc(whenText(p.at))}</span></span><span class="chip">${esc(untilText(p.at))}</span></a>`).join("") : `<p class="meta">${tr("news.none")}</p>`}
    <h4>${ico("bell", "sm")} ${tr("news.happened")}</h4>
    ${news.length ? news.slice(0, 12).map((x) => `<${x.href ? `a href="${escUrl(x.href)}" ${x.href.startsWith("#") ? "" : 'target="_blank" rel="noopener"'}` : "div"} class="nrow n-${x.tone}">${ico(x.tone === "bad" ? "alert" : x.tone === "ok" ? "check" : "cal", "sm")}<span class="ntext"><span>${esc(x.text)}</span><span class="meta">${esc(new Date(x.t).toLocaleString(lang === "ja" ? "ja-JP" : "en-GB", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }))}</span></span></${x.href ? "a" : "div"}>`).join("") : `<p class="meta">${tr("news.empty")}</p>`}
    <div class="row nfoot"><a class="btn" href="#/posting">${ico("send", "sm")}${tr("news.schedule")}</a><a class="btn" href="#/results">${ico("wave", "sm")}${tr("news.results")}</a>
      ${perm === "default" ? `<button data-notifyon="1">${ico("bell", "sm")}${tr("news.desktop")}</button>` : perm === "granted" ? `<span class="meta">${ico("check", "sm")} ${tr("news.desktopon")}</span>` : ""}</div>`;
}
document.addEventListener("click", async (e) => {
  if (e.target.closest("#newsBtn")) {
    newsOpen = !newsOpen; $("#newsPanel").hidden = !newsOpen; $("#newsBtn").setAttribute("aria-expanded", String(newsOpen));
    if (newsOpen) { lsSet(NEWS_SEEN, String(Date.now())); paintNews(); }
    return;
  }
  if (e.target.closest("[data-notifyon]")) { try { await Notification.requestPermission(); } catch { /* blocked */ } paintNewsPanel(); return; }
  if (newsOpen && !e.target.closest("#newsPanel")) { newsOpen = false; $("#newsPanel").hidden = true; $("#newsBtn").setAttribute("aria-expanded", "false"); }
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && newsOpen) { newsOpen = false; $("#newsPanel").hidden = true; } });
/* A light check every minute: only when the log changed does the page redraw (never while you type). */
let postsHash = "";
async function pollPosts() {
  let list; try { list = await api("/api/posts"); } catch { return; }
  const h = JSON.stringify(list.map((p) => [p.id, p.status, p.at, p.url, p.seen_at]));
  if (h !== postsHash) {
    postsHash = h; postsLog = list; postNews(list); if (page === "posting") loadAuto();
    const typing = document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (atHome() && !typing) renderHome();
  } else postNews(list);  // a scheduled post whose time just passed counts as live: same log, new state
}
setInterval(() => { if (postsLoaded) pollPosts(); paintNews(); }, 60000);
async function refreshAll() {
  const b = $("#syncBtn"); b.classList.add("spin"); b.disabled = true;
  try {
    ytVideos = null; logData = null; drawerCache.clear();
    await Promise.all([loadOverview(), loadPosting()]);
    if (atHome() && page === "footage") { foot.loadedKey = null; loadSources(); }
    if (atHome()) renderHome(true);
    toast(`${ico("check", "sm")} ${tr("sync.done")}`, 1800);
  } catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 5000); }
  finally { b.classList.remove("spin"); b.disabled = false; }
}
async function loadOverview() {
  overview = await api("/api/overview");
  // A server from before this change lists footage scans and folder checks as reels: they are not.
  overview.reels = overview.reels.filter((r) => r.rendered || !r.job?.kind || ["build", "remix"].includes(r.job.kind));
  overviewLoaded = true;
  if (!loadOverview.landed) {
    loadOverview.landed = true;
    const bare = () => /^(#\/?)?$/.test(location.hash);
    if (bare() && !overview.reels.some((r) => !r.house)) api("/api/vlogs").then((v) => { if (v?.parts?.some((p) => p.built) && bare()) location.hash = "#/videos"; }).catch(() => {});
  }
  lastSync = Date.now(); paintSync(); paintStatus();
  const waiting = needsReview().length;
  $("#homeCount").textContent = waiting || overview.reels.filter((r) => !r.house).length;  // the same count as the Reels page (house reels are not counted there)
  $("#homeCount").title = waiting ? `${waiting} to review` : "";
  $("#homeCount").className = "chip " + (waiting ? "warn" : "");
  $("#homeCount").hidden = !waiting && !overview.reels.some((r) => !r.house);  // no boxed 0 next to Reels
  tdNavPaint();  // Track D: Footage's new count, and names for the phone nav
  setTitle();
  if (atHome()) renderHome();
  else if (reel) renderQueue();
}
/* The tab says where you are and what is waiting, so a pinned tab is useful on its own. */
/* About: version and build from the server (package.json), who made it, how to credit it, and the
   NOTICE / trademark / third-party / changelog texts, readable in place. */
let about = null;
async function loadAbout() {
  try { about = await api("/api/about"); } catch { return; }
  $("#verTag").textContent = "v" + about.version;
  $("#footVer").textContent = "v" + about.version;
}
function openAbout() {
  $("#aboutModal").classList.add("on");
  const a = about || {};
  $("#aboutVer").textContent = a.version ? `v${a.version} · build ${a.build} · Node ${a.node}` : "";
  $("#aboutBody").innerHTML = `
    <table class="kv">
      <tr><td>${tr("about.madeby")}</td><td><a href="https://kensaur.us" target="_blank" rel="noopener author">Kenji Sakuramoto (kensaurus)</a> · kensaurus LLC</td></tr>
      <tr><td>${tr("about.licence")}</td><td>${tr("about.licencev")}</td></tr>
      <tr><td>${tr("about.credit2")}</td><td>${tr("about.creditv")}</td></tr>
      ${a.support ? `<tr><td>${tr("about.support")}</td><td>${tr("about.supportwhy")}<br>
        <a href="${escUrl(a.support.once?.[lang === "ja" ? "jpy" : "usd"])}" target="_blank" rel="noopener">${tr("about.once")}</a>
        ${(a.support.monthly || []).map((p) => ` · <a href="${escUrl(p.url)}" target="_blank" rel="noopener">${esc(lang === "ja" ? p.ja : p.name)} ${lang === "ja" ? `¥${Number(p.jpy).toLocaleString("ja-JP")}` : `$${Number(p.usd)}`}${tr("about.permonth")}</a>`).join("")}
        · <a href="${escUrl(a.support.manage)}" target="_blank" rel="noopener">${tr("about.manage")}</a></td></tr>` : ""}
      ${a.support?.sponsors?.length ? `<tr><td>${tr("about.sponsored")}</td><td>${a.support.sponsors.map((s) => s.url ? `<a href="${escUrl(s.url)}" target="_blank" rel="noopener sponsored">${esc(s.name)}</a>` : esc(s.name)).join(" · ")}</td></tr>` : ""}
      ${WORKSPACE ? `<tr><td>${tr("about.workspace")}</td><td>${esc(WORKSPACE)}</td></tr>` : ""}
      <tr><td>${tr("about.family")}</td><td>${FAMILY.map((f) => `<a href="${escUrl(f.url + (f.url.includes("?") ? "&" : "?") + "utm_source=lazycow&utm_medium=app&utm_campaign=family")}" target="_blank" rel="noopener"><b>${esc(f.name)}</b></a> <span class="meta">${tr(f.key)}</span>`).join("<br>")}
        <br><a href="https://kensaur.us/?view=portfolio&utm_source=lazycow&utm_medium=app&utm_campaign=family" target="_blank" rel="noopener">${tr("about.familyall")} ↗</a></td></tr>
    </table>
    <p class="meta">${tr("about.built")}</p>
    <div class="row wrap">${(a.docs || []).map((d) => `<button data-doc="${esc(d)}">${ico("list", "sm")}${esc(d)}</button>`).join("")}</div>
    <pre class="doc" id="aboutDoc" hidden></pre>`;
}
/* Other kensaurus products, shown in About (owner, 17 Nov: "crosslink and upsell our other products"). Names and
   taglines follow kensaur.us/apps.json (Lazycow's "related" list); links carry utm_source=lazycow. */
const FAMILY = [
  { name: "Mushi Mushi", key: "fam.mushi", url: "https://kensaur.us/mushi-mushi/" },
  { name: "kenji skills", key: "fam.skills", url: "https://kensaur.us/notes/kenji-skills/en/" },
];
async function showDoc(name) {
  const box = $("#aboutDoc");
  try { const r = await fetch("/docs/" + encodeURIComponent(name)); box.textContent = r.ok ? await r.text() : `${name}: ${r.status}`; }
  catch (err) { box.textContent = err.message; }
  box.hidden = false; box.scrollIntoView({ block: "nearest" });
}
function setTitle() {
  const waiting = needsReview().length;
  const where = !atHome() && reel ? `${reel.slug} · ${tr("nav.reels")}` : tr(PAGES[page]?.[1] || "nav.reels");
  document.title = `${waiting ? `(${waiting}) ` : ""}${where} · Lazycow Studio`;
}
const busyJob = (r) => r.job && (r.job.status === "queued" || r.job.status === "running");
/* A reel that can still go out: not a house reel, not rejected, not a draft, not skipped. Warnings about repeated
   words count only these (two rejected reels and a draft were nagging "3 reels repeat"). */
const mayPost = (r) => !r.house && !["rejected", "draft"].includes(r.status) && reelState(r) !== "skip";
// House reels are the old hand-made set: never queued for review (same rule as the card's review dot).
const needsReview = () => overview.reels.filter((r) => r.rendered && r.status === "rendered" && !r.house && !busyJob(r));
const atHome = () => $("#app").classList.contains("at-home");
function route() {
  const m = /^#\/reel\/([a-z0-9-]+)/.exec(location.hash);
  if (m && matchMedia("(max-width: 700px)").matches) { revOnly = m[1]; page = "review"; homeFilter = "all"; showHome(); paintNav(); return; }
  revOnly = null;
  // An explainer has no clip timeline: its page is the script, its preview and its video (server/ui/js/22-console.js).
  if (m && overviewLoaded && overview.reels.some((r) => r.slug === m[1] && r.type === "explainer")) { location.replace(`#/explainer/${m[1]}`); return; }
  if (m) { if (reel?.slug !== m[1] || atHome()) openReel(m[1]); paintNav(); return; }
  const ex = /^#\/explainer(?:\/([a-z0-9-]+))?/.exec(location.hash);
  if (ex?.[1] && typeof exOpen === "function") exOpen(ex[1]);
  // #/ and an unknown address open Home (BL-115); Reels has its own address, #/reels.
  const p = /^#\/(home|more|reels|posting|youtube|footage|log|accounts|ideas|results|keys|settings|words|review|making|videos|photos|explainer|versions|projects|comments|today|workflow|product)(?![a-z])/.exec(location.hash);
  const next = p ? (p[1] === "settings" ? "accounts" : p[1]) : "home";
  if (next !== page) homeFilter = "all";
  page = next;
  const lt = /^#\/log\/(\w+)(?:\/([\w-]+))?/.exec(location.hash);
  if (page === "log") { const want = lt ? lt[1] : "overview"; if (want !== logTab) { logTab = want; logPage = 0; logQ = ""; logKind = "all"; } if (lt?.[2]) { logQ = lt[2]; logPage = 0; } }
  const pt = /^#\/posting\/(\w+)(?:\/([\w-]+))?/.exec(location.hash);
  if (page === "posting") {
    // Track C (24 Nov): Week, Calendar and List have their own addresses (#/posting/week|calendar|list), so Back, a
    // bookmark and a link from elsewhere land on the view itself; #/posting alone keeps the last one used.
    let want = pt ? pt[1] : "schedule"; const view = TC_POST_VIEWS[want];
    if (view) { postView = view; try { localStorage.setItem("lc.post.view2", view); } catch { /* private window */ } want = "schedule"; }
    if (want !== postTab) { postTab = want; postQ = ""; postPage = 0; } const net = pt?.[2] || "all"; if (net !== postNet) { postNet = net; postPage = 0; }
  }
  const an = /^#\/keys\/(\w+)/.exec(location.hash);
  lyRoute();  // layout pass: the section or tab a page's address names (#/keys/llm, #/words/lines, #/footage/library…)
  showHome();
  const it = /^#\/ideas\/([\w-]+)/.exec(location.hash);
  if (page === "ideas" && it && IDEA_TOOLS.some((t) => t[0] === it[1])) ideaTab = it[1];
  // An address naming a part inside a section (#/keys/motion, #/keys/theme) marks that part; a section itself does not.
  if (an && !KEYS_SECS.some((s) => s[0] === an[1])) flashAnchor(an[1]);
}
window.addEventListener("hashchange", () => {
  if (reel && edit && isDirty() && !/^#\/reel\/(.+)/.test(location.hash) && !confirm("Leave unsaved edits?")) { window.history.replaceState(null, "", "#/reel/" + reel.slug); return; }
  // A page change slides (View Transitions; the old page's snapshot is taken now, the new one after route() paints).
  if (document.startViewTransition && !moCalm() && !document.querySelector(".modal.on")) {
    const order = SECTIONS.map(([sec]) => sec);
    const to = order.indexOf(secOf(PAGE_OF_HASH()) || ""), from = order.indexOf(secOf(page) || "");
    document.documentElement.dataset.nav = to < from ? "back" : "fwd";
    // A slow page (a big table) can outlast the transition's time limit: the page still changes, only the slide is
    // skipped, so the rejection is not an error worth a console line.
    const vt = document.startViewTransition(() => { route(); });
    for (const k of ["ready", "finished", "updateCallbackDone"]) vt[k]?.catch?.(() => {});
  } else route();
});
function PAGE_OF_HASH() { const m = /^#\/([a-z]+)/.exec(location.hash); return !m ? "home" : m[1] === "reel" ? "" : m[1]; }
function go(slug) { location.hash = slug ? "#/reel/" + slug : "#/reels"; }
/* A link into the middle of a page (#/keys/caps): wait for that part to be drawn, bring it into view, mark it briefly. */
function flashAnchor(name, tries = 40) {
  const el = document.querySelector(`[data-anchor="${name}"]`);
  if (!el) { if (tries > 0) setTimeout(() => flashAnchor(name, tries - 1), 100); return; }
  el.scrollIntoView({ block: "center" });
  el.classList.add("flash-anchor");
  setTimeout(() => el.classList.remove("flash-anchor"), 2400);
}
function showHome() { pause(); sys.clear("draft"); $("#app").classList.add("at-home"); document.body.classList.remove("in-editor"); renderHome(); setTitle(); }
async function loadReels(open) {
  await loadOverview();
  if (open && reel?.slug === open && !atHome()) await openReel(open);
}
async function openReel(slug) {
  reelJourney.shown = null;  // "where this reel is" fills again for this opening
  const r = overview.reels.find((x) => x.slug === slug);
  if (r && !r.rendered) { toast(`${ico("hourglass", "sm")} ${esc(slug)} is still being made: ${esc(r.job?.label || "queued")}`, 3000); go(""); return; }
  let spec;
  try { reel = await api("/api/reel?slug=" + encodeURIComponent(slug)); spec = await api("/api/project?slug=" + encodeURIComponent(slug)); }
  catch (err) { reel = null; toast(`${ico("alert", "sm")} ${esc(tr("err.noreel", { s: slug }))}`, 6000); go(""); return; }
  edit = toEdit(spec, reel);
  saved = JSON.stringify(edit); history = []; future = [];
  sel = null; $("#app").classList.remove("at-home"); document.body.classList.add("in-editor"); setMode("rendered"); seekWant = 0; setAspect(aspect); t = 0;
  $("#crumbTitle").textContent = `${slug} · ${edit.title_ja}`;
  renderQueue();
  renderAll();
  paintNav();
  setTitle();
  offerDraft();
  if (pendingAdd) { const item = pendingAdd; pendingAdd = null; insertAsset(item, Math.max(0, edit.shots.length - 1)); }
  if (pendingSelect != null && edit.shots[pendingSelect]) { const i = pendingSelect; pendingSelect = null; sel = { type: "shot", i }; seek(starts()[i] + 0.02); renderAll(); }
}
let pendingAdd = null; /* a clip chosen on the Footage page with "Add to a reel" */
let pendingSelect = null; /* a card's "N to check": open on the first clip to look at */
function renderQueue() {
  const q = needsReview(), i = q.findIndex((r) => r.slug === reel?.slug);
  $("#qPos").innerHTML = q.length ? `${ico("list", "sm")} ${i >= 0 ? `${i + 1} of ${q.length}` : `${q.length}`} to review` : `${ico("check", "sm")} none waiting`;
  $("#qPrev").disabled = !q.length; $("#qNext").disabled = !q.length;
}
function stepQueue(dir) {
  const q = needsReview(); if (!q.length) return go("");
  const i = q.findIndex((r) => r.slug === reel?.slug);
  const next = i < 0 ? q[0] : q[(i + dir + q.length) % q.length];
  if (next.slug !== reel?.slug) go(next.slug);
}
/* The server pushes job progress (MDN server-sent events). The poll only covers a dropped stream. */
function paintJob(j) {
  const r = overview.reels.find((x) => x.slug === j.slug);
  if (!r) return false;
  const was = r.job?.status;
  r.job = j;
  if (reel?.slug === j.slug && !atHome()) {
    const what = j.kind === "remix" ? "Mixing sound" : j.kind === "youtube" ? "Uploading" : "Rendering";
    $("#busy").innerHTML = busyChip(j, what);
  }
  const card = document.querySelector(`.rcard[data-open="${CSS.escape(j.slug)}"]`);
  if (!card || was !== j.status || !atHome()) return false;
  const bar = card.querySelector(".live-bar"); if (bar) bar.style.width = (j.pct || 0) + "%";
  const label = card.querySelector(".live-label"); if (label) label.textContent = j.label || "";
  const sec = card.querySelector(".live-sec"); if (sec) sec.textContent = j.eta != null ? `${j.pct}% · ${mins(j.eta)}` : `${j.seconds || 0}s`;
  return true;
}
/* The one progress line the editor shows: what, how far, how long left, and a way to stop it. */
function busyChip(j, what) {
  const stop = j.cancellable ? ` <button class="icon" data-cancel="${esc(j.slug)}" title="${tr("job.stop")}" aria-label="${tr("job.stop")}">${ico("x", "sm")}</button>` : "";
  if (j.status === "queued") return `<span class="chip blue">${ico("hourglass", "sm")} ${what} ${esc(j.slug)}: ${tr("job.queued", { n: j.position })}${j.eta ? ` · <span class="eta">${mins(j.eta)}</span>` : ""}${stop}</span>`;
  if (j.status === "running") return `<span class="chip warn">${ico("clapper", "sm")} ${what} ${esc(j.slug)} · ${j.pct}% · ${esc(jobLabel(j.label))}${j.eta != null ? ` · <span class="eta">${mins(j.eta)}</span>` : ""}${stop}</span>`;
  if (j.status === "error") return `<span class="chip bad" title="${esc((j.lines || []).slice(-1)[0] || "")}">${ico("alert", "sm")} ${tr("job.failed")}: ${esc(plainFail((j.lines || []).slice(-1)[0]))}</span>`;
  if (j.status === "cancelled") return `<span class="chip warn" data-keep="1">${ico("x", "sm")} ${esc(j.label || tr("job.stopped"))}</span>`;
  return "";
}
document.addEventListener("click", async (e) => {
  const c = e.target.closest("[data-cancel]"); if (!c) return;
  e.preventDefault();  // the card under the button must not open
  if (!confirm(tr("job.stopask", { s: c.dataset.cancel }))) return;
  c.disabled = true;
  try { await post("/api/job/cancel", { slug: c.dataset.cancel }); toast(`${ico("x", "sm")} ${esc(tr("job.stopping", { s: c.dataset.cancel }))}`); }
  catch (err) { c.disabled = false; toast(`${ico("alert", "sm")} ${esc(err.message)}`, 6000); }
});
function live() {
  const es = new EventSource("/api/events");
  // The browser reconnects by itself; meanwhile the page says the server is away, and catches up when it is back.
  es.onerror = () => { sys.check(); };
  es.onopen = () => { board.live = true; loadJobs(); if (sys.down) { sys.offline(false); loadOverview().catch(() => {}); } };
  // A short note from the server (e.g. drafts made by themselves from new footage).
  es.addEventListener("problems", () => PROB.load());
  es.addEventListener("comments", (e) => {
    try {
      const m = JSON.parse(e.data);
      if (m?.autoSent) toast(`${ico("chat", "sm")} ${esc(tr("cm.autotoast", { n: m.autoSent }))}`, 8000);
      if (m?.new || m?.autoSent || !cmView) loadComments();
    } catch { /* ignore */ }
  });
  es.addEventListener("note", (e) => { try { const n = JSON.parse(e.data); if (n?.text) toast(`${ico("film", "sm")} ${esc(n.text)}`, 12000); loadOverview().catch(() => {}); } catch { /* ignore */ } });
  // The drop box received files and they went quiet: refresh its count (the footage itself arrives with the watch).
  es.addEventListener("collect", (e) => { try { collect = { ...(collect || {}), drop: JSON.parse(e.data) }; toast(`${ico("download", "sm")} ${esc(tr("col.arrived", { n: collect.drop.received || 0 }))}`, 8000); if (page === "footage") renderHome(true); } catch { /* ignore */ } });
  es.addEventListener("job", (e) => {
    const j = JSON.parse(e.data);
    boardJob(j);
    if (page === "making" && atHome()) paintBoard();
    if (j.slug === "score-all") { scoreBusy = isActive(j) ? tr("pa.scoring", { i: (j.done || 0) + (j.status === "running" ? 1 : 0), n: j.of || "…" }) : ""; if (page === "results") renderHome(true); if (!isActive(j)) { scoreMap = null; predView = null; loadScores(); loadPerf(); toast(`${ico(j.status === "done" ? "check" : "alert", "sm")} ${esc(jobLabel(j.label))}`, 8000); } }
    if (j.kind === "make" && !isActive(j)) loadOverview().catch(() => {});
    if (j.slug === "stills") phJob(j);
    if (j.kind === "product") pvJob(j);  // Product videos (22-product.js): its progress panel
    if (j.slug === "stills-story") phStoryJob(j);
    if (["done", "error", "cancelled"].includes(j.status)) { const w = jobWaiters.get(j.slug); if (w) { jobWaiters.delete(j.slug); w(j); } }
    if (j.slug === "places") {  // place names for the map (a person pressed Get place names)
      foot.pjob = j;
      if (j.status === "done") { foot.places = null; foot.pfresh = true; toast(`${ico("check", "sm")} ${esc(tr("geo.gotnames"))}`, 6000); }
      if (j.status === "error") toast(`${ico("alert", "sm")} ${esc(tr("geo.job"))}: ${esc((j.lines || []).slice(-1)[0] || "failed")}`, 10000);
      if (atHome() && page === "footage") renderHome(true);
      return;
    }
    if (j.slug === "discover") {
      if (foot.picker) {
        foot.picker.job = j;
        if (j.status === "done") foot.picker.report = j.result;
        if (j.status === "error") foot.picker.error = (j.lines || []).slice(-1)[0] || "failed";
      }
      if (atHome() && page === "footage") renderHome(true);
      return;
    }
    if (j.slug === "footage" || j.slug === "gphotos") {
      foot.job = j;
      if (j.status === "done") {
        const n = j.result?.added ?? j.result?.downloaded ?? null;
        // A timer check that found nothing stays quiet; anything new is worth a toast.
        if (j.kind !== "watch" || n) toast(`${ico("check", "sm")} ${j.slug === "gphotos" ? `Google Photos: ${n ?? ""} new` : esc(tr("src.donemsg", { n: n ?? 0 }))}`, 6000);
        foot.items = []; foot.loadedKey = null; foot.mapLib = null; foot.look = null; loadFootage(); loadOverview(); loadSources();
      }
      if (j.status === "error") toast(`${ico("alert", "sm")} ${esc((j.lines || []).slice(-1)[0] || "failed")}`, 8000);
      // Home shows the reading too (BL-144: its "Read these N files now" on a first start).
      if (atHome() && (page === "footage" || page === "home")) renderHome(true);
      return;
    }
    if (j.kind === "versions" && /^ver-/.test(j.slug) && j.status !== "running") {
      // "Use the new version" ends here, about 10 minutes after the press: say whether it is live (it can fail).
      const s = reelName(j.slug.slice(4));
      if (j.status === "done") addNews("ok", tr("ver.used", { s }), "#/versions");
      else addNews("bad", tr("ver.usefail", { s, w: ((j.lines || []).slice(-1)[0] || "").slice(0, 160) }), "#/versions");
      if (page === "versions") loadVersions(true);
    }
    if (j.kind === "post") {
      // A post the studio sent itself (Accounts page): say where it went, then refresh Posting.
      if (j.status === "done") {
        for (const r of [].concat(j.result || [])) {
          const net = NET_NAME[r.network] || r.network;
          if (r.status === "failed") toast(`${ico("alert", "sm")} ${esc(net)}: ${esc(r.error || "failed")}`, 10000);
          else toast(`${ico("check", "sm")} ${esc(r.slug)} → ${esc(net)}: ${esc(r.status === "posted" ? tr("pub.st.posted") : r.status === "scheduled" ? tr("pub.st.scheduled") : tr("pub.st.queued"))}${r.at ? " " + esc(whenText(r.at)) : ""}${r.url ? ` · <a href="${escUrl(r.url)}" target="_blank" rel="noopener">${tr("pub.open")}</a>` : ""}`, 10000);
        }
      }
      if (j.status === "error") toast(`${ico("alert", "sm")} ${esc((j.lines || []).slice(-1)[0] || "posting failed")}`, 10000);
      if (j.status === "done" || j.status === "error") { publishing.delete(j.slug); bookingAt.delete(j.slug); loadPosting(); if (drawerOpen()) paintDrawer(); }
      return;
    }
    paintStatus();
    if (!paintJob(j)) { if (atHome() && (page === "reels" || page === "review" || j.status !== "running")) renderHome(true); }
    else { const qb = $("#queueBox"); if (qb) qb.innerHTML = queueBoxHtml(); }  // progress, ETA and errors in the queue panel as they happen
    if (j.kind === "youtube") {
      if (j.status === "done") {
        toast(`${ico("check", "sm")} ${esc(j.slug)} ${j.result?.publishAt ? `scheduled: public ${esc(whenText(j.result.publishAt))}` : `is on YouTube (${esc(j.result?.privacy || "")})`} · <a href="${escUrl(j.result?.url || "#")}" target="_blank" rel="noopener">open</a>`, 9000);
        ytVideos = null; loadPosting(); loadOverview();
      }
      if (j.status === "error") { toast(`${ico("alert", "sm")} YouTube: ${esc((j.lines || []).slice(-1)[0] || "upload failed")}`, 9000); loadOverview(); }
      return;
    }
    if (j.status === "done" && RENDER_KINDS.includes(j.kind)) { toast(`${ico("check", "sm")} ${esc(tr("job.readyreview", { s: reelName(j.slug) }))}`); loadOverview(); }  // the headline, not "theme-1126"
    else if (j.status === "error" && !RENDER_KINDS.includes(j.kind)) toast(`${ico("alert", "sm")} ${esc(boardName(j))}: ${esc(plainFail((j.lines || []).slice(-1)[0] || j.label))}`, 8000);
    if ((j.status === "error" || j.status === "cancelled") && atHome()) loadOverview();
  });
}
live();
setInterval(() => { if (!overview.reels.some(busyJob)) return; loadOverview().catch(() => {}); }, 15000);

/* ---------- text layouts (shared/story-layout.mjs) ---------- */
const THEME_ICON = { office: "phone", carstay: "pin", autumn: "leaf", fire: "flame", field: "layers", warm: "snow", loud: "volume", lookup: "moon", focus: "clock", connect: "user", aerial: "drone", reasons: "layers", day: "sun", seasons: "calendar", pov: "eye", nightfire: "flame", altitude: "drone" };
const STYLE_LABEL = {
  column: ["type", "Column", "Vertical headline top-right, captions low"],
  centre: ["fit", "Centre", "Headline centred in the upper third, captions centred low"],
  lower: ["list", "Lower third", "Headline low, captions high"],
  split: ["layers", "Split", "Vertical headline top-left, captions low"],
};
document.addEventListener("click", (e) => {
  if (e.target.closest("#colorMatch") && edit) {
    const on = edit.keep?.colorMatch !== false;
    commit(() => { edit.keep = { ...(edit.keep || {}), colorMatch: !on }; }, on ? "Shots keep their own colour. Save & render to apply." : "Shots are matched in colour. Save & render to apply.");
    return;
  }
  const stab = e.target.closest("[data-stab]");
  if (stab && edit) {
    commit(() => { edit.keep = { ...(edit.keep || {}), stabilize: stab.dataset.stab }; }, `Steady handheld: ${stab.dataset.stab}. Save & render to apply.`);
    return;
  }
  if (e.target.closest("#spokenWords") && edit) {
    const on = edit.keep?.spokenWords !== false;
    commit(() => { edit.keep = { ...(edit.keep || {}), spokenWords: !on }; }, on ? "Words stay still while the voice reads. Save & render to apply." : "Words light up as the voice reads them. Save & render to apply.");
    return;
  }
  if (e.target.closest("#blurFaces") && edit) { commit(() => { edit.blurFaces = !edit.blurFaces; }, edit.blurFaces ? "Faces show. Save & render to redraw." : "Faces will be blurred. Save & render to apply."); return; }
  const b = e.target.closest("[data-style]"); if (!b || !edit) return;
  commit(() => { edit.style = b.dataset.style; }, `Text layout: ${STYLE_LABEL[b.dataset.style][1]}. Save & render to apply.`);
});

/* ---------- sound: the same plan the build uses (py/studio/sound.py) ---------- */
const SFX_LEN = { whoosh_1: 0.7, whoosh_2: 0.6, whoosh_3: 0.8, riser: 1.2, hit: 1.6 };
function sfxPlan() {
  if (!edit.sfx) return [];
  const out = [];
  edit.beats.filter((b) => b.kind === "line").slice(0, 3).forEach((b, k) => {
    const name = `whoosh_${(k % 3) + 1}`;
    out.push({ name, at: Math.max(0, b.startSec - 0.52), sec: SFX_LEN[name] });
  });
  const end = edit.beats.find((b) => b.kind === "end");
  if (end) { out.push({ name: "riser", at: Math.max(0, end.startSec - 1.2), sec: 1.2 }); out.push({ name: "hit", at: end.startSec, sec: 1.6 }); }
  return out;
}
function musicInfo() {
  if (edit.music === "off" || edit.music === null) return null;
  if (edit.music && typeof edit.music === "object") return audioLib.find((a) => a.id === edit.music.id) || { title: edit.music.id, license: "?" };
  return reel.audio?.music || { title: "auto pick at render", creator: "", license: "CC0" };
}
async function loadAudio() { try { audioLib = await api("/api/audio"); } catch { audioLib = []; } if (ltab === "audio" && !atHome()) renderLeft(); }
let audition = null;
function playTrack(path, btn) {
  if (audition && audition.dataset.src === path && !audition.paused) { audition.pause(); btn.innerHTML = ico("play", "sm"); return; }
  if (audition) audition.pause();
  document.querySelectorAll("[data-listen]").forEach((b) => (b.innerHTML = ico("play", "sm")));
  audition = new Audio(file(path)); audition.dataset.src = path; audition.volume = 0.7; audition.play().catch(() => {});
  btn.innerHTML = ico("pause", "sm");
  audition.onended = () => (btn.innerHTML = ico("play", "sm"));
}
function renderAudioTab() {
  const cur = edit.music && typeof edit.music === "object" ? edit.music.id : edit.music;
  const playing_ = reel.audio?.music?.id;
  const row = (a) => {
    const on = a.id === cur || (cur === "auto" && a.id === playing_);
    return `<div class="track-row ${on ? "on" : ""}">
      <button class="icon" data-listen="${esc(a.file)}" title="Listen">${ico("play", "sm")}</button>
      <div style="min-width:0"><div class="t">${esc(a.title)}</div>
        <div class="meta">${esc(a.creator || "")} · ${(a.duration || 0).toFixed(0)} s · <span class="chip ${a.license === "CC0" || a.license === "PDM" || a.license === "OWN" ? "ok" : "bad"}" style="padding:0 6px">${esc(a.license === "OWN" ? "made here" : a.license)}</span>
        ${a.landing ? `<a class="meta" href="${escUrl(a.landing)}" target="_blank" rel="noopener">source</a>` : ""}</div></div>
      ${a.kind === "music" ? `<button class="toggle ${on ? "on" : ""}" data-use-music="${esc(a.id)}">${on ? ico("check", "sm") + "in use" : "Use"}</button>` : ""}
    </div>`;
  };
  const music = audioLib.filter((a) => a.kind === "music"), fx = audioLib.filter((a) => a.kind === "sfx");
  const vol = edit.music && typeof edit.music === "object" ? edit.music.volume ?? 1 : 1;
  return `<p class="note">${ico("info", "sm")} Music and effects are CC0 / public domain (from Openverse: Freesound, Wikimedia, Jamendo) or made here, so nothing needs a credit and nothing is NC. The licence of each file is kept, and a <b>credits.txt</b> goes with every delivery. Music dips automatically when a clip has its own sound.</p>
    <h3>${ico("volume")}This reel</h3>
    <div class="row">
      <button class="toggle ${edit.music === "auto" ? "on" : ""}" data-music-mode="auto" title="The studio picks a track that fits the theme">${ico("volume", "sm")}Auto</button>
      <button class="toggle ${edit.music === "off" ? "on" : ""}" data-music-mode="off">${ico("x", "sm")}No music</button>
      <button class="toggle ${edit.sfx ? "on" : ""}" data-sfx-toggle="1" title="A whoosh into each caption, a riser and a soft hit on the end card">${ico("volume", "sm")}Effects ${edit.sfx ? "on" : "off"}</button>
    </div>
    ${edit.music && typeof edit.music === "object" ? `<div class="row"><span class="meta" style="width:70px">Volume</span><input type="range" id="musVol" min="0.3" max="1.6" step="0.1" value="${vol}" style="flex:1"><span class="meta" id="musVolV">${Math.round(vol * 100)}%</span></div>
      <div class="row"><span class="meta" style="width:70px">Start at</span><input type="number" id="musStart" min="0" step="0.5" value="${edit.music.start ?? ""}" placeholder="auto" style="width:90px"><span class="meta">s into the track</span></div>` : ""}
    <div class="row"><button class="primary" id="applySound" ${soundDirty() ? "" : "disabled"} title="Re-mix music and effects onto the rendered picture (~30 s), then re-package every network">${ico("refresh", "sm")}Apply sound</button>
      <span class="meta">${soundDirty() ? "changed: apply to hear it in the player" : "the player has this sound"}</span></div>
    <h3>${ico("music")}Music (${music.length})</h3>${music.map(row).join("") || `<p class="note">No tracks yet: search below.</p>`}
    <div class="search">${ico("search")}<input id="audioQ" placeholder="Find more CC0 music: calm piano, folk guitar…"></div>
    <div class="row"><button id="findMusic">${ico("download", "sm")}Find music</button><button id="findSfx">${ico("download", "sm")}Find effects</button><span class="meta" id="findState"></span></div>
    <h3>${ico("volume")}Effects (${fx.length})</h3>${fx.map(row).join("")}`;
}
const soundKey = (e) => JSON.stringify([e.music, e.sfx]);
function soundDirty() { try { return soundKey(edit) !== soundKey(JSON.parse(saved)); } catch { return false; } }
document.addEventListener("click", async (e) => {
  const listen = e.target.closest("[data-listen]"), use = e.target.closest("[data-use-music]"), mode_ = e.target.closest("[data-music-mode]"), sfxT = e.target.closest("[data-sfx-toggle]");
  const lane = e.target.closest("[data-music]");
  if (listen) return playTrack(listen.dataset.listen, listen);
  if (e.target.closest("[data-goto-audio]")) { e.preventDefault(); ltab = "audio"; return renderLeft(); }
  if (use) return commit(() => { edit.music = { id: use.dataset.useMusic, volume: 1.0 }; }, "Music chosen. Apply sound to hear it in the render.");
  if (mode_) return commit(() => { edit.music = mode_.dataset.musicMode; }, mode_.dataset.musicMode === "off" ? "No music" : "Auto music");
  if (sfxT) return commit(() => { edit.sfx = !edit.sfx; }, edit.sfx ? "Effects off" : "Effects on");
  if (lane && !atHome()) { ltab = "audio"; sel = { type: "music" }; renderLeft(); renderTimeline(); return; }
  if (e.target.closest("#applySound")) return applySound();
  if (e.target.closest("#findMusic") || e.target.closest("#findSfx")) {
    const kind = e.target.closest("#findMusic") ? "music" : "sfx";
    const q = ($("#audioQ").value || (kind === "music" ? "calm acoustic" : "whoosh")).trim();
    $("#findState").textContent = "searching Openverse (CC0 only)…";
    try { const got = await post("/api/audio/fetch", { kind, query: q }); toast(`${ico("check", "sm")} ${got.length} new ${kind === "music" ? "track" : "effect"}${got.length === 1 ? "" : "s"} for “${esc(q)}”`); }
    catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 5000); }
    await loadAudio();
  }
});
document.addEventListener("input", (e) => {
  if (e.target.id === "musVol" && edit.music && typeof edit.music === "object") { $("#musVolV").textContent = Math.round(e.target.value * 100) + "%"; }
});
document.addEventListener("change", (e) => {
  if (e.target.id === "musVol" && edit.music && typeof edit.music === "object") commit(() => { edit.music.volume = +e.target.value; });
  if (e.target.id === "musStart" && edit.music && typeof edit.music === "object") commit(() => { const v = e.target.value; if (v === "") delete edit.music.start; else edit.music.start = +v; });
});
async function applySound() {
  if (isDirty() && JSON.stringify({ ...edit, music: 0, sfx: 0 }) !== JSON.stringify({ ...JSON.parse(saved), music: 0, sfx: 0 })) {
    return toast(`${ico("alert", "sm")} You also changed clips or words: use Save & render (it includes the sound).`, 4500);
  }
  try {
    const res = await post("/api/project", { project: toProject(), render: false });
    if (res.problems?.length) return toast(`${ico("alert", "sm")} ${esc(res.problems.join("; "))}`, 5000);
    saved = JSON.stringify(edit); saveDraftSoon();
    await post("/api/remix", { slug: edit.slug });
  } catch (err) { return toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000); }
  renderStatus(); renderLeft(); watchJob(edit.slug);
}

/* ---------- resizable panels (drag a divider; double-click resets; remembered) ---------- */
const LAYOUT_DEFAULT = { lw: 360, rw: 360, th: 372 };
const LAYOUT_LIMIT = { lw: [220, 720], rw: [240, 720], th: [190, 640] };
function setPanel(k, px) {
  const [lo, hi] = LAYOUT_LIMIT[k];
  const v = Math.round(Math.max(lo, Math.min(hi, px)));
  $("#app").style.setProperty("--" + k, v + "px");
  return v;
}
function restoreLayout() {
  let saved_ = {};
  try { saved_ = JSON.parse(localStorage.getItem("studio.layout") || "{}"); } catch { saved_ = {}; }
  for (const k of Object.keys(LAYOUT_DEFAULT)) setPanel(k, saved_[k] ?? LAYOUT_DEFAULT[k]);
}
function saveLayout() {
  const cs = getComputedStyle($("#app"));
  localStorage.setItem("studio.layout", JSON.stringify(Object.fromEntries(Object.keys(LAYOUT_DEFAULT).map((k) => [k, parseInt(cs.getPropertyValue("--" + k))]))));
}
document.addEventListener("pointerdown", (e) => {
  const g = e.target.closest(".gutter"); if (!g) return;
  e.preventDefault();
  const k = g.dataset.gutter, cs = getComputedStyle($("#app")), start = parseInt(cs.getPropertyValue("--" + k));
  const x0 = e.clientX, y0 = e.clientY;
  g.classList.add("drag");
  try { g.setPointerCapture(e.pointerId); } catch { /* window listeners below still follow the drag */ }
  const move = (ev) => {
    const d = k === "lw" ? ev.clientX - x0 : k === "rw" ? x0 - ev.clientX : y0 - ev.clientY;
    setPanel(k, start + d);
  };
  const up = () => {
    g.classList.remove("drag");
    window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
    saveLayout(); if (reel && !atHome()) renderTimeline();
  };
  window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
});
document.addEventListener("dblclick", (e) => {
  const g = e.target.closest(".gutter"); if (!g) return;
  setPanel(g.dataset.gutter, LAYOUT_DEFAULT[g.dataset.gutter]); saveLayout();
});

/* ---------- home: the flow as five steps, every reel as a card ---------- */
let themes = null, autoThemes = null, autoDays = 60, autoFaces = false, autoCut = "short", autoVary = true;
/* The label of a cut: Make reels' choice (short, walk, long) or a reel's own variant (none, site-walk, b-explainer).
   Its hint is the same key + "hint". */
const cutKey = (cut) => (cut === "long" || cut === "b-explainer" ? "make.cutlong" : cut === "walk" || cut === "site-walk" ? "make.cutwalk" : "make.cutshort");
let homeSig = "";
document.addEventListener("change", (e) => {
  if (e.target.id === "autoDays") autoDays = +e.target.value;
  if (e.target.id === "autoFaces") autoFaces = e.target.checked;
});
