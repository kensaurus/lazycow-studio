#!/usr/bin/env node
/**
 * FILE: scripts/release-zip.mjs
 * PURPOSE: The download a non-technical person gets: one zip with a single "Lazycow Studio <version>" folder holding
 *          README.TXT, Start Lazycow.cmd / .command and the code. No node_modules, no data: the double-click setup
 *          fetches the rest (scripts/bootstrap).
 * USAGE: node scripts/release-zip.mjs [--from <git checkout, default this one>] [--out <folder, default ./dist>]
 *        Run it on the public export (scripts/public-export.mjs --git) for a release, never on the private repo.
 * NOTES: git archive takes what is committed at HEAD and applies .gitattributes line endings (CRLF for .cmd/.ps1/.TXT,
 *        LF for .sh/.command), so the scripts run on each system. Prints the zip's SHA-256 for the release notes.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const from = resolve(opt("--from", ROOT));
const out = resolve(opt("--out", join(ROOT, "dist")));
const { version } = JSON.parse(readFileSync(join(from, "package.json"), "utf8"));

export function zipName(v) { return `Lazycow-Studio-${v}.zip`; }
export function folderName(v) { return `Lazycow Studio ${v}`; }

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  for (const must of ["README.TXT", "Start Lazycow.cmd", "Start Lazycow.command", "scripts/bootstrap/windows.ps1", "scripts/bootstrap/versions.json"]) {
    execFileSync("git", ["-C", from, "cat-file", "-e", `HEAD:${must}`]);  // throws if the release would lack it
  }
  mkdirSync(out, { recursive: true });
  const file = join(out, zipName(version));
  // Reproducible: the same files give the same bytes whatever commit carries them (a fixed time, the tree not the
  // commit). packages/ stays out: the npm package carries this zip's SHA-256 (scripts/build-packages.mjs), so the zip
  // cannot carry the package, and the studio does not need it.
  execFileSync("git", ["-C", from, "archive", "--format=zip", `--prefix=${folderName(version)}/`, "--mtime=2026-01-01T00:00:00Z",
    "-o", file, "HEAD^{tree}", "--", ".", ":(exclude)packages"]);
  const sha = createHash("sha256").update(readFileSync(file)).digest("hex");
  console.log(`${file}\nSHA-256 ${sha}`);
}
