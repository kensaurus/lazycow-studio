/**
 * FILE: packages/lazycow/lib/env.mjs
 * PURPOSE: Find the Lazycow Studio on this computer: its folder, its port and its optional API token.
 * OVERVIEW: The studio keeps STUDIO_PORT and STUDIO_API_TOKEN in the .env file in its own folder. That folder is
 *           LAZYCOW_DIR when set, else the one the double-click setup recorded in installed.json. Environment
 *           variables win over the file, so a config can still point anywhere.
 * DEPENDENCIES: node:fs, node:os, node:path
 * Part of Lazycow Studio by kensaurus (https://kensaur.us). Apache-2.0.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where the double-click setup keeps its runtimes and installed.json. */
export function setupHome() {
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Lazycow");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Lazycow");
  return join(homedir(), ".local", "share", "lazycow");
}

/** The studio folder this computer knows about, or "" when none. */
export function studioDir() {
  if (process.env.LAZYCOW_DIR) return process.env.LAZYCOW_DIR;
  try { return JSON.parse(readFileSync(join(setupHome(), "installed.json"), "utf8")).root || ""; } catch { return ""; }
}

function readEnv(dir) {
  if (!dir) return "";
  try { return readFileSync(join(dir, ".env"), "utf8"); } catch { return ""; }
}

/** One value from the studio's .env ("" when absent). */
export function envValue(text, key) {
  const m = new RegExp(`^${key}\\s*=\\s*["']?([^"'\\r\\n]*)`, "m").exec(text || "");
  return (m?.[1] || "").trim();
}

/** { base, port, token, dir } for the studio on this computer. Options override everything. */
export function studioTarget(opts = {}) {
  const dir = opts.dir ?? studioDir();
  const text = readEnv(dir);
  const rawPort = String(opts.port ?? (process.env.STUDIO_PORT || envValue(text, "STUDIO_PORT")));
  const port = /^\d{1,5}$/.test(rawPort) && Number(rawPort) > 0 && Number(rawPort) < 65536 ? Number(rawPort) : 4317;
  const base = (opts.base || `http://127.0.0.1:${port}`).replace(/\/+$/, "");
  const token = String(opts.token ?? process.env.STUDIO_API_TOKEN ?? envValue(text, "STUDIO_API_TOKEN") ?? "").trim();
  return { base, port, token, dir };
}
