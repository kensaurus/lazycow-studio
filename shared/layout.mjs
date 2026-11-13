/**
 * FILE: shared/layout.mjs
 * PURPOSE: Safe-zone math shared by Remotion and the unit tests.
 * OVERVIEW: 9:16 numbers are Meta's ads guide. Other aspects are in spec.json.
 * DEPENDENCIES: shared/spec.json
 * USAGE: import { captionBox, insideSafe } from "./layout.mjs"
 * NOTES: Two lines of type, centered, above the bottom UI.
 */
import spec from "./spec.json" with { type: "json" };

export function formatOf(w, h) {
  if (w === 1080 && h === 1920) return "9x16";
  if (w === 1080 && h === 1350) return "4x5";
  if (w === 1920 && h === 1080) return "16x9";
  throw new Error(`unknown canvas ${w}x${h}`);
}

export function safeOf(w, h) {
  return spec.formats[formatOf(w, h)].safe;
}

export function captionBox(text, w, h) {
  const safe = safeOf(w, h);
  const font = w >= 1600 ? 54 : 64;
  const lineH = Math.round(font * 1.25);
  const lines = Math.max(1, String(text).split("\n").length);
  const boxH = lines * lineH;
  const boxW = Math.min(900, safe.right - safe.x - 8);
  const x = Math.round((w - boxW) / 2);
  const y = Math.min(safe.bottom - boxH - 8, Math.round(safe.y + (safe.bottom - safe.y) * 0.62));
  return { x, y, w: boxW, h: boxH, bottom: y + boxH, right: x + boxW };
}

export function insideSafe(box, w, h) {
  const s = safeOf(w, h);
  return box.x >= s.x && box.y >= s.y && box.right <= s.right && box.bottom <= s.bottom;
}
