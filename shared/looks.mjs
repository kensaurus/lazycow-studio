/**
 * FILE: shared/looks.mjs
 * PURPOSE: The look and recipe names (shared/looks.json) and the pure helpers src/looks.tsx uses,
 *          so node tests can check them without a renderer.
 * OVERVIEW: parseMeter splits the altitude line into label, number and unit; splitGroups pairs shots
 *           for the split look; opensShown and headlineAlpha say how the headline stands on the first frame
 *           and comes back under the loop ending.
 * DEPENDENCIES: shared/looks.json
 * USAGE: import { LOOKS, RECIPES, parseMeter, splitGroups } from "../shared/looks.mjs"
 * NOTES: py/studio/staging.py reads the same JSON.
 */
import spec from "./looks.json" with { type: "json" };

export const LOOKS = Object.keys(spec.looks);
export const RECIPES = Object.keys(spec.recipes);

/** "標高1,444m。" → { label: "標高", value: 1444, unit: "m" }; null when the line has no number. */
export function parseMeter(ja) {
  const m = String(ja).replace(/\n/g, "").match(/^(.*?)(\d{1,3}(?:,\d{3})+|\d+)\s*(m|ｍ|km)/);
  if (!m) return null;
  return { label: m[1].replace(/[、。\s]+$/, ""), value: Number(m[2].replace(/,/g, "")), unit: m[3] === "ｍ" ? "m" : m[3] };
}

/** Pairs for the split look: (0,1), (2,3)… and the last shot alone under the end card. */
export function splitGroups(n) {
  const groups = [];
  let i = 0;
  while (i < n - 1) {
    if (i + 1 < n - 1) {
      groups.push([i, i + 1]);
      i += 2;
    } else {
      groups.push([i]);
      i += 1;
    }
  }
  if (n > 0) groups.push([n - 1]);
  return groups;
}

/**
 * Words from frame 0 (27 Nov 2026: 83 % of Shorts viewers swipe away, and a headline typed in from 0.1 s left the first
 * frame the feed shows without words). A hook that starts within one frame of the start is drawn whole at once: no fade,
 * no letters arriving, the kicker and the English with it. Every recipe keeps its look, already arrived (pov: typed,
 * caret blinking; altitude: the counter at its number, the ruler still running). A hook that starts later (an older
 * project's props) keeps its arrival. py/studio/reels.py open_on_words moves every hook to 0.0 before a render.
 */
export const OPEN_SEC = 1 / 30;
export const opensShown = (beat) => !!beat && beat.kind === "hook" && Number(beat.startSec) < OPEN_SEC;

/** Frames of the loop ending (src/looks.tsx LoopTail): the opening shot dissolves in under the reel's last frames. */
export const LOOP_FRAMES = 12;

/**
 * How visible the headline is at `frame`: 0..1, and whether it is drawn at all.
 * inSec / outSec: the fade in and out the component uses (Story 0.5 / 0.35, the looks 0.4 / 0.3).
 * tail: { from, to } frames of the loop ending, or null. A headline shown from frame 0 comes back over the tail, so the
 * last frame matches the first and a replay has no seam (the opening shot dissolves in beneath it at the same time).
 * @param {{ kind: string, startSec: number, endSec: number }} beat
 * @param {number} frame
 * @param {number} fps
 * @param {{ inSec?: number, outSec?: number, tail?: { from: number, to: number } | null }} [opts]
 * @returns {{ alpha: number, live: boolean, shown: boolean }}
 */
export function headlineAlpha(beat, frame, fps, { inSec = 0.5, outSec = 0.35, tail = null } = {}) {
  const t = frame / fps;
  const clamp = (x) => Math.max(0, Math.min(1, x));
  const shown = opensShown(beat);
  const live = t >= (shown ? 0 : beat.startSec) && t < beat.endSec;
  const inT = shown ? 1 : clamp((t - beat.startSec) / inSec);
  const outT = clamp((beat.endSec - t) / outSec);
  let alpha = live ? Math.min(inT, outT) : 0;
  if (shown && tail && tail.to - 1 > tail.from && frame >= tail.from) alpha = Math.max(alpha, clamp((frame - tail.from) / (tail.to - 1 - tail.from)));
  return { alpha, live: live || alpha > 0, shown };
}
