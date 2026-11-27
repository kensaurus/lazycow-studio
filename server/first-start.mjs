/**
 * FILE: server/first-start.mjs
 * PURPOSE: Whether a studio reads its footage folders as soon as it starts (BL-144). A new project whose folder already
 *          holds footage said "Drop your videos here" until the watcher's first look, 90 s after start (and never in a
 *          look-only studio). A project that was never read (no <data>/sources_state.json yet, the file every read
 *          writes) is read a few seconds after start instead.
 * USAGE: import { firstStartRead } from "./first-start.mjs" (server/review.mjs).
 * NOTES: A look-only studio (STUDIO_QUIET=1) starts nothing by itself, and may share another studio's data folder:
 *        Home offers it a "Read these N files now" button instead (GET /api/sources?look=1). STUDIO_WATCH_MINUTES=0
 *        turns the watcher off, and with it this read.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

/** { read: boolean, why: string } for a studio about to start. */
export function firstStartRead({ quiet, watchMinutes, data, exists = existsSync }) {
  if (quiet) return { read: false, why: "look-only studio: a person reads the folder from Home" };
  if (!(watchMinutes > 0)) return { read: false, why: "the footage watcher is off" };
  if (exists(join(data, "sources_state.json"))) return { read: false, why: "read before: the watcher keeps it up to date" };
  return { read: true, why: "first start" };
}
