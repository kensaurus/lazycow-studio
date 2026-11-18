#!/usr/bin/env node
/*
 * FILE: scripts/docs-gifs.mjs
 * PURPOSE: Record one short animated GIF per studio page for the docs (README, npm README, user guide, the kensaur.us
 *          story), each framed as a 90s program window (title bar, buttons, status bar), like the studio's own wizard.
 * USAGE:   node scripts/docs-gifs.mjs [--url http://127.0.0.1:4317] [--out docs/img/pages] [--only reels,posting] [--lang ja]
 *          The README hero: node scripts/docs-gifs.mjs --only approve --out <dir>, then copy approve.gif to docs/img/.
 *          Needs a running studio, Google Chrome, and ffmpeg (STUDIO_TOOLS or PATH).
 * SAFETY:  Looks only: it opens pages, scrolls, hovers, switches filters and plays previews. It never presses Approve,
 *          Book, Post, Save or anything that changes the studio (each scene below is a fixed list of such steps).
 * OUTPUT:  <out>/<scene>.gif (960x600 page inside a ~976x658 window, 8 frames a second, looping).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg("url", "http://127.0.0.1:4317");
const OUT = resolve(arg("out", "docs/img/pages"));
const ONLY = (arg("only", "") || "").split(",").filter(Boolean);
const LANG = arg("lang", "en");
const CHROME = process.env.CHROME_PATH || ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome"].find(existsSync);
const FFMPEG = [process.env.STUDIO_TOOLS && join(process.env.STUDIO_TOOLS, "ffmpeg.exe"), process.env.STUDIO_TOOLS && join(process.env.STUDIO_TOOLS, "ffmpeg"), "ffmpeg"].filter(Boolean).find((p) => p === "ffmpeg" || existsSync(p));
const W = 1440, H = 900, GW = 960, GH = 600, FPS = 8;

/* Each scene: a window title, a status-bar line, and steps. Step kinds: go (hash route; `ready` names an element to wait for), hold (frames), scroll (px over
   frames), hover / click (CSS selector, first visible match), sweep (move the pointer across an element over frames, for
   hover-scrub), moveto (glide the pointer onto an element over frames and leave it there, never pressing it), text (a
   button by its label), js (page code), key. A scene's `theme` ("dark"/"light", light by default) sets the studio's
   colours; `statusJa` is its status line for --lang ja; `vw`/`vh` change the page size (1440x900 by default); `pointer`
   draws the arrow; `hero` scenes are recorded only when named in --only. Only safe controls are named; UNSAFE below refuses a click on any control whose label or data attributes say
   it changes the studio. */
const UNSAFE = /approve|data-revok|book it|apply|data-wfapply|post now|send|save|delete|remove|reject|render|make reels|try again|reset|connect|承認|予約する|適用|保存|削除/i;
const SCENES = {
  today: { title: "TODAY.EXE", status: "Today: what goes out today, what waits for you, what finished overnight, and this week's views", statusJa: "今日：今日出る投稿、あなたを待っているもの、夜のうちに終わったこと、今週の再生数", steps: [
    { go: "#/today" }, { hold: 30 }] },
  reels: { title: "REELS.EXE", status: "Reels: the Studio Monitor, then every reel; point at one to scrub through it", statusJa: "リール：スタジオ モニターと、すべてのリール。カードにポインターを乗せると中身を早送り", steps: [
    { go: "#/" }, { hold: 12 }, { sweep: ".rcard[data-vid] .thumb", frames: 18 }, { hold: 4 },
    { scroll: 520, frames: 10 }, { hold: 6 }, { scroll: 700, frames: 10 }, { hold: 6 }] },
  workflow: { title: "WORKFLOW.EXE", status: "Workflow: every step a reel goes through, which AI service runs it, and what it costs", statusJa: "ワークフロー：リールが通る工程ごとに、動かすAIサービスと費用", steps: [
    { go: "#/workflow" }, { hold: 18 }, { click: "[data-wfnode]" }, { hold: 14 }, { scroll: 760, frames: 12 }, { hold: 6 },
    { click: "[data-wftpl]" }, { hold: 16 }] },
  review: { title: "REVIEW.EXE", status: "Review: watch each reel, see its clips and words, then Approve (it books itself)", statusJa: "確認：1本ずつ見て、クリップと言葉を確かめて承認（予約は自動）", steps: [
    { go: "#/review", settle: 3000 }, { hold: 10 }, { click: "[data-revplay]" }, { hold: 24 }, { hover: "[data-revok]" }, { hold: 8 }] },
  editor: { title: "EDITOR.EXE", status: "The reel editor: library, player, properties and the timeline, all on one screen", statusJa: "リール編集：素材、プレーヤー、設定、タイムラインを1画面に", steps: [
    { go: "#/reel/carstay-1108", ready: "#play" }, { hold: 10 }, { click: "#play" }, { hold: 30 }] },
  posting: { title: "POSTING.EXE", status: "Posting: a lane per network, a column per day, each post by its state; approved reels wait in the tray", statusJa: "投稿：SNSごとに1行、日ごとに1列。承認済みのリールは右の置き場で待つ", steps: [
    { go: "#/posting" }, { hold: 14 }, { scroll: 520, frames: 10 }, { hold: 10 }, { scroll: 520, frames: 10 }, { hold: 8 }] },
  results: { title: "RESULTS.EXE", status: "Results: views by network, predicted against actual, and the best time to post from your own numbers", statusJa: "結果：SNS別の再生、予測と実際、あなたの数字から割り出す投稿に向く時間", steps: [
    { go: "#/results" }, { hold: 10 }, { scroll: 420, frames: 8 }, { hold: 10 }, { click: "[data-restab='learn']" }, { hold: 6 },
    { scroll: 260, frames: 6 }, { hold: 14 }, { scroll: 1000, frames: 14 }, { hold: 14 }] },
  footage: { title: "FOOTAGE.EXE", status: "Footage: days of posts left, where you filmed, and every clip marked used or unused", statusJa: "素材：あと何日分投稿できるか、撮った場所、使用済み・未使用のクリップ", steps: [
    { go: "#/footage" }, { hold: 18 }, { scroll: 400, frames: 8 }, { hold: 8 }, { go: "#/footage/library" }, { hold: 10 }, { scroll: 500, frames: 8 }, { hold: 6 }] },
  versions: { title: "VERSIONS.EXE", status: "Versions: a better cut of a booked reel, shot by shot, with what changed lit up", statusJa: "バージョン：予約済みリールのもっと良い版を、カットごとに比べる", steps: [
    { go: "#/versions" }, { hold: 8 }, { scroll: 600, frames: 12 }, { hold: 18 }] },
  words: { title: "WORDS.EXE", status: "Words: every headline and line, how worn each one is, and how the reels using it did", statusJa: "言葉：見出しとセリフ、それぞれの使い古し具合と、使ったリールの反応", steps: [
    { go: "#/words" }, { hold: 16 }, { scroll: 400, frames: 8 }, { hold: 8 }, { go: "#/words/lines" }, { hold: 10 }] },
  log: { title: "LOG.EXE", status: "Activity log: every job over the last day, one lane per kind, coloured by result", statusJa: "処理の記録：直近1日の処理を、種類ごとの行に結果の色で", steps: [
    { go: "#/log/activity" }, { hold: 18 }, { scroll: 400, frames: 8 }, { hold: 8 }] },
  accounts: { title: "ACCOUNTS.EXE", status: "Settings: each network, how it gets posted, and what to do next", statusJa: "設定：SNSごとの投稿方法と、次にやること", steps: [
    { go: "#/accounts" }, { hold: 12 }, { scroll: 520, frames: 10 }, { hold: 10 }] },
  setup: { title: "SETUP.EXE", status: "Setup: the InstallShield-style wizard walks through every step", statusJa: "セットアップ：InstallShield風のウィザードで手順をひとつずつ", steps: [
    { go: "#/" }, { hold: 4 }, { js: "openWizard()" }, { hold: 12 }, { click: ".wzfoot .def" }, { hold: 10 }, { click: ".wzfoot .def" }, { hold: 10 }, { key: "Escape" }, { hold: 2 }] },
  popups: { title: "DONOTCLICK.EXE", status: "The 90s pop-up tour: Lazy Kenji explains every page (opt in, Esc stops it)", statusJa: "1999年風ポップアップの案内：Lazy Kenji が各ページを説明（任意、Escで終了）", steps: [
    { go: "#/" }, { hold: 4 }, { js: "POP.start()" }, { hold: 40 }, { key: "Escape" }, { hold: 4 }] },
  // The README hero (docs/img/approve.gif): a reel plays, the pointer comes to rest on Approve (it is never pressed), then
  // the Posting week with the reels that are already booked. Recorded only when named: --only approve.
  approve: { hero: true, vw: 1280, vh: 800, pointer: true, title: "REVIEW.EXE",
    status: "Watch the reel, then Approve is yours to press; approved reels are booked one a day per network",
    statusJa: "リールを見て、承認はあなたが押す。承認したリールは、各SNSに1日1本ずつ予約されます", steps: [
    { go: "#/review", settle: 3000 }, { hold: 4 }, { click: "[data-revplay]" }, { hold: 20 }, { moveto: "[data-revok]", frames: 8 }, { hold: 10 },
    { go: "#/posting" }, { hold: 18 }] },
};

function frameHtml(title, status) {
  // A Japanese window reads like a Japanese Windows 98 one: menus with their access keys in brackets, 準備完了 for Ready.
  const ja = LANG === "ja";
  const menu = ja ? ["ファイル(<u>F</u>)", "編集(<u>E</u>)", "表示(<u>V</u>)", "投稿(<u>P</u>)", "ヘルプ(<u>H</u>)"]
    : ["<u>F</u>ile", "<u>E</u>dit", "<u>V</u>iew", "<u>P</u>ost", "<u>H</u>elp"];
  return `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;background:transparent}
  .win{width:${GW + 16}px;background:#c0c0c0;border:2px solid;border-color:#fff #404040 #404040 #fff;box-shadow:inset -1px -1px #808080,inset 1px 1px #dfdfdf;padding:3px;font:12px/1 "MS Sans Serif",Tahoma,Verdana,"MS UI Gothic","Yu Gothic UI",Meiryo,sans-serif}
  .tb{height:22px;display:flex;align-items:center;gap:6px;padding:0 3px;background:linear-gradient(90deg,#000080,#1084d0);color:#fff;font-weight:700;letter-spacing:.3px}
  .tb img{width:16px;height:16px;image-rendering:pixelated}.tb .t{flex:1;white-space:nowrap}
  .tb b{width:18px;height:16px;background:#c0c0c0;color:#000;display:grid;place-items:center;border:2px solid;border-color:#fff #404040 #404040 #fff;font:700 11px/1 Tahoma,sans-serif}
  .menu{display:flex;gap:14px;padding:4px 6px 3px;color:#000}.menu u{text-decoration:underline}
  .scr{width:${GW}px;height:${GH}px;margin:1px 3px;background:#000;border:2px solid;border-color:#808080 #fff #fff #808080}
  .sb{display:flex;gap:3px;margin-top:3px}.sb span{border:1px solid;border-color:#808080 #fff #fff #808080;padding:3px 6px;color:#000;white-space:nowrap;overflow:hidden}
  .sb span:first-child{flex:1}</style>
  <div class="win" id="w"><div class="tb"><img src="${BASE}/brand/icon-16.png"><span class="t">C:\\LAZYCOW\\${title} - Lazycow Studio</span><b>_</b><b>□</b><b>×</b></div>
  <div class="menu">${menu.map((m) => `<span>${m}</span>`).join("")}</div>
  <div class="scr" id="s"></div><div class="sb"><span>${status}</span><span>localhost:4317</span><span>${ja ? "準備完了" : "Ready"}</span></div></div>`;
}

/* A drawn arrow pointer (headless Chrome paints none), for scenes that show where the pointer rests. It only follows
   mouse moves; it never clicks. */
const POINTER = () => {
  const put = () => {
    if (document.getElementById("lc-ptr") || !document.body) return;
    const p = document.createElement("div"); p.id = "lc-ptr";
    p.style.cssText = "position:fixed;left:-40px;top:-40px;width:22px;height:30px;z-index:2147483647;pointer-events:none";
    p.innerHTML = '<svg width="22" height="30" viewBox="0 0 22 30"><path d="M1 1v24l6-6 4 9 4-2-4-9h8z" fill="#fff" stroke="#000" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.body.appendChild(p);
  };
  addEventListener("mousemove", (e) => { put(); const p = document.getElementById("lc-ptr"); if (p) { p.style.left = e.clientX + "px"; p.style.top = e.clientY + "px"; } }, true);
};

/* What the public export must never carry (scripts/public-export.json "forbid": the owner's trip, its dates, names in
   footage folders...) must not land in a picture either: matching words are blurred where they stand. That file lives
   only in the private repo, so without it there is nothing to blur. */
const PRIVATE = (() => { try { return JSON.parse(readFileSync(new URL("./public-export.json", import.meta.url), "utf8")).forbid.map((f) => [f.re, f.flags || ""]); } catch { return []; } })();
const BLUR = (pats) => {
  const rxs = pats.map(([re, fl]) => new RegExp(re, fl.replace("g", "")));
  const one = (n) => {
    const p = n.parentNode, v = n.nodeValue;
    if (!v || !p || p.nodeType !== 1 || p.closest("[data-lc-blur]") || /^(SCRIPT|STYLE)$/.test(p.tagName)) return;
    let hit = null; for (const rx of rxs) { const m = rx.exec(v); if (m && m[0] && (!hit || m.index < hit.index)) hit = m; }
    if (!hit) return;
    const after = n.splitText(hit.index); after.nodeValue = after.nodeValue.slice(hit[0].length);
    const b = document.createElement("span"); b.dataset.lcBlur = "1"; b.textContent = hit[0];
    b.style.cssText = "display:inline-block;filter:blur(6px)"; p.insertBefore(b, after); one(after);
  };
  const scan = (root) => { if (root.nodeType === 3) return one(root); if (root.nodeType !== 1) return;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), all = []; for (let n; (n = w.nextNode());) all.push(n); all.forEach(one); };
  new MutationObserver((recs) => { for (const r of recs) { if (r.type === "characterData") one(r.target); else r.addedNodes.forEach(scan); } })
    .observe(document, { childList: true, subtree: true, characterData: true });
};

async function visibleFirst(page, sel) {
  for (const s of sel.split(/,\s*/)) {
    const loc = page.locator(s);
    const n = await loc.count();
    for (let i = 0; i < Math.min(n, 30); i++) if (await loc.nth(i).isVisible()) return loc.nth(i);
  }
  return null;
}

async function record(browser, name, scene) {
  const dir = join(tmpdir(), `lc-gif-${name}-${process.pid}`);
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  const VW = scene.vw || W, VH = scene.vh || H;
  const ctx = await browser.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: 1, locale: LANG === "ja" ? "ja-JP" : "en-GB" });
  // A first visit: no "seen" flags that would hide the wizard, the chosen language set.
  // Motion on (the GIFs show the studio's animations whatever the recording machine asks for) and the scene's colours.
  await ctx.addInitScript(([lang, theme]) => { try {
    localStorage.setItem("studio.lang", lang); localStorage.setItem("lc.wz.seen", "1");
    localStorage.setItem("studio.motion", "on"); localStorage.setItem("studio.motionHint", "1");
    localStorage.setItem("studio.theme", theme || "light");
  } catch { /* ignore */ } }, [LANG, scene.theme || ""]);
  // No email address ever lands in a public picture: every one on screen reads you@example.com, however often the
  // page redraws.
  await ctx.addInitScript(() => {
    const rx = /[\w.+-]+@[\w-]+(\.[\w-]+)+|\b\w{1,3}\.\.@[\w.-]+/g;
    const fixText = (n) => { const v = n.nodeValue; if (v && v.includes("@")) { const out = v.replace(rx, "you@example.com"); if (out !== v) n.nodeValue = out; } };
    const fix = (root) => { if (root.nodeType === 3) return fixText(root); if (root.nodeType !== 1 || !root.textContent.includes("@")) return;
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); for (let n; (n = w.nextNode());) fixText(n); };
    // Only what changed is looked at: walking the whole page on every redraw stalled it.
    new MutationObserver((recs) => { for (const r of recs) { if (r.type === "characterData") fixText(r.target); else r.addedNodes.forEach(fix); } })
      .observe(document, { childList: true, subtree: true, characterData: true });
  });
  if (PRIVATE.length) await ctx.addInitScript(BLUR, PRIVATE);
  if (scene.pointer) await ctx.addInitScript(POINTER);
  const page = await ctx.newPage();
  let k = 0, px = VW / 2, py = VH * 0.6;
  const shot = async () => { await page.screenshot({ path: join(dir, `${String(k++).padStart(4, "0")}.png`) }); };
  for (const s of scene.steps) {
    if (s.go) {
      await page.goto(BASE + "/" + s.go, { waitUntil: "domcontentloaded" }); await page.waitForTimeout(2500);
      // A busy studio can take a while: wait (up to 90 s) until no "Please wait" / "Loading" box is on screen; a page that
      // never finishes stops the scene, so no half-loaded GIF is ever written.
      // Then every picture and video in view must have its first frame (a grey box is not a finished page; a video set to
      // load nothing until played shows its poster instead), and a step's
      // `ready` element (the editor's player) must be showing.
      await page.waitForFunction((ready) => {
        const t = document.querySelector("#home")?.innerText || "";
        if (/Please wait|Loading |お待ちください|読み込み中/.test(t) || t.length <= 200) return false;
        if (ready && !document.querySelector(ready)?.getClientRects().length) return false;
        const inView = (e) => { const r = e.getBoundingClientRect(); return r.width > 2 && r.bottom > 0 && r.top < innerHeight; };
        return [...document.images].every((i) => !inView(i) || (i.complete && i.naturalWidth > 0))
          && [...document.querySelectorAll("video")].every((v) => !inView(v) || v.preload === "none" || v.readyState >= 2);
      }, s.ready || "", { timeout: 90000, polling: 400 }).catch(() => { throw new Error(`${name}: ${s.go} still loading after 90 s (the studio is busy?): nothing written`); });
      await page.waitForTimeout(1500 + (s.settle || 0));  // `settle`: extra ms for pictures drawn as backgrounds (clip strips)
      // The "Needs you" strip is about this studio's own chores, not the page being shown: hide it.
      await page.locator("[data-wnhide]").first().click({ timeout: 1500 }).catch(() => {});
      await page.addStyleTag({ content: ".toast,.toasts,#toasts,.probstrip.wn{display:none!important}" }).catch(() => {});
      px = VW / 2; py = VH * 0.6; await page.mouse.move(px, py); await page.waitForTimeout(300);
    }
    else if (s.hold) for (let i = 0; i < s.hold; i++) { await shot(); await page.waitForTimeout(60); }
    // The page's own scroller (the tallest scrollable box), not whatever panel sits under the pointer.
    else if (s.scroll) for (let i = 0; i < s.frames; i++) {
      await page.evaluate((dy) => { const all = [document.scrollingElement, ...document.querySelectorAll("main,section,div")]
        .filter((e) => e && e.scrollHeight > e.clientHeight + 40 && (e === document.scrollingElement || /auto|scroll/.test(getComputedStyle(e).overflowY)));
        all.sort((a, b) => b.clientHeight - a.clientHeight)[0]?.scrollBy(0, dy); }, s.scroll / s.frames).catch(() => {});
      await page.waitForTimeout(40); await shot(); }
    else if (s.hover || s.click) {
      const el = await visibleFirst(page, s.hover || s.click);
      if (!el) { console.log(`  ${name}: nothing matches ${s.hover || s.click}`); continue; }
      await el.scrollIntoViewIfNeeded().catch(() => {});
      if (s.click) {
        const what = await el.evaluate((n) => `${n.innerText || ""} ${[...n.attributes].map((a) => a.name).join(" ")}`).catch(() => "");
        if (UNSAFE.test(what)) throw new Error(`${name}: refusing to click "${what.trim().slice(0, 60)}": it changes the studio`);
      }
      if (s.hover) await el.hover().catch(() => {}); else await el.click().catch(() => {});
      await page.waitForTimeout(500);
    } else if (s.sweep) {
      const el = await visibleFirst(page, s.sweep);
      if (!el) { console.log(`  ${name}: nothing matches ${s.sweep}`); continue; }
      await el.scrollIntoViewIfNeeded().catch(() => {}); const b = await el.boundingBox();
      if (b) for (let i = 0; i < s.frames; i++) { px = b.x + 6 + (b.width - 12) * i / (s.frames - 1); py = b.y + b.height / 2; await page.mouse.move(px, py); await page.waitForTimeout(140); await shot(); }
    } else if (s.moveto) {
      // Glide the pointer onto a control and leave it there. Nothing is pressed.
      const el = await visibleFirst(page, s.moveto);
      if (!el) { console.log(`  ${name}: nothing matches ${s.moveto}`); continue; }
      await el.scrollIntoViewIfNeeded().catch(() => {}); const b = await el.boundingBox();
      if (b) { const x0 = px, y0 = py, x1 = b.x + Math.min(34, b.width / 2), y1 = b.y + b.height * 0.6;
        for (let i = 1; i <= s.frames; i++) { const t = i / s.frames, e = t * t * (3 - 2 * t); px = x0 + (x1 - x0) * e; py = y0 + (y1 - y0) * e;
          await page.mouse.move(px, py); await page.waitForTimeout(60); await shot(); } }
    } else if (s.text) {
      const loc = page.getByRole("button", { name: new RegExp(`^\\s*${s.text}`) });
      const el = (await loc.count()) ? loc.first() : null;
      if (el && await el.isVisible()) { await el.scrollIntoViewIfNeeded().catch(() => {}); await el.click().catch(() => {}); await page.waitForTimeout(700); }
      else console.log(`  ${name}: no button "${s.text}"`);
    } else if (s.js) { await page.evaluate(s.js).catch((e) => console.log(`  ${name}: ${e.message.split("\n")[0]}`)); await page.waitForTimeout(800); }
    else if (s.key) { await page.keyboard.press(s.key); await page.waitForTimeout(400); }
  }
  // The window frame, drawn once, then every page frame placed inside it.
  await page.setViewportSize({ width: GW + 60, height: GH + 120 });
  await page.setContent(frameHtml(scene.title, (LANG === "ja" && scene.statusJa) || scene.status));
  await page.waitForTimeout(300);
  const box = await page.locator("#w").boundingBox(), scr = await page.locator("#s").boundingBox();
  await page.locator("#w").screenshot({ path: join(dir, "frame.png") });
  await ctx.close();
  const x = Math.round(scr.x - box.x + 2), y = Math.round(scr.y - box.y + 2);
  const out = join(OUT, `${name}.gif`);
  const ff = spawnSync(FFMPEG, ["-y", "-loglevel", "error", "-loop", "1", "-i", join(dir, "frame.png"), "-framerate", String(FPS), "-i", join(dir, "%04d.png"),
    "-filter_complex", `[1:v]scale=${GW}:${GH}:flags=lanczos[s];[0:v][s]overlay=${x}:${y}:shortest=1,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
    "-loop", "0", out], { stdio: "inherit" });
  rmSync(dir, { recursive: true, force: true });
  if (ff.status !== 0) throw new Error(`ffmpeg failed for ${name}`);
  console.log(`${name}.gif  ${k} frames  ${Math.round(statSync(out).size / 1024)} KB`);
}

if (!CHROME) throw new Error("Google Chrome not found; set CHROME_PATH");
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
try {
  for (const [name, scene] of Object.entries(SCENES)) if (ONLY.length ? ONLY.includes(name) : !scene.hero) await record(browser, name, scene);
} finally { await browser.close(); }
