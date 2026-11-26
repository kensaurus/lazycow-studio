/* ---------- What needs you (batch A, 17 Nov): one strip under the header on every page, worst cause first ----------
   It replaces the stacked problem banner, Reels' NEXT row, the "Runs by itself" line and Posting's "Before these go out"
   box. Red = broken (a post or render will not happen until it is fixed); amber = will become a problem (a sign-in
   that ends in N days, nothing booked for the next day and a half); plain = a to-do (reels to review). Each item says
   one line and has one fix. The server's problems (PROB) come grouped by cause; the rest is what this page knows.
   "All N" opens the full list in place; × hides it until something new (the header's button stays). */
const WN = {
  open: false, sig: "",
  local() {
    const out = [], add = (lv, key, text, fix, detail = "") => out.push({ lv, key, text, fix, detail });
    const has = new Set(PROB.items.map((i) => i.id));
    const v = sys.verdict?.();
    if (v === "blocked" || (v === "slow" && innerWidth >= 900)) add(v === "blocked" ? "red" : "amber", "sys", tr(sys.msgKey()), { label: tr("wn.sys"), attrs: 'data-sysopen="1"' });
    for (const [k, c] of Object.entries(connections || {})) if (c?.error && !c.connected && !has.has("signin:" + k)) add("red", "conn:" + k, tr("next.reconnect", { n: c.name || NET_NAME[k] || k }), { label: tr("wn.signin"), href: "#/accounts" }, c.error);
    for (const h of autoView?.runs?.health?.items || []) {
      if (h.level === "ok" || has.has("signin:" + h.network) || has.has("check:" + h.network) || connections?.[h.network]?.error) continue;
      add(h.level === "bad" ? "red" : "amber", "health:" + h.network, `${NET_NAME[h.network] || h.network}: ${h.found}`, { label: h.fix || tr("wn.open"), href: "#/accounts" });
    }
    if (staleView?.groups?.failed) add("red", "swap", tr("wn.swapfail", { n: staleView.groups.failed }), { label: tr("wn.retry"), attrs: "data-swapretry" },
      (staleView.list || []).filter((x) => x.why === "failed").map((x) => `${reelName(x.slug)} · ${NET_NAME[x.network] || x.network}`).join(" | "));
    if (levelsView?.off?.length && !levelsView.fixing) add("amber", "levels", tr(levelsView.off.length === 1 ? "lv.h1" : "lv.h", { n: levelsView.off.length }), { label: tr("lv.fix"), attrs: "data-levelfix" },
      levelsView.off.map((x) => reelName(x.slug)).join(" · "));
    const refused = autoView?.runs?.plan?.refused || [];
    if (refused.length) add("amber", "refused", tr("wn.refused", { n: refused.length }), { label: tr("wn.see"), href: "#/posting", attrs: 'data-wnjump="auto"' },
      refused.map((x) => `${NET_NAME[x.network] || x.network}: ${x.why}`).slice(0, 3).join(" | "));
    if (!overviewLoaded) return out;
    if (postsLoaded) {
      const now = Date.now(), soon = now + 36 * 3600e3;
      const booked = postsLog.some((p) => ["planned", "scheduled", "queued"].includes(p.status) && p.at && new Date(p.at).getTime() > now && new Date(p.at).getTime() < soon);
      // Only when an approved reel could go out: a first reel still waiting for review is not "schedule a post" yet
      // (Plan posts books approved reels only; the review to-do already asks for it).
      if (!booked && overview.reels.some((r) => !r.house && r.status === "approved" && reelState(r) === "topost")) add("amber", "gap", tr("next.gap"), { label: tr("wn.plan"), attrs: "data-wnplan" });
      const ahead = postsLog.filter((p) => ["planned", "scheduled", "queued"].includes(p.status) && p.network !== "all" && p.at && new Date(p.at).getTime() > now);
      const rep = repeatMap(ahead).size;
      if (rep) add("amber", "rephook", tr(rep === 1 ? "w.repeatsum1" : "w.repeatsum", { n: rep }), { label: tr("w.fix"), href: "#/words" });
    }
    const same = overview.reels.filter((r) => mayPost(r) && r.sameWords > 0 && reelState(r) !== "posted").length;
    if (same) add("amber", "words", tr("next.words", { n: same }), { label: tr("w.fix"), href: "#/words" });
    const review = needsReview().length;
    if (review) add("todo", "review", tr(review === 1 ? "next.review1" : "next.review", { n: review, t: span(review * 60) }), { label: tr("wn.review"), href: "#/review" });
    if (verView?.ready?.length) add("todo", "versions", tr("wn.versions", { n: verView.ready.length }), { label: tr("ver.compare"), href: "#/versions" });
    const approved = overview.reels.filter((r) => !r.house && r.status === "approved" && reelState(r) === "topost").length;
    if (approved) add("todo", "approved", tr(autoView?.settings?.plan?.on ? "wn.approvedauto" : "next.approved", { n: approved, h: String(autoView?.settings?.plan?.hour ?? 9).padStart(2, "0") }), { label: tr("wn.plan"), attrs: "data-wnplan" });
    const thin = (overview.filmNext || []).filter((g) => !g.left);
    if (thin.length) add("todo", "film", tr("next.film", { t: thin[0].title || thin[0].theme, w: thin[0].need, n: thin.length }), { label: tr("wn.film"), href: "#/footage" });
    return out;
  },
  /** Every item, worst first: the server's problems by cause (red, amber), then this page's, then the to-dos. */
  items() {
    const ja = lang === "ja", groups = new Map();
    for (const i of PROB.items) { if (i.level === "info") continue; const c = PROB.cause(i.id); if (!groups.has(c)) groups.set(c, []); groups.get(c).push(i); }
    const server = [...groups].map(([c, l]) => {
      const lv = l.some((i) => i.level === "red") ? "red" : "amber", first = l.find((i) => i.level === lv) || l[0];
      return { lv, key: "p:" + c, n: l.length, text: l.length === 1 ? PROB.nice(first.title) : tr("wn.group", { c: PROB.causeName(c, ja), n: l.length }),
        detail: l.length === 1 ? PROB.nice(first.detail) : l.slice(0, 3).map((i) => PROB.nice(i.title)).join(" · ") + (l.length > 3 ? " …" : ""),
        fix: first.fix?.action?.ai === "retry" && l.length === 1 ? { label: first.fix.label, attrs: `data-aitry="${esc(first.fix.action.provider)}"` }
          : { label: first.fix?.label || tr("wn.open"), href: first.fix?.href || "#/" }, also: first.also, dismiss: l.length === 1 && first.dismissable ? first.id : "" };
    });
    const local = this.local(), rank = { red: 0, amber: 1, todo: 2 };
    server.forEach((x) => { x.list = groups.get(x.key.slice(2)); });
    return [...server, ...local].map((x, i) => ({ ...x, i, grp: this.grp(x.key) })).sort((a, b) => rank[a.lv] - rank[b.lv] || (b.n || 1) - (a.n || 1) || a.i - b.i);
  },
  /* Track C (24 Nov): one inbox. Every row in one of five groups, each problem on its own line with its one fix when
     the list is open, and the header's red button counting the same list (its aria said 6, its tooltip 2, the strip 9). */
  GROUPS: ["signin", "posting", "making", "numbers", "ideas"],
  grp(key) {
    const k = String(key || ""), c = k.startsWith("p:") ? k.slice(2) : k.split(":")[0];
    if (["signin", "conn", "health", "check"].includes(c)) return "signin";
    if (["numbers", "reach"].includes(c)) return "numbers";
    if (["missed", "unapproved", "refused", "gap", "swap", "rephook", "approved"].includes(c)) return "posting";
    if (["words", "film"].includes(c)) return "ideas";
    return "making";
  },
  /** One line per problem: a server group of several is opened into its problems, each with its own fix. */
  expand(rows) {
    const ja = lang === "ja";
    return rows.flatMap((x) => (!x.list || x.list.length < 2 ? [x] : x.list.map((i, k) => ({ lv: i.level === "red" ? "red" : "amber", key: `p1:${i.id}`, grp: x.grp, i: x.i + k / 100,
      text: PROB.nice(i.title), detail: PROB.nice(i.detail), also: i.also, dismiss: i.dismissable ? i.id : "",
      fix: i.fix?.action?.ai === "retry" ? { label: i.fix.label, attrs: `data-aitry="${esc(i.fix.action.provider)}"` } : { label: i.fix?.label || (ja ? "開く" : "Open"), href: i.fix?.href || "#/" } }))));
  },
  /** The header's red button: the stopped and worth-a-look lines of this same list, its tooltip and aria in one sentence. */
  paintBtn(all) {
    const btn = $("#probBtn"); if (!btn) return;
    const r = all.filter((x) => x.lv === "red").length, a = all.filter((x) => x.lv === "amber").length, n = r + a;
    btn.hidden = !n;
    btn.className = `langbtn probbtn ${r ? "red" : a ? "amber" : ""}`;
    btn.innerHTML = `${ico("alert", "sm")}<span>${n}</span>`;
    btn.title = n === 1 ? tr("tc.ib.btn1", { w: tr(r ? "tc.ib.red" : "tc.ib.amber") }) : tr("tc.ib.btn", { n, r, a });
    btn.setAttribute("aria-label", btn.title);
    btn.setAttribute("aria-expanded", String(this.open));
  },
  filter: "",
  /** Open the list at its problems (the red button): stopped ones when there are any, else the worth-a-look ones. */
  openAt(filter) {
    const all = this.expand(this.items());
    try { sessionStorage.removeItem("lc.wnHidden"); } catch { /* fine */ }
    this.filter = filter ?? (all.some((x) => x.lv === "red") ? "red" : all.some((x) => x.lv === "amber") ? "amber" : "");
    this.open = true; this.openTop = $("#home")?.scrollTop || 0;
    $("#probStrip")?.classList.remove("away");
    this.draw();
    $("#probStrip .wn-fbar button[aria-pressed=true]")?.focus({ preventScroll: true });
  },
  shut() { if (!this.open && !this.filter) return; this.open = false; this.filter = ""; this.draw(); },
  autoLine() {
    const pl = autoView?.settings?.plan;
    if (!pl) return "";
    return `<a class="wn-auto" href="#/posting" data-wnjump="auto" title="${esc(tr("auto.see"))}">${ico("clock", "sm")}<span>${esc(pl.on ? tr("wn.autoon", { h: String(pl.hour ?? 9).padStart(2, "0") }) : tr("auto.off"))}</span></a>`;
  },
  fixHtml(f, cls = "") {
    if (!f) return "";
    const arrow = cls.includes("primary") ? "" : " ›";  // a primary button draws its own arrow
    if (f.href && !f.attrs) return `<a class="btn wn-fix ${cls}" href="${escUrl(f.href)}">${esc(f.label)}${arrow}</a>`;
    return `<button type="button" class="wn-fix ${cls}" ${f.attrs || ""} ${f.href ? `data-wnhref="${escUrl(f.href)}"` : ""}>${esc(f.label)}${arrow}</button>`;
  },
  draw() {
    const strip = $("#probStrip"); if (!strip) return;
    if (autoView === null && !autoLoading && overviewLoaded) loadAuto();
    if (levelsView === null && !levelsLoading && postsLoaded) loadLevels();
    if (verView === null && !verLoading && postsLoaded) loadVersions();
    const items = this.items(), all = this.expand(items);
    this.paintBtn(all);
    const worst = items[0]?.lv || "", keys = items.map((x) => x.key + ":" + (x.n || 1)).join("|");
    let hidden = ""; try { hidden = sessionStorage.getItem("lc.wnHidden") || ""; } catch { /* fine */ }
    // Home has its own What needs you box with the same items: the strip would say it twice (opening it still works).
    const onHome = page === "home" && atHome() && !this.open;
    const hide = !overviewLoaded || onHome || (items.length > 0 && hidden === keys);
    const sig = [lang, keys, all.map((x) => x.text + (x.fix?.label || "")).join("|"), this.open, this.filter, hide, this.autoLine()].join("§");
    if (sig === this.sig) { this.place(); return; }
    this.sig = sig;
    if (hide) { strip.hidden = true; strip.innerHTML = ""; this.place(); return; }
    strip.hidden = false;
    strip.className = `probstrip wn l-${worst || "clear"}${this.open ? " open" : ""}`;
    strip.setAttribute("aria-label", tr("wn.label"));
    if (this.open && all.length) { strip.innerHTML = this.openHtml(all, worst); this.place(); return; }
    const lab = items.length ? `<span class="wn-lab" title="${esc(tr("tc.ib.lab", { n: all.length }))}"><span class="wn-labt">${esc(tr("wn.lab"))}</span><b>${all.length}</b></span>`
      : `<span class="wn-lab">${ico("check", "sm")}<span class="wn-labt">${esc(tr("wn.clear"))}</span></span>`;
    if (!items.length) {
      strip.innerHTML = `${lab}<p class="wn-calm"><span>${esc(tr("wn.calm"))}</span>${this.autoLine()}</p>`;
      this.place(); return;
    }
    const it = (x) => `<li class="wn-it ${x.lv}"><i class="wn-dot" aria-hidden="true"></i><span class="wn-t" title="${esc(x.detail || x.text)}"><b>${esc(x.text)}</b>${this.open && x.detail ? `<span class="meta">${esc(x.detail)}</span>` : ""}</span>${this.fixHtml(x.fix, x.lv === "red" ? "primary" : "")}${this.open && x.also?.href ? `<a class="btn wn-fix" href="${escUrl(x.also.href)}" target="_blank" rel="noopener">${esc(x.also.label || "")} ↗</a>` : ""}${this.open && x.dismiss ? `<button type="button" class="wn-fix" data-probdismiss="${esc(x.dismiss)}">${esc(tr("wn.dismiss"))}</button>` : ""}</li>`;
    const more = all.length > 1 ? `<button type="button" class="wn-more" data-wnmore="1" aria-expanded="${this.open}"><span class="wn-moret">${esc(this.open ? tr("wn.less") : tr("wn.all", { n: all.length }))}</span>${ico(this.open ? "chev-l" : "chev-r", "sm")}</button>` : "";
    strip.innerHTML = `${lab}<ul class="wn-list">${items.map(it).join("")}</ul>
      <span class="wn-side">${more}${this.open ? this.autoLine() : ""}<button type="button" class="icon wn-x" data-wnhide="1" title="${esc(tr("wn.hide"))}" aria-label="${esc(tr("wn.hide"))}">${ico("x", "sm")}</button></span>`;
    this.place();
  },
  /* Just under the header and lined up with the page's own column, whatever their heights (two rows on a phone). */
  place() {
    const h = document.querySelector(".app > header"), strip = $("#probStrip"), home = $("#home");
    if (!h || !strip) return;
    strip.style.top = `${Math.round(h.getBoundingClientRect().bottom + 8)}px`;
    if (home && atHome()) {
      const r = home.getBoundingClientRect(), cs = getComputedStyle(home), pl = parseFloat(cs.paddingLeft) || 0, pr = parseFloat(cs.paddingRight) || 0;
      const sb = home.offsetWidth - home.clientWidth;  // the page's own scrollbar
      strip.style.left = `${Math.round(r.left + pl)}px`; strip.style.width = `${Math.max(200, Math.round(r.width - pl - pr - sb))}px`;
    }
    // The page keeps room for the one-row strip only: the open list lies over the page like a menu. It used to push the
    // page down by its full height, and once scrolled (the strip fades) that room stayed as a ~467px blank band (BL-110).
    if (!this.open || strip.hidden) this.closedH = strip.hidden ? 0 : Math.round(strip.getBoundingClientRect().height + 14);
    document.documentElement.style.setProperty("--probh", `${this.closedH ?? 0}px`);
  },
  /** The open list: a filter row (All / Stopped / Worth a look / To do), then the five groups, each line one fix. */
  openHtml(all, worst) {
    const n = (lv) => all.filter((x) => x.lv === lv).length, f = this.filter;
    const shown = all.filter((x) => !f || x.lv === f).sort((a, b) => this.GROUPS.indexOf(a.grp) - this.GROUPS.indexOf(b.grp) || ({ red: 0, amber: 1, todo: 2 }[a.lv] - { red: 0, amber: 1, todo: 2 }[b.lv]) || a.i - b.i);
    const chip = (k, label, c) => (k && !c ? "" : `<button type="button" class="tc-ib-chip ${k || "all"}" data-wnfilter="${k}" aria-pressed="${f === k}">${esc(label)} <b>${c}</b></button>`);
    const also = (x) => (x.also?.href ? `<a class="tc-ib-also" href="${escUrl(x.also.href)}" ${/^#/.test(x.also.href) ? "" : 'target="_blank" rel="noopener"'}>${esc(x.also.label || "")}${/^#/.test(x.also.href) ? " ›" : " ↗"}</a>` : "");
    const line = (x) => `<li class="wn-it ${x.lv}"><i class="wn-dot" aria-hidden="true"></i><span class="wn-t"><b>${esc(x.text)}</b>${x.detail ? `<span class="meta">${esc(x.detail)}</span>` : ""}${also(x)}</span>${this.fixHtml(x.fix, x.lv === "red" ? "primary" : "")}${x.dismiss ? `<button type="button" class="icon tc-ib-x" data-probdismiss="${esc(x.dismiss)}" title="${esc(tr("wn.dismiss"))}" aria-label="${esc(tr("wn.dismiss"))}: ${esc(x.text)}">${ico("x", "sm")}</button>` : ""}</li>`;
    let body = "";
    for (const g of this.GROUPS) {
      const l = shown.filter((x) => x.grp === g); if (!l.length) continue;
      const name = { signin: tr("tc.ib.g.signin"), posting: tr("tc.ib.g.posting"), making: tr("tc.ib.g.making"), numbers: tr("tc.ib.g.numbers"), ideas: tr("tc.ib.g.ideas") }[g];
      body += `<li class="tc-ib-h" role="presentation"><span>${esc(name)}</span><b>${l.length}</b></li>${l.map(line).join("")}`;
    }
    void worst;
    return `<span class="wn-lab"><span class="wn-labt">${esc(tr("wn.lab"))}</span><b>${all.length}</b></span>
      <span class="wn-fbar" role="group" aria-label="${esc(tr("tc.ib.f"))}">${chip("", tr("tc.ib.f.all"), all.length)}${chip("red", tr("tc.ib.f.red"), n("red"))}${chip("amber", tr("tc.ib.f.amber"), n("amber"))}${chip("todo", tr("tc.ib.f.todo"), n("todo"))}</span>
      <span class="wn-side"><button type="button" class="wn-more" data-wnmore="1" aria-expanded="true"><span class="wn-moret">${esc(tr("wn.less"))}</span>${ico("chev-l", "sm")}</button>${this.autoLine()}<button type="button" class="icon wn-x" data-wnhide="1" title="${esc(tr("wn.hide"))}" aria-label="${esc(tr("wn.hide"))}">${ico("x", "sm")}</button></span>
      <ul class="wn-list">${body || `<li class="tc-ib-none">${esc(tr("tc.ib.none"))}</li>`}</ul>`;
  },
};
document.addEventListener("click", (e) => {
  const t = e.target.closest?.("[data-wnmore], [data-wnhide], [data-wnplan], [data-wnjump], [data-wnhref], [data-wnfilter]");
  if (!t) return;
  if (t.hasAttribute("data-wnfilter")) { WN.filter = t.dataset.wnfilter; WN.draw(); $(`#probStrip [data-wnfilter="${WN.filter}"]`)?.focus({ preventScroll: true }); return; }
  if (t.dataset.wnmore) { if (WN.open) WN.shut(); else { WN.open = true; WN.openTop = $("#home")?.scrollTop || 0; WN.draw(); } return; }
  // a fix that leads to another page closes the open list (it lay over that page)
  if (WN.open && t.closest("#probStrip") && (t.dataset.wnhref || t.tagName === "A")) setTimeout(() => WN.shut(), 0);
  if (t.dataset.wnhide) { try { sessionStorage.setItem("lc.wnHidden", WN.items().map((x) => x.key + ":" + (x.n || 1)).join("|")); } catch { /* fine */ } WN.open = false; WN.draw(); return; }
  if (t.hasAttribute("data-wnplan")) { e.preventDefault(); WN.open = false; WN.draw(); if (page !== "posting" || !atHome()) location.hash = "#/posting"; setTimeout(() => openPlanner(), page === "posting" ? 0 : 400); return; }
  if (t.dataset.wnjump === "auto") {
    autoOpen = true; WN.open = false; WN.draw();
    if (t.tagName !== "A" && (page !== "posting" || !atHome())) location.hash = "#/posting";
    setTimeout(() => { const d = document.querySelector("#home [data-autofold]"); if (d) { d.open = true; d.scrollIntoView({ block: "start", behavior: moCalm() ? "auto" : "smooth" }); } }, page === "posting" ? 50 : 700);
    return;
  }
  if (t.dataset.wnhref) location.hash = t.dataset.wnhref;
});
setInterval(() => WN.draw(), 30_000);
PROB.load();
setInterval(() => PROB.load(), 5 * 60_000);
addEventListener("resize", () => PROB.place());
$("#home")?.addEventListener("scroll", (e) => {
  const top = e.currentTarget.scrollTop;
  // the open list closes when the page under it scrolls on (or a new page opens), so it never leaves a band behind
  if (WN.open && Math.abs(top - (WN.openTop || 0)) > 120) WN.shut();
  if (!WN.open) $("#probStrip")?.classList.toggle("away", top > 60);
}, { passive: true });
window.addEventListener("hashchange", () => WN.shut());
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && WN.open && !PROB.open && !drawer && !planner) WN.shut(); });
document.addEventListener("click", (e) => {
  // a click outside the open list (and outside the button that opens it) closes it, like a menu
  if (WN.open && e.target.isConnected && !e.target.closest?.("#probStrip, #probBtn, [data-probopen], .toast")) WN.shut();
  if (e.target.closest?.("#newsPanel [data-probopen]")) { newsOpen = false; $("#newsPanel").hidden = true; $("#newsBtn").setAttribute("aria-expanded", "false"); }
});

/* The 90s pop-up tour (owner's idea, 13 Nov): Lazy Kenji explains each page in pop-up windows that keep coming, like a
   1999 website's ads. Opt in only, behind a DO NOT CLICK button and a warning. The windows live in the page (real tabs
   are blocked by browsers and could really slow a PC): at most 9 open and 40 in all. Closing one opens two, as it
   should. Esc or "Make it stop" closes them all. Only fixed text from this file is shown. */
const POP = {
  on: false, made: 0, timer: 0, z: 400, MAX_OPEN: 9, MAX_ALL: 40,
  tips: [
    ["footage", "point", ["STEP 1: FOOTAGE", "Tell me where your photos and videos are. I only read them. Nothing is moved or changed."], ["ステップ1：素材", "写真と動画の場所を教えてください。読むだけで、動かしたり変えたりしません。"]],
    ["making", "work", ["MAKE REELS", "One press and I cut a handful of short vertical videos from your best clips. Coffee time."], ["リールを作る", "ボタンひとつで、いちばんいい素材から縦長の短い動画を何本か作ります。コーヒーでもどうぞ。"]],
    ["review", "lounge", ["YOU ONLY REVIEW", "Watch each reel, approve the good ones. Nothing is ever posted without your yes."], ["あなたは確認するだけ", "1本ずつ見て、いいものをOKに。あなたのOKなしに投稿されることはありません。"]],
    ["posting", "thumbs", ["POSTING", "Pick a day, I book it: one post per network per day, when your audience is awake."], ["投稿", "日を選べば予約します。各SNSに1日1本、見る人が起きている時間に。"]],
    ["videos", "wave", ["LONG VIDEOS", "Back from a trip? I make 10-minute episodes for YouTube, with maps and a next-part card."], ["長い動画", "旅行帰り？YouTube用に10分ほどの回を、地図と「次回」カードつきで作ります。"]],
    ["results", "work", ["RESULTS", "How each post did, per network, and what to try next."], ["結果", "投稿ごとの反応をSNS別に。次に試すことも。"]],
    ["settings", "point", ["SETTINGS", "Keys, AI limits and accounts. Paid AI never goes over the limit you set."], ["設定", "キー、AIの上限、アカウント。有料AIは決めた上限を超えません。"]],
    ["", "point", ["PRO TIP", "Press Ctrl K anywhere to find a reel, a page or help. Like a 1999 search engine, but it works."], ["プロの技", "どこでも Ctrl K でリール・ページ・ヘルプを検索。1999年の検索エンジンと違って、ちゃんと見つかります。"]],
    ["", "worried", ["THE BELL", "Red in the bell means something will NOT happen until you fix it. There is always a Fix button."], ["ベル", "ベルが赤いときは、直すまで何かが起きません。かならず「直す」ボタンがあります。"]],
    ["", "thumbs", ["!!! CONGRATULATIONS !!!", "You are the 1,000,000th visitor... of your own computer. Your prize: free video editing."], ["！！！おめでとう！！！", "あなたは100万人目の訪問者です…自分のパソコンの。賞品：動画編集が無料。"]],
    ["making", "work", ["HOT NEW REELS IN YOUR AREA", "Dozens of reels are waiting in your footage folder right now. Make one in minutes."], ["あなたの近くの新作リール", "素材フォルダで、たくさんのリールが待っています。数分で1本。"]],
    ["", "worried", ["YOUR PC MAY BE RUNNING SLOW!", "It is the pop-ups. We did warn you. Press Esc, or just close the browser lol."], ["パソコンが重いかも！", "ポップアップのせいです。警告しましたよね。Esc か、ブラウザを閉じてください（笑）"]],
    ["", "lounge", ["YOU'VE GOT MAIL!", "No you have not. But you have footage. Go make something."], ["メールが届きました！", "届いていません。でも素材はあります。何か作りましょう。"]],
    ["", "nap", ["DOWNLOAD MORE RAM", "We can't. Nobody can. Close some tabs instead."], ["メモリをダウンロード", "できません。誰にも。タブを閉じましょう。"]],
  ],
  t(tip) { return lang === "ja" ? tip[3] : tip[2]; },
  ask() {
    if (document.querySelector(".popwarn")) return;
    const ja = lang === "ja";
    const box = document.createElement("div");
    box.className = "popwarn";
    box.innerHTML = `<div class="popwin" role="alertdialog" aria-modal="true" aria-label="${ja ? "警告" : "Warning"}">
      <div class="ptitle"><span>${ja ? "警告 - Lazycow Navigator" : "WARNING - Lazycow Navigator"}</span><button data-popno="1" aria-label="${ja ? "閉じる" : "Close"}">x</button></div>
      <div class="body"><img src="/brand/kenji-worried.png" alt=""><div><b>${ja ? "本当にいいですか？" : "ARE YOU SURE?"}</b>
      <p>${ja ? "1999年のウェブみたいに、ポップアップが次々に開きます（各ページの説明つき）。パソコンが重くなったら、ブラウザを閉じてください（笑）。" : "This opens a LOT of pop-ups, the 1999 way: a tour of every page. If your computer gets slow, just close the browser lol."}</p>
      <button class="go" data-popyes="1">${ja ? "楽しみたい" : "I want fun"}</button> <button class="go" data-popno="1">${ja ? "やめておく" : "No thanks"}</button></div></div></div>`;
    document.body.appendChild(box);
    box.querySelector("[data-popyes]").focus();
  },
  start() {
    document.querySelector(".popwarn")?.remove();
    if (this.on) return;
    this.on = true; this.made = 0;
    const ja = lang === "ja";
    const ctl = document.createElement("div");
    ctl.className = "popctl"; ctl.setAttribute("role", "status");
    ctl.innerHTML = `<span>${ja ? "重い？ブラウザを閉じてね（笑）" : "Slow? Just close the browser lol"}</span><button data-popstop="1">${ja ? "止めて！(Esc)" : "MAKE IT STOP (Esc)"}</button>`;
    document.body.appendChild(ctl);
    const slow = moCalm();
    this.spawn();
    this.timer = setInterval(() => this.spawn(), slow ? 3500 : 1600);
  },
  spawn() {
    if (!this.on) return;
    const open = document.querySelectorAll(".popwin:not(.popwarn .popwin)").length;
    if (this.made >= this.MAX_ALL) {
      clearInterval(this.timer);
      if (!open) this.stop();
      return;
    }
    if (open >= this.MAX_OPEN) return;
    const tip = this.tips[this.made % this.tips.length];
    const [title, text] = this.t(tip);
    const ja = lang === "ja";
    const w = document.createElement("div");
    w.className = "popwin" + (this.made % 3 === 0 ? " hot" : "");
    w.setAttribute("role", "dialog"); w.setAttribute("aria-label", title);
    const W = Math.min(340, innerWidth - 24), H = 190;
    w.style.left = `${Math.round(12 + Math.random() * Math.max(0, innerWidth - W - 24))}px`;
    w.style.top = `${Math.round(12 + Math.random() * Math.max(0, innerHeight - H - 90))}px`;
    w.style.zIndex = String(++this.z);
    w.innerHTML = `<div class="ptitle"><span>${title} - Lazycow Navigator</span><button data-popx="1" aria-label="${ja ? "閉じる" : "Close"}">x</button></div>
      <div class="body"><img src="/brand/kenji-${tip[1]}.png" alt=""><div><b>${title}</b><p>${text}</p>
      ${tip[0] ? `<button class="go" data-popgo="${tip[0]}">${ja ? "ここをクリック！" : "CLICK HERE!"}</button>` : ""}</div></div>
      <div class="news"><i>${ja ? "★ 新着 ★ Lazy Kenji のおすすめ ★ 無料 ★ 本当に無料 ★" : "*** NEW *** HOT TIP FROM LAZY KENJI *** 100% FREE *** NO CRACK NEEDED ***"}</i></div>`;
    document.body.appendChild(w);
    this.made++;
    if (this.made === this.MAX_ALL) setTimeout(() => this.finale(), 1800);
  },
  finale() {
    if (!this.on) return;
    const ja = lang === "ja";
    const w = document.createElement("div");
    w.className = "popwin hot";
    w.style.left = `${Math.max(12, innerWidth / 2 - 170)}px`; w.style.top = `${Math.max(12, innerHeight / 2 - 110)}px`; w.style.zIndex = String(++this.z);
    w.innerHTML = `<div class="ptitle"><span>${ja ? "おしまい" : "THE END"} - Lazycow Navigator</span><button data-popstop="1" aria-label="${ja ? "閉じる" : "Close"}">x</button></div>
      <div class="body"><img src="/brand/kenji-thumbs.png" alt=""><div><b>${ja ? "1999年を生き延びました" : "YOU SURVIVED 1999"}</b>
      <p>${ja ? "これで全部です。ケンジは豆の袋に戻ります。" : "That was all of them. Kenji is going back to his bean bag."}</p><button class="go" data-popstop="1">${ja ? "閉じる" : "Close them all"}</button></div></div>`;
    document.body.appendChild(w);
  },
  close(win) {
    win.remove();
    if (this.on && this.made < this.MAX_ALL) { this.spawn(); this.spawn(); }  // close one, two come back: authentic
  },
  stop() {
    this.on = false; clearInterval(this.timer);
    document.querySelectorAll(".popwin, .popctl, .popwarn").forEach((el) => el.remove());
  },
};
document.addEventListener("click", (e) => {
  const t = e.target.closest?.("[data-pop], [data-popyes], [data-popno], [data-popx], [data-popgo], [data-popstop]");
  if (!t) return;
  if (t.dataset.pop) { closeWizard?.(); return POP.ask(); }
  if (t.dataset.popyes) return POP.start();
  if (t.dataset.popno) return document.querySelector(".popwarn")?.remove();
  if (t.dataset.popstop) return POP.stop();
  if (t.dataset.popgo) { goPage(t.dataset.popgo); return POP.close(t.closest(".popwin")); }
  if (t.dataset.popx) return POP.close(t.closest(".popwin"));
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && (POP.on || document.querySelector(".popwarn"))) POP.stop(); });
