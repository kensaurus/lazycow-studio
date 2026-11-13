/**
 * FILE: scripts/app.mjs
 * PURPOSE: Open Lazycow Studio as its own window, like a desktop program: no address bar, no tabs.
 * OVERVIEW: Starts the studio server if it is not answering yet, waits for it, then opens Chrome or Edge in app mode
 *           (--app=http://127.0.0.1:4317) with its own window size. Uses your normal browser profile, so your
 *           sign-ins (and the Chrome link) are the same as in your browser.
 * USAGE: npm run app   (or make a desktop shortcut to it: see README › "Open it as an app")
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startStudio } from "./launch.mjs";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const PORT = Number(process.env.STUDIO_PORT || 4317);
const URL_ = `http://127.0.0.1:${PORT}/`;
const up = async () => { try { return (await fetch(URL_ + "api/health", { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } };

if (!(await up())) {
  console.log("Starting the studio…");
  startStudio();  // scripts/launch.mjs: in the background, its output kept in server.log
  for (let i = 0; i < 60 && !(await up()); i++) await new Promise((r) => setTimeout(r, 1000));
}
const pf = process.env.PROGRAMFILES || "C:/Program Files", pf86 = process.env["PROGRAMFILES(X86)"] || "C:/Program Files (x86)", local = process.env.LOCALAPPDATA || "";
const browsers = process.platform === "win32"
  ? [join(pf, "Google/Chrome/Application/chrome.exe"), join(pf86, "Google/Chrome/Application/chrome.exe"), join(local, "Google/Chrome/Application/chrome.exe"), join(pf86, "Microsoft/Edge/Application/msedge.exe"), join(pf, "Microsoft/Edge/Application/msedge.exe")]
  : process.platform === "darwin" ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
  : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/microsoft-edge"];
const exe = browsers.find((b) => existsSync(b));
if (!exe) { console.log(`Open ${URL_} in your browser (Chrome or Edge not found).`); process.exit(0); }
spawn(exe, [`--app=${URL_}`, "--window-size=1440,900"], { detached: true, stdio: "ignore" }).unref();
console.log(`Lazycow Studio opened as an app window (${exe.split(/[\/]/).pop()}).`);
