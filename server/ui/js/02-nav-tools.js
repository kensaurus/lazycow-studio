/* ---------- pages: Reels, Posting, YouTube, Footage ---------- */
let page = "reels";
const PAGES = { making: ["clapper", "nav.making"], reels: ["film", "nav.reels"], today: ["clock", "nav.today"], posting: ["send", "nav.posting"], youtube: ["play", "nav.youtube"], footage: ["layers", "nav.footage"], log: ["list", "nav.log"], accounts: ["user", "nav.accounts"],
  ideas: ["search", "nav.ideas"], results: ["wave", "nav.results"], keys: ["shield", "nav.keys"], words: ["type", "nav.words"], review: ["eye", "nav.review"], videos: ["play", "nav.videos"], photos: ["image", "nav.photos"],
  explainer: ["info", "nav.explainer"], versions: ["layers", "nav.versions"], projects: ["folder", "nav.projects"], comments: ["chat", "nav.comments"], workflow: ["flow", "d_nav.workflow"], product: ["phone", "nav.product"],
  home: ["home", "nav.home"], more: ["grid", "nav.more"] };
/* ---------- the studio's tools in one list (BL-114, BL-118, BL-120; owner, 24 Nov: "build Lazycow general and robust for
   a general audience; many of the UI/UX are really over-engineered for our usage") ----------
   FEATURES is the one registry: each tool's section, whether it shows in simple mode or only with "Show all tools",
   its help line on More tools and the actions whose use is counted. The top bar's sections, the tab rows, Ctrl K, the
   next-step links and More tools all read it, and server/review.mjs reads its ids between the two marks below to
   accept usage counts (one entry per line). A tool that is not a page of its own names its address (href), icon and
   label (name). Hidden tools still open by their address: nothing a link or bookmark points to ever breaks. */
/* FEATURES-BEGIN */
const FEATURES = {
  home: { level: "simple", sec: "home" },
  footage: { level: "simple", sec: "footage" },
  reels: { level: "simple", sec: "reels", acts: ["make"] },
  today: { level: "full", sec: "reels", help: "ft.today" },
  making: { level: "full", sec: "reels", help: "ft.making" },
  review: { level: "simple", sec: "reels", acts: ["approve"] },
  explainer: { level: "simple", sec: "reels", help: "ft.explainer" },
  words: { level: "full", sec: "reels", help: "ft.words" },
  videos: { level: "full", sec: "reels", help: "ft.videos" },
  product: { level: "full", sec: "reels", help: "ft.product" },
  photos: { level: "full", sec: "reels", help: "ft.photos" },
  posting: { level: "simple", sec: "posting", acts: ["book"] },
  versions: { level: "full", sec: "posting", help: "ft.versions" },
  youtube: { level: "full", sec: "posting", help: "ft.youtube" },
  ideas: { level: "full", sec: "posting", help: "ft.ideas" },
  bluesky: { level: "full", sec: "posting", help: "ft.bluesky", href: "#/ideas/bluesky", icon: "chat", name: "ft.bskyname" },
  results: { level: "simple", sec: "results" },
  resnext: { level: "full", sec: "results", help: "ft.resnext", href: "#/results/next", icon: "flow", name: "rs.t.learn" },
  reswhere: { level: "full", sec: "results", help: "ft.reswhere", href: "#/results/where", icon: "globe", name: "rb.t.where" },
  resposts: { level: "full", sec: "results", help: "ft.resposts", href: "#/results/posts", icon: "list", name: "rs.t.posts" },
  resyt: { level: "full", sec: "results", help: "ft.resyt", href: "#/results/youtube", icon: "play", name: "ft.resytname" },
  comments: { level: "full", sec: "results", help: "ft.comments" },
  log: { level: "full", sec: "results", help: "ft.log" },
  accounts: { level: "simple", sec: "settings" },
  workflow: { level: "full", sec: "settings", help: "ft.workflow" },
  keys: { level: "simple", sec: "settings" },
  projects: { level: "simple", sec: "" },
  more: { level: "simple", sec: "more" },
};
/* FEATURES-END */
/* Simple (a new project's start: the few tools most people use) or full (everything). Saved per project on the server
   (GET/POST /api/ui); the last value seen is kept in the browser so the first paint does not flicker. */
let uiLevel = (() => { try { return localStorage.getItem("lc.ui.level") === "simple" ? "simple" : "full"; } catch { return "full"; } })(), uiUsage = {}, uiDefaulted = false;
const ftShown = (id) => uiLevel === "full" || !FEATURES[id] || FEATURES[id].level !== "full";
const ftHref = (id) => FEATURES[id]?.href || "#/" + id;
const ftName = (id) => tr(FEATURES[id]?.name || PAGES[id]?.[1] || "nav." + id);
const ftIcon = (id) => FEATURES[id]?.icon || PAGES[id]?.[0] || "list";
/* BL-140 (first-run walk 26 Nov): simple mode's top bar keeps at most five controls: the setup chip (while setup is
   unfinished), Help, the bell, the language and one "More" menu holding the rest (search, refresh, colours, the system
   check, About and the switch to all tools). The version chip, Ctrl K search, refresh, colours, the system dot, the red
   problems button (its count rides on the bell; the strip under the bar lists them) and the status bar's key hints show
   in full mode only (CSS keys on <html data-ui>). Every keyboard shortcut keeps working in both. */
function uiChrome() {
  document.documentElement.dataset.ui = uiLevel;
  const b = document.getElementById("moreBtn"); if (!b) return;
  b.title = tr("rv.more.tip"); b.setAttribute("aria-label", tr("rv.more.tip"));
}
uiChrome();
let moreOpen = false;
function moreMenuPaint() {
  const m = document.getElementById("moreMenu"); if (!m) return;
  m.hidden = !moreOpen; document.getElementById("moreBtn")?.setAttribute("aria-expanded", String(moreOpen));
  if (!moreOpen) { m.innerHTML = ""; return; }
  // Outside the header (its overflow would clip it), under the button, its right edge on the button's.
  const r = document.getElementById("moreBtn")?.getBoundingClientRect();
  if (r) { m.style.top = `${Math.round(r.bottom + 6)}px`; m.style.right = `${Math.max(8, Math.round(innerWidth - r.right))}px`; }
  const dark = typeof themeDark === "function" && themeDark();
  const item = (k, icon, label, extra = "") => `<button type="button" role="menuitem" data-moreact="${k}">${ico(icon, "sm")}<span>${esc(label)}</span>${extra}</button>`;
  m.innerHTML = item("search", "search", tr("rv.more.search"), "<kbd>Ctrl K</kbd>") + item("sync", "refresh", tr("rv.more.sync"))
    + item("theme", dark ? "sun" : "moon", tr(dark ? "rv.more.light" : "rv.more.dark")) + item("system", "shield", tr("rv.more.system"))
    + item("about", "info", tr("rv.more.about", { v: ($("#verTag")?.textContent || "").trim() }))
    + `<hr>` + item("full", "grid", tr("uix.showall"));
}
function moreClose(focus) { if (!moreOpen) return; moreOpen = false; moreMenuPaint(); if (focus) document.getElementById("moreBtn")?.focus(); }
document.addEventListener("click", (e) => {
  if (e.target.closest?.("#moreBtn")) { moreOpen = !moreOpen; moreMenuPaint(); if (moreOpen) document.querySelector("#moreMenu [role=menuitem]")?.focus(); return; }
  const a = e.target.closest?.("[data-moreact]");
  if (a) {
    const k = a.dataset.moreact; moreClose(false);
    // The full-mode buttons stay in the page (hidden in simple mode), so each item presses the same one.
    if (k === "search") palOpen(); else if (k === "sync") $("#syncBtn")?.click(); else if (k === "theme") themeToggle();
    else if (k === "system") $("#sysBtn")?.click(); else if (k === "about") openAbout(); else if (k === "full") uiSetLevel("full");
    return;
  }
  if (moreOpen && !e.target.closest?.("#moreMenu")) moreClose(false);
});
document.addEventListener("keydown", (e) => {
  if (!moreOpen) return;
  if (e.key === "Escape") { e.preventDefault(); moreClose(true); return; }
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const items = [...document.querySelectorAll("#moreMenu [role=menuitem]")], at = items.indexOf(document.activeElement);
  if (!items.length) return;
  e.preventDefault(); items[(at + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus();
});
/* The tool open now: a page, or one of the tabs that are tools of their own (Results' tabs, Reply on Bluesky). */
function ftNow() {
  if (page === "results") { const k = { next: "resnext", where: "reswhere", posts: "resposts", youtube: "resyt" }[resTab]; if (k) return k; }
  if (page === "ideas" && ideaTab === "bluesky") return "bluesky";
  return page;
}
/* The site map: sections in the order work moves (home, footage in, reels made, posted, results back, settings, more
   tools); a section with more than one page shows them as tabs under its title. Read from FEATURES. */
const SECTIONS = ["home", "footage", "reels", "posting", "results", "settings", "more"].map((s) => [s, Object.keys(FEATURES).filter((id) => FEATURES[id].sec === s && PAGES[id])]);
/* What [ and ] step through: every tab and sub-tab of a section, as their addresses (filtered by ftShown when used). */
const TAB_CYCLE = [["footage"], ["reels", "today", "making", "review", "explainer", "words", "videos", "product", "photos"], ["posting", "posting/calendar", "posting/list", "posting/reels", "posting/sent", "versions", "youtube", "ideas/ideas", "ideas/site-check", "ideas/page", "ideas/links"], ["results", "results/next", "results/where", "results/posts", "results/youtube", "comments", "log/activity", "log/posts", "log/reels"], ["accounts", "workflow", "keys"]];
const tabShown = (addr) => { const [pg, sub] = addr.split("/"); const id = pg === "results" ? ({ next: "resnext", where: "reswhere", posts: "resposts", youtube: "resyt" }[sub] || pg) : pg; return ftShown(id); };
const secOf = (pg) => (SECTIONS.find(([, ps]) => ps.includes(pg)) || ["reels"])[0];
const SUBTAB = { reels: "sub.reels", today: "sub.today", making: "sub.making", review: "sub.review", explainer: "sub.explainer", words: "sub.words", videos: "sub.videos", product: "sub.product", photos: "sub.photos", posting: "sub.plan", versions: "sub.versions", youtube: "sub.youtube", ideas: "sub.ideas", results: "sub.results", comments: "sub.comments", log: "sub.log", accounts: "sub.accounts", keys: "sub.keys", workflow: "d_sub.workflow" };
function subCount(pg) {
  if (!overviewLoaded) return "";
  const n = pg === "making" ? overview.reels.filter(busyJob).length : pg === "review" ? needsReview().length : pg === "versions" ? (verView?.ready?.length || 0)
    : pg === "comments" ? (cmView?.counts?.open || 0) : 0;
  return n ? ` <b class="subn">${n}</b>` : "";
}
function subTabs() {
  const sec = SECTIONS.find(([, ps]) => ps.includes(page));
  // Simple mode: only the tools it shows, and the page open now when it was reached by its address.
  const tabs = sec ? sec[1].filter((pg) => pg === page || ftShown(pg)) : [];
  if (!sec || tabs.length < 2 || sec[0] === "posting") return;  // Posting carries its own single row of views
  const html = `<nav class="subtabs" aria-label="${esc(tr(PAGES[sec[1][0]][1]))}">${tabs.map((pg) => `<a href="#/${pg}" class="${pg === page ? "on" : ""}" ${pg === page ? 'aria-current="page"' : ""}>${ico(PAGES[pg][0], "sm")}${esc(tr(SUBTAB[pg]))}${subCount(pg)}</a>`).join("")}</nav>`;
  const head = $("#home .pagehead");
  if (head) head.insertAdjacentHTML("afterend", html); else $("#home").insertAdjacentHTML("afterbegin", html);
}
function paintNav() {
  uiChrome();
  if (typeof paintStartChip === "function") paintStartChip();
  document.querySelectorAll(".topnav [data-page]").forEach((b) => {
    const on = atHome() ? b.dataset.sec === secOf(page) : b.dataset.sec === "reels";
    b.classList.toggle("on", on);
    if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");  // screen readers hear which page is open
  });
  const nav = $(".topnav"), cur = nav?.querySelector("[aria-current=page]");
  if (cur && nav.scrollWidth > nav.clientWidth + 1) cur.scrollIntoView({ block: "nearest", inline: "nearest" });
  navFades();
  tdNavPaint();
}
function crumbs(...parts) {
  const no = String(SECTIONS.findIndex(([sec]) => sec === secOf(page)) + 1).padStart(2, "0");
  const [label] = parts[parts.length - 1] || [""];
  const back = secOf(page) === "posting" && page !== "posting" ? `<a class="backlink" href="#/posting">‹ ${esc(tr("nav.posting"))}</a>` : "";
  return `<nav class="bc" aria-label="${esc(parts.map(([l]) => l).join(" › "))}"><span class="secno" aria-hidden="true">${no}</span>${back}<b>${esc(label)}</b></nav>`;
}

/* Posting state per reel and network: the log, corrected by what YouTube reports
   (a scheduled Short whose time has passed and is public now counts as posted). */
const POST_NETS = ["youtube", "instagram", "tiktok", "facebook", "threads", "x", "linkedin", "gbp", "line-voom", "line-oa", "pinterest", "bluesky", "xiaohongshu"];
const POST_RANK = { posted: 3, scheduled: 2, planned: 1, failed: 1, missing: 1 };  // missing: not found after its time (py/studio/live.py)
function postState(slug) {
  const out = {};
  for (const p of postsLog) {
    if (p.slug !== slug || p.network === "all") continue;
    let st = p.status === "queued" ? "scheduled" : p.status;  // queued = the studio sends it at that time: booked, like a schedule
    if (st === "scheduled" && p.network === "youtube" && Array.isArray(ytVideos)) {
      const v = ytVideos.find((x) => x.id === p.remote_id);
      if (v && v.privacy === "public") st = "posted";
    }
    if (p.status === "scheduled" && p.at && new Date(p.at).getTime() < Date.now()) st = "posted";  // the site published it at its time (until a check says otherwise)
    if ((POST_RANK[st] || 0) > (POST_RANK[out[p.network]?.status] || 0)) out[p.network] = { ...p, status: st };
  }
  return out;
}
const isSkipped = (slug) => postsLog.some((p) => p.slug === slug && p.status === "skipped");
/* One state per reel, in the order a person cares about: is it out, is it booked, is it shelved, or waiting. */
function reelState(r) {
  if (busyJob(r)) return "making";
  if (!r.rendered) return "draft";  // never rendered (or its render failed) and nothing is making it now
  const st = Object.values(postState(r.slug));
  if (st.some((p) => p.status === "posted")) return "posted";
  if (st.some((p) => p.status === "scheduled" || p.status === "planned")) return "scheduled";
  if (r.house) return "house";
  if (isSkipped(r.slug) || r.status === "rejected" || r.status === "reroll") return "skip";
  return "topost";
}
const STATE_ORDER = ["topost", "scheduled", "posted", "skip", "making", "draft", "house"];
const STATE_KEY = { topost: "st.topost", scheduled: "st.scheduled", posted: "st.posted", skip: "st.skip", making: "st.making", draft: "st.draft", house: "st.house" };
/* In the order a reel moves: being made → to post → scheduled → posted; then the side exits. */
const SEGMENTS = ["draft", "making", "topost", "scheduled", "posted", "skip", "all"];
const FLOW = ["making", "topost", "scheduled", "posted"];
let showMaker = false;
function segBar(counts) {
  const btn = (k) => `<button class="${homeFilter === k ? "on" : ""}" data-hf="${k}" aria-pressed="${homeFilter === k}"><i class="dot s-${k}"></i>${tr(k === "all" ? "st.all" : STATE_KEY[k])}<span>${counts[k] ?? 0}</span></button>`;
  return `<div class="seg" role="toolbar" aria-label="${tr("st.filter")}">${FLOW.map(btn).join(`<span class="flow-sep" aria-hidden="true">›</span>`)}<span class="seg-gap"></span>${counts.draft ? btn("draft") : ""}${btn("skip")}${btn("all")}</div>`;
}
function stateCounts(list) {
  const c = { all: list.filter((r) => !r.house).length };
  for (const r of list) { if (r.house) continue; const s = reelState(r); c[s] = (c[s] || 0) + 1; }  // the built-in house reels are not counted anywhere
  return c;
}
function renderHome(force) {
  const steady = { ...overview, reels: overview.reels.map((r) => (r.job ? { ...r, job: { status: r.job.status, position: r.job.position } } : r)) };
  const sig = JSON.stringify([page, lang, steady, homeFilter, sys.health?.verdict, sys.health?.buildSeconds, [...(autoThemes || [])], autoDays, autoFaces, !!themes, postsLog, yt, ytVideos, showMaker, ytLists, foot.items.length, foot.f, foot.q, foot.open, foot.job, foot.g, autoCut, foot.group, foot.tag, [...foot.more], logData, logTab, logQ, logKind, logPage, capEdit, postTab, postNet, postQ, postPage, postView, tcListPage, planner && [...planner.nets, planner.start, planner.approvedOnly, planner.days, planner.busy], drawer && 1, connections, profilesKit, channelsSpec, wsView, wordsView, wordsBusy, wordsAdd, page === "review" ? [Object.keys(revCache).length, revBusy, revPlay] : 0, page === "ideas" ? [ideaTab, Object.entries(ideasBusy), Object.keys(ideasRes), Math.floor(Date.now() / 1000)] : 0, lySig(), uiLevel]);
  if (!force && sig === homeSig) {
    const q = document.querySelector("#home section.queue");  // only the progress moved: redraw that one panel
    if (q) { const open = q.querySelector("details")?.open; q.outerHTML = queueHtml(); const d = document.querySelector("#home section.queue details"); if (d && open !== undefined) d.open = open; }
    return;
  }
  homeSig = sig;
  if (renderHome.shown !== page) moVisit();  // a new page visit: its graphics may play their entrance once more
  uiCount(ftNow());  // the private usage count (BL-120): once per page or tool opened
  paintNav();
  ({ log: renderLog, posting: renderPosting, youtube: renderYouTube, footage: renderFootage, accounts: renderAccounts,
     ideas: renderIdeas, results: renderResults, keys: renderKeys, words: renderWords, review: renderReview, making: renderMaking, videos: renderVideos, product: renderProduct, photos: renderPhotos, explainer: renderExplainer, versions: renderVersions,
     projects: renderProjects, comments: renderComments, today: renderToday, workflow: renderWorkflow, home: renderHomePage, more: renderMore }[page] || renderReels)();
  subTabs();
  ftNote();  // a full-mode tool opened by its address in simple mode says so, with the switch
  WN.draw();  // "What needs you" under the header follows what the page knows now
  watchWires();  // any node-and-wire map on the page draws its wires once laid out
  // A tab row wider than the screen: the open tab in view, and a fade on each side that has more.
  document.querySelectorAll("#home .subtabs, #home .posttabs").forEach((row) => {
    const on = row.querySelector(".on"); if (!on || row.scrollWidth <= row.clientWidth + 1) return;
    const a = on.offsetLeft - row.offsetLeft, b = a + on.offsetWidth;
    if (a < row.scrollLeft || b > row.scrollLeft + row.clientWidth) row.scrollLeft = Math.max(0, b - row.clientWidth + 24);
  });
  navFades(); requestAnimationFrame(navFades);  // again once the new page is laid out
  keepQuickPlay();
  // The opening fade plays when a page is opened, not each time its data refreshes (that read as flicker).
  if (renderHome.shown !== page) { renderHome.shown = page; $("#home").classList.remove("enter"); void $("#home").offsetWidth; $("#home").classList.add("enter"); }
  else $("#home").classList.remove("enter");
}
/* "What should I do now?" — the studio reads its own state and offers the three most useful next steps,
   most urgent first: a computer that cannot render, reels waiting for you, a gap in the posting plan,
   renders under way, the shot the library is missing. Each one is a button that goes there. */
function nextSteps() {
  const out = [];
  const add = (rank, tone, icon, text, attrs) => {
    const to = /data-goto="([a-z]+)/.exec(attrs)?.[1]; if (to && !ftShown(to)) return;  // simple mode: no step into a hidden tool
    out.push({ rank, html: `<button class="step ${tone}" ${attrs}>${ico(icon, "sm")}<span>${text}</span>${ico("chev-r", "sm")}</button>` });
  };
  const v = sys.verdict();
  const phoneOnly = v === "slow" && window.innerWidth < 900;  // a phone looking at the pages is fine; the editor says so itself
  if (v === "blocked" || (v === "slow" && !phoneOnly)) add(0, v === "blocked" ? "bad" : "warn", "alert", esc(tr(sys.msgKey())), `data-sysopen="1"`);
  const review = needsReview();
  if (review.length) add(1, "warn", "eye", tr(review.length === 1 ? "next.review1" : "next.review", { n: review.length, t: span(review.length * 60) }), `data-act="review"`);
  const busy = overview.reels.filter(busyJob);
  if (busy.length) {
    const eta = Math.max(...busy.map((r) => r.job.eta || 0));
    void eta;  // rendering is not a to-do: it lives in the status bar and on Reels › Being made
  }
  const approved = overview.reels.filter((r) => !r.house && r.status === "approved" && reelState(r) === "topost");
  for (const [k, c] of Object.entries(connections)) if (c?.error && !c.connected) add(1, "bad", "alert", tr("next.reconnect", { n: esc(c.name || k) }), `data-goto="accounts"`);
  const repeats = overview.reels.filter((r) => mayPost(r) && r.sameWords > 0 && reelState(r) !== "posted");
  if (repeats.length) add(2, "warn", "type", tr("next.words", { n: repeats.length }), `data-goto="words"`);
  if (approved.length) add(2, "ok", "send", tr("next.approved", { n: approved.length }), `data-goto="posting"`);
  const thin = (overview.filmNext || []).filter((g) => !g.left);
  if (thin.length) add(5, "info", "camera", tr("next.film", { t: esc(thin[0].title || thin[0].theme), w: esc(mkNeed(thin[0])), n: thin.length }), `data-goto="footage"`);
  if (!out.length && !overview.reels.some((r) => !r.house)) return "";  // nothing made yet: the empty state asks once
  if (!out.length) add(6, "ok", "clapper", tr("next.make"), `id="toggleMaker"`);
  return `<nav class="nextsteps" aria-label="${tr("next.title")}"><span class="meta">${tr("next.title")}</span>${out.sort((a, b) => a.rank - b.rank).slice(0, 3).map((x) => x.html).join("")}</nav>`;
}
/* Approve every reel waiting: first press arms the button, second does it. People on camera get Consent OK first
   (the owner has everyone's consent); a reel rendered with Blur faces needs none. */
let approveArm = false, approveBusy = "", approveTimer = null;
async function approveAll() {
  const list = needsReview();
  if (!approveArm) { approveArm = true; renderHome(true); clearTimeout(approveTimer); approveTimer = setTimeout(() => { approveArm = false; renderHome(true); }, 8000); return; }
  approveArm = false; clearTimeout(approveTimer);
  let ok = 0; const failed = [];
  for (const [i, r] of list.entries()) {
    approveBusy = `${i + 1} / ${list.length}`; renderHome(true);
    try {
      if (r.faces && !r.consent && !r.blurFaces) await post("/api/consent", { slug: "story-" + r.slug });
      await post("/api/approve", { slug: "story-" + r.slug }); ok++;
    } catch (err) { failed.push(`${r.slug}: ${String(err.message).trim().split("\n").pop()}`); }
  }
  approveBusy = ""; await loadOverview(); renderHome(true);
  toast(`${ico(failed.length ? "alert" : "check", "sm")} ${tr("act.approvedn", { n: ok })}${failed.length ? `<br>${failed.map(esc).join("<br>")}` : ""}`, failed.length ? 10000 : 4000);
}
document.addEventListener("click", (e) => { if (e.target.closest("#approveAll")) approveAll(); });
/* Reels › Being made: the render queue as a page (what is rendering now, what waits, time left, stop or retry) and
   the reels that just finished, waiting for review. Reached from the sub-tab, the Next strip and the status bar. */
/* The live board: every piece of work the studio is doing or did in the last 6 hours. GET /api/jobs gives the whole
   list; each live "job" event updates one entry in place; on a reconnect, and every 15 s while the page is visible,
   the list is read again so nothing missed while the connection was down stays wrong. */
var board = { jobs: new Map(), at: 0, live: false, loading: false };  // var: the status bar reads it from the first paint
var RENDER_KINDS = ["build", "remix"];
var BOARD_GROUPS = [["videos", ["vlog"]], ["ai", ["ai", "score"]], ["post", ["post", "helper", "youtube", "live"]], ["make", ["make"]], ["footage", ["watch", "discover", "footage", "gphotos", "cameras", "import", "takeout", "places"]]];
function groupOf(j) { return (BOARD_GROUPS.find(([, ks]) => ks.includes(j.kind)) || ["other"])[0]; }
function isActive(j) { return ["queued", "running"].includes(j.status); }
async function loadJobs() {
  if (board.loading) return; board.loading = true;
  try {
    const r = await api("/api/jobs");
    board.jobs = new Map(r.jobs.map((j) => [j.slug, j])); board.at = Date.now();
  } catch { /* the next tick tries again */ }
  board.loading = false; paintBoard(); paintStatus();
}
function boardJob(j) {
  const prev = board.jobs.get(j.slug) || {};
  board.jobs.set(j.slug, { ...prev, ...j, ended: isActive(j) ? null : prev.ended || Date.now(), started: prev.started || (j.status === "running" ? Date.now() - (j.seconds || 0) * 1000 : null) });
  board.at = Date.now(); board.live = true;
}
setInterval(() => { if (document.visibilityState === "visible") loadJobs(); }, 15000);
setInterval(() => { if (page === "making" && atHome()) paintBoard(); }, 1000);  // the "updated … ago" line and run times tick
var GROUP_KEY = { videos: "bd.g.videos", ai: "bd.g.ai", post: "bd.g.post", make: "bd.g.make", footage: "bd.g.footage", other: "bd.g.other" };
/* A project's name from its id ("my-trip" → "My Trip 2026"); the id, readable, until the list has loaded. */
function wsLabel(id) {
  if (!wsView && !wsLabel.asked) { wsLabel.asked = true; api("/api/workspaces").then((w) => { wsView = wsView || w; if (page === "making") paintBoard(); else if (atHome()) renderHome(true); }).catch(() => {}); }
  return (wsView?.list || []).find((w) => w.id === id)?.name || String(id).replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
}
/* The person said everyone in this project's footage agreed to be filmed (Review page switch): no consent reminder on each
   reel, no question on Approve. Approving still records consent per reel. Off until the list has loaded. */
function consentAll() {
  if (!wsView) { wsLabel("main"); return false; }
  return !!(wsView.list || []).find((w) => w.id === (wsView.running || "main"))?.consentAll;
}
function boardName(j) {
  const s = j.slug || "";
  const due = /^post-due-(.+)$/.exec(s); if (due) return tr("job.due", { p: wsLabel(due[1]) });
  const v = /^vlog-(\d+)$/.exec(s);
  if (v) return tr("bd.vlog", { n: v[1] });
  if (s === "vlog-plan") return tr("bd.vlogplan");
  if (/^live-/.test(s)) return tr("job.livecheck");
  if (s === "helper-perf") return tr("job.readnumbers");
  if (s === "footage") return tr("job.foldercheck");
  if (s === "places") return tr("geo.job");
  return s.replace(/^(ai|post|replace|helper|make)-/, "").replace(/^score-all$/, tr("bd.scoreall"));
}
function jobRow(j) {
  const pct = j.of ? Math.round(100 * (j.done || 0) / j.of) : j.pct || 0;
  const t = j.status === "running" ? mins(j.seconds || 0) : j.status === "queued" ? tr("bd.waiting", { n: j.position || "…" }) : "";
  return `<li class="bj s-${esc(j.status)}"><span class="bj-name" title="${esc(j.slug)}">${esc(boardName(j))}</span>
    <span class="bj-what">${esc(jobLabel(j.label))}${j.of > 200 ? ` <span class="meta">${pct}%</span>` : j.of ? ` <span class="meta">${j.done || 0}/${j.of}</span>` : ""}</span>
    <span class="bj-bar"><i style="width:${Math.max(0, Math.min(100, pct)).toFixed(1)}%"></i></span><span class="bj-t">${esc(t)}</span></li>`;
}
function boardHtml() {
  const all = [...board.jobs.values()];
  const active = all.filter((j) => isActive(j) && !RENDER_KINDS.includes(j.kind));
  const recent = all.filter((j) => !isActive(j) && j.ended).sort((a, b) => b.ended - a.ended).slice(0, 15);
  const ago_ = board.at ? Math.round((Date.now() - board.at) / 1000) : null;
  const live = sys.down ? `<span class="bd-live off">${tr("bd.offline")}</span>` : `<span class="bd-live">${tr("bd.live", { t: ago_ == null ? "…" : ago_ < 2 ? tr("bd.now") : tr("bd.ago", { n: ago_ }) })}</span>`;
  const groups = BOARD_GROUPS.map(([g]) => g).concat("other").map((g) => [g, active.filter((j) => groupOf(j) === g)]).filter(([, js]) => js.length);
  if (!groups.length && !recent.length) return "";  // nothing running, nothing finished: the page's own empty state says it once
  return `<section class="sheet boardsheet w9task"><h2><img src="/brand/icon-16.png" alt="" width="16" height="16">${tr("bd.h")} ${live}</h2>
    ${groups.length ? groups.map(([g, js]) => `<h3 class="sub">${tr(GROUP_KEY[g])} <span class="meta">${js.length}</span></h3><ul class="bjl">${js.map(jobRow).join("")}</ul>`).join("") : ""}
    ${recent.length ? `<h3 class="sub">${tr("bd.recent")}</h3><ul class="bjl recent">${recent.map((j) => `<li class="bj s-${esc(j.status)}"><span class="bj-ic" aria-hidden="true">${j.status === "done" ? "✓" : j.status === "cancelled" ? "–" : "✗"}</span>
      <span class="bj-name" title="${esc(j.slug)}">${esc(boardName(j))}</span><span class="bj-what" title="${esc(j.status === "error" ? (j.lines || []).slice(-1)[0] || "" : "")}">${esc(j.status === "error" ? plainFail((j.lines || []).slice(-1)[0] || j.label) : jobLabel(j.label || ""))}</span>
      <span class="bj-t">${esc(ago(new Date(j.ended).toISOString()))}</span></li>`).join("")}</ul>` : ""}</section>`;
}
function paintBoard() {
  const el = document.getElementById("board"); if (el) el.innerHTML = boardHtml();
  paintMonitor();
  const none = document.getElementById("mkNone"); if (none) none.hidden = [...board.jobs.values()].some(isActive);  // never "nothing is being made" over a running job
  psTick();  // batch C: the stage strips' clocks, or the queue when a stage moved
}
function renderMaking() {
  const head = `<div class="pagehead">${crumbs([tr("nav.reels"), "#/"], [tr("nav.making")])}<span class="grow"></span>
    <button class="primary" data-openmaker="1">${ico("clapper", "sm")}${tr("act.make")}</button></div>`;
  if (!overviewLoaded) { $("#home").innerHTML = head + loadingHtml(tr("nav.making")); return; }
  const R = overview.reels;
  const q = queueHtml();
  const fresh = R.filter((r) => !r.house && r.rendered && r.status === "rendered" && !busyJob(r))
    .sort((a, b) => (b.updated || 0) - (a.updated || 0)).slice(0, 8);
  if (!board.at) loadJobs();
  psSig = "";
  $("#home").innerHTML = `${head}<p class="intro">${tr("mk.intro")}</p>
    <div id="mkQueue">${q}</div>${q ? "" : `<div class="empty mascot" id="mkNone" ${[...board.jobs.values()].some(isActive) ? "hidden" : ""}>${kenji("nap")}<b>${tr("mk.nonet")}</b><span>${tr("mk.nonehint")}</span><button class="primary" data-openmaker="1">${ico("clapper", "sm")}${tr("act.make")}</button></div>`}
    <div id="board">${boardHtml()}</div>
    ${fresh.length ? `<h3 class="sub">${ico("eye", "sm")} ${tr("mk.fresh", { n: needsReview().length })} <a class="btn" href="#/review">${tr("act.review")}</a></h3>
      <div class="rgroup mk-fresh"><div class="reels">${fresh.map(reelCard).join("")}</div></div>` : ""}`;
}
document.addEventListener("click", (e) => { if (e.target.closest("[data-helpkeys]")) palOpen("keys"); });
document.addEventListener("click", (e) => {
  if (!e.target.closest("[data-openmaker]")) return;
  showMaker = true; if (location.hash === "#/reels") renderHome(); else location.hash = "#/reels";
});
/* The lead of Reels: the reel that goes out next (and when), and the reels waiting for you; the groups below are a
   denser contact sheet whose card actions appear on hover or focus. */
function leadHtml() {
  // Only what needs you: the reels waiting for review. What goes out next is in the status bar and on Posting already,
  // so it is not repeated here as a big card.
  const waiting = needsReview(), wait = waiting.slice(0, 4);
  const mon = `<div id="sysmon" class="w9win sysmon">${monitorHtml()}</div>`;
  if (!wait.length) return `<section class="lead monlead">${mon}</section>`;
  return `<section class="lead monlead"><div class="leadcol wide"><h3 class="leadh">${esc(tr("lead.review", { n: waiting.length }))} <a href="#/review">${tr("act.review")} ›</a></h3><div class="reels">${wait.map(reelCard).join("")}</div></div>${mon}</section>`;
}
/* The Studio Monitor beside the reels waiting for you (the owner, 16 Nov: "enhance the other parts ... with these kind
   of creativity"; the row was two cards and an empty two-thirds). A 90s system-monitor window, made only of what the
   studio already knows: the reels at each stage of the flow, the work running now with block progress bars, and the
   next posts. Repainted with the job board (paintBoard), so it stays live without its own timer. */
function blockBar(pct, label) {
  const p = Math.max(0, Math.min(100, Math.round(pct || 0)));
  return `<span class="w9bar sm" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p}" aria-label="${esc(label)}"><i style="width:${p}%"></i></span>`;
}
function monitorHtml() {
  const c = stateCounts(overview.reels), top = Math.max(1, ...FLOW.map((k) => c[k] || 0));
  const jobs = [...board.jobs.values()].filter(isActive).sort((a, b) => (a.status === "running" ? 0 : 1) - (b.status === "running" ? 0 : 1)).slice(0, 4);
  const ahead = postsLoaded ? upcomingPosts(9999) : [];
  // Next out: every post of the next time slot (17 Nov: three of six were shown, the rest looked missing), then the
  // slots after it while there is room.
  const next = [];
  for (let i = 0, lastT = null; i < ahead.length; i++) {
    const t = new Date(ahead[i].at).getTime();
    if (t !== lastT) { if (next.length >= 6) break; lastT = t; }
    next.push(ahead[i]);
  }
  const flow = FLOW.map((k) => `<li><button class="linkbtn" data-hf="${k}">${esc(tr(STATE_KEY[k]))}</button>${blockBar(100 * (c[k] || 0) / top, tr(STATE_KEY[k]))}<b>${c[k] || 0}</b></li>`).join("");
  const work = jobs.length ? jobs.map((j) => {
    const pct = j.of ? 100 * (j.done || 0) / j.of : j.pct || 0;
    return `<li><span class="clamp" title="${esc(j.slug)}">${esc(boardName(j))}</span>${blockBar(j.status === "running" ? pct : 0, boardName(j))}<b>${j.status === "running" ? `${Math.round(pct)}%` : esc(tr("mon.queued"))}</b></li>`;
  }).join("") : `<li class="idle">${esc(tr("mon.idle"))}</li>`;
  // The time once per slot (a header row), then each network and its reel at full width.
  const out = next.length ? next.map((p, i) => {
    const t = new Date(p.at).getTime(), head = i === 0 || t !== new Date(next[i - 1].at).getTime();
    return `${head ? `<li class="slot"><b>${esc(wallOf(t, audTz()).slice(11))}</b><span>${esc(untilText(p.at))}</span></li>` : ""}<li class="np"><span class="clamp" title="${esc(`${NET_NAME[p.network] || p.network} · ${reelName(p.slug)}`)}">${netLogo(chOf(p.network), "sm")} <span lang="ja">${esc(reelName(p.slug))}</span></span></li>`;
  }).join("")
    : `<li class="idle">${esc(tr(postsLoaded ? "mon.nonext" : "mon.reading"))}</li>`;
  return `<div class="w9title"><img src="/brand/icon-16.png" alt="" width="16" height="16"><b>${tr("mon.title")}</b><span class="grow"></span><i class="led ${jobs.length ? "busy" : ""}" aria-hidden="true"></i></div>
    <div class="monbody">
      <fieldset><legend>${tr("mon.flow")}</legend><ul class="monl">${flow}</ul></fieldset>
      <fieldset><legend>${tr("mon.work")} <span>${jobs.length}</span></legend><ul class="monl">${work}</ul></fieldset>
      <fieldset><legend>${tr("mon.next")}</legend><ul class="monl">${out}</ul></fieldset>
      ${postsLoaded ? weekGridHtml() : ""}
    </div>
    <div class="monfoot"><span>${esc(tr("mon.clips", { n: (overview.library?.ranch ?? 0).toLocaleString(lang === "ja" ? "ja-JP" : "en-GB") }))}</span><span>${esc(tr("mon.review", { n: needsReview().length }))}</span><span>${esc(tr("mon.booked", { n: postsLoaded ? upcomingPosts(9999).length : "…" }))}</span></div>`;
}
/* The next 7 days, one row per network, each cell filled by its state (batch A: booked on the site, the studio sends it,
   a reminder, failed or missing, out, an empty slot): one laneSvg in "cells" mode. Point at a cell for its posts; a
   click opens Posting's week at that network and day. The same bookings as Posting, read from the posting log. */
const WEEK_ORDER = ["youtube", "instagram-story", "photo-story", ...POST_NETS.filter((n) => n !== "youtube")];
function weekGridHtml() {
  const days = Array.from({ length: 7 }, (_, i) => wallOf(Date.now() + i * 864e5).slice(0, 10)), d = laneData(days);
  const rows = d.rows.filter((r) => d.items.some((x) => x.row === r.key) || [...d.gaps.keys()].some((k) => k.startsWith(r.key + "|")));
  const model = { id: "lnMon", mode: "cells", rows, days, items: d.items, gaps: d.gaps, today: days[0], counts: true, label: tr("mon.week"), hint: tr("ln.monhint"),
    sig: JSON.stringify([lang, d.items.map((x) => [x.id, x.day, x.state]), [...d.gaps.keys()]]),
    act: (kind, c) => { LANES.focus = { net: c.net, day: c.day }; postView = "lanes"; postTab = "schedule"; postNet = "all"; if (location.hash !== "#/posting") location.hash = "#/posting"; else renderHome(true); } };
  const n = d.items.filter((x) => x.state !== "out").length;
  return `<fieldset class="monwk"><legend>${esc(tr("mon.week"))} <span>${n}</span> <a href="#/posting" data-pview="lanes">${esc(tr("mon.weekopen"))} ›</a></legend>${rows.length ? laneSvg(model) + lnKey() : `<p class="idle">${esc(tr("mon.weeknone"))}</p>`}</fieldset>`;
}
function paintMonitor() { const el = document.getElementById("sysmon"); if (el) { el.innerHTML = monitorHtml(); drawLanes(); } }
