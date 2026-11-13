/**
 * FILE: scripts/autostart.mjs
 * PURPOSE: Start the studio when you sign in to Windows, so booked posts the studio sends itself (Bluesky) and the
 *          daily checks run without anyone opening it. Switched on and off on Posting › Runs by itself.
 * OVERVIEW: A small "Lazycow Studio.cmd" in your Startup folder (shell:startup) runs scripts/launch.mjs, which starts
 *           the server in the background only if it is not running. It needs no administrator rights and no
 *           scheduled task; deleting the file (or the switch) undoes it. Other systems: not offered yet (the state
 *           says why), so nothing is written there.
 * USAGE: node scripts/autostart.mjs on|off|status
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
export const FILE_NAME = "Lazycow Studio.cmd";

export function startupDir(env = process.env, platform = process.platform) {
  return platform === "win32" && env.APPDATA ? join(env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Startup") : null;
}

/** The file's text: start launch.mjs minimised; it returns as soon as the server is up (or already was). */
export function startupScript(root = ROOT, node = process.execPath) {
  return ["@echo off", "rem Lazycow Studio: starts the studio when you sign in (Posting > Runs by itself). Delete this file to stop.",
    `start "" /min "${node}" "${join(root, "scripts", "launch.mjs")}" --at-signin`, ""].join("\r\n");
}

/* The Startup folder is the whole Windows account's, but every studio folder on the computer (a second checkout, a
   test copy) shows this switch. "on" means the file starts THIS folder; a file that starts another folder is
   reported as `other` and is never removed or re-pointed from here (that would stop the other studio starting). */
const launcherIn = (root) => join(root, "scripts", "launch.mjs").toLowerCase();

export function startupState(dir = startupDir(), root = ROOT) {
  if (!dir) return { supported: false, on: false, why: "Starting at sign-in is set up on Windows only for now; start it with npm run review." };
  const file = join(dir, FILE_NAME);
  if (!existsSync(file)) return { supported: true, on: false, file };
  let text = "";
  try { text = readFileSync(file, "utf8").toLowerCase(); } catch { /* unreadable: treat as another studio's */ }
  return text.includes(launcherIn(root)) ? { supported: true, on: true, file } : { supported: true, on: false, other: true, file };
}

export function setStartup(on, dir = startupDir(), root = ROOT, node = process.execPath) {
  if (!dir) throw new Error(startupState(dir, root).why);
  const file = join(dir, FILE_NAME), now = startupState(dir, root);
  if (now.other) throw new Error(`Another studio folder starts when you sign in (${file}). Switch it off in that studio first.`);
  if (on) { mkdirSync(dir, { recursive: true }); writeFileSync(file, startupScript(root, node)); }
  else if (existsSync(file)) unlinkSync(file);
  return startupState(dir, root);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const what = process.argv[2] || "status";
  if (!["on", "off", "status"].includes(what)) { console.error("usage: node scripts/autostart.mjs on|off|status"); process.exit(2); }
  const st = what === "status" ? startupState() : setStartup(what === "on");
  console.log(st.supported ? `Start at sign-in: ${st.on ? "on" : "off"} (${st.file})` : st.why);
}
