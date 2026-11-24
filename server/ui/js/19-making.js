/* ---------- Batch C (18 Nov): making and reviewing, made visible ----------
   1 Being made: each reel's real stages as a strip (psStrip), the live one moving, a failed one red with its cause.
   2 Review: where a reel would land if approved, by the Plan posts rules (cLandsHtml). Read only: it books nothing.
   3 Editor: the Issues lane under the ruler, from ONE list (edIssues) that the rules chip and Properties read too.
   4 Words: how worn each headline is (cWearData; drawn by wHeadlinesHtml). 5 Versions: the shot diff (cVerDiffHtml). 6 Hover-scrub on reel
   cards (cScrub*, beside the quick player). 7 Results › Activity log: the job swimlane, with the other project's jobs
   hidden by default (cSwim*). */

/* 1. Being made. The stages are the ones the renderer prints (py/studio/reels.py, STAGE n/7): best moments, the three
   sizes, sound, the network copies, the review sheet. A sound remix starts at the mix, so its picture stages are
   skipped. The server keeps when each stage began (stageAt) and, once two runs have them, each stage's usual time. */
const C_BUILD = ["c_ps.grade", "c_ps.r916", "c_ps.r45", "c_ps.r169", "c_ps.sound", "c_ps.nets", "c_ps.sheet"];
const cSeen = new WeakMap();  // when this page got each job snapshot: the clocks tick on from there
const cAge = (j) => { if (!cSeen.has(j)) cSeen.set(j, Date.now()); return (Date.now() - cSeen.get(j)) / 1000; };
function psSteps(j) {
  const n = Math.max(1, j.stages || 7), named = n === 7 && RENDER_KINDS.includes(j.kind), first = j.kind === "remix" ? 5 : 1;
  const st = j.status, cur = ["running", "error"].includes(st) ? Math.max(first, j.stage || first) : 0;
  const steps = [{ k: "q", label: tr("c_ps.queued"), s: st === "queued" ? "now" : "done" }];
  for (let k = 1; k <= n; k++) steps.push({ k, label: named ? tr(C_BUILD[k - 1]) : tr("c_ps.step", { n: k }),
    s: k < first ? "skip" : st === "queued" ? "todo" : st === "done" || k < cur ? "done" : k === cur ? (st === "error" ? "fail" : "now") : "todo" });
  steps.push({ k: "r", label: tr("c_ps.ready"), s: st === "done" ? "done" : "todo" });
  return { steps, cur, n, first };
}
/* The numbers under the strip: time in this stage, time so far, and time left only when past runs give one. */
function psTimes(j) {
  const age = j.status === "running" ? cAge(j) : 0, el = (j.seconds || 0) + age;
  const at = j.stageAt?.[j.stage], inStage = at != null ? Math.max(0, el - at) : null;
  const typ = j.stageTypical?.[j.stage], frac = j.of ? Math.min(1, (j.done || 0) / j.of) : typ && inStage != null ? Math.min(0.95, inStage / typ) : null;
  const left = j.typical && j.eta != null ? Math.max(0, j.eta - age) : null;
  return { el, inStage, typ, frac, left };
}
function psClock(j) {
  const t = psTimes(j), bits = [];
  if (t.inStage != null) bits.push(tr("c_ps.instage", { t: mmss(t.inStage) }) + (t.typ ? ` ${tr("c_ps.usual", { t: mmss(t.typ) })}` : ""));
  bits.push(tr("c_ps.sofar", { t: mmss(t.el) }));
  bits.push(t.left != null ? mins(t.left) : tr("c_ps.noeta"));
  return bits.join(" · ");
}
function psStrip(r) {
  const j = r.job || {}; if (!["queued", "running", "error"].includes(j.status)) return "";
  const { steps, cur, n } = psSteps(j), t = j.status === "running" ? psTimes(j) : {};
  const fresh = j.status === "running" && !moCalm();
  // The live stage's stripes run from the clock, so a repaint (every second here) never restarts them.
  const live = fresh ? ` style="animation-delay:-${((Date.now() % 1400) / 1000).toFixed(2)}s"` : "";
  const li = steps.map((x) => `<li class="ps-s s-${x.s}"${x.s === "now" ? ` aria-current="step"` : ""} title="${esc(x.label)}${x.s === "skip" ? " · " + esc(tr("c_ps.skipped")) : ""}">
      <span class="ps-bar">${x.s === "now" && j.status === "running" ? `<b class="ps-fill${t.frac == null ? " ind" : ""}" style="--p:${t.frac == null ? 1 : t.frac.toFixed(3)}"><i${live}></i></b>` : ""}</span><span class="ps-l">${esc(x.label)}</span></li>`).join("");
  const cause = j.status === "error" ? (j.cause ? j.cause[lang === "ja" ? 1 : 0] : plainFail((j.lines || []).filter(Boolean).slice(-1)[0])) : "";
  const where = j.status === "error" ? tr("c_ps.stopped", { s: steps.find((x) => x.s === "fail")?.label || "" })
    : j.status === "queued" ? tr("c_ps.waiting", { n: j.position || "…" }) : `${tr("c_ps.stageof", { k: cur, n })} · ${esc(jobLabel(j.label))}${j.of > 1 ? ` · ${j.done || 0}/${j.of}` : ""}`;
  return `<div class="ps st-${esc(j.status)}" data-ps="${esc(r.slug)}" role="group" aria-label="${esc(tr("c_ps.aria", { s: reelName(r.slug) }))}">
    <ol class="ps-steps" style="--n:${steps.length}">${li}</ol>
    <p class="ps-line">${j.status === "error" ? `${ico("alert", "sm")}<b>${esc(where)}</b> <span class="ps-cause">${esc(cause)}</span>` : `<b>${where}</b>${j.status === "running" ? ` <span class="ps-clock" data-psclock="${esc(r.slug)}">${esc(psClock(j))}</span>` : ""}`}</p></div>`;
}
/* Every second on Being made (paintBoard): redraw the queue when a stage moved, else only tick its clocks. */
let psSig = "";
function psTick() {
  const box = document.getElementById("mkQueue"); if (!box || !overviewLoaded) return;
  const live = overview.reels.filter((r) => r.job && ["queued", "running", "error"].includes(r.job.status));
  const sig = JSON.stringify(live.map((r) => [r.slug, r.job.status, r.job.stage, r.job.done, r.job.of, r.job.position]));
  if (sig !== psSig) {
    psSig = sig;
    const open = box.querySelector("details")?.open;
    box.innerHTML = queueHtml();
    if (open === false) { const d = box.querySelector("details"); if (d) d.open = false; }
    return;
  }
  for (const el of box.querySelectorAll("[data-psclock]")) { const r = live.find((x) => x.slug === el.dataset.psclock); if (r) el.textContent = psClock(r.job); }
}

/* 2. Review › where it would land. For each network Plan posts books on (planBooks, connected), the first free slot
   that would be left for this reel if it were approved now: the reels already approved take theirs first (the same
   plannerPlan run, with this reel left out), then one post per network a day, the site's own limit (BOOK_AHEAD), the
   network's posting times (slotsOf), the weekly networks, no headline twice on one network within two weeks, and
   planFits (no people on Google Maps, LinkedIn only for long cuts). Nothing is booked from here. */
let cLandMemo = { key: "" };
function cLandTaken() {
  const key = JSON.stringify([postsLog.length, postsLog.map((p) => p.id).reduce((a, b) => Math.max(a, b || 0), 0), overview.reels.filter((r) => r.status === "approved").length, Math.floor(Date.now() / 6e4), Object.keys(connections || {}).length, !!yt.connected]);
  if (cLandMemo.key === key) return cLandMemo;
  const nets = PLAN_NETS().filter((n) => planBooks(n) && planReady(n));
  const P = { nets: new Set(nets), start: wallOf(Date.now()).slice(0, 10), days: 60, approvedOnly: true };
  const plan = plannerPlan(P, plannerPool(true));
  cLandMemo = { key, nets, taken: new Set(plan.map((x) => `${x.net}|${x.day}`)) };
  return cLandMemo;
}
function cLandsOn(r) {
  const { nets, taken } = cLandTaken(), today = wallOf(Date.now()).slice(0, 10), DAY = 864e5;
  const hookOf = new Map(overview.reels.map((x) => [x.slug, x.hookText || ""]));
  const out = [], skip = [];
  for (const n of nets) {
    if (!planFits(r, n)) { skip.push(n); continue; }
    const times = takenTimes(n), busy = new Set(postsLog.filter((p) => p.network === n && holdsSlot(p)).map((p) => dayOf(p.at)));
    const same = r.hookText ? postsLog.filter((p) => p.network === n && holdsSlot(p) && p.at && hookOf.get(p.slug) === r.hookText).map((p) => Date.parse(p.at)) : [];
    const weekly = PLAN_WEEKLY.includes(n), slots = weekly ? slotsOf(n).slice(0, 1) : slotsOf(n), lim = Math.min(60, BOOK_AHEAD[n] ?? 60);
    let hit = null, day = today;
    for (let i = 0; i < lim && !hit; i++, day = nextDay(day)) {
      if (busy.has(day) || taken.has(`${n}|${day}`)) continue;
      const dow = new Date(day + "T12:00Z").getUTCDay();
      for (const s of slots) {
        if (s.dow >= 0 && s.dow !== dow) continue;
        const at = zonedIso(`${day}T${s.hm}`), t = Date.parse(at);
        if (!slotFree(times, at) || (weekly && times.some((x) => Math.abs(x - t) < 7 * DAY - 36e5)) || same.some((x) => Math.abs(x - t) <= 14 * DAY)) continue;
        hit = { day, hm: s.hm, at }; break;
      }
    }
    out.push({ n, hit, lim });
  }
  out.sort((a, b) => (a.hit ? a.hit.at : "9").localeCompare(b.hit ? b.hit.at : "9"));
  return { out, skip };
}
function cLandsHtml(r) {
  if (r.status === "approved" || !postsLoaded) return `<div class="rvgoes"><span class="meta">${tr(r.status === "approved" ? "rv.goes.ok" : "rv.goes")}</span>${goesNets().map((n) => netLogo(chOf(n), "sm")).join("")}</div>`;
  const { out, skip } = cLandsOn(r), L = lang === "ja" ? "ja-JP" : "en-GB";
  const dayTxt = (d) => new Date(d + "T12:00Z").toLocaleDateString(L, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const chips = out.map(({ n, hit, lim }) => hit
    ? `<button type="button" class="c-land" data-cland="${esc(n)}|${hit.day}" title="${esc(tr("c_land.tip", { n: NET_NAME[n] || n, t: `${postDayLabel(hit.day)} ${hit.hm}` }))}">${netLogo(chOf(n), "sm")}<b>${esc(dayTxt(hit.day))}</b><span>${esc(hit.hm)}</span></button>`
    : `<span class="c-land later" title="${esc(tr("c_land.latertip", { n: NET_NAME[n] || n, d: lim }))}">${netLogo(chOf(n), "sm")}<b>${esc(tr("c_land.later"))}</b></span>`).join("");
  const sk = skip.length ? `<span class="c-land skip" title="${esc(tr("c_land.skiptip", { list: skip.map((n) => NET_NAME[n] || n).join(", ") }))}">${skip.map((n) => netLogo(chOf(n), "sm")).join("")}<b>${esc(tr("c_land.skip", { n: skip.length }))}</b></span>` : "";
  return `<div class="rvgoes c-lands"><span class="meta">${esc(tr("c_land.h"))}</span>${chips || `<span class="meta">${esc(tr("c_land.none"))}</span>`}${sk}<span class="c-land-note meta">${esc(tr("c_land.note"))}</span></div>`;
}
document.addEventListener("click", (e) => {
  const c = e.target.closest?.("[data-cland]"); if (!c) return;
  const [net, day] = c.dataset.cland.split("|");
  LANES.focus = { net, day }; postView = "lanes"; postTab = "schedule"; postNet = "all";
  if (location.hash !== "#/posting") location.hash = "#/posting"; else renderHome(true);
});

/* 3. The reel editor's issues: ONE list, so the rules chip, the Issues lane and Properties can never disagree (before,
   the chip said "rules OK" while clips carried a warning sign). Each issue has a time span, a weight (block: the render
   refuses it; look: worth a look before approving; note) and the clip or caption it belongs to. Sources: the render
   rules (rules(), the same check Save & render uses), the clip checks the overview carries (look: true), the AI
   review's captions over the wrong picture and unlisted claims, words too long or too short for their time, missing or
   silent sound and black or frozen frames from the quality check, and clips enlarged from a small source (soft). */
const cIss = { slug: "", ai: null };
const C_CPS = 8, C_MINSEC = 1.0;  // Japanese characters a second people can read on a short; the least time on screen
function cAiLoad() {
  if (!edit || cIss.slug === edit.slug) return;
  cIss.slug = edit.slug; cIss.ai = null;
  const slug = edit.slug;
  api("/api/ai/review?slug=" + encodeURIComponent(slug)).then((r) => { if (cIss.slug === slug) { cIss.ai = r?.review || false; if (edit?.slug === slug && !atHome()) renderTimeline(); } }).catch(() => { cIss.ai = false; });
}
function edIssues() {
  if (!edit || !reel) return [];
  cAiLoad();
  const out = [], st = starts(), T = total(), shotSpan = (i) => [st[i] ?? 0, (st[i] ?? 0) + (edit.shots[i]?.sec || 0)];
  const beatAt = (t) => edit.beats.findIndex((b) => b.kind !== "end" && t >= b.startSec - 0.05 && t < b.endSec + 0.05);
  for (const msg of rules()) {
    if (/used twice/.test(msg)) {
      const names = edit.shots.map((s) => s.file.toLowerCase());
      names.forEach((nm, i) => { if (names.indexOf(nm) !== i) out.push({ t: shotSpan(i), sev: "block", kind: "rule", text: tr("c_is.twice", { f: edit.shots[i].file }), shot: i }); });
    } else if (/too many photos/.test(msg)) {
      edit.shots.forEach((s, i) => { if (s.kind === "photo") out.push({ t: shotSpan(i), sev: "block", kind: "rule", text: tr("c_is.photos", { m: msg.replace(/^.*\(/, "").replace(")", "") }), shot: i }); });
    } else if (/over 4 s/.test(msg)) {
      edit.shots.forEach((s, i) => { if (s.sec > 4) out.push({ t: shotSpan(i), sev: "block", kind: "rule", text: tr("c_is.long", { s: s.sec }), shot: i }); });
    } else if (/no hook/.test(msg)) out.push({ t: [0, 0.5], sev: "block", kind: "rule", text: tr("c_is.nohook"), beat: edit.beats.findIndex((b) => b.kind === "hook") });
    else out.push({ t: [0, T], sev: "block", kind: "rule", text: /^length/.test(msg) ? tr("c_is.length", { m: msg.replace(/^length /, "") }) : msg });
  }
  const card = overview.reels.find((r) => r.slug === edit.slug);
  for (const c of lookChecks(card)) {
    const i = edit.shots.findIndex((s) => s.file.toLowerCase() === String(c.file).toLowerCase());
    if (i >= 0) out.push({ t: shotSpan(i), sev: "look", kind: "look", text: c.flags.join(" · "), shot: i });
  }
  const ai = cIss.ai;
  if (ai) {
    for (const m of ai.mismatches || []) {
      const t = Math.max(0, +m.at || 0), b = beatAt(t), s = shotAt(t);
      out.push({ t: b >= 0 ? [edit.beats[b].startSec, edit.beats[b].endSec] : shotSpan(s), sev: "look", kind: "ai", text: tr("c_is.aimm", { l: String(m.line || "").replace(/\n/g, " "), s: m.shows || "" }), beat: b >= 0 ? b : undefined, shot: b >= 0 ? undefined : s });
    }
    for (const c of ai.claims || []) {
      const key = String(c.text || "").replace(/\s/g, "").slice(0, 8), b = edit.beats.findIndex((x) => key && x.ja.replace(/\s/g, "").includes(key));
      out.push({ t: b >= 0 ? [edit.beats[b].startSec, edit.beats[b].endSec] : [0, T], sev: "look", kind: "ai", text: tr("c_is.claim", { c: String(c.text || "").replace(/\n/g, " "), w: c.why || "" }), beat: b >= 0 ? b : undefined });
    }
  }
  edit.beats.forEach((b, i) => {
    if (b.kind === "end") return;
    const chars = String(b.ja || "").replace(/\s/g, "").length, d = b.endSec - b.startSec;
    if (d > 0 && chars / d > C_CPS) out.push({ t: [b.startSec, b.endSec], sev: "look", kind: "words", text: tr("c_is.toomany", { n: chars, d: d.toFixed(1) }), beat: i });
    else if (d < C_MINSEC) out.push({ t: [b.startSec, b.endSec], sev: "look", kind: "words", text: tr("c_is.brief", { d: d.toFixed(1) }), beat: i });
  });
  if (edit.music === "off" && !(reel.audio?.sfx || []).length) out.push({ t: [0, T], sev: "note", kind: "sound", text: tr("c_is.nomusic") });
  const qa = reel.qa?.["9x16"]?.checks || [];
  for (const c of qa) {
    if (c.level === "ok" || !["silence", "black", "freeze", "loudness", "peak"].includes(c.id)) continue;
    const m = /at ([\d.]+)\s*-\s*([\d.]+)\s*s/.exec(c.found || ""), span_ = m ? [+m[1], +m[2]] : [0, T];
    out.push({ t: span_, sev: c.level === "bad" || c.level === "fail" ? "block" : "look", kind: "sound", text: tr("c_is.qa." + c.id, { f: c.found }), shot: m ? shotAt(+m[1]) : undefined });
  }
  edit.shots.forEach((s, i) => {
    const src = reel.shots?.find((x) => x.file === s.file)?.source, short = src ? Math.min(+src.width || 0, +src.height || 0) : 0;
    if (short && short < 1080) out.push({ t: shotSpan(i), sev: "look", kind: "soft", text: tr("c_is.soft", { w: src.width, h: src.height }), shot: i });
  });
  return out.sort((a, b) => a.t[0] - b.t[0]);
}
const C_SEV = { block: 0, look: 1, note: 2 };
const C_KIND_ICO = { rule: "alert", look: "eye", ai: "chat", words: "type", sound: "volume", soft: "image" };
/* The lane: one marker per stretch of time (issues on the same clip or caption share one, with a count). */
function cIssueLane() {
  const list = edIssues(), groups = new Map();
  list.forEach((x, k) => { const key = `${x.t[0].toFixed(2)}|${x.t[1].toFixed(2)}`; (groups.get(key) || groups.set(key, []).get(key)).push(k); });
  cIss.list = list;
  const head = document.getElementById("issHead");
  if (head) head.innerHTML = `${ico("alert", "sm")}${esc(tr("c_is.h"))}${list.length ? ` <b class="iss-n ${list.some((x) => x.sev === "block") ? "bad" : "look"}">${list.length}</b>` : ""}`;
  if (!list.length) return `<span class="iss-clear">${ico("check", "sm")} ${esc(tr("c_is.clear"))}</span>`;
  const T = Math.max(0.1, total());
  return [...groups.values()].map((ks) => {
    const xs = ks.map((k) => list[k]), top = xs.reduce((a, b) => (C_SEV[b.sev] < C_SEV[a.sev] ? b : a)), [a, b] = top.t;
    const tip = xs.map((x) => `${tr("c_is.k." + x.kind)}: ${x.text}`).join("\n");
    // A whole-reel issue (its length, no music) is a thin band along the lane, so it never hides the clip markers.
    return `<button type="button" class="iss-m sev-${top.sev} k-${top.kind}${b - a >= 0.6 * T ? " wide" : ""}" data-iss="${ks[0]}" style="left:${(a * pps).toFixed(1)}px;width:${Math.max(16, (b - a) * pps - 2).toFixed(1)}px" title="${esc(tip)}" aria-label="${esc(`${mmss(a)} ${tip}`)}">${ico(C_KIND_ICO[top.kind] || "alert", "sm")}<span>${esc(xs.length > 1 ? `${xs.length} · ${tr("c_is.k." + top.kind)}` : tr("c_is.k." + top.kind))}</span></button>`;
  }).join("");
}
function cIssGo(k) {
  const x = cIss.list?.[k]; if (!x) return;
  pause();
  if (x.beat != null && x.beat >= 0) { sel = { type: "beat", i: x.beat }; seek(edit.beats[x.beat].startSec + 0.02); }
  else if (x.shot != null && x.shot >= 0) { sel = { type: "shot", i: x.shot }; seek(starts()[x.shot] + 0.02); }
  else seek(x.t[0] + 0.02);
  renderAll();
  const same = cIss.list.filter((y) => y.t[0] === x.t[0] && y.t[1] === x.t[1]);
  toast(`${ico(C_KIND_ICO[x.kind] || "alert", "sm")} ${same.map((y) => `<b>${esc(tr("c_is.k." + y.kind))}</b> ${esc(y.text)}`).join("<br>")}`, 6000);
  const m = document.querySelector(`.iss-m[data-iss="${k}"]`); if (m) m.focus();
}
// Pointer down on a marker acts before the timeline's own handler (which would clear the selection and redraw).
document.addEventListener("pointerdown", (e) => {
  const m = e.target.closest?.(".iss-m"); if (!m) return;
  e.stopPropagation(); e.preventDefault(); cIssGo(+m.dataset.iss);
}, true);
document.addEventListener("click", (e) => { const m = e.target.closest?.(".iss-m"); if (m && e.detail === 0) cIssGo(+m.dataset.iss); });
/* The chip in the timeline's tool row and the Rules line in Properties: the same list, said once. */
function cRulesChip() {
  const list = edIssues(), block = list.filter((x) => x.sev === "block"), look = list.filter((x) => x.sev === "look");
  const chip = $("#rulesChip"); if (!chip) return;
  const tail = `${total().toFixed(1)} s · ${edit.shots.length} ${tr("c_is.clips")}`;
  chip.innerHTML = block.length ? `${ico("alert", "sm")} ${esc(block[0].text)}${block.length > 1 ? ` +${block.length - 1}` : ""}`
    : look.length ? `${ico("eye", "sm")} ${esc(tr("c_is.chiplook", { n: look.length }))} · ${tail}` : `${ico("check", "sm")} ${esc(tr("c_is.chipok"))} · ${tail}`;
  chip.className = "chip c-rules " + (block.length ? "bad" : look.length ? "warn" : "ok");
  chip.title = block.length || look.length ? list.filter((x) => x.sev !== "note").map((x) => `${mmss(x.t[0])} ${tr("c_is.k." + x.kind)}: ${x.text}`).join("\n") + "\n" + tr("c_is.chiptip") : tr("c_is.oktip");
  chip.setAttribute("role", "button"); chip.tabIndex = 0;
}
document.addEventListener("click", (e) => {
  if (!e.target.closest?.("#rulesChip.c-rules") || atHome()) return;
  const k = cIss.list?.findIndex((x) => x.sev === "block"), j = k >= 0 ? k : cIss.list?.findIndex((x) => x.sev === "look");
  if (j >= 0) cIssGo(j);
});
document.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && e.target.closest?.("#rulesChip.c-rules")) { e.preventDefault(); e.target.click(); } });
function cIssuesRow() {
  const list = edIssues(), block = list.filter((x) => x.sev === "block"), look = list.filter((x) => x.sev === "look");
  if (block.length) return `<span style="color:var(--bad)">${block.map((x) => esc(x.text)).join("<br>")}</span>${look.length ? `<br><span class="meta">${esc(tr("c_is.alsolook", { n: look.length }))}</span>` : ""}`;
  if (look.length) return `<span title="${esc(tr("c_is.passtip"))}">${esc(tr("c_is.pass"))}</span> · <span style="color:var(--warn)">${esc(tr("c_is.chiplook", { n: look.length }))}</span> <span class="meta">${esc(tr("c_is.seelane"))}</span>`;
  return `<span title="${esc(tr("c_is.passtip"))}">${esc(tr("c_is.allpass"))}</span>`;
}

/* 4. Words › how worn each headline is. For every headline in the bank: how many posts carry it (out, and booked),
   when it last went out, how many networks show it within two weeks either side of today, and how its posts did
   against a typical post on the same network (views ÷ that network's median, from /api/perf/table; only where at
   least two posts have numbers). Worn: on most networks already within those two weeks, the window Plan posts
   keeps one headline out of per network, so there is barely a slot left for it. */
const cWear = { perf: null, loading: false };
const cNorm = (s) => String(s || "").replace(/\s+/g, "");
function cWearData() {
  if (cWear.perf === null && !cWear.loading) {
    cWear.loading = true;
    api("/api/perf/table?days=120").then((p) => { cWear.perf = p?.rows || []; }).catch(() => { cWear.perf = []; }).finally(() => { cWear.loading = false; if (page === "words") renderHome(true); });
  }
  const W = wordsView, now = Date.now(), DAY = 864e5, nets = Math.max(1, PLAN_NETS().length), wornAt = Math.max(2, Math.ceil(nets * 0.6));
  const med = {};
  for (const [n, xs] of Object.entries((cWear.perf || []).filter((p) => p.views != null).reduce((m, p) => ((m[p.network] ||= []).push(+p.views), m), {}))) {
    const s = xs.sort((a, b) => a - b); med[n] = s[s.length >> 1];
  }
  const perfOf = new Map(); for (const p of cWear.perf || []) if (p.views != null) perfOf.set(`${p.slug}|${p.network}`, +p.views);
  return (W.lines || []).filter((l) => l.kind === "hook" && l.status !== "suggested").map((l) => {
    const key = cNorm(l.ja), reels = overview.reels.filter((r) => !r.house && cNorm(r.hookText) === key);
    const slugs = new Set(reels.map((r) => r.slug));
    const posts = postsLog.filter((p) => slugs.has(p.slug) && p.network !== "all" && p.at && holdsSlot(p));
    const out = posts.filter((p) => isLive(p)), booked = posts.filter((p) => !isLive(p) && new Date(p.at).getTime() > now);
    const last = out.map((p) => new Date(p.at).getTime()).sort((a, b) => b - a)[0] || null;
    const next = booked.map((p) => new Date(p.at).getTime()).sort((a, b) => a - b)[0] || null;
    const near = new Set(posts.filter((p) => Math.abs(new Date(p.at).getTime() - now) <= 14 * DAY).map((p) => p.network));
    const ratios = out.map((p) => { const v = perfOf.get(`${p.slug}|${p.network}`), m = med[p.network]; return v != null && m > 0 ? v / m : null; }).filter((x) => x != null);
    const ratio = ratios.length >= 2 ? ratios.reduce((a, b) => a + b, 0) / ratios.length : null;
    return { l, reels, out: out.length, booked: booked.length, last, next, near: near.size, nets, worn: near.size >= wornAt, ratio, measured: ratios.length };
  }).sort((a, b) => b.worn - a.worn || (b.out + b.booked) - (a.out + a.booked));
}

/* 5. Versions › the shot diff: the live version and the new one as two shot strips on one time axis, what changed
   lit (clip, words, timing, look, music), and each version's review score with what it was based on. Two reviews made
   from different things (one watched the video, one saw still frames) are not comparable: versions.better_than says
   "unknown" then, and so does this. */
const cVer = {};
function cVerLoad(slug) {
  if (cVer[slug]) return; cVer[slug] = "loading";
  api("/api/versions/shots?slug=" + encodeURIComponent(slug)).then((d) => { cVer[slug] = d; }).catch((err) => { cVer[slug] = { error: err.message }; })
    .finally(() => { if (page === "versions") renderHome(true); });
}
function cVerDiffHtml(x) {
  const d = cVer[x.slug];
  if (!d || d === "loading") { cVerLoad(x.slug); return `<div class="c-vd"><div class="skel skel-line"></div><div class="skel skel-line" style="width:70%"></div></div>`; }
  if (d.error) return "";
  const A = d.versions.find((v) => v.n === (x.live || 1)), B = d.versions.find((v) => v.n === x.n);
  if (!A || !B) return "";
  const T = Math.max(A.seconds || 0, B.seconds || 0, ...[A, B].flatMap((v) => v.shots.map((s) => (s.at || 0) + (s.sec || 0)))) || 1;
  const n = Math.max(A.shots.length, B.shots.length), clip = new Set(), time = new Set();
  for (let i = 0; i < n; i++) {
    const a = A.shots[i], b = B.shots[i];
    if (!a || !b || a.file !== b.file) clip.add(i);
    else if (Math.abs((a.at || 0) - (b.at || 0)) > 0.05 || Math.abs((a.sec || 0) - (b.sec || 0)) > 0.05 || Math.abs((a.from || 0) - (b.from || 0)) > 0.05) time.add(i);
  }
  const words = new Set(); B.beats.forEach((b, i) => { if (cNorm(b.ja) !== cNorm(A.beats[i]?.ja)) words.add(i); });
  const beatTime = B.beats.some((b, i) => A.beats[i] && (Math.abs(b.at - A.beats[i].at) > 0.05 || Math.abs(b.end - A.beats[i].end) > 0.05));
  const look = ["look", "grade", "typeKit", "palette", "style"].filter((k) => (A[k] || "") !== (B[k] || ""));
  const music = (A.music || "") !== (B.music || "");
  const ch = (on, icon, label, n_) => `<span class="c-vch${on ? " on" : ""}">${ico(icon, "sm")}${esc(label)}${on && n_ ? ` <b>${n_}</b>` : ""}${on ? "" : ` <span class="meta">${esc(tr("c_vd.same"))}</span>`}</span>`;
  const score = (v, label) => {
    const r = v.review;
    return `<span class="c-vd-score"><b>${esc(label)}</b> v${v.n} ${r ? `· ${esc(tr("ver.score", { h: r.hook ?? "–", l: r.look ?? "–" }))} · ${esc(tr(r.mismatches ? "ver.mm" : "ver.nomm", { n: r.mismatches }))} · <span class="c-vd-basis b-${esc(r.basis)}">${esc(tr(r.basis === "frames" ? "c_vd.frames" : "c_vd.video"))}</span>` : `· ${esc(tr("ver.noreview"))}`}</span>`;
  };
  const differ = A.review && B.review && A.review.basis !== B.review.basis;
  const verdict = differ ? `<p class="c-vd-verdict unknown">${ico("info", "sm")} ${esc(tr("c_vd.differ"))}</p>`
    : x.verdict === "unknown" || !A.review || !B.review ? `<p class="c-vd-verdict unknown">${ico("info", "sm")} ${esc(tr("ver.v.unknown"))}</p>` : "";
  const strip = (v, other, label, cls) => `<div class="c-vd-row ${cls}"><span class="c-vd-lab"><b>${esc(label)}</b><span class="meta">v${v.n}</span></span>
    <div class="c-vd-track" role="list" aria-label="${esc(tr("c_vd.shots", { v: label }))}">${v.shots.map((s, i) => `<span role="listitem" class="c-vd-shot${clip.has(i) ? " ch-clip" : time.has(i) ? " ch-time" : ""}" style="left:${(100 * (s.at || 0) / T).toFixed(2)}%;width:${(100 * (s.sec || 0) / T).toFixed(2)}%;background-image:url('${s.thumb ? thumb(s.thumb, 120) : ""}')" title="${esc(`${tr("ver.shot", { n: i + 1 })} · ${s.file} · ${s.sec}s${clip.has(i) && other.shots[i] ? ` · ${tr("c_vd.was", { f: other.shots[i].file })}` : ""}`)}"><i>${i + 1}</i></span>`).join("")}</div>
    <div class="c-vd-words">${v.beats.filter((b) => b.kind !== "end").map((b) => { const k = v.beats.indexOf(b); return `<span class="c-vd-beat k-${esc(b.kind)}${words.has(k) ? " ch" : ""}" style="left:${(100 * b.at / T).toFixed(2)}%;width:${(100 * (b.end - b.at) / T).toFixed(2)}%" title="${esc(String(b.ja || "").replace(/\n/g, " "))}" lang="ja">${esc(String(b.ja || "").replace(/\n/g, " "))}</span>`; }).join("")}</div></div>`;
  return `<div class="c-vd" style="--T:${T.toFixed(2)}"><div class="c-vd-head"><b>${esc(tr("c_vd.h"))}</b>
      ${ch(clip.size, "film", tr("c_vd.clip"), clip.size)}${ch(words.size, "type", tr("c_vd.words"), words.size)}${ch(time.size || beatTime, "clock", tr("c_vd.timing"), time.size)}${ch(look.length, "image", tr("c_vd.look"), 0)}${ch(music, "music", tr("c_vd.music"), 0)}</div>
    <div class="c-vd-scores">${score(A, tr("ver.live"))}${score(B, tr("ver.new"))}</div>${verdict}
    <div class="c-vd-strips">${strip(A, B, tr("ver.live"), "live")}<div class="c-vd-axis" aria-hidden="true"></div>${strip(B, A, tr("ver.new"), "new")}</div>
    <p class="meta c-vd-key"><i class="k-clip"></i>${esc(tr("c_vd.kclip"))} <i class="k-time"></i>${esc(tr("c_vd.ktime"))} <i class="k-words"></i>${esc(tr("c_vd.kwords"))}</p></div>`;
}

/* 7. Results › Activity log: every finished job of the last 24 hours (or 7 days) as bars on one lane per kind of job,
   coloured by how it ended. A bar opens that job: when, how long, its last line, and a reel render's own log lines.
   The other project's due-post runs (they go out from this studio every five minutes) are hidden by default. */
const cSwim = { days: lsGet("lc.c.swimDays", "1") === "7" ? 7 : 1, data: {}, at: {}, loading: false, pick: null, cur: -1, lines: {}, bars: [] };
let cLogOther = lsGet("lc.c.logOther", "") === "1";
const cIsOther = (j) => { const m = /^post-due-(.+)$/.exec(j?.slug || ""); return !!m && m[1] !== (wsView?.running || "main"); };
const C_SWIM_ORDER = ["build", "remix", "ai", "score", "versions", "vlog", "vlogup", "youtube", "post", "helper", "live", "make", "watch", "scan", "footage", "discover", "import", "gphotos", "cameras", "takeout"];
function cSwimLoad(force) {
  const d = cSwim.days;
  if (cSwim.loading || (!force && cSwim.data[d] && Date.now() - cSwim.at[d] < 60e3)) return;
  cSwim.loading = true;
  api(`/api/log/jobs?days=${d}`).then((r) => { cSwim.data[d] = r; cSwim.at[d] = Date.now(); }).catch(() => { cSwim.data[d] = cSwim.data[d] || { rows: [], error: true }; })
    .finally(() => { cSwim.loading = false; if (page === "log" && logTab === "activity") renderHome(true); });
}
const cJobKey = (j) => `${j.slug}|${j.started}`;
function cSwimHtml() {
  if (!wsView) wsLabel("main");
  cSwimLoad();
  const d = cSwim.data[cSwim.days];
  const all = d?.rows || [], others = all.filter(cIsOther), rows = all.filter((j) => cLogOther || !cIsOther(j));
  const kinds = [...new Set(rows.map((j) => j.kind))].sort((a, b) => (C_SWIM_ORDER.indexOf(a) + 1 || 99) - (C_SWIM_ORDER.indexOf(b) + 1 || 99));
  const to = d?.now || Date.now(), from = to - cSwim.days * 864e5;
  cSwim.model = { rows: rows.map((j) => ({ ...j, t0: Date.parse(j.started), t1: Date.parse(j.ended), lane: kinds.indexOf(j.kind) })).filter((j) => j.t1 >= from).sort((a, b) => a.t0 - b.t0), kinds, from, to };
  const other = wsView?.list?.find((w) => w.id !== (wsView?.running || "main") && others.some((j) => j.slug.endsWith(w.id)))?.name || (others[0] ? wsLabel(others[0].slug.replace(/^post-due-/, "")) : "");
  const fails = cSwim.model.rows.filter((j) => j.status === "error").length;
  const pick = cSwim.pick && cSwim.model.rows.find((j) => cJobKey(j) === cSwim.pick);
  const head = `<div class="c-sw-head"><h3>${ico("clock", "sm")} ${esc(tr("c_sw.h"))}</h3>
      <div class="seg" role="group" aria-label="${esc(tr("c_sw.range"))}">${[1, 7].map((n) => `<button class="${cSwim.days === n ? "on" : ""}" data-cswdays="${n}" aria-pressed="${cSwim.days === n}">${esc(tr(n === 1 ? "c_sw.24h" : "c_sw.7d"))}</button>`).join("")}</div>
      <span class="c-sw-sum meta">${d ? esc(tr("c_sw.sum", { n: cSwim.model.rows.length, f: fails })) : ""}</span><span class="grow"></span>
      <span class="c-sw-key meta"><i class="s-done"></i>${esc(tr("c_sw.done"))} <i class="s-error"></i>${esc(tr("c_sw.error"))} <i class="s-cancelled"></i>${esc(tr("c_sw.cancelled"))}</span>
      ${others.length || cLogOther ? `<label class="chk c-sw-other"><input type="checkbox" data-cswother ${cLogOther ? "checked" : ""}> ${esc(tr("c_sw.other", { p: other || tr("c_sw.otherp"), n: others.length }))}</label>` : ""}</div>`;
  if (!d) return `<section class="c-swim">${head}<div class="skel" style="height:120px"></div></section>`;
  if (!kinds.length) return `<section class="c-swim">${head}<p class="note">${esc(tr("c_sw.none"))}</p></section>`;
  const fresh = !moCalm() && !moState().shown.has("c:swim:" + cSwim.days);
  return `<section class="c-swim">${head}
    <div class="c-sw-body" style="--lanes:${kinds.length}"><div class="c-sw-corner"></div><ul class="c-sw-names">${kinds.map((k) => `<li title="${esc(jobKind(k))}">${esc(jobKind(k))} <span class="meta">${cSwim.model.rows.filter((j) => j.kind === k).length}</span></li>`).join("")}</ul>
      <div class="c-sw-plot"><svg class="c-sw-svg${fresh ? " in" : ""}" tabindex="0" role="img" focusable="true" aria-label="${esc(tr("c_sw.aria", { n: cSwim.model.rows.length, k: kinds.length }))}" aria-describedby="cSwRead"></svg></div></div>
    <p class="c-sw-read meta" id="cSwRead" aria-live="polite">${esc(tr("c_sw.hint"))}</p>
    ${pick ? cSwimDetail(pick) : ""}</section>`;
}
function cSwimText(j) {
  const L = lang === "ja" ? "ja-JP" : "en-GB", t = new Date(j.t0).toLocaleString(L, { weekday: cSwim.days > 1 ? "short" : undefined, hour: "2-digit", minute: "2-digit" });
  return `${t} · ${jobKind(j.kind)} · ${jobName(j.slug)} · ${tr(j.status === "done" ? "c_sw.done" : j.status === "error" ? "c_sw.error" : "c_sw.cancelled")} · ${span(j.seconds)}`;
}
function cSwimDetail(j) {
  const reel = overview.reels.some((r) => r.slug === j.slug), render = ["build", "remix"].includes(j.kind) && reel;
  if (render && cSwim.lines[j.slug] === undefined) {
    cSwim.lines[j.slug] = null;
    api("/api/log/lines?slug=" + encodeURIComponent(j.slug)).then((r) => { cSwim.lines[j.slug] = r; }).catch(() => { cSwim.lines[j.slug] = { lines: [] }; }).finally(() => { if (page === "log") renderHome(true); });
  }
  const L = lang === "ja" ? "ja-JP" : "en-GB", tm = (t) => new Date(t).toLocaleString(L, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const lg = cSwim.lines[j.slug];
  const stale = lg?.at && Math.abs(Date.parse(lg.at) - j.t1) > 120e3;
  const cause = j.status === "error" ? plainFail(j.last) : "";
  return `<div class="c-sw-detail s-${esc(j.status)}" role="region" aria-label="${esc(jobName(j.slug))}">
    <div class="row wrap"><b>${esc(jobName(j.slug))}</b>${mp(j.status === "done" ? "check" : j.status === "error" ? "alert" : "x", esc(tr(j.status === "done" ? "c_sw.done" : j.status === "error" ? "c_sw.error" : "c_sw.cancelled")), j.status === "done" ? "s-posted" : j.status === "error" ? "bad" : "")}
      <span class="meta">${esc(jobKind(j.kind))} · ${esc(tm(j.t0))} → ${esc(tm(j.t1))} · ${esc(span(j.seconds))}${j.stage && j.stages ? ` · ${esc(tr("c_sw.stopat", { k: j.stage, n: j.stages }))}` : ""}</span><span class="grow"></span>
      ${reel ? `<a class="btn" href="#/reel/${esc(j.slug)}">${ico("film", "sm")}${tr("act.open")}</a>` : ""}<button data-cswclose="1">${ico("x", "sm")}${tr("src.close")}</button></div>
    ${j.last ? `<p class="c-sw-last${j.status === "error" ? " bad" : ""}">${esc(cause && cause !== j.last ? `${cause} (${j.last})` : j.last)}</p>` : ""}
    ${render ? (lg == null ? `<div class="skel skel-line"></div>` : lg.lines?.length ? `${stale ? `<p class="meta">${esc(tr("c_sw.newer", { t: tm(Date.parse(lg.at)) }))}</p>` : ""}<pre class="c-sw-lines">${esc(lg.lines.join("\n"))}</pre>` : `<p class="meta">${esc(tr("c_sw.nolines"))}</p>`)
      : `<p class="meta">${esc(tr("c_sw.onlylast"))}</p>`}</div>`;
}
function cSwimDraw() {
  const svg = document.querySelector(".c-sw-svg"), m = cSwim.model; if (!svg || !m) return;
  const W = Math.max(160, Math.round(svg.parentElement.clientWidth)), LH = 26, AX = 22, H = AX + LH * m.kinds.length;
  const x = (t) => ((t - m.from) / (m.to - m.from)) * W;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("width", W); svg.setAttribute("height", H);
  // The time axis: every 3 hours over a day, every day over a week; the hours in this computer's clock.
  let ax = "", grid = "";
  const step = cSwim.days > 1 ? 864e5 : 3 * 36e5, d0 = new Date(m.from); d0.setMinutes(0, 0, 0);
  if (cSwim.days > 1) d0.setHours(0); else d0.setHours(Math.ceil(d0.getHours() / 3) * 3);
  const L = lang === "ja" ? "ja-JP" : "en-GB";
  // On a narrow screen only every second (or third) tick gets a label, so they never run together.
  const every = Math.max(1, Math.ceil(48 / ((step / (m.to - m.from)) * W)));
  for (let t = d0.getTime(), i = 0; t <= m.to; t += step, i++) {
    const px = x(t); if (px < 0) continue;
    grid += `M${px.toFixed(1)},${AX}V${H}`;
    if (px < W - 30 && i % every === 0) ax += `<text class="c-sw-tick" x="${(px + 3).toFixed(1)}" y="14">${esc(cSwim.days > 1 ? new Date(t).toLocaleDateString(L, { weekday: "short", day: "numeric" }) : new Date(t).toLocaleTimeString(L, { hour: "2-digit", minute: "2-digit" }))}</text>`;
  }
  let lanes = ""; for (let i = 1; i < m.kinds.length; i++) lanes += `M0,${AX + i * LH}H${W}`;
  cSwim.bars = m.rows.map((j, k) => { const x0 = Math.max(0, x(j.t0)), x1 = Math.min(W, Math.max(x(j.t1), x0 + 3)); return { k, x0, x1, y: AX + j.lane * LH + 5, j }; });
  const bars = cSwim.bars.map((b) => `<rect class="c-b s-${esc(b.j.status)}${cJobKey(b.j) === cSwim.pick ? " on" : ""}" data-k="${b.k}" x="${b.x0.toFixed(1)}" y="${b.y}" width="${Math.max(3, b.x1 - b.x0).toFixed(1)}" height="${LH - 10}"/>`).join("");
  const now = x(Date.now());
  svg.innerHTML = `<rect class="c-sw-axbg" x="0" y="0" width="${W}" height="${AX}"/><path class="c-sw-grid" d="${grid}"/><path class="c-sw-lanes" d="${lanes}"/>${ax}${bars}
    <path class="c-sw-now" d="M${Math.min(W - 1, now).toFixed(1)},0V${H}"/><rect class="c-sw-cur" x="-20" y="0" width="0" height="0"/>`;
  if (svg.classList.contains("in")) { moState().shown.add("c:swim:" + cSwim.days); setTimeout(() => svg.classList.remove("in"), 1200); }
  if (!cSwim.ro) { cSwim.ro = new ResizeObserver(() => { const s = document.querySelector(".c-sw-svg"); if (s && Math.round(s.parentElement.clientWidth) !== +s.getAttribute("width")) cSwimDraw(); }); }
  cSwim.ro.disconnect(); cSwim.ro.observe(svg.parentElement);
}
function cSwimHit(e) {
  const svg = e.target.closest?.(".c-sw-svg"); if (!svg) return null;
  const r = svg.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top, lane = Math.floor((py - 22) / 26);
  let best = null, bd = 6;
  for (const b of cSwim.bars) { if (b.j.lane !== lane) continue; const dd = px < b.x0 ? b.x0 - px : px > b.x1 ? px - b.x1 : 0; if (dd < bd) { bd = dd; best = b; } }
  return best;
}
function cSwimFocus(b) {
  const svg = document.querySelector(".c-sw-svg"), read = document.getElementById("cSwRead"); if (!svg) return;
  const cur = svg.querySelector(".c-sw-cur");
  if (b && cur) { cur.setAttribute("x", (b.x0 - 2).toFixed(1)); cur.setAttribute("y", b.y - 3); cur.setAttribute("width", Math.max(7, b.x1 - b.x0 + 4).toFixed(1)); cur.setAttribute("height", 22); }
  else cur?.setAttribute("width", 0);
  if (read) read.textContent = b ? cSwimText(b.j) : tr("c_sw.hint");
}
document.addEventListener("pointermove", (e) => { if (e.target.closest?.(".c-sw-svg")) cSwimFocus(cSwimHit(e)); }, { passive: true });
document.addEventListener("pointerleave", (e) => { if (e.target.matches?.(".c-sw-svg")) cSwimFocus(null); }, true);
document.addEventListener("click", (e) => {
  const dd = e.target.closest?.("[data-cswdays]");
  if (dd) { cSwim.days = +dd.dataset.cswdays; lsSet("lc.c.swimDays", String(cSwim.days)); cSwim.pick = null; renderHome(true); return; }
  if (e.target.closest?.("[data-cswclose]")) { cSwim.pick = null; renderHome(true); return; }
  if (!e.target.closest?.(".c-sw-svg")) return;
  const b = cSwimHit(e); if (!b) return;
  cSwim.pick = cJobKey(b.j); cSwim.cur = b.k; renderHome(true);
  document.querySelector(".c-sw-detail")?.scrollIntoView({ block: "nearest", behavior: moCalm() ? "auto" : "smooth" });
});
document.addEventListener("keydown", (e) => {
  if (!e.target.matches?.(".c-sw-svg") || !cSwim.bars.length) return;
  const n = cSwim.bars.length;
  if (["ArrowRight", "ArrowLeft", "Home", "End"].includes(e.key)) {
    e.preventDefault();
    cSwim.cur = e.key === "Home" ? 0 : e.key === "End" ? n - 1 : Math.max(0, Math.min(n - 1, (cSwim.cur < 0 ? (e.key === "ArrowLeft" ? n : -1) : cSwim.cur) + (e.key === "ArrowRight" ? 1 : -1)));
    cSwimFocus(cSwim.bars[cSwim.cur]);
  } else if (e.key === "Enter" && cSwim.bars[cSwim.cur]) {
    e.preventDefault(); cSwim.pick = cJobKey(cSwim.bars[cSwim.cur].j); renderHome(true);
    requestAnimationFrame(() => { document.querySelector(".c-sw-svg")?.focus(); cSwimFocus(cSwim.bars[cSwim.cur]); });
  }
});
document.addEventListener("change", (e) => {
  if (!e.target.matches?.("[data-cswother]")) return;
  cLogOther = e.target.checked; lsSet("lc.c.logOther", cLogOther ? "1" : ""); logPage = 0; renderHome(true);
});

