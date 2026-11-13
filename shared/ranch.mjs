/**
 * FILE: shared/ranch.mjs
 * PURPOSE: Is this checkout the owner's Tsumagoi Work&Camp workspace (the "ranch"), or a clean clone?
 * OVERVIEW: Same rule as py/studio/config.py ranch_overlay() / is_ranch(). STUDIO_RANCH=1 or 0 decides when set;
 *           otherwise the ranch overlay's marker (shared/reels.json, the ranch's reel plan) must be present. The owner's
 *           private checkout has it; a public clone does not, so it starts brand-neutral and keeps its reels in
 *           <data>/projects. The ranch is the main project (reels in ./projects) of a checkout with the overlay.
 * DEPENDENCIES: node:fs, node:path
 * USAGE: import { ranchOverlay, defaultProjectsDir, isRanch } from "../shared/ranch.mjs";
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export const RANCH_MARKER = join("shared", "reels.json");

export function ranchOverlay(root, flag = "", exists = existsSync) {
  const f = String(flag || "").trim().toLowerCase();
  if (["1", "on", "true", "yes"].includes(f)) return true;
  if (["0", "off", "false", "no"].includes(f)) return false;
  return exists(join(root, RANCH_MARKER));
}

/** Where reel project files go when STUDIO_PROJECTS is not set. */
export function defaultProjectsDir(root, data, overlay) {
  return overlay ? join(root, "projects") : join(data, "projects");
}

export function isRanch(root, projectsDir, overlay) {
  return !!overlay && resolve(projectsDir) === resolve(join(root, "projects"));
}
