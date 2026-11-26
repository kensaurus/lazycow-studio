/* ---------- Keys & AI: paste a key once; the studio checks it, keeps it on this computer, never shows it again. ---------- */
let aiView = null; const keyMsg = {};
const KEY_FIELDS = [["firecrawl_key", "search", "key.firecrawl", "key.firecrawlhint", "https://www.firecrawl.dev/app/api-keys"],
  ["fal_key", "film", "key.fal", "key.falhint", "https://fal.ai/dashboard/keys"],
  ["openrouter_key", "type", "key.openrouter", "key.openrouterhint", "https://openrouter.ai/settings/keys"],
  ["together_key", "layers", "key.together", "key.togetherhint", "https://api.together.ai/settings/api-keys"]];
async function loadKeys() {
  // Each part draws as soon as it answers: AI limits come back in a few hundred ms, research's status starts a Python
  // process (about a second); waiting for both kept the whole page on "Loading" (13 Nov).
  const draw = () => { if (page === "keys") renderHome(true); };
  const a = api("/api/ai").catch(() => null).then((v) => { aiView = v || { unavailable: true }; draw(); });
  const r = api("/api/research").catch(() => null).then((v) => { researchView = v; draw(); });
  await Promise.all([a, r]);
  loadCredits(false);
}
let aiCredits = null, creditsBusy = false;
/* When the balances were last read (ms), or 0 when no provider reported one (no keys yet: nothing to check). */
const creditsAt = () => Math.max(0, ...Object.values(aiCredits?.providers || {}).map((x) => (x.checked || 0) * 1000));
async function loadCredits(fresh) {
  creditsBusy = true; if (page === "keys" && aiView) renderHome(true);
  try { aiCredits = await api("/api/ai/credits" + (fresh ? "?fresh=1" : "")); } catch (e) { aiCredits = { error: e.message }; }
  creditsBusy = false; if (page === "keys") renderHome(true);
}
/* Under each key: what the studio spent with it and what the provider says is left (or why it cannot say). */
/* A saved key the provider refused at the last balance check (py/studio/ai.py credits: rejected). */
const keyRejected = (k) => !!aiCredits?.providers?.[k.replace(/_key$/, "")]?.rejected;
function creditLine(k) {
  const pv = k.replace(/_key$/, ""), c = aiCredits?.providers?.[pv];
  if (!c || !c.key) return "";
  const unit = c.unit === "credits" ? (n) => Number(n).toLocaleString() + " " + tr("key.credits") : (n) => usd(n);
  const left = c.left != null ? `<b>${tr("key.left", { n: unit(c.left) })}</b>${c.limit ? ` <span class="meta">${tr("key.of", { n: unit(c.limit) })}</span>` : ""}` : "";
  const f = c.left != null && c.limit ? Math.max(0, Math.min(1, c.left / c.limit)) : null;
  const sp = c.spent || {};
  return `<div class="kl-use">
    ${f != null ? `<div class="bar ${f < 0.1 ? "low" : ""}" role="meter" aria-valuemin="0" aria-valuemax="${c.limit}" aria-valuenow="${c.left}" aria-label="${esc(tr("key.leftlabel"))}"><i style="transform:scaleX(${f.toFixed(3)})"></i></div>` : ""}
    <span>${left}${left ? " · " : ""}${c.unit === "credits" ? (c.renews ? tr("key.renews", { d: new Date(c.renews).toLocaleDateString(lang === "ja" ? "ja-JP" : "en-GB", { day: "numeric", month: "short" }) }) : "") : tr("key.studiospent", { n: usd(sp.total || 0), t: usd(sp.today || 0), c: sp.calls || 0 })}</span>
    ${c.error || c.note ? `<span class="meta">${esc(c.error || c.note)}</span>` : ""}
    <a class="meta" href="${escUrl(c.dashboard)}" target="_blank" rel="noopener">${tr("key.billing")} ↗</a>${aipMarkBits(pv, c.left == null)}</div>`;
}
/* aip: a key that cannot read its balance (fal without billing access) never tells the studio it is empty, so the
   owner can say so; once marked (or after a failed paid call) it reads "out of credit" with Try again. */
function aipMarkBits(pid, unknown) {
  if (pid === "firecrawl") return "";
  const st = fbView?.providers?.find?.((p) => p.id === pid)?.state;
  if (st && st !== "ok") return `<span class="wtag bad">${esc(tr("fb_a.h." + st))}</span><button type="button" class="aip-link" data-fbtry="${esc(pid)}">${esc(tr("fb_a.try"))}</button>`;
  return unknown ? `<button type="button" class="aip-link" data-aipout="${esc(pid)}">${esc(tr("aip_s.markout"))}</button>` : "";
}
function keySet(k) {
  if (k === "firecrawl_key") return researchView == null ? true : researchView.ready;  // still loading: no "add your key" flash
  const keys = aiView?.keys || {};
  return { fal_key: keys.fal, openrouter_key: keys.openrouter, together_key: keys.together }[k] ?? aipHasKey(k.replace(/_key$/, ""));
}
/* aip (21 Nov): every other service a job uses (Stability AI after Music is switched to it) or whose key is saved gets
   its own row here, with its key page, so "add your key" never ends on a page without the field. Saved through
   POST /api/settings {keys: {provider: key}} (checked by the provider's free call first). */
let aipProv = null;
const AIP_CORE = new Set(["fal", "openrouter", "together", "own"]);
/* Services the owner chose under "Add a key for another service" (26 Nov): a key can go in before any job uses the
   service, e.g. kie.ai as a backup. The row stays for this visit; once saved it stays because the key is there. */
const aipAdd = new Set();
const aipHasKey = (pid) => fbView?.providers?.find?.((p) => p.id === pid)?.hasKey ?? aiCredits?.providers?.[pid]?.key;
const aipKeyUrl = (p) => { const m = /^[a-z0-9.-]+\.[a-z]{2,}(\/[^\s(]*)?/i.exec(p?.keyHint || ""); return m ? "https://" + m[0] : p?.dashboard || ""; };
function aipExtra() {
  if (aipProv === null) { aipProv = undefined; api("/api/ai/providers").then((v) => { aipProv = v?.providers || []; }).catch(() => { aipProv = []; }).finally(() => { if (page === "keys" && atHome()) renderHome(true); }); }
  if (!wfView) loadWf();
  if (!fbView) loadFb();
  const used = {};
  for (const cap of WF_CAPS) { const c = wfView?.capabilities?.[cap]; if (c?.on && c.provider && !AIP_CORE.has(c.provider)) (used[c.provider] ||= []).push(capName(cap)); }
  return (aipProv || []).filter((p) => !AIP_CORE.has(p.id) && p.keyEnv && (used[p.id] || aipHasKey(p.id) || aipAdd.has(p.id)))
    .map((p) => [p.id + "_key", "layers", esc(p.name), used[p.id] ? tr("aip_s.uses", { c: used[p.id].join(lang === "ja" ? "、" : ", ") }) : tr(aipHasKey(p.id) ? "aip_s.idle" : "aip_s.addhint"), aipKeyUrl(p)]);
}
/* One line under the keys: every other service in the registry that takes a key, as a short list to pick from. */
function aipMore(shown) {
  const have = new Set(shown.map(([k]) => k.replace(/_key$/, "")));
  const more = (aipProv || []).filter((p) => !AIP_CORE.has(p.id) && p.keyEnv && !have.has(p.id));
  if (!more.length) return "";
  return `<p class="kl-more"><label><span class="meta">${esc(tr("aip_s.addother"))}</span>
    <select data-aipadd="1"><option value="">${esc(tr("aip_s.pickone"))}</option>${more.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")}</select></label></p>`;
}
document.addEventListener("change", (e) => {
  const s = e.target.closest?.("[data-aipadd]"); if (!s || !s.value) return;
  const k = s.value + "_key";
  aipAdd.add(s.value); keyOpen[k] = true; renderHome(true);
  setTimeout(() => document.querySelector(`[data-keyform="${CSS.escape(k)}"] input`)?.focus(), 50);
});
function renderKeys() {
  if (aiView === null) { aiView = undefined; loadKeys(); }
  if (aiView === undefined) { $("#home").innerHTML = `<div class="pagehead">${crumbs([tr("nav.settings")])}</div>${loadingHtml(tr("nav.keys"))}`; return; }
  freshYt();
  const caps = aiView?.caps || {}, spent = aiView?.spent || {};
  const row = ([k, icon, title, hint, link]) => {
    const on = keySet(k), open = keyOpen[k] || !on || (keyMsg[k] && !keyMsg[k].ok);
    return `<li class="kl ${on ? "on" : "off"}">
      ${kTile({ icon, hue: on ? 140 : 25 })}
      <div class="kl-main"><b>${tr(title)}</b><span class="meta">${trA(hint)}</span>${k === "openrouter_key" && aiView?.reviewBasis === "frames" ? `<span class="meta aiframes">${ico("image", "sm")} ${esc(tr("ai.frames", { n: "12–16" }))}</span>` : ""}${on ? creditLine(k) : ""}</div>
      <span class="kl-state">${on && keyRejected(k) ? `${ico("alert", "sm")}${tr("key.rejected")}` : on ? `${ico("check", "sm")}${tr("key.saved")}` : `${ico("alert", "sm")}${tr("key.missing")}`}</span>
      ${on ? `<button type="button" class="kl-toggle" data-keyedit="${k}" aria-expanded="${open ? "true" : "false"}">${tr(open ? "key.close" : "key.change")}</button>` : "<span></span>"}
      ${open ? `<form class="kl-form" data-keyform="${k}">
        <label><span class="meta">${tr(on ? "key.replace" : "key.paste")}</span><input name="v" type="password" autocomplete="off" spellcheck="false" placeholder="${esc(tr("key.ph"))}"></label>
        <button class="primary" type="submit">${ico("check", "sm")}${tr("key.save")}</button>
        <a class="btn" href="${escUrl(link)}" target="_blank" rel="noopener">${tr("key.get")} ↗</a>
        ${on ? `<button type="button" class="linkish" data-keyoff="${k}">${tr("key.remove")}</button>` : ""}
        ${keyMsg[k] ? `<p class="${keyMsg[k].ok ? "okline" : "bad"}">${ico(keyMsg[k].ok ? "check" : "alert", "sm")} ${esc(keyMsg[k].text)}</p>` : ""}</form>` : ""}</li>`;
  };
  const meter = (used, cap, label) => { const f = cap > 0 ? Math.min(1, used / cap) : 1;
    return `<div class="meter ${f >= 1 ? "full" : f >= 0.8 ? "near" : ""}"><div class="meter-top"><b>${usd(used)}</b><span class="meta">${tr("key.of", { n: usd(cap) })} · ${label}</span></div>
      <div class="bar" role="meter" aria-valuemin="0" aria-valuemax="${cap}" aria-valuenow="${used}" aria-label="${esc(label)}"><i style="transform:scaleX(${f.toFixed(3)})"></i></div></div>`; };
  const allKeys = [...KEY_FIELDS, ...aipExtra()];
  const ready = allKeys.filter(([k]) => keySet(k)).length, refused = allKeys.filter(([k]) => keySet(k) && keyRejected(k)).length;
  const keysBody = () => `<section class="sheet"><h2>${ico("shield", "sm")} ${tr("key.h")}<span class="count">${ready}/${allKeys.length}</span></h2>
      <p class="credhead"><span class="meta">${creditsAt() ? tr("key.checked", { t: ago(new Date(creditsAt()).toISOString()) }) : aiCredits?.providers ? "" : aiCredits?.error ? esc(aiCredits.error) : tr("key.checking")}</span>
        <button data-credits="1" ${creditsBusy ? "disabled" : ""}>${tr(creditsBusy ? "key.checking" : "key.recheck")}</button></p>
      <ul class="kled">${allKeys.map(row).join("")}</ul>${aipMore(allKeys)}</section>`;
  const capsBody = () => aiView && !aiView.unavailable ? `<section class="sheet spend" data-anchor="caps"><h2>${ico("shield", "sm")} ${tr("key.caps")}</h2><p class="meta">${tr("key.capshint")} <a href="#/log/overview">${tr("key.seespend")} ›</a></p>
      <div class="meters">${meter(spent.today ?? 0, caps.daily ?? 0, tr("key.today"))}${meter(spent.total ?? 0, caps.total ?? 20, tr("key.alltime"))}</div>
      <form class="capgrid" data-capform="1">
        <label><span class="meta">${tr("key.perreel")}</span><input name="ai_reel_cap_usd" type="number" min="0" max="100" required step="0.5" inputmode="decimal" value="${esc(caps.reel ?? 2)}"></label>
        <label><span class="meta">${tr("key.daily")}</span><input name="daily_usd_budget" type="number" min="0" max="500" required step="1" inputmode="decimal" value="${esc(caps.daily ?? 2)}"></label>
        <label><span class="meta">${tr("key.total")}</span><input name="ai_total_cap_usd" type="number" min="0" max="1000" required step="1" inputmode="decimal" value="${esc(caps.total ?? 20)}"></label>
        <button class="primary" type="submit">${ico("check", "sm")}${tr("key.savecaps")}</button></form></section>`
    : `<section class="sheet"><h2>${ico("shield", "sm")} ${tr("key.caps")}</h2><p class="meta">${esc(tr("ly_ks.capsoff"))}</p></section>`;
  const fallbackBody = () => `<section class="sheet fbsheet">${fbCard()}</section>`;
  const chromeBody = () => chromeLinkCard() || (helperView ? `<section class="sheet chromelink"><h2>${ico("link", "sm")} ${tr("cl.title")}</h2><p class="meta">${esc(tr("ly_ks.chromeoff"))}</p><p><a class="btn" href="#/accounts">${ico("user", "sm")}${esc(tr("nav.accounts"))} ›</a></p></section>` : "");
  const bodies = { general: () => everydayCard({ ready, keyCount: allKeys.length, spent, caps }), keys: keysBody, blocks: aiBlocksCard, llm: ownLlmCard, fallback: fallbackBody, caps: capsBody, studio: motionCard, brand: brandCard, chrome: chromeBody, google: ytGoogleCard, connect: connectCard, about: aboutUsageCard };
  const cur = KEYS_SECS.some((s) => s[0] === keysSec) ? keysSec : "general";
  // Every section's status shows in the side list, so each part's data is asked for now (its card asks when it is empty).
  for (const [id] of KEYS_SECS) if (id !== cur && ["blocks", "llm", "brand", "chrome", "fallback"].includes(id)) bodies[id]();
  const st = { ready, refused, spent, caps, keyCount: allKeys.length };
  const typing = document.activeElement?.matches?.("[data-kssearch]") ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
  $("#home").innerHTML = `<div class="pagehead">${crumbs([tr("nav.settings")])}</div>
    ${cur === "keys" ? `<p class="intro">${tr("key.intro")}</p>` : ""}
    <div class="kset">${keysNav(cur, st)}
      <div class="ks-body" role="region" aria-label="${esc(tr(KEYS_SECS.find((s) => s[0] === cur)[2]))}">${bodies[cur]() || `<div class="sheet"><div class="skel skel-line"></div><div class="skel skel-line"></div><div class="skel skel-line" style="width:60%"></div></div>`}</div></div>`;
  ksFilter();
  if (typing) { const s = document.querySelector("[data-kssearch]"); s?.focus(); try { s?.setSelectionRange(typing[0], typing[1]); } catch { /* type=search */ } }
}
/* ---------- layout pass (18 Nov): Settings › Keys & AI as a settings page — a side list of its sections, each with a
   one-line status, and one section open at a time at its own address (#/keys/<section>). The owner: "stop making long
   page like settings key and ai". Old addresses land on their section: #/keys/motion and #/keys/theme open This studio
   and mark that switch, #/keys/caps opens Spending limits, #/keys/google YouTube, #/keys/llm Your own AI model. ---------- */
/* BL-119 (24 Nov): the everyday settings first (Everyday: tools shown, language, time zone, footage, posting by itself,
   starting with the computer, the AI key and its spending limit), the rest under one Advanced fold: never more than two
   levels. #/keys opens Everyday; each section keeps its own address. */
let keysSec = "general", keysQ = "";
// [id, icon, title, group]
const KEYS_SECS = [["general", "home", "uix.everyday", "everyday"], ["keys", "shield", "ly_ks.t.keys", "everyday"], ["caps", "wave", "ly_ks.t.caps", "everyday"],
  ["blocks", "layers", "ly_ks.t.blocks", "advanced"], ["llm", "type", "ly_ks.t.llm", "advanced"], ["fallback", "refresh", "ly_ks.t.fallback", "advanced"],
  ["studio", "sun", "ly_ks.t.studio", "advanced"], ["brand", "user", "ly_ks.t.brand", "advanced"], ["chrome", "link", "ly_ks.t.chrome", "advanced"],
  ["google", "play", "ly_ks.t.google", "advanced"], ["connect", "chat", "ly_ks.t.connect", "advanced"], ["about", "info", "uix.about", "advanced"]];
const KEYS_ALIAS = { motion: "studio", theme: "studio", colours: "studio", colors: "studio", spend: "caps", limits: "caps", youtube: "google", project: "brand", claude: "connect", mcp: "connect", ai: "keys", everyday: "general", usage: "about", level: "general", tz: "general", language: "general" };
const keysSecOf = (x) => (KEYS_SECS.some((s) => s[0] === x) ? x : KEYS_ALIAS[x] || "general");
function ksStatus(id, x) {
  const L = (k, v) => tr(k, v);
  if (id === "keys") return x.refused ? [L("ly_ks.st.refused", { n: x.refused }), "warn"] : [L("ly_ks.st.keys", { n: x.ready, m: x.keyCount || KEY_FIELDS.length }), x.ready ? (x.ready < (x.keyCount || 0) ? "warn" : "ok") : "warn"];
  if (id === "blocks") return wfView?.capabilities ? [L("ly_ks.st.on", { n: WF_CAPS.filter((c) => wfView.capabilities[c]?.on).length, m: WF_CAPS.length }), ""] : ["…", ""];
  if (id === "llm") { const c = aiView?.ownLlm || llmPresets?.ownLlm; return c ? [L("ly_ks.st.llmon", { m: c.model }), "ok"] : [L("ly_ks.st.notset"), ""]; }
  if (id === "fallback") {
    if (!fbView) return ["…", ""]; if (fbView.error) return [L("ly_ks.st.err"), "warn"];
    const down = (fbView.providers || []).filter((p) => p.state !== "ok").length;
    return fbView.settings?.on === false ? [L("ly_ks.st.off"), ""] : down ? [L("ly_ks.st.down", { n: down }), "warn"] : [L("ly_ks.st.allok"), "ok"];
  }
  if (id === "caps") return aiView && !aiView.unavailable ? [L("ly_ks.st.caps", { u: usd(x.spent.total ?? 0), c: usd(x.caps.total ?? 20) }), (x.spent.total ?? 0) >= (x.caps.total ?? 20) * 0.8 ? "warn" : ""] : ["—", ""];
  if (id === "studio") return [L("ly_ks.st.studio", { t: tr("d_th." + themePref()), m: tr("mo." + moPref()) }), ""];
  if (id === "brand") return [brandView ? brandView.name || "—" : "…", ""];
  if (id === "chrome") { if (!helperView) return ["…", ""]; const b = helperView.browser || {}; return b.mode !== "extension" ? [L("ly_ks.st.notused"), ""] : b.connected ? [L("ly_ks.st.linked"), "ok"] : [L("ly_ks.st.notlinked"), "warn"]; }
  if (id === "google") return yt.connected ? [yt.channel?.title || L("ly_ks.st.linked"), "ok"] : [L(yt.appInfo?.set ? "ly_ks.st.notlinked" : "ly_ks.st.noapp"), "warn"];
  if (id === "connect") return [L("ly_ks.st.connect"), ""];
  if (id === "general") return [`${tr(uiLevel === "full" ? "uix.st.full" : "uix.st.simple")} · ${lang === "ja" ? "日本語" : "English"}${AUD_TZ ? " · " + AUD_TZ.split("/").pop().replace(/_/g, " ") : ""}`, ""];
  if (id === "about") return [about?.version ? `v${about.version}` : "", ""];
  return ["", ""];
}
/* Settings › Everyday: one row per everyday setting, each with its value and the one control or link that changes it.
   Every control is the one the studio already has (the level switch, the language button, the time zone the setup
   wizard saves, the posting-by-itself box, the start-with-the-computer switch), so nothing is set in two ways. */
function everydayCard(x) {
  if (autoView === null && !autoLoading) loadAuto();
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone, tzNow = AUD_TZ || "";
  const tzOpts = [...new Set([tzNow, here, ...TZ_CHOICES.map(([z]) => z)].filter(Boolean))].map((z) => `<option value="${esc(z)}" ${z === (tzNow || here) ? "selected" : ""}>${esc((TZ_CHOICES.find(([c]) => c === z)?.[1] || z.replace(/_/g, " ")) + (z === here ? ` · ${tr("uix.tzhere")}` : ""))}</option>`).join("");
  const plan = autoView?.settings?.plan, st = autoView?.startup, lib = overview.library || {};
  const row = (icon, label, value, ctl = "") => `<li class="ev-row">${ico(icon, "sm")}<b>${esc(label)}</b><span class="ev-val">${value}</span><span class="ev-ctl">${ctl}</span></li>`;
  return `<section class="sheet everyday" data-anchor="general"><h2>${ico("home", "sm")} ${esc(tr("uix.everyday"))}</h2>
    <ul class="ev-list">
      ${row("grid", tr("uix.level"), esc(tr(uiLevel === "full" ? "uix.fullnote" : "uix.simplenote")), `<label class="switch"><input type="checkbox" data-uilevel="1" ${uiLevel === "full" ? "checked" : ""}><span>${esc(tr("uix.showall"))}</span></label>`)}
      ${row("globe", tr("uix.lang"), lang === "ja" ? "日本語" : "English", `<button type="button" data-uilang="${lang === "ja" ? "en" : "ja"}">${lang === "ja" ? "English" : "日本語"}</button>`)}
      ${row("clock", tr("uix.tz"), esc(tzNow || tr("uix.tznone")), `<select data-uitz="1" aria-label="${esc(tr("uix.tz"))}">${tzOpts}</select><button type="button" data-uitzsave="1">${esc(tr("uix.tzsave"))}</button>`)}
      ${row("layers", tr("uix.footage"), esc(tr("uix.footn", { n: Number(lib.total || lib.ranch || 0).toLocaleString(lang === "ja" ? "ja-JP" : "en-GB") })), `<a class="btn" href="#/footage/sources">${esc(tr("uix.footadd"))} ›</a>`)}
      ${row("cal", tr("uix.post"), esc(!plan ? "…" : plan.on ? tr("uix.posthour", { h: `${String(plan.hour ?? 9).padStart(2, "0")}:00` }) : tr("uix.postoff")), `<a class="btn" href="#/posting" data-wnjump="auto">${esc(tr("uix.change"))} ›</a>`)}
      ${row("refresh", tr("uix.startup"), "", st?.other ? `<span class="meta">${esc(tr("ab.startupother"))}</span>` : st?.supported ? `<label class="switch"><input type="checkbox" data-startup ${st.on ? "checked" : ""}><span>${esc(tr(st.on ? "uix.on" : "uix.off"))}</span></label>` : `<span class="meta">${esc(st?.why || "…")}</span>`)}
      ${row("shield", tr("uix.ai"), esc(tr("uix.aiset", { n: x.ready, m: x.keyCount })), `<a class="btn" href="#/keys/keys">${esc(tr("uix.change"))} ›</a>`)}
      ${row("wave", tr("uix.cap"), aiView && !aiView.unavailable ? esc(tr("uix.capv", { u: usd(x.spent.total ?? 0), c: usd(x.caps.total ?? 20) })) : "—", `<a class="btn" href="#/keys/caps">${esc(tr("uix.change"))} ›</a>`)}
      ${row("user", tr("nav.accounts"), esc(tr("uix.netsn", { n: (channelsSpec?.channels || []).filter((c) => !c.off).length })), `<a class="btn" href="#/accounts">${esc(tr("uix.change"))} ›</a>`)}
    </ul></section>`;
}
document.addEventListener("click", async (e) => {
  const lg = e.target.closest?.("[data-uilang]"); if (lg) { setLang(lg.dataset.uilang); return; }
  if (!e.target.closest?.("[data-uitzsave]")) return;
  const z = document.querySelector("[data-uitz]")?.value || "";
  try {
    const j = await post("/api/settings", { tz: z });
    toast(`${ico("check", "sm")} ${j?.note ? esc(j.note) : esc(tr("wz.tzsaved"))}`, 6000);
    if (j?.restarting) setTimeout(() => location.reload(), 4000);
  } catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000); }
});
/* Settings › About & usage: the version, the private usage counts as a small table (BL-120), and the full About. */
function aboutUsageCard() {
  const rows = Object.entries(uiUsage).filter(([, c]) => c?.n).sort((a, b) => b[1].n - a[1].n);
  const name = (id) => { const [f, act] = id.split(":"); return act ? tr(`uix.act.${act}`) : ftName(f); };
  return `<section class="sheet" data-anchor="about"><h2>${ico("info", "sm")} ${esc(tr("uix.about"))}</h2>
    <p class="meta">${esc(about?.version ? `Lazycow Studio v${about.version}${about.build ? ` · build ${about.build}` : ""}` : "Lazycow Studio")} · <button type="button" class="linkbtn" data-about="1">${esc(tr("uix.credits"))}</button></p>
    <h3 class="ev-h">${esc(tr("uix.usageh"))}</h3><p class="meta">${esc(tr("mt.private"))}</p>
    ${rows.length ? `<table class="uix-usage"><thead><tr><th>${esc(tr("uix.col.tool"))}</th><th class="num">${esc(tr("uix.col.n"))}</th><th>${esc(tr("uix.col.last"))}</th></tr></thead>
      <tbody>${rows.slice(0, 12).map(([id, c]) => `<tr><td>${esc(name(id))}</td><td class="num">${c.n}</td><td>${esc(uiAgo(c.last))}</td></tr>`).join("")}</tbody></table>` : `<p class="meta">${esc(tr("uix.usagenone"))}</p>`}</section>`;
}
function keysNav(cur, x) {
  const kw = (id, title) => [I18N.en[title], I18N.ja[title], I18N.en["ly_ks.kw." + id], I18N.ja["ly_ks.kw." + id]].filter(Boolean).join(" ").toLowerCase();
  const item = ([id, icon, title, g]) => {
    const [s, tone] = ksStatus(id, x);
    return `<a href="#/keys/${id}" class="${id === cur ? "on" : ""}" ${id === cur ? 'aria-current="page"' : ""} data-kssec="${id}" data-ksgrp="${g}" data-kw="${esc(kw(id, title) + " " + s.toLowerCase())}">
      ${ico(icon, "sm")}<b>${esc(tr(title))}</b><span class="ks-st ${tone}">${tone === "warn" ? ico("alert", "sm") : ""}${esc(s)}</span></a>`;
  };
  // Everyday first; the rest in one fold, open when one of its sections is open or a search is typed.
  const adv = KEYS_SECS.filter((s) => s[3] === "advanced"), advOn = adv.some((s) => s[0] === cur) || !!keysQ.trim();
  return `<nav class="ks-nav" aria-label="${esc(tr("ly_ks.nav"))}">
    <label class="ks-search">${ico("search", "sm")}<input type="search" data-kssearch="1" placeholder="${esc(tr("ly_ks.search"))}" aria-label="${esc(tr("ly_ks.search"))}" value="${esc(keysQ)}" autocomplete="off" spellcheck="false"></label>
    <span class="ks-g" data-ksg="everyday">${esc(tr("uix.g.everyday"))}</span>${KEYS_SECS.filter((s) => s[3] === "everyday").map(item).join("")}
    <details class="ks-adv" data-ksadv="1" ${advOn ? "open" : ""}><summary class="ks-g" data-ksg="advanced">${esc(tr("uix.g.advanced"))} <span class="count">${adv.length}</span></summary>${adv.map(item).join("")}</details>
    <p class="meta ks-none" hidden>${esc(tr("ly_ks.none"))}</p></nav>`;
}
function ksFilter() {
  const q = keysQ.trim().toLowerCase(), nav = document.querySelector(".ks-nav"); if (!nav) return;
  let any = 0;
  for (const a of nav.querySelectorAll("[data-kssec]")) { const hit = !q || q.split(/\s+/).every((w) => a.dataset.kw.includes(w)); a.hidden = !hit; if (hit) any++; }
  for (const g of nav.querySelectorAll("[data-ksg]")) g.hidden = ![...nav.querySelectorAll(`[data-ksgrp="${g.dataset.ksg}"]`)].some((a) => !a.hidden);
  const adv = nav.querySelector("[data-ksadv]");
  if (adv) { adv.hidden = ![...adv.querySelectorAll("[data-kssec]")].some((a) => !a.hidden); if (q) adv.open = true; }  // a search opens the fold
  nav.querySelector(".ks-none").hidden = !!any;
}
document.addEventListener("input", (e) => { const s = e.target.closest?.("[data-kssearch]"); if (!s) return; keysQ = s.value; ksFilter(); });
document.addEventListener("keydown", (e) => {
  const s = e.target.closest?.("[data-kssearch]"); if (!s || e.key !== "Enter") return;
  const a = [...document.querySelectorAll(".ks-nav [data-kssec]")].find((x) => !x.hidden); if (a) { e.preventDefault(); location.hash = a.getAttribute("href"); }
});
/* The tab or section a page's address names, read before the page draws. */
function lyRoute() {
  const h = location.hash;
  const top = () => { const home = $("#home"); if (home) home.scrollTop = 0; };
  if (page === "keys") { const m = /^#\/keys\/(\w+)/.exec(h), want = m ? keysSecOf(m[1]) : "general"; if (want !== keysSec) { keysSec = want; top(); } }
  if (page === "words") { const m = /^#\/words\/(\w+)/.exec(h), want = m && W_TABS.includes(m[1]) ? m[1] : "headlines"; if (want !== wTab) { wTab = want; top(); } }
  if (page === "footage") {
    const m = /^#\/footage\/(\w+)/.exec(h);
    if (m && FOOT_TABS[m[1]]) { if (foot.drawer !== FOOT_TABS[m[1]]) { foot.drawer = FOOT_TABS[m[1]]; top(); } }
    else if (lyRoute.prev !== "footage") foot.drawer = "auto";  // a fresh visit opens what needs attention
  }
  if (page === "results") {  // Track B: #/results/next, /where, /posts, /youtube (learn and schedule: the old names)
    const m = /^#\/results\/(\w+)/.exec(h), k = m ? ({ learn: "next", schedule: "where" }[m[1]] || m[1]) : "overview";
    const want = RES_TABS[k] ? k : "overview";
    if (want !== resTab) { resTab = want; top(); }
  }
  lyRoute.prev = page;
}
/* What the layout pass adds to the page's redraw check: a new section, tab, sort, page or pick redraws the page. */
function lySig() {
  return page === "keys" ? [keysSec] : page === "words" ? [wTab, wSel, wSort, wPage, lPage, lKind, lQ, postsLoaded, cWear.perf?.length ?? -1]
    : page === "review" ? [revFocus, !!scoreMap] : page === "reels" ? [rTheme, rNet] : page === "results" ? [resTab] : page === "footage" ? [footTabNow(), !!foot.h && !foot.h.loading] : 0;
}
/* Chrome link: with the key from the extension's Welcome page saved, the studio links to your Chrome by itself
   (at start and whenever the link drops), so TikTok, X, LinkedIn, Google Maps, LINE and Pinterest stay Ready. */
function chromeLinkCard() {
  if (!helperView) { api("/api/helper").then((h) => { helperView = h; if (page === "keys") renderHome(true); }).catch(() => {}); return ""; }
  const b = helperView.browser || {};
  if (b.mode !== "extension") return "";
  const state = b.connected ? `<span class="kl-state ok">${ico("check", "sm")}${tr("cl.on")}</span>` : b.pending ? `<span class="kl-state">${tr("cl.wait")}</span>` : `<span class="kl-state todo">${ico("alert", "sm")}${tr("cl.off")}</span>`;
  return `<section class="sheet chromelink"><h2>${ico("link", "sm")} ${tr("cl.title")}</h2>
    <p class="cl-line">${state} ${b.autoConnect ? `<span class="meta">${tr("cl.auto")}</span>` : `<span class="meta">${tr("cl.manual")}</span>`}</p>
    ${b.autoConnect ? "" : `<div class="row cl-quick"><button type="button" class="primary big" data-clclip="1">${ico("check", "sm")}${tr("cl.clip")}</button><span class="meta">${tr("cl.cliphint")}</span></div>`}
    <form class="kl-form" data-clform="1"><label><span class="meta">${tr(b.autoConnect ? "cl.replace" : "cl.paste")}</span><input name="token" type="password" autocomplete="off" spellcheck="false" placeholder="${esc(tr("cl.ph"))}"></label>
      <button class="primary" type="submit">${ico("check", "sm")}${tr("key.save")}</button>
      ${b.connected ? "" : `<button type="button" data-chromeconnect="1">${ico("link", "sm")}${tr("acc.chrome.go")}</button>`}
      ${b.autoConnect ? `<button type="button" class="linkish" data-cloff="1">${tr("key.remove")}</button>` : ""}</form>
    ${b.error && !b.connected ? `<p class="meta bad">${ico("alert", "sm")} ${esc(b.error)}</p>` : ""}
  </section>`;
}
document.addEventListener("submit", async (e) => {
  const f = e.target.closest("[data-clform]"); if (!f) return;
  e.preventDefault();
  const token = String(new FormData(f).get("token") || "").trim(); if (!token) return;
  try { const r = await post("/api/helper/token", { token }); helperView = { ...(helperView || {}), browser: r.browser }; toast(`${ico("check", "sm")} ${tr("cl.saved")}`, 8000); }
  catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 9000); }
  setTimeout(async () => { helperView = await api("/api/helper").catch(() => helperView); renderHome(true); }, 6000);
  renderHome(true);
});
/* One button: the key the person just copied on the extension's page is read from the clipboard and saved. */
document.addEventListener("click", async (e) => {
  const b = e.target.closest?.("[data-clclip]"); if (!b) return;
  let text = "";
  try { text = (await navigator.clipboard.readText()) || ""; } catch { toast(`${ico("alert", "sm")} ${tr("cl.noclip")}`, 9000); return; }
  const m = /PLAYWRIGHT_MCP_EXTENSION_TOKEN\s*=\s*([A-Za-z0-9_\-.=+/]{16,512})/.exec(text) || /^\s*([A-Za-z0-9_\-.=+/]{16,512})\s*$/.exec(text);
  if (!m) { toast(`${ico("alert", "sm")} ${tr("cl.notkey")}`, 9000); return; }
  b.disabled = true;
  try { const r = await post("/api/helper/token", { token: m[1] }); helperView = { ...(helperView || {}), browser: r.browser }; toast(`${ico("check", "sm")} ${tr("cl.saved")}`, 8000); }
  catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 9000); }
  renderHome(true);
});
document.addEventListener("click", async (e) => {
  const b = e.target.closest?.("[data-cloff]"); if (!b) return;
  if (!confirm(tr("cl.askoff"))) return;
  try { const r = await post("/api/helper/token", { remove: true }); helperView = { ...(helperView || {}), browser: r.browser }; } catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000); }
  renderHome(true);
});
/* The Settings pages read YouTube's state again when opened, so a sign-in made in another tab shows up. */
function freshYt() {
  if (Date.now() - (freshYt.at || 0) < 15000) return;
  freshYt.at = Date.now();
  api("/api/youtube").then((v) => { const was = JSON.stringify(yt); yt = v; if (JSON.stringify(v) !== was && atHome() && (page === "keys" || page === "accounts")) renderHome(true); }).catch(() => {});
}
const keyOpen = {};
document.addEventListener("click", (e) => {
  const b = e.target.closest?.("[data-keyedit]"); if (!b) return;
  keyOpen[b.dataset.keyedit] = !keyOpen[b.dataset.keyedit]; delete keyMsg[b.dataset.keyedit]; renderHome(true);
  if (keyOpen[b.dataset.keyedit]) document.querySelector(`[data-keyform="${b.dataset.keyedit}"] input`)?.focus();
});

/* YouTube's Google side: which Google app (Cloud project) and which account. The person chooses both. */
/* This project: whose reels these are (py/studio/brand.py). The ranch workspace's values come from its overlay (shared/ranch); a
   project made in the studio sets its own name, link, hashtags, home place and the words it never uses. */
let brandView = null;
function brandCard() {
  if (!brandView) { api("/api/brand").then((b) => { brandView = b; if (page === "keys") renderHome(true); }).catch(() => {}); return ""; }
  const b = brandView, place = b.place;
  if (!b.editable) {
    return `<section class="sheet" data-anchor="brand"><h2>${ico("user", "sm")} ${tr("br.h")}</h2>
      <p class="meta">${tr("br.fixed", { n: esc(b.name) })}</p>
      <dl class="kv"><dt>${tr("br.link")}</dt><dd>${esc(b.link || "—")}</dd><dt>${tr("br.tags")}</dt><dd>${esc((b.tags || []).join(" ") || "—")}</dd>
        <dt>${tr("br.place")}</dt><dd>${place ? `${esc(tr("br.placeis", { km: place.radiusKm }))} <a class="linkish" href="https://www.google.com/maps?q=${encodeURIComponent(`${place.lat},${place.lon}`)}" target="_blank" rel="noopener" title="${esc(`${place.lat}, ${place.lon}`)}">${tr("br.map")} ↗</a>` : esc(tr("br.noplace"))}</dd></dl></section>`;
  }
  return `<section class="sheet" data-anchor="brand"><h2>${ico("user", "sm")} ${tr("br.h")}</h2>
    <p class="meta">${tr("br.lead")}</p>
    <form class="capgrid brandform" data-brandform="1">
      <label><span class="meta">${tr("br.name")}</span><input name="name" maxlength="60" value="${esc(b.name || "")}"></label>
      <label><span class="meta">${tr("br.nameen")}</span><input name="nameEn" maxlength="60" value="${esc(b.nameEn || "")}"></label>
      <label><span class="meta">${tr("br.handle")}</span><input name="handle" maxlength="41" placeholder="@yourname" value="${esc(b.handle || "")}"></label>
      <label><span class="meta">${tr("br.link")}</span><input name="link" type="url" placeholder="https://" value="${esc(b.link || "")}"></label>
      <label><span class="meta">${tr("br.tags")}</span><input name="tags" placeholder="#yourbrand" value="${esc((b.tags || []).join(" "))}"></label>
      <fieldset class="brandplace"><legend class="meta">${tr("br.place")}</legend>
        <label class="meta chk"><input type="checkbox" name="anywhere" ${place ? "" : "checked"}> ${tr("br.anywhere")}</label>
        <label><span class="meta">${tr("br.lat")}</span><input name="lat" inputmode="decimal" value="${esc(place?.lat ?? "")}"></label>
        <label><span class="meta">${tr("br.lon")}</span><input name="lon" inputmode="decimal" value="${esc(place?.lon ?? "")}"></label>
        <label><span class="meta">${tr("br.km")}</span><input name="radiusKm" type="number" min="0.1" step="0.1" value="${esc(place?.radiusKm ?? 2)}"></label></fieldset>
      <label class="wide"><span class="meta">${tr("br.banned")}</span><textarea name="banned" rows="3" placeholder="${esc(tr("br.bannedph"))}">${esc((b.rules?.banned || []).join("\n"))}</textarea></label>
      <label class="meta chk"><input type="checkbox" name="noPrices" ${b.rules?.noPrices ? "checked" : ""}> ${tr("br.noprices")}</label>
      <button class="primary" type="submit">${ico("check", "sm")}${tr("br.save")}</button>
      ${brandMsg ? `<p class="${brandMsg.ok ? "okline" : "bad"}">${ico(brandMsg.ok ? "check" : "alert", "sm")} ${esc(brandMsg.key ? tr(brandMsg.key) : brandMsg.text)}</p>` : ""}</form></section>`;
}
let brandMsg = null;
document.addEventListener("submit", async (e) => {
  const f = e.target.closest("[data-brandform]");
  if (!f) return;
  e.preventDefault();
  const v = Object.fromEntries(new FormData(f));
  const body = { name: v.name, nameEn: v.nameEn, handle: v.handle, link: v.link, tags: v.tags, banned: v.banned, noPrices: !!v.noPrices,
    place: v.anywhere ? null : { lat: v.lat, lon: v.lon, radiusKm: v.radiusKm } };
  try { brandView = { ...(await post("/api/brand", body)), editable: true }; brandMsg = { ok: true, key: "br.saved" }; }  // a key, so it follows a language switch
  catch (err) { brandMsg = { ok: false, text: err.message }; }
  renderHome(true);
});
/* Use with Claude or Cursor: the MCP server and the HTTP API, with this computer's real paths filled in. */
function connectCard() {
  const c = CONNECT;
  if (!c) return "";
  const env = { ...(c.port !== 4317 ? { STUDIO_PORT: String(c.port) } : {}) };
  const json = JSON.stringify({ mcpServers: { lazycow: { command: c.node, args: [c.mcp], ...(Object.keys(env).length ? { env } : {}) } } }, null, 2);
  const cli = `claude mcp add lazycow${c.port !== 4317 ? ` -e STUDIO_PORT=${c.port}` : ""} -- "${c.node}" "${c.mcp}"`;
  const block = (id, text) => `<div class="codecopy"><pre id="${id}">${esc(text)}</pre><button type="button" data-copy="${id}">${ico("check", "sm")}${tr("cc.copy")}</button></div>`;
  return `<section class="sheet" data-anchor="connect"><h2>${ico("link", "sm")} ${tr("cc.h")}</h2>
    <p class="meta">${tr("cc.lead")}</p>
    <p><b>${tr("cc.claude")}</b></p>${block("ccCli", cli)}
    <p><b>${tr("cc.desktop")}</b> <span class="meta">${tr("cc.desktopwhere")}</span></p>${block("ccJson", json)}
    <p class="meta">${tr("cc.after")}</p>
    ${c.token ? `<p class="meta">${ico("shield", "sm")} ${tr("cc.token")}</p>` : ""}
    <p class="meta">${tr("cc.api")} <a href="${escUrl(c.api)}" target="_blank" rel="noopener">openapi.yaml ↗</a> · ${tr("cc.docs", { d: esc(c.docs) })}</p></section>`;
}
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-copy]");
  if (!b) return;
  const text = document.getElementById(b.dataset.copy)?.textContent || "";
  try { await navigator.clipboard.writeText(text); toast(`${ico("check", "sm")} ${esc(tr("cc.copied"))}`, 2500); }
  catch { toast(`${ico("alert", "sm")} ${esc(tr("cc.nocopy"))}`, 5000); }
});
function ytGoogleCard() {
  const a = yt.appInfo || {}, hint = lsGet("lc.yt.hint", "");
  const brand = /@pages\.plusgoogle\.com$/.test(yt.account || "");
  const where = yt.connected ? `<p class="ytg-where ok">${ico("check", "sm")} ${tr("ytg.where", { c: esc(yt.channel?.title || "?"), h: esc(yt.channel?.handle || "") })}</p>`
    : `<p class="ytg-where todo">${ico("alert", "sm")} ${tr(a.set ? "ytg.notyet" : "ytg.noappyet")}</p>`;
  return `<section class="sheet ytg" data-anchor="google"><h2>${ico("play", "sm")} ${tr("ytg.title")}</h2>${where}
    <dl class="kv">
      <dt>${tr("ytg.app")}</dt><dd>${a.set ? `<b>${esc(a.project || "?")}</b> <span class="meta">(${esc(tr("ytg.project"))} ${esc(a.projectNumber || "")} · ${esc(a.type === "desktop" ? tr("ytg.desktop") : a.type || "")})</span>` : `<span class="bad">${tr("ytg.noapp")}</span>`}</dd>
      <dt>${tr("ytg.account")}</dt><dd>${yt.connected ? (brand ? `<b>${tr("ytg.brand")}</b> <span class="meta">${esc(yt.channel?.title || "")}</span>` : `<b>${esc(yt.account || tr("ytg.unknown"))}</b>`) : tr("acc.not")}</dd>
      <dt>${tr("ytg.channel")}</dt><dd>${yt.connected ? `${esc(yt.channel?.title || "")} <span class="meta">${esc(yt.channel?.handle || "")}</span>` : "–"}</dd>
      <dt>${tr("ytg.analytics")}</dt><dd>${yt.connected ? (yt.analytics ? `${ico("check", "sm")} ${tr("ytg.on")}` : tr("ytg.off")) : "–"}</dd>
    </dl>
    <form class="row" data-ytconnect="1"><label><span class="meta">${tr("ytg.which")}</span><input name="hint" type="email" placeholder="name@gmail.com" value="${esc(hint)}" autocomplete="email"></label>
      <button class="primary" type="submit" ${a.set ? "" : "disabled"}>${ico("link", "sm")}${tr(yt.connected ? "ytg.switch" : "yt.connect")}</button>
      ${yt.connected ? `<button type="button" data-ytoff="1">${tr("acc.disconnect")}</button>` : ""}</form>
    <p class="meta">${tr("ytg.chooser")}</p>
    <details class="ytown" ${a.set ? "" : "open"}><summary><b>${tr("ytg.own")}</b></summary>
      <ol class="idealist"><li>${tr("ytg.s1")} <a href="https://console.cloud.google.com/projectselector2/apis/library/youtube.googleapis.com" target="_blank" rel="noopener">${tr("ytg.open")} ↗</a></li>
        <li>${tr("ytg.s2")} <a href="https://console.cloud.google.com/auth/audience" target="_blank" rel="noopener">${tr("ytg.open")} ↗</a></li>
        <li>${tr("ytg.s3")} <a href="https://console.cloud.google.com/auth/clients/create" target="_blank" rel="noopener">${tr("ytg.open")} ↗</a></li>
        <li>${tr("ytg.s4")}</li></ol>
      <label class="row"><input type="file" accept=".json,application/json" data-ytapp="1"><span class="meta">${tr("ytg.pick")}</span></label>
      ${a.set && a.source === "file" ? `<button type="button" class="linkish" data-ytforget="1">${tr("ytg.forget")}</button>` : ""}</details>
    ${a.set ? `<div class="row wrap">${a.source === "studio" ? `<span class="meta">${ico("check", "sm")} ${tr("ytg.fromstudio")}</span>`
      : `<button type="button" data-ytshare="${a.shared ? "0" : "1"}">${ico("link", "sm")}${tr(a.shared ? "ytg.unshare" : "ytg.share")}</button><span class="meta">${tr(a.shared ? "ytg.sharedon" : "ytg.sharewhy")}</span>`}</div>` : ""}
    ${ytOthersHtml()}
  </section>`;
}
/* More YouTube accounts beside the main one (Long videos can upload to any of them). */
function ytOthersHtml() {
  if (ytAccounts == null) { loadYtAccounts(); return ""; }
  const others = ytAccounts.filter((x) => x.id !== "main");
  return `<div class="ytothers"><b>${tr("ytg.others")}</b>
    ${others.length ? `<ul class="idealist">${others.map((x) => `<li>${esc(acctName(x))} <span class="meta">${esc(x.email || "")}</span> <button type="button" class="acoff" data-ytoffacct="${esc(x.id)}">${ico("x", "sm")}${tr("acc.disconnect")}</button></li>`).join("")}</ul>` : `<p class="meta">${tr("ytg.noothers")}</p>`}
    <a class="btn" href="/api/youtube/connect?account=new">${ico("plus", "sm")}${tr("vyt.another")}</a></div>`;
}
document.addEventListener("submit", (e) => {
  const f = e.target.closest("[data-ytconnect]"); if (!f) return;
  e.preventDefault();
  const hint = String(new FormData(f).get("hint") || "").trim();
  lsSet("lc.yt.hint", hint);
  location.href = "/api/youtube/connect" + (hint ? "?hint=" + encodeURIComponent(hint) : "");
});
document.addEventListener("change", async (e) => {
  const inp = e.target.closest?.("[data-ytapp]"); if (!inp || !inp.files?.[0]) return;
  try {
    const text = await inp.files[0].text();
    await post("/api/youtube/app", { json: text });
    toast(`${ico("check", "sm")} ${tr("ytg.saved")}`, 8000);
  } catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 9000); }
  inp.value = ""; yt = await api("/api/youtube").catch(() => yt); renderHome(true);
});
document.addEventListener("click", async (e) => {
  const sh = e.target.closest?.("[data-ytshare]"), oa = e.target.closest?.("[data-ytoffacct]");
  if (sh) {
    try { await post("/api/youtube/app", { share: sh.dataset.ytshare === "1" }); toast(`${ico("check", "sm")} ${tr(sh.dataset.ytshare === "1" ? "ytg.sharedon" : "ytg.unshared")}`, 6000); }
    catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000); }
    yt = await api("/api/youtube").catch(() => yt); renderHome(true); return;
  }
  if (oa) {
    if (!confirm(tr("ytg.askoffacct"))) return;
    try { await post("/api/youtube/disconnect", { account: oa.dataset.ytoffacct }); } catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000); }
    ytAccounts = null; renderHome(true); return;
  }
  const off = e.target.closest?.("[data-ytoff]"), fg = e.target.closest?.("[data-ytforget]");
  if (!off && !fg) return;
  if (!confirm(tr(off ? "ytg.askoff" : "ytg.askforget"))) return;
  try { await post(off ? "/api/youtube/disconnect" : "/api/youtube/app", off ? {} : { forget: true }); } catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000); }
  yt = await api("/api/youtube").catch(() => yt); renderHome(true);
});
/* ---------- Your own model: any OpenAI-compatible server (Ollama, LM Studio, vLLM, OpenAI, Groq, OpenRouter) for the
   writing jobs and, with a vision model, the long videos' names and chapters (py/studio/ai.py save_llm, config.own_llm). */
let llmPresets = null, llmMsg = null;
function ownLlmCard() {
  if (llmPresets === null) { llmPresets = undefined; api("/api/ai/llm").then((v) => { llmPresets = v || { presets: [] }; if (page === "keys") renderHome(true); }).catch(() => { llmPresets = { presets: [] }; }); }
  const cur = aiView?.ownLlm || llmPresets?.ownLlm || null, ps = llmPresets?.presets || [];
  return `<section class="sheet ownllm" data-anchor="llm"><h2>${ico("layers", "sm")} ${tr("llm.h")}${cur ? ` <span class="kl-state ok">${ico("check", "sm")}${tr("llm.on")}</span>` : ""}</h2>
    <p class="meta">${tr("llm.lead")}</p>
    ${cur ? `<p class="okline">${ico("check", "sm")} ${esc(tr("llm.using", { m: cur.model, u: cur.url }))}${cur.visionModel ? " · " + esc(tr("llm.vision", { m: cur.visionModel })) : ""}</p>` : ""}
    <form class="capgrid llmform" data-llmform="1">
      <label><span class="meta">${tr("llm.preset")}</span><select data-llmpreset="1"><option value="">${tr("llm.pick")}</option>${ps.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join("")}</select></label>
      <label><span class="meta">${tr("llm.url")}</span><input name="base_url" type="url" spellcheck="false" autocomplete="off" placeholder="http://127.0.0.1:11434/v1" value="${esc(cur?.url || "")}"></label>
      <label><span class="meta">${tr("llm.model")}</span><input name="model" spellcheck="false" autocomplete="off" placeholder="qwen3:8b" value="${esc(cur?.model || "")}"></label>
      <label><span class="meta">${tr("llm.vmodel")}</span><input name="vision_model" spellcheck="false" autocomplete="off" placeholder="qwen3-vl:8b" value="${esc(cur?.visionModel || "")}"></label>
      <label><span class="meta">${tr(cur?.hasKey ? "llm.keykeep" : "llm.key")}</span><input name="api_key" type="password" autocomplete="off" spellcheck="false"></label>
      <button class="primary" type="submit">${ico("check", "sm")}${tr("llm.save")}</button>
      ${cur ? `<button type="button" class="linkish" data-llmoff="1">${tr("llm.off")}</button>` : ""}</form>
    ${llmMsg ? `<p class="${llmMsg.ok ? "okline" : "bad"}">${ico(llmMsg.ok ? "check" : "alert", "sm")} ${esc(llmMsg.text)}</p>` : ""}
    <p class="meta">${tr("llm.what")} <a href="https://github.com/kensaurus/lazycow-studio/blob/main/docs/architecture.md" target="_blank" rel="noopener">${tr("llm.docs")} ↗</a></p></section>`;
}
document.addEventListener("change", (e) => {
  const s = e.target.closest?.("[data-llmpreset]"); if (!s || s.value === "") return;
  const p = llmPresets?.presets?.[+s.value], f = s.closest("form"); if (!p || !f) return;
  f.base_url.value = p.base_url; f.model.value = p.model || ""; f.vision_model.value = p.vision_model || "";
  (p.model ? f.base_url : f.model).focus();
});
document.addEventListener("submit", async (e) => {
  const f = e.target.closest("[data-llmform]"); if (!f) return;
  e.preventDefault();
  const d = Object.fromEntries(new FormData(f)), key = String(d.api_key || "").trim();
  const llm = { base_url: String(d.base_url || "").trim(), model: String(d.model || "").trim(), vision_model: String(d.vision_model || "").trim(), ...(key ? { api_key: key } : {}) };
  if (!llm.base_url || !llm.model) { llmMsg = { ok: false, text: tr("llm.url") + " · " + tr("llm.model") }; return renderHome(true); }
  f.querySelector("button[type=submit]").disabled = true;
  try { const r = await saveSetting({ llm }); llmMsg = { ok: true, text: tr("llm.saved", { n: r.ai?.models?.length ?? 0 }) }; llmPresets = null; }
  catch (err) { llmMsg = { ok: false, text: err.message.replace(/^\w*Error: /, "") }; }
  loadKeys();
});
document.addEventListener("click", async (e) => {
  const b = e.target.closest?.("[data-llmoff]"); if (!b) return;
  if (!confirm(tr("llm.askoff"))) return;
  try { await saveSetting({ llm: { base_url: "" } }); llmMsg = { ok: true, text: tr("llm.removed") }; llmPresets = null; } catch (err) { llmMsg = { ok: false, text: err.message }; }
  loadKeys();
});
async function saveSetting(body) { return post("/api/settings", body); }
document.addEventListener("submit", async (e) => {
  const f = e.target.closest("[data-keyform]"), c = e.target.closest("[data-capform]");
  if (!f && !c) return;
  e.preventDefault();
  if (c) { const d = Object.fromEntries(new FormData(c)); try { await saveSetting({ ai_reel_cap_usd: +d.ai_reel_cap_usd, ai_total_cap_usd: +d.ai_total_cap_usd, daily_usd_budget: +d.daily_usd_budget }); toast(`${ico("check", "sm")} ${tr("acc.saved")}`); } catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 7000); } return loadKeys(); }
  const k = f.dataset.keyform, v = String(new FormData(f).get("v") || "").trim();
  if (!v) return;
  f.querySelector("button[type=submit]").disabled = true;
  const own = KEY_FIELDS.some(([x]) => x === k);  // aip: any other registry service is saved as keys: {provider: key}
  try { const r = await saveSetting(own ? { [k]: v } : { keys: { [k.replace(/_key$/, "")]: v } }); keyMsg[k] = { ok: true, text: r.message || tr("key.ok") }; keyOpen[k] = false; }
  catch (err) { keyMsg[k] = { ok: false, text: err.message.replace(/^\w*Error: /, "") }; }
  if (!own) { loadFb(true); loadWf(); loadCredits(true); }
  loadKeys();
});
document.addEventListener("click", async (e) => {
  const b = e.target.closest?.("[data-keyoff]"); if (!b) return;
  if (!confirm(tr("key.askremove"))) return;
  const k = b.dataset.keyoff, own = KEY_FIELDS.some(([x]) => x === k);
  try { await saveSetting(own ? { [k]: "" } : { keys: { [k.replace(/_key$/, "")]: "" } }); keyMsg[k] = { ok: true, text: tr("key.removed") }; } catch (err) { keyMsg[k] = { ok: false, text: err.message }; }
  if (!own) { loadFb(true); loadWf(); }
  loadKeys();
});
/* ---------- Accounts: what the studio can post by itself, which networks this project uses, the profile kit ---------- */
let profilesKit = null, helperView = null;   // helperView: the browser helper, and which sites its window is signed in to
async function loadAccounts() {
  const [c, k, h] = await Promise.all([api("/api/connections").catch(() => connections), api("/api/profiles").catch(() => null), api("/api/helper").catch(() => null)]);
  connections = c || {}; profilesKit = k; helperView = h;
  if (atHome() && page === "accounts") renderHome(true);
}
/* Redraws (the page refreshes while it waits on Chrome or a sign-in) keep whatever sections the person opened. */
const detailKey = (d) => [d.className, d.id, d.closest("article")?.querySelector("b")?.textContent || "", d.querySelector("summary")?.textContent || ""].join("|");
function keepOpen(draw) {
  const open = new Set([...document.querySelectorAll("#home details")].filter((d) => d.open).map(detailKey));
  const shut = new Set([...document.querySelectorAll("#home details")].filter((d) => !d.open).map(detailKey));
  draw();
  document.querySelectorAll("#home details").forEach((d) => { const k = detailKey(d); if (open.has(k)) d.open = true; else if (shut.has(k)) d.open = false; });
}
function renderAccounts() {
  // A redraw (Chrome polling, a rehearsal's progress) keeps the caret in the map panel's account field.
  const a = document.activeElement, kf = a?.id && a.closest?.("#amDetail") ? { id: a.id, s: a.selectionStart, e: a.selectionEnd } : null;
  keepOpen(drawAccounts);
  const el = kf && document.getElementById(kf.id);
  if (el && el !== document.activeElement) { el.focus({ preventScroll: true }); try { if (kf.s != null) el.setSelectionRange(kf.s, kf.e); } catch { /* not a text field */ } }
}
/* Settings › Accounts › how each network gets its post: the project in the middle, the three ways a post leaves the
   studio as branches (the studio sends it through the network's connection, your Chrome books or fills it in, or you
   upload it from a reminder), each network the project uses hanging off its way. A network waiting on a step hangs
   on a dashed wire with an amber dot; each one says its next booking and when its sign-in ends. Click a node for the
   details and the way to its card below. Same parts as Footage's source map (mapNode, wireMap, mapDetail). */
const AM_HOW = { studio: { cls: "k-api", icon: "send", name: "am.api", what: "am.api.d" }, helper: { cls: "k-chrome", icon: "link", name: "am.chrome", what: "am.chrome.d" }, hand: { cls: "k-hand", icon: "download", name: "am.hand", what: "am.hand.d" } };
const accMap = { node: null, seen: new Set(), shown: null };
function accMapHtml(nets, st, { viaChrome, chromeOn, ws }) {
  if (!nets.length) return "";
  const now = Date.now();
  const ahead = (n) => postsLog.filter((p) => p.network === n && ["scheduled", "queued", "planned"].includes(p.status) && p.at && new Date(p.at).getTime() > now).sort((a, b) => new Date(a.at) - new Date(b.at));
  const sent = (n) => postsLog.filter((p) => p.network === n && p.status === "posted").length;
  const day = (iso) => new Date(iso).toLocaleDateString(lang === "ja" ? "ja-JP" : "en-GB", { month: "short", day: "numeric" });
  const howName = (h) => (h === "helper" && !viaChrome ? "am.helper" : AM_HOW[h].name), howWhat = (h) => (h === "helper" && !viaChrome ? "am.helper.d" : AM_HOW[h].what);
  const netInfo = (n) => {
    const x = st[n], c = connections[n], next = ahead(n);
    const acct = x.who || c?.account || chanOf(n)?.account || "";
    const status = x.group === "ready" ? ["ok", tr("am.ready")] : ["warn", tr(x.how === "helper" ? (!viaChrome ? "acc.st.signin" : !chromeOn ? "acc.st.chrome" : x.unknown ? "acc.st.check" : "acc.st.chromesign") : x.how === "studio" ? "acc.st.connect" : "am.step")];
    if (c?.error && !c.connected) status[0] = "bad";
    if (x.expiring) status[1] = tr("acc.st.expires", { d: day(c.until) });
    return { n, x, c, next, acct, status, name: NET_NAME[n] || n };
  };
  const groups = ["studio", "helper", "hand"].map((h) => ({ h, list: nets.filter((n) => st[n].how === h).map(netInfo) })).filter((g) => g.list.length);
  const fresh = (id) => !accMap.seen.has(id);
  const netNode = (o) => (i) => mapNode({ kcls: AM_HOW[o.x.how].cls, logo: netLogo(chOf(o.n)), name: o.name, status: o.status, i, fresh: fresh(o.n), on: accMap.node === o.n, attr: `data-accnode="${esc(o.n)}"`, controls: "amDetail",
    cls: o.x.group === "ready" ? "" : "wire-dash", title: o.name,
    nums: o.next.length ? `${esc(tr("am.next", { t: whenText(o.next[0].at) }))}` : `<span class="meta">${esc(tr("am.nonext"))}</span>`,
    after: o.x.expiring ? "" : o.c?.until ? tr("am.ends", { d: day(o.c.until) }) : o.next.length > 1 ? tr("am.booked", { n: o.next.length }) : "",
    label: `${o.name}. ${tr(howName(o.x.how))}. ${o.status[1]}. ${o.next.length ? tr("am.next", { t: whenText(o.next[0].at) }) + ", " + tr("am.booked", { n: o.next.length }) : tr("am.nonext")}${o.c?.until ? ". " + tr("am.ends", { d: day(o.c.until) }) : ""}` });
  const howStatus = (g) => {
    const todo = g.list.filter((o) => o.x.group !== "ready").length;
    if (g.h === "helper" && viaChrome) return chromeOn ? (todo ? ["warn", tr("am.todo", { n: todo })] : ["ok", tr("am.linked")]) : ["bad", tr("am.unlinked")];
    return todo ? ["warn", tr("am.todo", { n: todo })] : ["ok", tr("am.ready")];
  };
  const howNode = (g) => (i) => mapNode({ kcls: AM_HOW[g.h].cls, icon: AM_HOW[g.h].icon, name: tr(howName(g.h)), status: howStatus(g), i, fresh: fresh("how:" + g.h), on: accMap.node === "how:" + g.h, attr: `data-accnode="how:${g.h}"`, controls: "amDetail",
    nums: esc(tr("am.nets", { n: g.list.length })) + " · " + esc(tr("am.booked", { n: g.list.reduce((a, o) => a + o.next.length, 0) })), label: `${tr(howName(g.h))}: ${g.list.map((o) => o.name).join(", ")}. ${howStatus(g)[1]}` });
  const all = groups.flatMap((g) => g.list), soonest = all.flatMap((o) => o.next)[0] && all.flatMap((o) => o.next).sort((a, b) => new Date(a.at) - new Date(b.at))[0];
  const hub = `<div class="sm-hub ${fresh("_hub") ? "in" : ""}" role="group" aria-label="${esc(ws?.name || WORKSPACE || tr("sm.project"))}">
      <span class="sm-hubico" aria-hidden="true">${ico("send")}</span>
      <b>${esc(ws?.name || WORKSPACE || tr("sm.project"))}</b>
      <span class="meta">${esc(tr("am.hub", { n: all.length }))}</span>
      <span class="meta">${esc(tr("am.booked", { n: bookedAhead().length }))}</span>
      ${bookedAhead().some((p) => p.network === "instagram-story") ? `<span class="meta">${esc(tr("am.stories", { n: bookedAhead().filter((p) => p.network === "instagram-story").length }))}</span>` : ""}
      ${soonest ? `<span class="meta">${esc(tr("am.hubnext", { t: whenText(soonest.at) }))}</span>` : ""}</div>`;
  // Details for the open node.
  let detail = `<p class="meta sm-hint">${ico("info", "sm")} ${tr("am.hint")}</p>`;
  const open = accMap.node, wasShown = accMap.shown;
  if (open?.startsWith("how:")) {
    const g = groups.find((y) => "how:" + y.h === open);
    if (g) detail = mapDetail({ id: "amDetail", kcls: AM_HOW[g.h].cls, icon: AM_HOW[g.h].icon, name: tr(howName(g.h)), sub: tr("am.nets", { n: g.list.length }), status: howStatus(g), fresh: wasShown !== open, closeAttr: 'data-accnode=""',
      facts: [[tr("am.what"), esc(tr(howWhat(g.h)))], [tr("am.which"), `<span class="am-nets">${g.list.map((o) => `<button type="button" class="mp" data-accnode="${esc(o.n)}">${netLogo(chOf(o.n), "sm")}${esc(o.name)}<i class="dot st-${o.status[0]}" aria-hidden="true"></i></button>`).join("")}</span>`]],
      acts: g.h === "helper" && viaChrome && !chromeOn ? `<button class="primary" data-chromeconnect="1">${ico("link", "sm")}${tr("acc.chrome.go")}</button>` : "" });
  } else if (open) {
    const o = all.find((y) => y.n === open);
    // 24 Nov: the node opens the network's settings in place (amcPanel, below), not a read-only strip.
    if (o) detail = amcPanel(o, { viaChrome, chromeOn, how: howName(o.x.how), what: howWhat(o.x.how), sent: sent(o.n), day, fresh: wasShown !== open });
  }
  accMap.shown = open && detail.includes('id="amDetail"') ? open : null;
  // BL-139: on a phone the map folds under its title (it ran 945 px of Settings' three screens); the person's choice
  // to open or close it holds while the page redraws.
  const mapOpen = accMap.open ?? !matchMedia("(max-width: 760px)").matches;
  const html = `<details class="panel ammap am-fold" data-amfold ${mapOpen ? "open" : ""}><summary class="fh-head"><h3 id="amTitle">${ico("send")} ${tr("am.title")}</h3><span class="am-foldsum">${esc(tr("am.hub", { n: all.length }))} · ${esc(tr("am.booked", { n: bookedAhead().length }))}</span></summary>
    ${wireMap({ id: "amMap", label: tr("am.label"), hub, cls: "flow-out", branches: groups.map((g) => ({ node: howNode(g), kids: g.list.map(netNode) })) })}
    ${detail}</details>`;
  if (moCalm() || !("IntersectionObserver" in window)) { for (const g of groups) { accMap.seen.add("how:" + g.h); for (const o of g.list) accMap.seen.add(o.n); } accMap.seen.add("_hub"); }  // else marked once on screen (moWatch)
  return html;
}
document.addEventListener("click", (e) => {
  const nd = e.target.closest?.("[data-accnode]");
  if (nd) {
    const id = nd.dataset.accnode, was = accMap.node;
    accMap.node = id && id !== was ? id : null;
    renderHome(true);
    if (accMap.node) requestAnimationFrame(() => document.getElementById("amDetail")?.scrollIntoView({ block: "nearest", behavior: moCalm() ? "auto" : "smooth" }));
    else if (was) document.querySelector(`#home [data-accnode="${CSS.escape(was)}"].snode`)?.focus();
    return;
  }
  const j = e.target.closest?.("[data-accjump]"); if (!j) return;
  const card = document.getElementById("acc-" + j.dataset.accjump);
  if (!card) return;
  card.closest("details")?.setAttribute("open", "");
  card.scrollIntoView({ block: "center", behavior: moCalm() ? "auto" : "smooth" });
  card.classList.remove("flash"); void card.offsetWidth; card.classList.add("flash");
  setTimeout(() => card.querySelector("button, a, input")?.focus({ preventScroll: true }), 300);
});
document.addEventListener("toggle", (e) => {
  if (!e.target.matches?.("[data-amfold]")) return;
  accMap.open = e.target.open;
  if (e.target.open) requestAnimationFrame(() => drawWires());  // the wires are drawn from the laid-out nodes
}, true);
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !e.target.closest?.("#amDetail")) return;
  e.preventDefault(); document.querySelector('#amDetail [data-accnode=""]')?.click();
});
/* ---------- Settings › Accounts › a network's settings on the map (owner, 24 Nov: "isn't it better if the config can
   be done from the interactive and visual pipeline?"). Clicking a network node opens this panel in place of the old
   read-only strip, the same height: its account (POST /api/channels/set {id, account}), on or off for this project
   ({id, on}; off is asked here first), whether Plan posts books it by itself (POST /api/autopost {set: {plan: {networks}}},
   the list Runs by itself edits; [] = all), its one sign-in step (the cards' own handlers: data-signin, data-helpsign,
   data-saidsigned, data-chromeconnect), its posting times as the planner reads them (server/autoplan.mjs postSlots,
   helper.mjs planWeek), and on the sites your Chrome schedules a rehearsal (POST /api/helper/schedule {rehearse: true}:
   every step but the last press; nothing is posted or logged). ---------- */
const AMC_SCHED = ["x", "tiktok", "gbp", "line-oa", "linkedin", "pinterest"];  // helper.mjs SCHEDULERS
const AMC_LIMIT = { x: 365, tiktok: 10, gbp: 180, "line-oa": 180, linkedin: 90, pinterest: 9, facebook: 29, bluesky: 60, youtube: 60 };  // autoplan.mjs AUTO_LIMITS
const amc = { draft: {}, ask: null, run: {} };
/* The hours Plan posts uses (autoplan.mjs postSlots + helper.mjs planWeek): Google Maps Fri/Sat 12:00, LINE Saturday
   10:00 and LinkedIn Sunday 19:00 (weekly); else the usual hour (19:00 when listed, else the first) and, every 4th
   booking (EXPLORE_EVERY), one of the other listed hours as a test. Japan time; another audience zone keeps 19:00. */
function amcHours(n) {
  const fixed = { gbp: ["amc.t.gbp", "12:00", [5, 6]], "line-oa": ["amc.t.line", "10:00", [6]], linkedin: ["amc.t.linkedin", "19:00", [0]] }[n];
  if (fixed) return { key: fixed[0], usual: fixed[1], days: fixed[2], others: [] };
  const hours = [...new Set((chanOf(n)?.postTimesJst || []).filter((h) => /^\d{2}:\d{2}$/.test(h)))];
  if (audTz() !== "Asia/Tokyo" || !hours.length) return { usual: "19:00", others: [] };
  const usual = hours.includes("19:00") ? "19:00" : hours[0];
  return { usual, others: hours.filter((h) => h !== usual) };
}
/* A rehearsal's time: the network's usual hour on its next allowed day, at least an hour from now. */
function amcAt(n) {
  const h = amcHours(n);
  let d = wallOf(Date.now()).slice(0, 10);
  for (let i = 0; i < 14; i++, d = nextDay(d)) {
    if (h.days && !h.days.includes(new Date(d + "T12:00Z").getUTCDay())) continue;
    const at = zonedIso(`${d}T${h.usual}`);
    if (Date.parse(at) >= Date.now() + 3600e3) return at;
  }
  return "";
}
/* The next approved reel this network has not had (the planner's own fit: planFits). */
const amcReel = (n) => (overview?.reels || []).filter((r) => !r.house && r.rendered && r.status === "approved" && !busyJob(r) && !isSkipped(r.slug) && planFits(r, n))
  .sort((a, b) => a.slug.localeCompare(b.slug))[0] || null;
function amcPanel(o, { viaChrome, chromeOn, how, what, sent, day, fresh }) {
  const n = o.n, x = o.x, c = o.c, s = chanOf(n) || {}, name = o.name, id = chOf(n), nid = id.replace(/[^a-z0-9-]/gi, "");
  if (autoView === null && !autoLoading) {  // Plan posts' network list, as Runs by itself shows it
    autoLoading = true;
    api("/api/autopost").then((v) => { autoView = v; }).catch(() => {}).finally(() => { autoLoading = false; if (page === "accounts" && atHome()) renderHome(true); });
  }
  const st = (k, text) => `<span class="amc-st st-${k}"><i class="dot" aria-hidden="true"></i>${esc(text)}</span>`;
  const row = (k, v, cls = "", forId = "") => `<div class="amc-row ${cls}">${forId ? `<label class="amc-k" for="${forId}">${esc(k)}</label>` : `<span class="amc-k">${esc(k)}</span>`}<div class="amc-v">${v}</div></div>`;
  // 1. The account this project posts as (networks.json "accounts").
  const acct = `<form class="amc-acct" data-amcacct="${esc(id)}" data-amcnet="${esc(n)}"><input id="amc-acct-${nid}" name="account" value="${esc(amc.draft[n] ?? s.account ?? "")}" placeholder="${esc(tr("acc.acctph"))}" autocomplete="off" spellcheck="false"><button type="submit">${ico("check", "sm")}${esc(tr("amc.save"))}</button></form>`;
  // 2. On for this project; booked by itself (Plan posts' networks; the networks it can book only).
  const ps = autoView?.settings?.plan, auto = autoView ? (autoView.networks || []).includes(n) : n in AMC_LIMIT;
  const autoOn = ps ? !ps.networks.length || ps.networks.includes(n) : false;
  const ahead = ps ? Math.min(ps.aheadDays ?? 14, n === "tiktok" ? Math.min(AMC_LIMIT.tiktok, ps.tiktokAheadDays ?? 9) : AMC_LIMIT[n] ?? 60) : 0;
  const sw = amc.ask === n
    ? `<div class="amc-ask" role="group" aria-label="${esc(tr("amc.offask", { n: name }))}"><span>${esc(tr("amc.offask", { n: name }))}</span><button type="button" class="danger" data-amcoff="${esc(n)}">${esc(tr("amc.offyes"))}</button><button type="button" data-amckeep="${esc(n)}">${esc(tr("amc.offno"))}</button></div>`
    : `<label class="switch"><input type="checkbox" data-amcon="${esc(n)}" checked><span>${esc(tr("acc.use"))}</span></label>`
      + (auto ? `<label class="switch"><input type="checkbox" data-amcauto="${esc(n)}" ${autoOn ? "checked" : ""} ${ps ? "" : "disabled"}><span>${esc(tr("amc.auto"))}</span></label>${ps ? `<span class="meta">${esc(ps.on ? (autoOn ? tr("amc.ahead", { d: ahead }) : "") : tr("amc.planoff"))}</span>` : ""}` : "");
  // 3. The one sign-in step, the way its card does it.
  const ends = c?.until ? `<span class="meta">${esc(tr("am.ends", { d: day(c.until) }))}</span>` : "";
  let sign;
  if (x.how === "hand") sign = `<span class="meta">${esc(tr("amc.nosign"))}</span>`;
  else if (x.how === "studio" && n === "youtube") sign = yt.connected ? st("ok", tr("amc.as", { a: x.who || "YouTube" })) : `<a class="btn primary" href="/api/youtube/connect">${ico("play", "sm")}${esc(tr("yt.connect"))}</a>`;
  else if (x.how === "studio" && c) {
    const good = c.connected && !c.error && !x.expiring, one = c.signin && (n === "bluesky" || c.signin.ready);
    sign = (good ? st("ok", c.account ? tr("amc.as", { a: c.account }) : tr("amc.connected")) : st(o.status[0], o.status[1])) + ends
      + (one ? `<form class="signform amc-inl" data-signin="${esc(n)}"><input type="hidden" name="handle" value="${esc((c.account || "").replace(/^@/, ""))}"><button type="submit" class="${good ? "" : "primary"}">${ico("link", "sm")}${esc(tr(good ? "amc.again" : n === "bluesky" ? "acc.bsky.signin" : "acc.fb.connect"))}</button></form>`
        : good ? "" : `<button type="button" class="primary" data-accjump="${esc(n)}">${ico("alert", "sm")}${esc(tr("acc.r.setup"))}</button>`);
  } else if (x.how === "studio") sign = st(o.status[0], o.status[1]);
  else if (viaChrome && !chromeOn) sign = st("warn", tr("am.unlinked")) + `<button type="button" class="primary" data-chromeconnect="1">${ico("link", "sm")}${esc(tr("acc.chrome.go"))}</button>`;
  else {
    const ready = x.group === "ready";
    sign = (ready ? st("ok", x.said ? tr("amc.said", { d: day(x.said) }) : tr("amc.signed")) : st("warn", tr(x.unknown ? "amc.cantell" : "amc.notsigned")))
      + `<button type="button" class="${ready ? "" : "primary"}" data-helpsign="${esc(n)}">${ico("link", "sm")}${esc(tr(viaChrome ? "acc.chrome.open" : "acc.help.signin", { n: name }))}</button>`
      + (x.unknown && !ready ? `<button type="button" data-saidsigned="${esc(n)}">${ico("check", "sm")}${esc(tr("acc.saidsigned"))}</button>` : "");
  }
  // 4. Posting times, as the planner books them.
  const h = amcHours(n), tz = audTz() === "Asia/Tokyo" ? " JST" : "";
  const times = !auto ? tr("amc.t.best", { list: slotsOf(n).map((t) => t.hm).join(", ") + tz })
    : h.key ? tr(h.key, { h: h.usual }) + tz
    : tr("amc.t.usual", { h: h.usual + tz }) + (h.others.length ? " · " + tr("amc.t.test", { list: h.others.join(", ") }) : "");
  // 5. Its posts: the next one, how many are booked, how many went out.
  const posts = [o.next.length ? tr("am.next", { t: whenText(o.next[0].at) }) : tr("am.nonext"), o.next.length ? tr("am.booked", { n: o.next.length }) : "", tr("amc.sent", { n: sent })].filter(Boolean).join(" · ");
  // 6. A rehearsal on the sites your Chrome schedules (approved reels only; nothing is posted).
  let tryRow = "";
  if (AMC_SCHED.includes(n) && x.how === "helper") {
    const R = amc.run[n], reel = amcReel(n), at = amcAt(n);
    let v;
    if (R?.busy) v = `<span class="amc-prog" role="status">${ico("refresh", "sm")}${esc(tr("amc.trying", { l: R.label || "" }))}</span>`;
    else {
      const why = viaChrome && !chromeOn ? tr("amc.trychrome") : x.group !== "ready" ? tr("amc.trysign") : !reel ? tr("amc.trynone", { n: name }) : !at ? tr("amc.trynone", { n: name }) : "";
      v = `<button type="button" data-amctry="${esc(n)}" ${why ? "disabled" : ""} aria-describedby="amc-try-${nid}">${ico("eye", "sm")}${esc(tr("amc.trybtn"))}</button>
        <span class="meta" id="amc-try-${nid}">${esc(why || tr("amc.trywhat", { s: reelName(reel.slug), t: whenText(at) }))}</span>`
        + (R?.msg ? `<span class="amc-out ${R.ok ? "okline" : "bad"}" role="status">${ico(R.ok ? "check" : "alert", "sm")} ${esc(tr(R.ok ? "amc.tryok" : "amc.tryfail", { m: R.msg }))}</span>` : "");
    }
    tryRow = row(tr("amc.tryh"), v, "amc-try");
  }
  const jump = `<button type="button" class="${x.group === "ready" ? "" : "primary"}" data-accjump="${esc(n)}">${ico(x.group === "ready" ? "chev-r" : "alert", "sm")}${esc(tr(x.group === "ready" ? "am.card" : "am.dostep"))}</button><a class="btn" href="#/posting/schedule/${encodeURIComponent(n)}">${ico("cal", "sm")}${esc(tr("am.posts"))}</a>`;
  return `<section class="sn-detail amc ${AM_HOW[x.how].cls} ${fresh ? "in" : ""}" id="amDetail" aria-label="${esc(tr("amc.label", { n: name }))}" tabindex="-1">
    <div class="sn-head"><span class="sn-ico logo" aria-hidden="true">${netLogo(chOf(n))}</span><div><b>${esc(name)}</b><span class="meta" title="${esc(tr(what))}">${esc(tr(how))} · ${st(o.status[0], o.status[1])}</span></div>
      <span class="grow"></span><span class="amc-hacts">${jump}</span><button type="button" class="icon" data-accnode="" aria-label="${esc(tr("src.close"))}" title="${esc(tr("src.close"))}">${ico("x", "sm")}</button></div>
    <div class="amc-grid">${row(tr("am.acct"), acct, "", `amc-acct-${nid}`)}${row(tr("amc.here"), sw, "amc-sw")}${row(tr("amc.sign"), sign)}${row(tr("amc.times"), `<span>${esc(times)}</span>`)}${row(tr("amc.posts"), `<span>${esc(posts)}</span>`)}${tryRow}</div></section>`;
}
document.addEventListener("input", (e) => { const f = e.target.closest?.("[data-amcacct]"); if (f) amc.draft[f.dataset.amcnet] = e.target.value; });
document.addEventListener("submit", async (e) => {
  const f = e.target.closest?.("[data-amcacct]"); if (!f) return;
  e.preventDefault();
  const n = f.dataset.amcnet, btn = f.querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    channelsSpec = await post("/api/channels/set", { id: f.dataset.amcacct, account: f.elements.account.value.trim() });
    delete amc.draft[n];
    toast(`${ico("check", "sm")} ${esc(tr("amc.saved", { n: NET_NAME[n] || n }))}`, 2500);
  } catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 6000); }
  renderHome(true);
  document.getElementById(f.querySelector("input")?.id || "")?.focus({ preventScroll: true });
});
document.addEventListener("change", async (e) => {
  const on = e.target.closest?.("[data-amcon]"), au = e.target.closest?.("[data-amcauto]");
  if (on) {  // switching on happens from the "Not used" list; off asks first, here, not in a dialog
    if (on.checked) return;
    on.checked = true; amc.ask = on.dataset.amcon; renderHome(true);
    document.querySelector("#amDetail [data-amckeep]")?.focus({ preventScroll: true });
    return;
  }
  if (!au || !autoView) return;
  const n = au.dataset.amcauto, all = autoView.networks, cur = autoView.settings.plan.networks.length ? autoView.settings.plan.networks : all;
  let next = au.checked ? [...new Set([...cur, n])] : cur.filter((y) => y !== n);
  if (!next.length) { au.checked = true; toast(`${ico("info", "sm")} ${esc(tr("amc.last"))}`, 4000); return; }
  if (all.every((y) => next.includes(y))) next = [];  // all = follow every network, new ones included (as Runs by itself)
  au.disabled = true;
  await autoSet({ plan: { networks: next } });
  if (page === "accounts" && atHome()) { renderHome(true); document.querySelector(`#amDetail [data-amcauto="${CSS.escape(n)}"]`)?.focus({ preventScroll: true }); }
});
document.addEventListener("click", async (e) => {
  const keep = e.target.closest?.("[data-amckeep]"), off = e.target.closest?.("[data-amcoff]"), go = e.target.closest?.("[data-amctry]");
  if (keep) { const n = keep.dataset.amckeep; amc.ask = null; renderHome(true); document.querySelector(`#amDetail [data-amcon="${CSS.escape(n)}"]`)?.focus(); return; }
  if (off) {
    const n = off.dataset.amcoff; off.disabled = true;
    try { channelsSpec = await post("/api/channels/set", { id: chOf(n), on: false }); amc.ask = null; accMap.node = null; toast(`${ico("check", "sm")} ${esc(tr("amc.isoff", { n: NET_NAME[n] || n }))}`, 4000); }
    catch (err) { off.disabled = false; toast(`${ico("alert", "sm")} ${esc(err.message)}`, 6000); }
    renderHome(true);
    return;
  }
  if (go) amcTry(go.dataset.amctry);
});
/* Rehearse one booking: the next approved reel at the usual hour, every step on the site but the last press. Files are
   prepared first when the reel has none for this network (as the week view's booking does); progress from /api/job. */
async function amcTry(n) {
  const reel = amcReel(n), at = amcAt(n);
  if (!reel || !at || amc.run[n]?.busy) return;
  const R = amc.run[n] = { busy: true, label: tr("amc.trystart") };
  const paint = () => { if (page === "accounts" && atHome()) renderHome(true); };
  paint();
  try {
    const d = await api("/api/reel?slug=" + encodeURIComponent(reel.slug));
    if (!d.channels?.some((ch) => ch.name === chOf(n) && ch.files?.some((f) => /\.mp4$/i.test(f)))) { R.label = tr("amc.tryfiles"); paint(); await post("/api/package", { slug: reel.slug, channels: [chOf(n)] }); }
    let j = await post("/api/helper/schedule", { slug: reel.slug, network: n, at, rehearse: true });
    const key = j.slug;
    while (["queued", "running"].includes(j.status)) {
      R.label = `${j.label || ""}${j.status === "running" && j.stages ? ` (${j.stage || 0}/${j.stages})` : ""}`;
      paint();
      await new Promise((r) => setTimeout(r, 2000));
      j = await api("/api/job?slug=" + encodeURIComponent(key));
    }
    amc.run[n] = { ok: j.status === "done" && j.result?.state === "rehearsed", msg: j.result?.message || j.label || (j.lines || []).slice(-1)[0] || j.status };
  } catch (err) { amc.run[n] = { ok: false, msg: String(err.message || err).replace(/^\w*Error: /, "") }; }
  paint();
}
/* ---------- Accounts › Check every connection (GET /api/connections/check, py/studio/netcheck.py) ----------
   18 Nov: a Bluesky post failed with a bare 401 (the account's email was not verified) and Story numbers needed a Meta
   permission nobody knew was missing. The check asks each network once when Accounts opens (read-only, about 10 s) and
   lists only what needs a hand, each with its fix and the page to open. */
/* BL-135 (first-run walk 26 Nov): "No network is in use yet" sat under "Main · 6 networks in use". The check now asks
   about the networks the header counts (every one the project has not switched off, ?nets=), not only the ones already
   booked or posted, and the request is made again when that list changes. */
let ncView = null, ncBusy = false, ncNets = [], ncKey = null;
function runNetCheck() {
  if (ncBusy) return;
  ncBusy = true; ncKey = ncNets.join(","); setTimeout(() => { if (page === "accounts" && atHome()) renderHome(true); }, 0);  // through renderHome (drawAccounts alone dropped the Settings tab row), after any draw under way
  api("/api/connections/check" + (ncNets.length ? "?nets=" + encodeURIComponent(ncNets.join(",")) : "")).then((v) => { ncView = v; }, (err) => { ncView = { error: err.message }; })
    .finally(() => { ncBusy = false; if (page === "accounts" && atHome()) renderHome(true); });
}
/* Track C (24 Nov): the same finding on several networks is one line naming them all ("Your Chrome is not linked" was
   written out seven times, and the page ran 2.4 screens). */
function tcNcGroups(need) {
  const g = new Map();
  for (const n of need) for (const x of (n.checks || []).filter((c) => c.ok !== true)) {
    const k = [x.ok === false, x.say, x.fix || "", x.url || ""].join("\u0001");
    if (!g.has(k)) g.set(k, { x, nets: [] });
    g.get(k).nets.push(n);
  }
  return [...g.values()];
}
/* The check's networks as the page shows them: fine, a step still to do under Needs one step (inStep), or a finding to
   list. A network in its step keeps only a failed post of its own as a finding (BL-135). */
function ncSteps(nets, inStep) {
  const c = { ok: 0, step: 0, warn: 0, bad: 0 }, fine = [], need = [], steps = [];
  for (const n of nets) {
    const mine = inStep(n) ? (n.checks || []).filter((x) => x.id === "lastpost") : n.checks || [];
    const st = mine.some((x) => x.ok === false) ? "bad" : mine.some((x) => x.ok === null) ? "warn" : inStep(n) ? "step" : "ok";
    c[st]++;
    if (st === "ok") fine.push(n); else if (st === "step") steps.push(n); else need.push({ ...n, checks: mine });
  }
  return { c, fine, need, steps };
}
function netCheckHtml(once = [], inUse = []) {
  ncNets = inUse;
  if ((ncView === null || ncKey !== inUse.join(",")) && !ncBusy) runNetCheck();
  const V = ncView;
  const head = (state, say) => `<div class="nchead"><h2>${ico(state === "ok" ? "check" : "alert", "sm")}${tr("nc.h")}</h2><span class="meta">${say}</span><span class="grow"></span>
    <button class="linkish" data-netcheck="1" ${ncBusy ? "disabled" : ""}>${ico(ncBusy ? "hourglass" : "refresh", "sm")}${tr(ncBusy ? "nc.checking" : "nc.again")}</button></div>`;
  if (!V) return `<section class="netcheck">${head("ok", tr("nc.checking"))}</section>`;
  if (V.error) return `<section class="netcheck warn">${head("warn", esc(V.error))}</section>`;
  const nets = V.networks || [];
  if (!nets.length) return `<section class="netcheck">${head("ok", tr("nc.none"))}</section>`;
  // A network the header puts under Needs one step (connect once, link Chrome, check a sign-in once) counts as that step
  // here, never as "fine" (Track C, 24 Nov: "11 fine" above "Needs one step (4)") nor as a second problem: its sign-in
  // findings are the step's own row below. Only a failed post of its own is listed again (BL-135).
  const step = new Set(once.map((n) => chOf(n)).concat(once));
  const { c, fine, need, steps } = ncSteps(nets, (n) => step.has(n.network) || step.has(chOf(n.network)));
  const worst = c.bad ? "bad" : c.warn || c.step ? "warn" : "ok";
  const item = (x) => `<li><span class="${x.ok === false ? "t-bad" : "t-warn"}">${tr(x.ok === false ? "nc.bad" : "nc.warn")}</span> ${esc(x.say)}
    ${x.fix || x.url ? `<span class="ncfix">${esc(x.fix || "")}${x.url ? ` <a href="${escUrl(x.url)}" target="_blank" rel="noopener">${tr("nc.open")} ↗</a>` : ""}</span>` : ""}</li>`;
  // One row when nothing is wrong (24 Nov, Accounts ≤ 2 screens): only the counts that are not 0, each naming its
  // networks in its tooltip ("1 fine · 5 need one step below", the same numbers as Ready and Needs one step above).
  const sep = lang === "ja" ? "・" : ", ", names = (l) => l.map((n) => n.name).join(sep);
  const part = (n, key, cls, tip) => (n ? `<span class="${cls}" title="${esc(tip)}">${esc(tr(key, { n }))}</span>` : "");
  const sum = [part(c.ok, "rv.nc.ok", "", fine.length ? tr("nc.fine", { list: names(fine) }) : ""), part(c.step, "rv.nc.step", "t-warn", tr("rv.nc.steptip", { list: names(steps) })),
    part(c.warn, "rv.nc.warn", "t-warn", ""), part(c.bad, "rv.nc.bad", "t-bad", "")].filter(Boolean).join(" · ");
  return `<section class="netcheck ${worst}" aria-live="polite">${head(worst, sum + (V.at ? ` · ${esc(whenText(V.at))}` : ""))}
    ${need.length ? `<ul class="nclist">${tcNcGroups(need).map(({ x, nets: ns }) => `<li><span class="ncnet">${ns.map((n) => `<span class="tc-ncn">${netLogo(n.network, "sm")}${esc(n.name)}${n.account ? ` <span class="meta">${esc(n.account)}</span>` : ""}</span>`).join("")}</span>
      <ul>${item(x)}</ul></li>`).join("")}</ul>` : ""}</section>`;
}
document.addEventListener("click", (e) => { if (e.target.closest?.("[data-netcheck]")) runNetCheck(); });
function drawAccounts() {
  if (profilesKit === null) { profilesKit = undefined; loadAccounts(); }
  /* Back from a network's own sign-in page (server: /oauth/<network> → #/accounts?connected=… or ?connectError=…&why=…). */
  const back = /^#\/accounts\?(.+)$/.exec(location.hash);
  if (back) {
    const q = new URLSearchParams(back[1]), ok = q.get("connected"), bad = q.get("connectError");
    window.history.replaceState(null, "", "#/accounts");
    /* Only a network this studio knows, and escaped anyway: the address is the one thing any web page can set, and the toast
       is HTML (security review 13 Nov: a crafted #/accounts?connected=<img onerror=…> ran script as the studio). */
    if (ok && (connections[ok] || NET_NAME[ok])) { delete signErr[ok]; toast(`${ico("check", "sm")} ${esc(tr("acc.done", { n: connections[ok]?.name || NET_NAME[ok] }))}`, 6000); }
    if (bad && /^[a-z0-9-]{1,40}(:setup)?$/.test(bad)) signErr[bad] = q.get("why") || tr("acc.errtitle");
    profilesKit = undefined; loadAccounts();  // fetch the new connection state, then draw again
  }
  const ws = wsView?.list?.find((x) => x.id === wsView.running);
  const errBox = (msg) => msg ? `<div class="accerr" role="alert">${ico("alert", "sm")}<div><b>${tr("acc.errtitle")}</b><span>${esc(msg)}</span></div></div>` : "";
  /* The way that needs no keys: one big button that opens the network's own sign-in page. */
  const fbSetup = (id, c) => `<form class="accform" data-accsetup="${esc(id)}">
        <label><span class="meta">${tr("acc.fb.appid")}</span><input name="app_id" inputmode="numeric" autocomplete="off" spellcheck="false" required placeholder="${esc(c.signin.fields?.[0]?.placeholder || "")}" value="${esc(signDraft[id] || "")}"></label>
        <label><span class="meta">${tr("acc.fb.secret")}</span><input name="app_secret" type="password" autocomplete="off" spellcheck="false" required></label>
        ${errBox(signErr[id + ":setup"])}
        <div class="row acclinks"><button class="primary" type="submit">${ico("check", "sm")}${tr("acc.fb.save")}</button><a class="btn" href="${escUrl(c.signin.link || "https://developers.facebook.com/apps/")}" target="_blank" rel="noopener">${ico("link", "sm")}${tr("acc.fb.open")} ↗</a></div>
        <p class="meta">${tr("acc.fb.blocked", { u: esc(c.signin.redirect || "") })}</p></form>`;
  const oneClick = (id, c) => {
    if (!c.signin) return "";
    if (id === "bluesky") return `<form class="accform signform" data-signin="bluesky">
        <label><span class="meta">${tr("acc.bsky.handle")}</span><input name="handle" autocomplete="username" spellcheck="false" placeholder="name.bsky.social" value="${esc(signDraft[id] ?? (c.account || "").replace(/^@/, ""))}"></label>
        ${errBox(signErr[id])}
        <button class="primary big" type="submit">${ico("link", "sm")}${tr("acc.bsky.signin")}</button><p class="meta">${tr("acc.bsky.note")}</p></form>`;
    if (!c.signin.ready) return `<div class="fbsetup"><b>${tr("acc.fb.setup")}</b><p class="meta">${tr("acc.fb.setupnote")}</p>${fbSetup(id, c)}</div>`;
    return `<form class="accform signform" data-signin="${esc(id)}">${errBox(signErr[id])}
        <button class="primary big" type="submit">${ico("link", "sm")}${tr("acc.fb.connect")}</button><p class="meta">${tr("acc.fb.note")}</p></form>
      <details class="accother" ${signErr[id + ":setup"] ? "open" : ""}><summary class="meta">${tr("acc.fb.change")}</summary>${fbSetup(id, c)}</details>`;
  };
  /* The other way (keys pasted by hand) stays, folded away: an app password never runs out. */
  const manual = (id, c) => `<p class="meta">${esc(c.how || "")}</p>
      ${(c.links || []).length ? `<div class="row acclinks">${c.links.map((l) => `<a class="btn" href="${escUrl(l.url)}" target="_blank" rel="noopener">${ico("link", "sm")}${esc(l.label)} ↗</a>`).join("")}</div>` : ""}
      <form class="accform" data-accform="${esc(id)}">${(c.fields || []).map((f) => `<label><span class="meta">${esc(f.label)}</span><input name="${esc(f.key)}" type="${f.secret ? "password" : "text"}" autocomplete="off" spellcheck="false" placeholder="${esc(f.key === "handle" && c.account ? c.account.replace(/^@/, "") : f.placeholder || "")}" value="${esc(accDraft[id]?.[f.key] ?? (f.key === "handle" ? (c.account || "").replace(/^@/, "") : ""))}" ${f.optional ? "" : "required"}></label>`).join("")}
        ${errBox(accErr[id])}
        <button class="primary" type="submit">${ico("link", "sm")}${tr("acc.connect")}</button></form>`;
  const until = (c) => c.until ? `<p class="meta">${tr("acc.until", { d: esc(new Date(c.until).toLocaleDateString(lang === "ja" ? "ja-JP" : undefined, { month: "short", day: "numeric" })) })}</p>`
    : c.fallback ? `<p class="meta">${ico("check", "sm")} ${tr("acc.bsky.kept")}</p>` : "";
  /* Each network the project uses lands in one of three groups, by what the person has to do:
     needs one step (connect or sign in once), ready (and how it gets posted), or not used. */
  freshYt();
  const signedIn = (n) => helperView?.signins?.[n] ?? null;
  const viaChrome = helperView?.browser?.mode === "extension", chromeOn = viaChrome && !!helperView?.browser?.connected;
  const SCHED_NETS = ["x", "tiktok", "gbp", "line-oa", "linkedin", "pinterest"];  // the studio schedules these itself through your Chrome
  const stateOf = (n) => {
    const s = chanOf(n), c = connections[n];
    if (s.off) return { group: "off" };
    if (n === "youtube") return yt.connected ? { group: "ready", how: "studio", who: yt.channel?.title } : { group: "todo", how: "studio", act: "yt" };
    if (c) {
      if (c.connected && !c.error) {
        const left = c.until ? new Date(c.until).getTime() - Date.now() : Infinity;
        const after = c.until ? postsLog.some((p) => p.network === n && ["scheduled", "queued"].includes(p.status) && new Date(p.at) > new Date(c.until)) : false;
        const soon = left < 3 * 864e5 || (after && left < 14 * 864e5);  // posts booked past the end would not go out
        return { group: soon ? "todo" : "ready", how: "studio", who: c.account, until: c.until, act: soon ? "connect" : "", expiring: soon };
      }
      return { group: "todo", how: "studio", act: "connect" };
    }
    // A site the studio cannot check from outside counts as ready once the person says they are signed in (asked again after 30 days).
    const said = +lsGet("studio.signedin." + n, 0), saidOk = said && Date.now() - said < 30 * 864e5;
    if (HELPER_NETS.includes(n)) return signedIn(n) === true || (signedIn(n) === null && saidOk) ? { group: "ready", how: "helper", said: signedIn(n) === null ? said : 0 } : { group: "todo", how: "helper", act: "helper", unknown: signedIn(n) === null };
    return s.upload ? { group: "ready", how: "hand" } : { group: "todo", how: "hand", act: "" };
  };
  if (!channelsSpec?.channels) {  // the project's network list is still loading: show the shape, not a half page
    $("#home").innerHTML = `<div class="pagehead">${crumbs([tr("nav.settings")])}</div><div class="skel skel-line" style="width:55%"></div><div class="skel skel-line" style="width:35%"></div><div class="agrid" style="margin-top:14px">${'<div class="skel" style="height:150px"></div>'.repeat(4)}</div>`;
    return;
  }
  const nets = POST_NETS.filter((n) => chanOf(n)).sort((a, b) => (netTier(a) === "common" ? 0 : 1) - (netTier(b) === "common" ? 0 : 1));  // BL-116: common first
  const st = Object.fromEntries(nets.map((n) => [n, stateOf(n)]));
  const by = (g) => nets.filter((n) => st[n].group === g);
  const HOW_TONE = { studio: "s-posted", helper: "", hand: "" };
  const headOf = (n, x) => { const s = chanOf(n);
    // A checked account (a connection's own name) first, then the handle saved for this project (networks.json
    // "accounts"), the generic channels.json wording last: 24 Nov the TikTok card still read the old handle after the
    // move to the new handle, and Pinterest read the old board name.
    const named = s.account || s.who || "";
    const sub = x.who ? `${ico("check", "sm")} ${esc(x.who)}` : esc(named);
    return `<div class="row">${netLogo(n === "youtube" ? "youtube" : n, 28)}<div class="acname"><b>${esc(NET_NAME[n] || n)}</b><div class="meta" title="${esc(x.who || named)}">${sub}</div></div>${pillOf(n, x)}</div>`; };
  const pillOf = (n, x) => {
    if (x.expiring) return mp("clock", tr("acc.st.expires", { d: new Date(connections[n].until).toLocaleDateString(lang === "ja" ? "ja-JP" : "en-GB", { month: "short", day: "numeric" }) }), "s-topost");
    return x.group === "ready" ? mp(x.how === "studio" ? "send" : x.how === "helper" ? (viaChrome ? "link" : "globe") : "download", tr({ studio: "acc.st.studio", helper: viaChrome ? "acc.st.mychrome" : "acc.st.helper", hand: "acc.st.hand" }[x.how]), HOW_TONE[x.how])
      : mp("alert", tr(x.how === "helper" ? (!viaChrome ? "acc.st.signin" : !chromeOn ? "acc.st.chrome" : x.unknown ? "acc.st.check" : "acc.st.chromesign") : "acc.st.connect"), "s-topost"); };
  // Bluesky posts booked after its two-week sign-in ends: an app password (folded under "Other way") keeps them going.
  const bskyAfter = (c) => postsLog.filter((p) => p.network === "bluesky" && ["scheduled", "queued"].includes(p.status) && new Date(p.at) > new Date(c.until)).length;
  /* Ready: one compact card each (logo, name, account, how it posts, one line); how to post there, the settings and
     Disconnect fold into one "More" per card, so the cards line up and the map above stays the overview. */
  const settingsInner = (n) => { const s = chanOf(n); return `<div class="acset-in"><b class="meta">${ico("list", "sm")}${tr("acc.settings")}</b>
      <label class="switch"><input type="checkbox" data-neton="${esc(chOf(n))}" ${s.off ? "" : "checked"}><span>${tr("acc.use")}</span></label>
      <label><span class="meta">${tr("acc.acct")}</span><input class="acct" data-netacct="${esc(chOf(n))}" value="${esc(s.account || "")}" placeholder="${esc(tr("acc.acctph"))}"></label></div>`; };
  const card = (n) => { const x = st[n], s = chanOf(n), c = connections[n];
    const igs = connections["instagram-story"], storyBad = n === "facebook" && igs && !igs.connected;
    const line = n === "facebook" && igs?.connected ? tr("acc.fbline") : x.how === "studio" ? tr(n === "youtube" || c?.canSchedule ? "acc.canhold" : "acc.studiosends") : x.how === "helper" ? tr(viaChrome ? (SCHED_NETS.includes(n) ? "acc.chrome.sched" : "acc.chrome.fill") : "acc.help.ready") : tr("acc.hand.ready");
    const off = c?.connected ? `<button type="button" class="acoff" data-accoff="${esc(n)}">${ico("x", "sm")}${tr("acc.disconnect")}</button>`  /* BL-067: a real button, not a link */ : x.how === "helper" && !viaChrome ? `<button class="linkish" data-helpsign="${esc(n)}">${tr("acc.help.again")}</button>` : "";
    return `<article class="acard ready" id="acc-${esc(n)}" style="--nc:${CH_STYLE[n]?.bg || CH_STYLE[chOf(n)]?.bg || "var(--accent)"}">${headOf(n, x)}
      <p class="meta acline" title="${esc(line)}">${line}</p>
      ${storyBad ? `<p class="meta warnline">${ico("alert", "sm")} ${tr("acc.igs.off", { why: esc(igs.error || "") })}</p>${c?.signin?.ready ? `<form class="accform signform" data-signin="facebook"><button class="primary" type="submit">${ico("link", "sm")}${tr("acc.igs.again")}</button></form>` : ""}` : ""}
      ${s.blocker ? `<p class="meta bad">${ico("alert", "sm")} ${esc(s.blocker)}</p>` : ""}
      <details class="acmore"><summary class="meta"><span class="acdots" aria-hidden="true">⋯</span>${tr("acc.more")}</summary><div class="acmore-b">
        ${n === "facebook" && igs?.connected ? `<p class="meta">${ico("check", "sm")} ${tr("acc.igs.on", { a: esc(igs.account || "") })}</p>` : ""}${x.until ? until(c) : ""}
        ${playbookHtml(n).replace('<details class="pb">', '<details class="pb" open>')}${settingsInner(n)}${off}</div></details></article>`; };
  const rowOf = (n) => { const x = st[n], c = connections[n], name = NET_NAME[n] || n;
    const open = accOpen.has(n) || !!accErr[n] || !!signErr[n] || !!signErr[n + ":setup"];
    const d = c?.until ? new Date(c.until).toLocaleDateString(lang === "ja" ? "ja-JP" : "en-GB", { month: "short", day: "numeric" }) : "";
    const toggle = (label, primary) => `<button type="button" class="${primary ? "primary" : "linkish"}" data-accopen="${esc(n)}" aria-expanded="${open}" aria-controls="accp-${esc(n)}">${primary ? ico("link", "sm") : ""}${open ? tr("acc.r.close") : label}</button>`;
    const signLink = (label, primary) => `<form class="signform acr-form" data-signin="${esc(n)}"><input type="hidden" name="handle" value="${esc((c?.account || "").replace(/^@/, ""))}"><button type="submit" class="${primary ? "primary" : "linkish"}">${primary ? ico("link", "sm") : ""}${label}</button></form>`;
    let line = "", acts = "", panel = "";
    if (x.act === "yt") { line = tr("acc.yt.why"); acts = `<a class="btn primary" href="/api/youtube/connect">${ico("play", "sm")}${tr("yt.connect")}</a>`; }
    else if (x.act === "connect" && c && x.expiring) {
      const k = n === "bluesky" ? bskyAfter(c) : 0, a = c.account || name;
      line = esc(tr(k ? "acc.r.expiring" : "acc.r.expiring0", { a, d, k, n: name }));
      acts = c.fields?.length ? toggle(tr("acc.r.addpw"), true) + (c.signin ? signLink(tr("acc.r.again"), false) : "") : c.signin ? signLink(tr("acc.r.again"), true) : "";
      panel = manual(n, c);
    } else if (x.act === "connect" && c) {
      line = c.error ? `<span class="bad">${c.via === "signin" ? tr("acc.bsky.ranout") : esc(c.error)}</span>` : esc(tr("acc.r.connect"));
      if (c.signin && (n === "bluesky" || c.signin.ready)) { acts = signLink(n === "bluesky" ? tr("acc.bsky.signin") : tr("acc.fb.connect"), true) + (c.fields?.length ? toggle(tr("acc.r.other"), false) : ""); panel = manual(n, c) + errBox(signErr[n]); }
      else if (c.signin) { acts = toggle(tr("acc.r.setup"), true); panel = oneClick(n, c); }
      else { acts = toggle(tr("acc.connect"), true); panel = manual(n, c); }
    } else if (x.act === "helper" && viaChrome && !chromeOn) line = tr("acc.chrome.card");
    else if (x.act === "helper" && viaChrome) {
      line = tr(x.unknown ? "acc.chrome.unknown" : "acc.chrome.signin", { n: esc(name) });
      acts = `<button class="primary" data-helpsign="${esc(n)}">${ico("link", "sm")}${tr("acc.chrome.open", { n: esc(name) })}</button>${x.unknown ? `<button data-saidsigned="${esc(n)}">${ico("check", "sm")}${tr("acc.saidsigned")}</button>` : ""}`;
    } else if (x.act === "helper") {
      line = n === "threads" ? tr("acc.threads.q") : "";
      acts = `<button class="primary" data-helpsign="${esc(n)}">${ico("link", "sm")}${tr("acc.help.signin", { n: esc(name) })}</button>`;
      if (n === "threads") { acts += toggle(tr("acc.r.how"), false); panel = `<p class="meta">${tr("acc.threads.tip")}</p>`; }
    } else line = tr("acc.hand.why");
    const acct = x.who || c?.account || chanOf(n)?.account || "";
    return `<li class="acrow${x.expiring ? " warn" : ""}${open && panel ? " open" : ""}" id="acc-${esc(n)}" style="--nc:${CH_STYLE[n]?.bg || CH_STYLE[chOf(n)]?.bg || "var(--accent)"}">
      ${netLogo(n === "youtube" ? "youtube" : n, 28)}
      <div class="acr-main"><div class="acr-top"><b>${esc(name)}</b>${acct ? `<span class="meta">${esc(acct)}</span>` : ""}${pillOf(n, x)}</div>
        ${line ? `<p class="acr-line">${line}</p>` : ""}${chanOf(n)?.blocker ? `<p class="meta bad">${ico("alert", "sm")} ${esc(chanOf(n).blocker)}</p>` : ""}</div>
      <div class="acr-acts">${acts}</div>
      ${open && panel ? `<div class="acr-panel" id="accp-${esc(n)}">${panel}</div>` : ""}</li>`; };
  const todo = by("todo"), ready = by("ready"), off = by("off");
  const helperTodo = todo.filter((n) => st[n].how === "helper");
  /* Chrome not linked yet: the networks that wait on it are named inside the one Connect box, not as identical cards. */
  const waitChrome = viaChrome && !chromeOn ? helperTodo : [];
  const todoCards = todo.filter((n) => !waitChrome.includes(n));
  const OFF_WHY = { instagram: tr("off.instagram"), threads: tr("off.threads"), "line-voom": tr("off.linevoom") };
  /* BL-116: the common networks first; the rest fold under "More networks (N)", open by itself only when one is on.
     Off common networks stay under Not used, as before. */
  const offCommon = off.filter((n) => netTier(n) === "common"), moreNets = nets.filter((n) => netTier(n) !== "common"), moreOn = moreNets.filter((n) => st[n].group !== "off");
  const offWhy = (n) => OFF_WHY[chOf(n)] || OFF_WHY[n] || chanOf(n)?.who || "";
  const offRow = (n) => `<li>${netLogo(n === "youtube" ? "youtube" : n, 22)}<span title="${esc(offWhy(n))}"><b>${esc(NET_NAME[n] || n)}</b> <span class="meta">${esc(offWhy(n))}</span></span>
      <label class="switch"><input type="checkbox" data-neton="${esc(chOf(n))}" ${st[n].group === "off" ? "" : "checked"}><span>${tr("acc.use")}</span></label></li>`;
  const offRows = offCommon.map(offRow).join("");
  const kit = profilesKit?.networks || {};
  const KIT_LABEL = { name: tr("acc.k.name"), bio: tr("acc.k.bio"), link: tr("acc.k.link") };
  const kitHtml = Object.keys(kit).length ? Object.entries(kit).map(([n, k]) => `<article class="kit">${netLogo(chOf(n) || n, 22)}<b>${esc(NET_NAME[n] || n)}</b>
      ${[["name", k.name || profilesKit.displayName], ["bio", k.bio], ["link", k.link]].filter(([, v]) => v).map(([lab, v]) => `<div class="kitrow"><span class="meta">${KIT_LABEL[lab]}</span><span class="clamp">${esc(v)}</span><button class="icon" data-kitcopy="${esc(v)}" title="${esc(tr("x.copy"))}" aria-label="${esc(tr("x.copy"))}">${ico("copy", "sm")}</button></div>`).join("")}</article>`).join("")
    : `<p class="meta">${tr("acc.k.none")}</p>`;
  const sum = `<div class="accsum" role="status">
      <span class="accnum ok"><b>${ready.length}</b>${tr("acc.g.ready")}</span>
      <span class="accnum todo"><b>${todo.length}</b>${tr("acc.g.todo")}</span>
      <span class="accnum"><b>${off.length}</b>${tr("acc.g.off")}</span>
</div>`;
  $("#home").innerHTML = `<div class="pagehead">${crumbs([tr("nav.settings")])}<span class="grow"></span>${ws ? `<button class="wschip" data-wsopen="1" style="--ws:${esc(ws.color)}"><span class="wsdot"></span>${esc(ws.name)}${ico("chev-r", "sm")}</button>` : ""}</div>
    <p class="meta accintro">${tr("acc.intro")}</p>${sum}
    ${netCheckHtml(by("todo"), nets.filter((n) => st[n].group !== "off"))}
    ${accMapHtml(nets.filter((n) => st[n].group !== "off"), st, { viaChrome, chromeOn, ws })}
    ${todo.length ? `<section class="accsec"><h2>${ico("alert", "sm")}${tr("acc.g.todo")}<span class="count">${todo.length}</span></h2><p class="meta">${tr("acc.g.todonote")}</p>
      ${helperTodo.length && helperView?.browser?.mode === "extension" && helperView.browser.connected && !helperView.browser.pending && !waitChrome.length
        // Connected: a status line, not a box among the steps (it has nothing to press).
        ? `<p class="meta chromeok">${ico("link", "sm")} <b>${tr("acc.chrome.on")}</b>${helperView.browser.note && !/^connected to your chrome\.?$/i.test(String(helperView.browser.note).trim()) ? ` · ${esc(helperView.browser.note)}` : ""}</p>`
        : helperTodo.length && helperView?.browser?.mode === "extension" ? `<div class="helpnote">${ico("link", "sm")}<div><b>${tr(helperView.browser.connected ? "acc.chrome.on" : "acc.chrome.title")}</b><p class="meta">${esc(helperView.browser.pending?.message || (helperView.browser.connected ? helperView.browser.note : "") || helperView.browser.error || tr("acc.chrome.why"))}</p>${waitChrome.length ? `<ul class="waitnets">${waitChrome.map((n) => `<li>${netLogo(n, 18)}${esc(NET_NAME[n] || n)}</li>`).join("")}</ul>` : ""}${helperView.browser.autoConnect ? "" : `<p class="meta"><a href="#/keys/chrome">${tr("cl.nudge")}</a></p>`}</div>${helperView.browser.connected ? "" : `<button class="primary" data-chromeconnect="1">${ico("link", "sm")}${tr(helperView.browser.pending ? "acc.chrome.again" : "acc.chrome.go")}</button>`}</div>`
        : helperTodo.length ? `<div class="helpnote">${ico("info", "sm")}<div><b>${tr("acc.help.title")}</b><p class="meta">${tr("acc.help.group")}</p></div>${helperTodo.length > 1 ? `<button class="primary" data-helpsign="*">${ico("link", "sm")}${tr("acc.help.all", { k: helperTodo.length })}</button>` : ""}</div>` : ""}
      ${todoCards.length ? `<ul class="acrows">${todoCards.map(rowOf).join("")}</ul>` : ""}</section>` : ""}
    ${ready.length ? `<details class="accsec accfold acc-readyfold" ${todo.length ? "" : "open"}><summary><h2>${ico("check", "sm")}${tr("acc.g.ready")}<span class="count">${ready.length}</span></h2><span class="acc-readylogos" aria-hidden="true">${ready.map((n) => netLogo(chOf(n), "sm")).join("")}</span></summary><p class="meta">${tr("acc.g.readynote")}</p><div class="agrid acready">${ready.map(card).join("")}</div></details>`: ""}
    ${offCommon.length ? `<details class="accsec accfold"><summary><h2>${ico("eye", "sm")}${tr("acc.g.off")}<span class="count">${offCommon.length}</span></h2></summary><p class="meta">${tr("acc.g.offnote")}</p><ul class="offlist">${offRows}</ul></details>` : ""}
    ${moreNets.length ? `<details class="accsec accfold acc-more" ${moreOn.length ? "open" : ""}><summary><h2>${ico("grid", "sm")}${esc(tr("acc.g.more", { n: moreNets.length }))}${moreOn.length ? `<span class="count">${esc(tr("acc.g.moreon", { n: moreOn.length }))}</span>` : ""}</h2><span class="acc-readylogos" aria-hidden="true">${moreNets.map((n) => netLogo(chOf(n), "sm")).join("")}</span></summary><p class="meta">${esc(tr("acc.g.morenote"))}</p><ul class="offlist">${moreNets.map(offRow).join("")}</ul></details>` : ""}
    ${playbooks.length ? `<details class="accsec accfold" id="strategy"><summary><h2>${ico("info", "sm")}${tr("pb.all")}</h2></summary><p class="meta">${tr("pb.allnote")}</p>
      <div class="agrid pbgrid">${nets.filter((n) => st[n].group !== "off" && pbOf(n)).map((n) => `<article class="acard pbcard">${`<div class="row">${netLogo(n === "youtube" ? "youtube" : n, 24)}<div class="acname"><b>${esc(NET_NAME[n] || n)}</b><div class="meta">${esc(pbOf(n).role || "")}</div></div></div>`}${playbookHtml(n).replace('<details class="pb">', '<details class="pb pball" open>')}</article>`).join("")}</div></details>` : ""}
    <details class="accsec accfold"><summary><h2>${ico("user", "sm")}${tr("acc.h3")}</h2></summary><p class="meta">${tr("acc.h3note")}</p><div class="kits">${kitHtml}</div></details>`;
}

/* A network's playbook as a short guide: what it is for, the video, the words, tags, when, the profile and
   how to answer comments (with copy buttons for the calm replies). Rules come from shared/playbooks.json. */
function playbookHtml(n) {
  const b = pbOf(n); if (!b) return "";
  const f = b.format || {}, c = b.caption || {}, h = b.hashtags || {}, t = b.times || {}, pr = b.profile || {}, cm = b.community || {};
  const secs = Array.isArray(f.idealSec) ? `${f.idealSec[0]}–${f.idealSec[1]}s` : f.idealSec ? `${f.idealSec}s` : "";
  const row = (label, val) => val ? `<div class="pbrow"><span class="meta">${label}</span><span>${val}</span></div>` : "";
  const copyBtn = (v) => `<button class="icon" data-kitcopy="${esc(v)}" title="${esc(tr("x.copy"))}" aria-label="${esc(tr("x.copy"))}">${ico("copy", "sm")}</button>`;
  const tags = (h.examples || []).join(" ");
  const tpl = [["ja", cm.angryTemplateJa], ["en", cm.angryTemplateEn], ["zh", cm.angryTemplateZh]].filter(([, v]) => v);
  return `<details class="pb"><summary class="meta">${ico("info", "sm")}${tr("pb.title")}</summary>
    ${b.status ? `<p class="bad">${ico("alert", "sm")} ${esc(b.status)}</p>` : ""}
    ${row(tr("pb.role"), esc(b.role || ""))}
    ${row(tr("pb.video"), esc([secs, f.aspect, f.hook].filter(Boolean).join(" · ")))}
    ${row(tr("pb.words"), esc([c.idealChars ? tr("pb.chars", { n: c.idealChars, m: c.maxChars ?? "?" }) : "", (c.languages || []).join("/"), c.cta].filter(Boolean).join(" · ")))}
    ${c.linkInCaption === false ? row(tr("pb.link"), `<span class="warn">${tr("pb.nolink")}</span>`) : ""}
    ${(c.avoid || []).length ? row(tr("pb.avoid"), esc(c.avoid.join(" · "))) : ""}
    ${row(tr("pb.tags"), `${h.max ? esc(tr("pb.tagcount", { a: h.min ?? 0, b: h.max })) : esc(tr("pb.notags"))}${h.mix ? ` · ${esc(h.mix)}` : ""}${tags ? `<span class="pbtags">${esc(tags)} ${copyBtn(tags)}</span>` : ""}`)}
    ${row(tr("pb.when"), esc([(t.bestJst || []).join(", ") + (t.bestJst?.length ? " JST" : ""), t.cadencePerWeek ? tr("pb.week", { n: Math.min(7, t.cadencePerWeek) }) : ""].filter(Boolean).join(" · ")))}
    ${row(tr("pb.profile"), esc([pr.bioMax ? tr("pb.bio", { n: pr.bioMax }) : "", pr.linkSlot, pr.pin, ...(pr.tips || [])].filter(Boolean).join(" · ")))}
    ${row(tr("pb.comments"), esc([cm.replyWithinHours ? tr("pb.reply", { n: cm.replyWithinHours }) : "", cm.tone, cm.spam].filter(Boolean).join(" · ")))}
    ${tpl.length ? `<div class="pbtpl"><span class="meta">${tr("pb.angry")}</span>${tpl.map(([l, v]) => `<div class="pbline"><b>${l.toUpperCase()}</b><span>${esc(v)}</span>${copyBtn(v)}</div>`).join("")}</div>` : ""}
    ${(cm.features || []).length ? row(tr("pb.tools"), esc(cm.features.join(" · "))) : ""}
  </details>`;
}
/* What was typed into a connect form stays (in this page's memory only) through redraws and failed tries;
   a failure is shown inside that card, in the words the network check wrote, not as a passing toast. */
const accDraft = {}, accErr = {};
/* Needs one step: which rows have their form open (the app password, the other way); closed by default. */
const accOpen = new Set();
document.addEventListener("click", (e) => {
  const b = e.target.closest?.("[data-accopen]"); if (!b) return;
  const n = b.dataset.accopen;
  if (accOpen.has(n) || accErr[n] || signErr[n]) { accOpen.delete(n); delete accErr[n]; delete signErr[n]; } else accOpen.add(n);
  renderHome(true);
  if (accOpen.has(n)) requestAnimationFrame(() => document.querySelector(`#accp-${CSS.escape(n)} input:not([type=hidden])`)?.focus());
});
/* One-click sign-in: the handle (Bluesky) or App ID (Facebook) typed so far, and the last problem per card. */
const signDraft = {}, signErr = {};
document.addEventListener("input", (e) => {
  const s = e.target.closest?.("[data-signin], [data-accsetup]");
  if (s && (e.target.name === "handle" || e.target.name === "app_id")) { signDraft[s.dataset.signin || s.dataset.accsetup] = e.target.value; return; }
  const f = e.target.closest?.("[data-accform]"); if (!f || !e.target.name) return;
  (accDraft[f.dataset.accform] ||= {})[e.target.name] = e.target.value;
});
document.addEventListener("submit", async (e) => {
  const f = e.target.closest("[data-signin]"); if (!f) return;
  e.preventDefault();
  const net = f.dataset.signin, btn = f.querySelector("button[type=submit]");
  btn.disabled = true; btn.textContent = tr("acc.opening");
  try {
    const r = await post("/api/connect/start", { network: net, handle: String(new FormData(f).get("handle") || "").trim() });
    delete signErr[net];
    location.href = r.url;  // the network's own page; it sends the browser back to the Accounts page
    return;
  } catch (err) { signErr[net] = err.message.replace(/^\w*Error: /, ""); }
  renderHome(true);
  document.querySelector(`[data-signin="${net}"] .accerr`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
});
document.addEventListener("submit", async (e) => {
  const f = e.target.closest("[data-accsetup]"); if (!f) return;
  e.preventDefault();
  const net = f.dataset.accsetup, d = new FormData(f), btn = f.querySelector("button[type=submit]");
  btn.disabled = true; btn.textContent = tr("acc.checking");
  try {
    connections = await post("/api/connect/setup", { network: net, fields: { app_id: String(d.get("app_id") || "").trim(), app_secret: String(d.get("app_secret") || "").trim() } });
    delete signErr[net + ":setup"]; delete signDraft[net];
    toast(`${ico("check", "sm")} ${tr("acc.fb.saved")}`, 6000);
  } catch (err) { signErr[net + ":setup"] = err.message.replace(/^\w*Error: /, ""); }
  renderHome(true);
});
document.addEventListener("submit", async (e) => {
  const f = e.target.closest("[data-accform]"); if (!f) return;
  e.preventDefault();
  const net = f.dataset.accform;
  const fields = Object.fromEntries([...new FormData(f).entries()].map(([k, v]) => [k, String(v).trim()]).filter(([, v]) => v));
  const btn = f.querySelector("button[type=submit]"); btn.disabled = true; btn.textContent = tr("acc.checking");
  try {
    connections = await post("/api/connections", { network: net, fields });
    delete accErr[net]; delete accDraft[net]; accOpen.delete(net);
    toast(`${ico("check", "sm")} ${tr("acc.done", { n: connections[net]?.name || net })}`, 5000);
  } catch (err) { accErr[net] = err.message.replace(/^w*Error: /, ""); }
  renderHome(true);
  if (accErr[net]) document.querySelector(`[data-accform="${net}"] .accerr`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
});
document.addEventListener("change", async (e) => {
  const on = e.target.closest("[data-neton]"), ac = e.target.closest("[data-netacct]");
  if (!on && !ac) return;
  try {
    channelsSpec = await post("/api/channels/set", on ? { id: on.dataset.neton, on: on.checked } : { id: ac.dataset.netacct, account: ac.value });
    toast(`${ico("check", "sm")} ${tr("acc.saved")}`, 2500);
  } catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 6000); }
  renderHome(true);
});
/* Connect the helper to this Chrome: answers at once; the page then polls until the person presses Allow & select. */
document.addEventListener("click", async (e) => {
  const c = e.target.closest?.("[data-chromeconnect]"); if (!c) return;
  c.disabled = true;
  try { const r = await post("/api/helper/connect", {}); helperView = { ...(helperView || {}), browser: r.browser }; toast(`${ico("link", "sm")} ${esc(r.browser?.pending?.message || tr("acc.chrome.waiting"))}`, 15000); }
  catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000); }
  renderHome(true);
  const t0 = Date.now(), tick = setInterval(async () => {
    const h = await api("/api/helper").catch(() => null);
    if (h) helperView = h;
    if (!h?.browser?.pending || Date.now() - t0 > 600000) { clearInterval(tick); profilesKit = undefined; loadAccounts(); }
    else if (page === "accounts") renderHome(true);
  }, 3000);
});
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-helpsign]"); if (!b) return;
  const nets = b.dataset.helpsign === "*" ? [] : [b.dataset.helpsign];
  b.disabled = true;
  if (helperView?.browser?.mode === "extension") toast(`${ico("link", "sm")} ${tr("acc.chrome.waiting")}`, 180000);
  try {
    let r;
    try { r = await post("/api/helper/signin", { networks: nets }); }
    catch (err) {
      if (!/not installed/i.test(err.message)) throw err;
      toast(`${ico("download", "sm")} ${tr("pub.helperinstalling")}`, 60000);
      await post("/api/helper/install", {});
      r = await post("/api/helper/signin", { networks: nets });
    }
    toast(`${ico("check", "sm")} ${r.opened ? tr("acc.help.opened", { list: r.opened.map((n) => NET_NAME[n] || n).join(", ") || "-" }) : esc(r.message || tr("acc.chrome.on"))}`, 12000);
  } catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000); }
  b.disabled = false; profilesKit = undefined; loadAccounts();
});
/* Back on this tab after signing in elsewhere: read the helper's sign-ins again. */
window.addEventListener("focus", () => { if (page === "accounts" && atHome()) { profilesKit = undefined; loadAccounts(); } });
document.addEventListener("click", async (e) => {
  const off = e.target.closest("[data-accoff]"), kc = e.target.closest("[data-kitcopy]");
  if (kc) { await navigator.clipboard.writeText(kc.dataset.kitcopy); toast(`${ico("copy", "sm")} ${tr("pd.copied")}`); return; }
  if (!off) return;
  if (!confirm(tr("acc.askoff", { n: connections[off.dataset.accoff]?.name || off.dataset.accoff }))) return;
  try { connections = await post("/api/connections", { network: off.dataset.accoff, remove: true }); } catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 6000); }
  renderHome(true);
});

