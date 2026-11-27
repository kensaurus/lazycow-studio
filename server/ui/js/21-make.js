/* ---------- Make reels on a project's first run (26 Nov first-run walk: BL-130, BL-134, BL-136, BL-137, BL-141) ----------
   Starter stories: a new project has no themes, and a first reel needed a headline, lines and four shots written from
   nothing. Make reels offers ready-made stories by kind of business (shared/starter-stories.json, GET /api/themes/stories);
   one press saves one as the project's own theme (POST /api/themes, editable with ✎ like any other) and makes its first
   reel, or ticks it ready to make when there is no footage yet. "Start from a story" opens them again later.
   Ticks kept: the themes ticked on Make reels are saved per project with the level (POST /api/ui {picks}, <data>/ui.json),
   so a reload no longer says "0 of 2 picked" after "It is ticked below".
   Shot words: What to film next in the page's language (needJa from the server, BL-137).
   Keys mk.st.* and mk.est.*. */
const MK = { stories: null, storiesBusy: false, storiesP: null, gallery: false, busy: null, picks: "idle", sent: null, saveTimer: null, footSeen: null };
function mkLoadStories() {
  if (MK.storiesP) return MK.storiesP;
  MK.storiesBusy = true;
  MK.storiesP = api("/api/themes/stories").then((v) => { MK.stories = Array.isArray(v?.stories) ? v.stories : []; }, () => { MK.stories = []; })
    .finally(() => { MK.storiesBusy = false; if (atHome()) renderHome(true); });
  return MK.storiesP;
}
/* For Home's first run (BL-131, feat/bl-home): the stories in the page's language, in gallery order, as
   [{id, title (the kind of place), headline, icon, any}]. Empty until they are read (Home is drawn again then). Home links
   each as <a href="#/reels" data-openmaker="1" data-starter="<id>">: that one press opens Make reels with the story applied.
   any: a story for any kind of place (BL-145). */
function mkStarterStories() {
  mkLoadStories();
  const L = lang === "ja" ? "ja" : "en";
  return (MK.stories || []).map((s) => ({ id: s.id, title: s.kind?.[L] || s.id, headline: mkLine(s.theme?.hook?.[L], L), icon: s.icon || "film", any: !!s.any }));
}
/* A headline on one line: its line breaks are spaces in English and nothing in Japanese. */
function mkLine(text, L) { return String(text || "").replace(/\n/g, L === "ja" ? "" : " "); }
/* A starter pressed outside Make reels (Home): once the stories and themes are read, the same as pressing its card. */
async function mkStarterGo(id) {
  await mkLoadStories();
  for (let i = 0; !themes && i < 50; i++) await new Promise((ok) => setTimeout(ok, 200));
  showMaker = true;
  if (!(MK.stories || []).some((s) => s.id === id)) { MK.gallery = true; return renderHome(true); }  // an unknown id: show them all
  return mkUseStory(id);
}
document.addEventListener("click", (e) => {
  const a = e.target.closest?.("[data-starter]");
  if (a && !a.closest(".mk-stories")) mkStarterGo(a.dataset.starter);
});
/* The gallery: one card per story, the whole card is the button. `first`: the project has no themes yet (the gallery
   stands where the theme pills go, with Write my own beside it). */
function mkStoriesHtml(first) {
  mkLoadStories();
  const L = lang === "ja" ? "ja" : "en";
  const cards = MK.stories === null ? `<span class="skel skel-line" style="width:280px"></span>`
    : MK.stories.map((s) => {
      const t = s.theme || {}, busy = MK.busy === s.id;
      return `<button type="button" class="mk-sc" data-mkstory="${esc(s.id)}" ${MK.busy ? "disabled" : ""} aria-label="${esc(`${tr("mk.st.use")}: ${s.kind?.[L] || s.id} · ${mkLine(t.hook?.[L], L)}`)}">
        <span class="mk-sc-k">${ico(s.icon || "film", "sm")}${esc(s.kind?.[L] || s.id)}</span>
        <b class="mk-sc-h" lang="${L}">${esc(mkLine(t.hook?.[L], L))}</b>
        <span class="mk-sc-a meta">${esc(busy ? tr("mk.st.busy") : s.about?.[L] || "")}</span></button>`;
    }).join("");
  return `<section class="mk-stories${first ? " first" : ""}" aria-label="${esc(tr("mk.st.h"))}">
    <div class="mk-st-head"><b>${first ? esc(tr("th.none")) + " " : ""}${esc(tr("mk.st.h"))}</b><span class="meta">${esc(tr("mk.st.lead"))}</span>
      <span class="grow"></span>${first ? `<button type="button" class="chip" data-theme-new="1">${ico("type", "sm")}${esc(tr("mk.st.own"))}</button>`
        : `<button type="button" class="chip" data-mkstories="0">${ico("x", "sm")}${esc(tr("mk.st.close"))}</button>`}</div>
    <div class="mk-st-grid">${cards}</div></section>`;
}
/* The chip beside New theme: the stories again, once a project has themes. In simple mode it stands where "Ideas for
   new themes" was (Research is a full-mode tool, hidden there: BL-141). */
const mkStoriesChip = () => `<button type="button" class="chip${MK.gallery ? " on" : ""}" data-mkstories="${MK.gallery ? 0 : 1}" aria-expanded="${MK.gallery}">${ico("layers", "sm")}${esc(tr("mk.st.h"))}</button>`;
const mkIdeasChip = () => (ftShown("ideas") ? `<a class="chip" href="#/ideas/ideas">${ico("search", "sm")}${esc(tr("lpa_a.ideas"))}</a>` : "");
/* A story as this project's theme, in the page's language: the headline and lines as the first language (the editor's
   first box) and, on the Japanese page, English as the second; the shots as shown with their English search forms. */
function mkStoryTheme(s) {
  const t = s.theme, ja = lang === "ja", one = (x) => (ja ? x?.ja : x?.en) || "", other = (x) => (ja ? x?.en || "" : "");
  return { title: one(t.title), hook: { ja: one(t.hook), en: other(t.hook) }, lines: (t.lines || []).map((l) => ({ ja: one(l), en: other(l) })),
    shots: ja && t.shotsJa?.length === t.shots.length ? t.shotsJa : t.shots, shotsEn: t.shots, tags: t.tags || [], style: t.style || "column" };
}
async function mkUseStory(id) {
  const s = (MK.stories || []).find((x) => x.id === id);
  if (!s || MK.busy) return;
  MK.busy = id; renderHome(true);
  let key = s.id;
  for (let n = 2; themes && themes[key]; n++) key = `${s.id.slice(0, 20)}-${n}`;
  try {
    await post("/api/themes", { key, theme: mkStoryTheme(s) });
    themes = await api("/api/themes");
    themesChanged();
    if (!autoThemes) autoThemes = new Set();
    autoThemes.add(key);
    MK.gallery = false; showMaker = true;
    const name = themeTitle(key), fit = await mkFitOf(key);
    // One press to the first reel when enough clips fit (BL-145); otherwise it waits, ticked, and says why.
    if (fit >= MK.need && sys.health?.verdict !== "blocked") {
      MK.fail = null; toast(`${ico("check", "sm")} ${esc(tr("mk.st.made", { k: name }))}`, 6000);
      autopilot([key]);
    } else { MK.fail = fit < MK.need ? mkFew(key, fit) : null; toast(`${ico("check", "sm")} ${esc(tr("mk.st.ready", { k: name }))}`, 7000); }
  } catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000); }
  MK.busy = null; renderHome(true);
}
document.addEventListener("click", (e) => {
  const st = e.target.closest?.("[data-mkstory]");
  if (st) { e.stopPropagation(); return mkUseStory(st.dataset.mkstory); }
  const g = e.target.closest?.("[data-mkstories]");
  if (g) { MK.gallery = g.dataset.mkstories === "1"; renderHome(true); }
  if (e.target.closest?.("[data-mkany]")) return mkUseAny();
  if (e.target.closest?.("[data-mkfailx]")) { MK.fail = null; renderHome(true); }
});
/* ---------- BL-145: Make only when a reel can be made ----------
   A reel needs MK.need (4) different clips that fit its theme (py/studio/assemble.py MIN_SHOTS; the server counts them
   by the same picks: GET /api/themes/fit). Make reels' button is greyed with the reason while every ticked theme is short
   (or the library holds fewer clips than a reel needs), instead of failing after the press with a toast that went away.
   A too-few failure stays on the page (MK.fail) with one press to an "Any place" story. A library of 200 clips or more
   is not counted ahead (every theme fits there; a rare failure still stays on the page). */
MK.need = 4; MK.fit = null; MK.fitSig = ""; MK.fail = null;
function mkFitLoad() {
  const lib = overview.library?.ranch ?? 0, keys = Object.keys(themes || {}).sort();
  if (!overviewLoaded || !keys.length || lib < MK.need || lib >= 200) return;
  const sig = JSON.stringify([lib, overview.library?.total, keys, !!autoFaces, overview.reels.length]);
  if (MK.fitSig === sig) return;
  MK.fitSig = sig;
  api(`/api/themes/fit${autoFaces ? "?faces=1" : ""}`).then((r) => { MK.fit = r?.fit || {}; MK.need = r?.need || 4; }, () => { MK.fit = null; })
    .finally(() => { if (atHome() && page === "reels") renderHome(true); });
}
/** Clips that fit one theme now (the library's count when it holds fewer than a reel needs, or the count is unknown). */
async function mkFitOf(key) {
  const lib = overview.library?.ranch ?? 0;
  if (lib < MK.need) return lib;
  try {
    const r = await api(`/api/themes/fit?themes=${encodeURIComponent(key)}${autoFaces ? "&faces=1" : ""}`);
    MK.need = r?.need || MK.need; MK.fit = { ...(MK.fit || {}), ...(r?.fit || {}) };
    return r?.fit?.[key] ?? lib;
  } catch { return lib; }
}
const mkAnyId = () => (MK.stories || []).find((s) => s.any)?.id || null;
/** A theme made from an "Any place" story (its id, or the id with -2, -3 … when saved twice). */
const mkIsAny = (key) => (MK.stories || []).some((s) => s.any && (key === s.id || String(key).startsWith(s.id + "-")));
function mkFew(key, n) {
  const lib = overview.library?.ranch ?? 0, any = mkIsAny(key);  // already an Any place story: only more footage helps
  return { key, any: !any, why: lib < MK.need ? tr(lib ? "fr.lib" : "fr.lib0", { n: lib, need: MK.need }) : tr(any ? "fr.fewadd" : "fr.few", { t: themeTitle(key), n, need: MK.need }) };
}
/** Why Make is greyed for these ticked themes, or null: fewer clips in the library than a reel needs, or every ticked
    theme counted short. A theme not counted yet never blocks. */
function mkMakeBlock(keys) {
  if (!overviewLoaded || !keys.length) return null;
  const lib = overview.library?.ranch ?? 0;
  if (lib < MK.need) return mkFew(keys[0], lib);
  const short = keys.filter((k) => MK.fit?.[k] != null && MK.fit[k] < MK.need);
  if (!short.length || short.length < keys.length) return null;
  return short.length === 1 ? mkFew(short[0], MK.fit[short[0]]) : { key: short[0], any: !short.every(mkIsAny), why: tr("fr.fewn", { m: short.length, need: MK.need }) };
}
/** The reason under Make: a failure kept from the last press first, else why the button is greyed. */
function mkWhyHtml(block) {
  const w = MK.fail || block;
  if (!w) return "";
  if (w.any && !MK.stories) mkLoadStories();  // the stories are read with the gallery only; the page is drawn again once in
  return `<p class="mk-why warnline" id="mkWhy" ${MK.fail ? 'role="alert"' : ""}>${ico("alert", "sm")}<span>${esc(w.why)}</span>
    ${w.any && mkAnyId() ? `<button type="button" class="chip" data-mkany="1">${ico("pin", "sm")}${esc(tr("fr.useany"))}</button>` : ""}
    <button type="button" class="chip" data-goto="footage">${ico("plus", "sm")}${esc(tr("make.addfootage"))}</button>
    ${MK.fail ? `<button type="button" class="icon" data-mkfailx="1" title="${esc(tr("wn.hide"))}" aria-label="${esc(tr("wn.hide"))}">${ico("x", "sm")}</button>` : ""}</p>`;
}
/* The fallback: an "Any place" story instead of the ticked ones (its theme ticked alone; made when it fits). */
async function mkUseAny() {
  const id = mkAnyId();
  if (!id || MK.busy) return;
  MK.fail = null; autoThemes = new Set();
  const have = Object.keys(themes || {}).find((k) => k === id || k.startsWith(id + "-"));
  if (!have) return mkUseStory(id);
  autoThemes.add(have); renderHome(true);
  const fit = await mkFitOf(have);
  if (fit < MK.need) MK.fail = mkFew(have, fit); else if (sys.health?.verdict !== "blocked") autopilot([have]);
  renderHome(true);
}
/* Ticks kept per project (BL-136). Read once (GET /api/ui picks); until then nothing is saved, so an empty first paint
   never overwrites the saved ticks. A tick made before they arrive wins over them. */
function mkPicksLoad() {
  if (MK.picks !== "idle") return;
  MK.picks = "loading";
  api("/api/ui").then((v) => {
    const saved = Array.isArray(v?.picks) ? v.picks : [];
    if (themes && (!autoThemes || !autoThemes.size)) autoThemes = new Set(saved.filter((k) => themes[k]));
    MK.sent = JSON.stringify([...(autoThemes || [])].sort());
  }, () => { MK.sent = null; }).finally(() => { MK.picks = "ready"; if (atHome() && page === "reels") renderHome(true); });
}
function mkPicksSync() {
  if (!themes) return;
  if (MK.picks === "idle") return mkPicksLoad();
  if (MK.picks !== "ready" || !autoThemes) return;
  const now = JSON.stringify([...autoThemes].filter((k) => themes[k]).sort());
  if (now === MK.sent) return;
  MK.sent = now;
  clearTimeout(MK.saveTimer);
  MK.saveTimer = setTimeout(() => post("/api/ui", { picks: JSON.parse(now) }).catch(() => { MK.sent = null; }), 400);
}
/* The footage numbers are read again when a reel is made (BL-134: the estimate stayed put while reels were made). */
function mkFootWatch() {
  const made = overview.reels.filter((r) => !r.house).length;
  if (MK.footSeen !== null && made !== MK.footSeen && foot.h && !foot.h.loading) foot.h = null;
  MK.footSeen = made;
}
/* What to film for a theme, in the page's language: the Japanese words when the server has them (BL-137). */
const mkNeed = (t) => (lang === "ja" && t?.needJa) || t?.need || "";
