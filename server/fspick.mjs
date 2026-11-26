/**
 * FILE: server/fspick.mjs
 * PURPOSE: The folder picker's typed path (BL-141, 26 Nov): what a person types or pastes in the picker's path box is
 *          cleaned (spaces, the quotes Windows' "Copy as path" adds, a leading ~ for the home folder) and checked before
 *          anything lists it: an absolute path, no control characters, and it must exist and be a folder.
 * DEPENDENCIES: node:fs, node:os, node:path
 * USAGE: import { typedFolder, checkFolder } from "./fspick.mjs" (server/review.mjs GET /api/fs/list).
 * NOTES: The same rules as every other picker path (folderArg in server/review.mjs): Windows drive paths or POSIX
 *        absolute paths only, at most 1024 characters. A network share (\\server\share) is not taken, as before.
 */
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

const ABS = /^([A-Za-z]:[\\/]|\/)/;

/** {path} for a usable absolute folder path, else {error}. Nothing on disk is read here. */
export function typedFolder(raw, { home = homedir(), platform = process.platform } = {}) {
  if (typeof raw !== "string") return { error: "folder path" };
  let p = raw.trim();
  const q = /^(["'])(.*)\1$/.exec(p);
  if (q) p = q[2].trim();
  if (!p || p.length > 1024 || /[\u0000-\u001f]/.test(p)) return { error: "folder path" };
  if (p === "~" || /^~[\\/]/.test(p)) p = home + p.slice(1);
  if (/^[A-Za-z]:$/.test(p)) p += "\\";  // "D:" is the drive's top folder
  if (!ABS.test(p)) return { error: "a full folder path, like C:\\Users\\you\\Videos or /Users/you/Movies" };
  const path = /^[A-Za-z]:/.test(p) || platform === "win32" ? win32.resolve(p) : posix.resolve(p);
  return { path };
}

/** {ok: true} when the path is a folder on this computer, else {error} saying which: missing, or a file. */
export function checkFolder(path) {
  let st;
  try { st = statSync(path); } catch (e) {
    return { error: e?.code === "EACCES" || e?.code === "EPERM" ? `no permission to read that folder: ${path}` : `no such folder: ${path}` };
  }
  return st.isDirectory() ? { ok: true } : { error: `not a folder: ${path}` };
}
