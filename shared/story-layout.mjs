/**
 * FILE: shared/story-layout.mjs
 * PURPOSE: Where the Story composition puts its words, for every canvas and text style.
 * OVERVIEW: hook = the reversal headline, line = a proof sentence, end = the
 *           嬬恋牧場 Work & Camp card. Four styles so reels do not all look alike:
 *             column  vertical Mincho top-right (tall canvases), lines low
 *             centre  horizontal headline centred in the upper third, lines centred low
 *             lower   horizontal headline in the lower third, lines high
 *             split   vertical Mincho top-left (tall canvases), lines low
 *           Lines also take a side ("left" / "right"): the build puts each line on
 *           the side of its shot where the picture is quiet, so words do not cover
 *           the subject. Every box stays inside the safe zone (test/story.test.mjs).
 * DEPENDENCIES: shared/layout.mjs (safe zones from spec.json)
 * USAGE: storyLayout(w, h, hookColumns, style) and lineBox(L, side) from Story.tsx and the tests
 * NOTES: Japanese sizes leave 12% line spacing. Change a size here, not in TSX.
 */
import { safeOf } from "./layout.mjs";

export const STYLES = ["column", "centre", "lower", "split"];

export function storyLayout(w, h, hookColumns = ["不便だからこそ、", "景色がいい。"], style = "column") {
  const s = safeOf(w, h);
  const safeW = s.right - s.x;
  const safeH = s.bottom - s.y;
  const tall = h / w > 1.5;
  const st = STYLES.includes(style) ? style : "column";
  const vertical = tall && (st === "column" || st === "split");
  const longest = Math.max(...hookColumns.map((c) => [...c].length));
  const hookFont = vertical
    ? Math.floor(Math.min(104, (safeH - 230) / (longest * 1.08)))
    : Math.floor(Math.min(tall ? 92 : 84, (safeW - 20) / (longest * 1.04)));
  const hookW = vertical ? Math.ceil(hookColumns.length * hookFont * 1.32) : Math.ceil(longest * hookFont * 1.04);
  const hookH = vertical ? Math.ceil(longest * hookFont * 1.08) : Math.ceil(hookColumns.length * hookFont * 1.3);
  const enFont = tall ? 54 : 46;
  const lineFont = tall ? 58 : 46;
  const enLine = tall ? 46 : 38;
  const lineH = Math.ceil(2 * lineFont * 1.4 + 2 * enLine * 1.35 + 30);
  const enH = tall ? 170 : 120;

  let hook, hookEn, lineY, align;
  if (vertical) {
    const right = st === "column";
    hook = { x: right ? s.right - hookW - 10 : s.x + 10, y: s.y + 20, w: hookW, h: hookH, font: hookFont };
    const enW = Math.min(620, safeW - hookW - 40);
    hookEn = { x: right ? s.x + 10 : s.right - enW - 10, y: s.bottom - enH - 10, w: enW, h: enH, font: enFont };
    lineY = s.bottom - lineH - 8;
    align = right ? "left" : "right";
  } else if (st === "centre") {
    const y = Math.round(s.y + safeH * (tall ? 0.2 : 0.14));
    hook = { x: Math.round(s.x + (safeW - hookW) / 2), y, w: hookW, h: hookH, font: hookFont };
    hookEn = { x: s.x + 10, y: y + hookH + 16, w: safeW - 20, h: enH, font: enFont };
    lineY = s.bottom - lineH - 8;
    align = "center";
  } else if (st === "lower") {
    const y = Math.round(s.bottom - hookH - enH - 40);
    hook = { x: s.x + 10, y, w: hookW, h: hookH, font: hookFont };
    hookEn = { x: s.x + 10, y: y + hookH + 16, w: Math.min(1100, safeW - 20), h: enH, font: enFont };
    lineY = s.y + 20;
    align = "left";
  } else {
    const right = st === "split";
    hook = { x: right ? s.right - hookW - 10 : s.x + 10, y: s.y + 30, w: hookW, h: hookH, font: hookFont };
    hookEn = { x: s.x + 10, y: hook.y + hookH + 16, w: safeW - 20, h: enH, font: enFont };
    lineY = s.bottom - lineH - 8;
    align = right ? "right" : "left";
  }
  const line = { x: s.x + 10, y: lineY, w: safeW - 20, h: lineH, font: lineFont, enFont: enLine };
  const endH = tall ? 330 : 280;
  const end = { x: s.x, y: Math.round(s.y + (safeH - endH) / 2), w: safeW, h: endH };
  return { safe: s, hook, hookEn, line, end, vertical, style: st, hookAlign: st === "centre" ? "center" : vertical ? "start" : hook.x > s.x + safeW / 3 ? "right" : "left", lineAlign: align };
}

/** The line box for one caption. side: "left" | "right" | undefined (the style's default). */
export function lineBox(L, side) {
  const align = L.style === "centre" && !side ? "center" : side || L.lineAlign;
  const w = Math.round((L.line.w) * (align === "center" ? 1 : 0.86));
  const x = align === "right" ? L.line.x + L.line.w - w : align === "center" ? L.line.x : L.line.x;
  return { ...L.line, x, w, align };
}

export function inside(box, s) {
  return box.x >= s.x && box.y >= s.y && box.x + box.w <= s.right && box.y + box.h <= s.bottom;
}

export function overlaps(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/* ---------- looks and recipes (src/looks.tsx, shared/looks.json) ---------- */

const tallSafe = (s) => s.bottom - s.y > (s.right - s.x) * 0.9;

/**
 * The kicker: a short framing label ("POV:", "3つの理由") shown with the headline. It goes above the
 * headline when there is room, else just above the English (vertical styles) or under it, never on the words.
 */
export function kickerBox(L) {
  const s = L.safe;
  const tall = tallSafe(s);
  const font = tall ? 44 : 38;
  const enFont = tall ? 34 : 30;
  const h = Math.ceil(font * 1.35 + enFont * 1.3 + 6);
  const w = Math.min(tall ? 760 : 900, s.right - s.x - 20);
  const hookX = L.hookAlign === "right" ? L.hook.x + L.hook.w - w : L.hookAlign === "center" ? Math.round(L.hook.x + (L.hook.w - w) / 2) : L.hook.x;
  const clampX = (x) => Math.max(s.x + 10, Math.min(s.right - 10 - w, x));
  // A vertical headline leaves the other top corner empty: the kicker goes there, beside it.
  const right = L.hook.x > s.x + (s.right - s.x) / 2;
  const besideX = right ? s.x + 10 : L.hook.x + L.hook.w + 24;
  const besideW = right ? L.hook.x - s.x - 34 : s.right - 10 - besideX;
  const beside = L.vertical && besideW >= 420 ? [{ x: besideX, y: L.hook.y, w: Math.min(w, besideW) }] : [];
  const candidates = [
    ...beside,
    { x: clampX(hookX), y: L.hook.y - h - 14 },
    { x: clampX(L.hookEn.x), y: L.hookEn.y - h - 12 },
    { x: clampX(L.hookEn.x), y: L.hookEn.y + L.hookEn.h + 8 },
    { x: s.x + 10, y: s.bottom - h - 4 },
  ].map((c) => ({ w, ...c, h, font, enFont }));
  const free = (b) => inside(b, s) && !overlaps(b, L.hook) && !overlaps(b, L.hookEn);
  return candidates.find(free) || candidates.find((b) => inside(b, s)) || candidates[candidates.length - 1];
}

/** The countdown's giant number for one line: beside the line box, on its side, never on the words. */
export function numeralBox(L, side) {
  const B = lineBox(L, side);
  const s = L.safe;
  const tall = tallSafe(s);
  const font = tall ? 300 : 230;
  const w = Math.round(font * 1.25);
  const h = Math.round(font * 1.02);
  const x = B.align === "right" ? s.right - w - 10 : B.align === "center" ? Math.round(s.x + (s.right - s.x - w) / 2) : s.x + 10;
  const linesHigh = B.y < s.y + (s.bottom - s.y) / 3;
  const y = linesHigh ? B.y + B.h + 6 : B.y - h - 6;
  return { x, y, w, h, font, align: B.align };
}

/**
 * The timeline rail (朝 昼 夕 夜). It shows after the headline, so it only has to keep off the lines:
 * the top of the safe zone, or the bottom when a style puts the lines high.
 */
export function railBox(L) {
  const s = L.safe;
  const tall = tallSafe(s);
  const h = tall ? 136 : 110;
  const linesHigh = L.line.y < s.y + (s.bottom - s.y) / 3;
  const y = linesHigh ? s.bottom - h - 6 : s.y + 6;
  return { x: s.x + 40, y, w: s.right - s.x - 80, h, font: tall ? 46 : 38, enFont: tall ? 30 : 26 };
}

/** The altitude counter that stands in for the headline: label, climbing number, English. */
export function meterBox(L) {
  const s = L.safe;
  const safeH = s.bottom - s.y;
  const tall = tallSafe(s);
  const label = tall ? 60 : 50;
  const num = tall ? 230 : 190;
  const en = tall ? 52 : 44;
  const h = Math.ceil(label * 1.3 + num * 1.02 + en * 1.3 + 24);
  const y = tall ? Math.round(s.y + safeH * 0.14) : Math.round(s.y + (safeH - h) / 2);
  return { x: s.x + 10, y, w: s.right - s.x - 20, h, label, num, en };
}

/** Season (or time) chips for the split look: one per half, beside the divider, right-aligned. */
export function chipBoxes(L, w, h) {
  const s = L.safe;
  const cw = 200;
  if (h > w) {
    const ch = 104;
    const mid = Math.round(h / 2);
    return [
      { x: s.right - cw - 10, y: Math.max(s.y, mid - ch - 18), w: cw, h: ch },
      { x: s.right - cw - 10, y: Math.min(s.bottom - ch, mid + 18), w: cw, h: ch },
    ];
  }
  const ch = 92;
  const mid = Math.round(w / 2);
  return [
    { x: Math.max(s.x, mid - cw - 24), y: s.y + 10, w: cw, h: ch },
    { x: Math.min(s.right - cw, mid + 24), y: s.y + 10, w: cw, h: ch },
  ];
}
