#!/usr/bin/env node
/*
 * FILE: scripts/docs-gifs.mjs
 * PURPOSE: Record one short animated GIF per studio page for the docs (README, npm README, user guide, the kensaur.us
 *          story), each framed as a 90s program window (title bar, buttons, status bar), like the studio's own wizard.
 * USAGE:   node scripts/docs-gifs.mjs [--url http://127.0.0.1:4317] [--out docs/img/pages] [--only reels,posting]
 *          Needs a running studio, Google Chrome, and ffmpeg (STUDIO_TOOLS or PATH).
 * SAFETY:  Looks only: it opens pages, scrolls, hovers, switches filters and plays previews. It never presses Approve,
 *          Book, Post, Save or anything that changes the studio (each scene below is a fixed list of such steps).
 * OUTPUT:  <out>/<scene>.gif (960x600 page inside a ~976x658 window, 8 frames a second, looping).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
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

/* Each scene: a window title, a status-bar line, and steps. Step kinds: go (hash route), hold (frames), scroll (px over
   frames), hover / click (CSS selector, first visible match), text (a button by its label), js (page code), key. Only safe controls are named. */
const SCENES = {
  reels: { title: "REELS.EXE", status: "Reels: what is waiting for you, what goes out next, every reel by the day it was made", steps: [
    { go: "#/" }, { hold: 16 }, { scroll: 520, frames: 10 }, { hold: 4 },
    { hover: ".rgroup .rcard" }, { hold: 10 }, { scroll: 700, frames: 10 }, { hold: 6 }] },
  review: { title: "REVIEW.EXE", status: "Review: watch each reel, see its clips and words, then Approve (it books itself)", steps: [
    { go: "#/review" }, { hold: 10 }, { click: "[data-revplay]" }, { hold: 24 }, { hover: "[data-revok]" }, { hold: 8 }] },
  editor: { title: "EDITOR.EXE", status: "The reel editor: library, player, properties and the timeline, all on one screen", steps: [
    { go: "#/reel/carstay-1108" }, { hold: 10 }, { click: "#play" }, { hold: 30 }] },
  posting: { title: "POSTING.EXE", status: "Posting: the calendar of every booking, with each day's times and headline", steps: [
    { go: "#/posting" }, { hold: 8 }, { scroll: 560, frames: 10 }, { hold: 10 }, { hover: ".cchip" }, { hold: 6 },
    { click: "a[href='#/posting/schedule/instagram-story']" }, { hold: 10 }, { click: "a[href='#/posting/schedule/youtube']" }, { hold: 8 }] },
  results: { title: "RESULTS.EXE", status: "Results: views by network, what is not being shown, every post's numbers", steps: [
    { go: "#/results" }, { hold: 12 }, { scroll: 380, frames: 8 }, { hold: 12 }, { scroll: 600, frames: 10 }, { hold: 8 }] },
  footage: { title: "FOOTAGE.EXE", status: "Footage: where clips come from (Drive, Google Photos, a Google Form) and what is unused", steps: [
    { go: "#/footage" }, { hold: 10 }, { scroll: 420, frames: 8 }, { hold: 8 }, { text: "Videos" }, { hold: 8 }, { scroll: 500, frames: 8 }, { hold: 6 }] },
  accounts: { title: "ACCOUNTS.EXE", status: "Settings: each network, how it gets posted, and what to do next", steps: [
    { go: "#/accounts" }, { hold: 12 }, { scroll: 520, frames: 10 }, { hold: 10 }] },
  setup: { title: "SETUP.EXE", status: "Setup: the InstallShield-style wizard walks through every step", steps: [
    { go: "#/" }, { hold: 4 }, { js: "openWizard()" }, { hold: 12 }, { click: ".wzfoot .def" }, { hold: 10 }, { click: ".wzfoot .def" }, { hold: 10 }, { key: "Escape" }, { hold: 2 }] },
  popups: { title: "DONOTCLICK.EXE", status: "The 90s pop-up tour: Lazy Kenji explains every page (opt in, Esc stops it)", steps: [
    { go: "#/" }, { hold: 4 }, { js: "POP.start()" }, { hold: 40 }, { key: "Escape" }, { hold: 4 }] },
};

function frameHtml(title, status) {
  return `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;background:transparent}
  .win{width:${GW + 16}px;background:#c0c0c0;border:2px solid;border-color:#fff #404040 #404040 #fff;box-shadow:inset -1px -1px #808080,inset 1px 1px #dfdfdf;padding:3px;font:12px/1 "MS Sans Serif",Tahoma,Verdana,sans-serif}
  .tb{height:22px;display:flex;align-items:center;gap:6px;padding:0 3px;background:linear-gradient(90deg,#000080,#1084d0);color:#fff;font-weight:700;letter-spacing:.3px}
  .tb img{width:16px;height:16px;image-rendering:pixelated}.tb .t{flex:1;white-space:nowrap}
  .tb b{width:18px;height:16px;background:#c0c0c0;color:#000;display:grid;place-items:center;border:2px solid;border-color:#fff #404040 #404040 #fff;font:700 11px/1 Tahoma,sans-serif}
  .menu{display:flex;gap:14px;padding:4px 6px 3px;color:#000}.menu u{text-decoration:underline}
  .scr{width:${GW}px;height:${GH}px;margin:1px 3px;background:#000;border:2px solid;border-color:#808080 #fff #fff #808080}
  .sb{display:flex;gap:3px;margin-top:3px}.sb span{border:1px solid;border-color:#808080 #fff #fff #808080;padding:3px 6px;color:#000;white-space:nowrap;overflow:hidden}
  .sb span:first-child{flex:1}</style>
  <div class="win" id="w"><div class="tb"><img src="${BASE}/brand/icon-16.png"><span class="t">C:\\LAZYCOW\\${title} - Lazycow Studio</span><b>_</b><b>□</b><b>×</b></div>
  <div class="menu"><span><u>F</u>ile</span><span><u>E</u>dit</span><span><u>V</u>iew</span><span><u>P</u>ost</span><span><u>H</u>elp</span></div>
  <div class="scr" id="s"></div><div class="sb"><span>${status}</span><span>localhost:4317</span><span>Ready</span></div></div>`;
}

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
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, locale: LANG === "ja" ? "ja-JP" : "en-GB" });
  // A first visit: no "seen" flags that would hide the wizard, the chosen language set.
  await ctx.addInitScript((lang) => { try { localStorage.setItem("studio.lang", lang); localStorage.setItem("lc.wz.seen", "1"); } catch { /* ignore */ } }, LANG);
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
  const page = await ctx.newPage();
  let k = 0;
  const shot = async () => { await page.screenshot({ path: join(dir, `${String(k++).padStart(4, "0")}.png`) }); };
  for (const s of scene.steps) {
    if (s.go) {
      await page.goto(BASE + "/" + s.go, { waitUntil: "domcontentloaded" }); await page.waitForTimeout(3500);
      // The "things need you" strip is about this studio's own chores, not the page being shown: hide it.
      await page.locator("#probStrip button.icon").first().click({ timeout: 1500 }).catch(() => {});
      await page.mouse.move(W / 2, H * 0.6); await page.waitForTimeout(300);
    }
    else if (s.hold) for (let i = 0; i < s.hold; i++) { await shot(); await page.waitForTimeout(60); }
    else if (s.scroll) for (let i = 0; i < s.frames; i++) { await page.mouse.wheel(0, s.scroll / s.frames); await page.waitForTimeout(40); await shot(); }
    else if (s.hover || s.click) {
      const el = await visibleFirst(page, s.hover || s.click);
      if (!el) { console.log(`  ${name}: nothing matches ${s.hover || s.click}`); continue; }
      await el.scrollIntoViewIfNeeded().catch(() => {});
      if (s.hover) await el.hover().catch(() => {}); else await el.click().catch(() => {});
      await page.waitForTimeout(500);
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
  await page.setContent(frameHtml(scene.title, scene.status));
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
  for (const [name, scene] of Object.entries(SCENES)) if (!ONLY.length || ONLY.includes(name)) await record(browser, name, scene);
} finally { await browser.close(); }
