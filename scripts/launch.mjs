/**
 * FILE: scripts/launch.mjs
 * PURPOSE: Start the studio in the background if it is not running yet, and return at once. Used at sign-in
 *          (Posting › Runs by itself › Start with Windows, scripts/autostart.mjs) and by `npm run app`.
 * OVERVIEW: Asks /api/health first, so a second start does nothing. The server runs detached with its output
 *           appended to server.log in the studio's home folder (STUDIO_HOME, else ~/.lazycow), through a file
 *           handle it shares, so the in-app restart can keep writing there (the same way server/review.mjs
 *           restartSelf starts the next server). A shell redirect (`>> server.log`) is not used: it held the
 *           old server's output open and blocked its own restart.
 * USAGE: node scripts/launch.mjs   (exit 0 when it is running, 1 when it did not answer within a minute)
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** One value from the studio's .env (no quotes), or "". */
function fromEnvFile(key) {
  try {
    const line = readFileSync(join(ROOT, ".env"), "utf8").split(/\r?\n/).find((l) => l.startsWith(`${key}=`));
    return line ? line.slice(key.length + 1).trim().replace(/^["']|["']$/g, "") : "";
  } catch { return ""; }
}
export const PORT = Number(process.env.STUDIO_PORT || fromEnvFile("STUDIO_PORT") || 4317);
export const HOME = process.env.STUDIO_HOME || fromEnvFile("STUDIO_HOME") || join(homedir(), ".lazycow");

export async function up(port = PORT) {
  try { return (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; }
}

/** Start the server detached; its output goes to <home>/server.log. Returns the log's path. */
export function startStudio(why = "started") {
  mkdirSync(HOME, { recursive: true });
  const log = join(HOME, "server.log");
  appendFileSync(log, `\n--- ${why} ${new Date().toISOString()} by scripts/launch.mjs ---\n`);
  const fd = openSync(log, "a");
  // The server reads .env itself; a project's own folders never come from the shell that started this (server/review.mjs
  // PROJECT_OWN). Everything else, such as STUDIO_PORT or STUDIO_HOME, passes through.
  const OWN = new Set(["STUDIO_DATA", "STUDIO_SOURCE", "STUDIO_DRAFTS", "STUDIO_READY", "STUDIO_PROJECTS", "STUDIO_WORKSPACE"]);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !OWN.has(k)));
  // The Node running this goes first on the server's PATH: the double-click setup keeps its own Node out of the
  // system PATH, and the engine finds `npx` (Remotion renders) through PATH.
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") || "PATH";
  env[pathKey] = [dirname(process.execPath), env[pathKey]].filter(Boolean).join(delimiter);
  spawn(process.execPath, [join(ROOT, "server", "review.mjs")], { cwd: ROOT, env, detached: true, stdio: ["ignore", fd, fd], windowsHide: true }).unref();
  return log;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (await up()) { console.log(`Lazycow Studio is already running: http://127.0.0.1:${PORT}/`); process.exit(0); }
  const log = startStudio(process.argv.includes("--at-signin") ? "started at sign-in" : "started");
  for (let i = 0; i < 60; i++) {
    if (await up()) { console.log(`Lazycow Studio is running: http://127.0.0.1:${PORT}/`); process.exit(0); }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.error(`Lazycow Studio did not answer within a minute; see ${log}`);
  process.exit(1);
}
