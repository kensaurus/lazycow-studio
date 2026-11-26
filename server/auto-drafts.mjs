/**
 * FILE: server/auto-drafts.mjs
 * PURPOSE: The bookkeeping of drafts from new footage (server/review.mjs autoDrafts): whether this studio may draft at
 *          all, how many it may still make today, and the per-project file that keeps the day's count and the last run.
 * DEPENDENCIES: node:fs, node:path
 * USAGE: import { draftsFile, readDraftsState, draftsRoom, nextDraftsState } from "./auto-drafts.mjs" (server/review.mjs).
 * NOTES: BL-142 (26 Nov). A look-only studio (STUDIO_QUIET=1) never drafts: a person pressing Look for new files or adding a
 *        folder there still catalogues the footage, but no reel is made or rendered by itself. The count lives in the
 *        project's own data folder (<data>/auto-drafts.json), so one project's drafts never use up another's day. The old
 *        shared STUDIO_HOME/auto-drafts.json is only read, never written or deleted: a project with no file of its own
 *        takes today's count from it (so the day it is upgraded, no project drafts more than the shared cap allowed);
 *        its total and last run belonged to whichever project ran, so they are not carried over.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DRAFTS_NAME = "auto-drafts.json";

/** The project's own count file: <data>/auto-drafts.json. */
export const draftsFile = (dataDir) => join(dataDir, DRAFTS_NAME);

const readJson = (file) => { try { const v = JSON.parse(readFileSync(file, "utf8")); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { return null; } };

/**
 * The saved state for this project ({day, n, themeAt, last, lastWhy, lastMade, lastSteer, total}), {} when none.
 * `legacy` is the old shared file (STUDIO_HOME/auto-drafts.json): used only when the project has no file yet, and then
 * only its count for today.
 */
export function readDraftsState(file, { legacy = null, today = new Date().toISOString().slice(0, 10) } = {}) {
  const own = readJson(file);
  if (own) return own;
  const old = legacy ? readJson(legacy) : null;
  return old && old.day === today && Number.isFinite(+old.n) && +old.n > 0 ? { day: today, n: Math.floor(+old.n) } : {};
}

/** How many drafts may still be made today: 0 in a look-only studio, when drafting is off, or once the day's cap is used. */
export function draftsRoom({ quiet, perDay, state = {}, today = new Date().toISOString().slice(0, 10) }) {
  if (quiet || !(perDay > 0)) return 0;
  const used = state.day === today ? Math.max(0, Number(state.n) || 0) : 0;
  return Math.max(0, perDay - used);
}

/** The state after a run that made `made` (each {slug, steer?}) from `picked` themes out of `themeCount`. */
export function nextDraftsState(state, { today, made, picked, themeCount, why, at = new Date().toISOString() }) {
  const s = state.day === today ? state : { ...state, day: today, n: 0 };
  return { ...s, day: today, n: (Number(s.n) || 0) + made.length, themeAt: themeCount ? ((Number(s.themeAt) || 0) + picked) % themeCount : 0,
    last: at, lastWhy: why, lastMade: made.map((m) => m.slug), lastSteer: made.map((m) => m.steer || null), total: (Number(s.total) || 0) + made.length };
}

/** Saves the state; best effort (a full or read-only disk only loses the count). */
export function writeDraftsState(file, state) {
  try { writeFileSync(file, JSON.stringify(state)); return true; } catch { return false; }
}
