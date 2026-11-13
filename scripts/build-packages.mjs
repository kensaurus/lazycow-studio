#!/usr/bin/env node
/**
 * FILE: scripts/build-packages.mjs
 * PURPOSE: Keep the npm package (packages/lazycow) in step with the studio: the MCP server copied from
 *          server/mcp.mjs, LICENSE and NOTICE, the version, the MCP registry entry, and the release zip's SHA-256.
 * USAGE:  node scripts/build-packages.mjs [--zip <Lazycow-Studio-x.y.z.zip>]   write everything
 *         node scripts/build-packages.mjs --check                              exit 1 when anything is out of step
 * NOTES:  --zip hashes the release zip that `lazycow install` will accept (scripts/release-zip.mjs makes it). Without
 *         it the hash already in lib/release.json stays, if it is for this version. The package never ships a
 *         release.json for another version: install would refuse every download.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = join(ROOT, "packages", "lazycow");
const REPO = "kensaurus/lazycow-studio";
const args = process.argv.slice(2);
const check = args.includes("--check");
const zipArg = args.includes("--zip") ? args[args.indexOf("--zip") + 1] : "";

const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null);
const version = JSON.parse(read(join(ROOT, "package.json"))).version;
const want = new Map();  // path -> content
const lf = (s) => s.replace(/\r\n/g, "\n");

// 1. The MCP server, one source of truth.
const mcp = lf(read(join(ROOT, "server", "mcp.mjs")));
const [shebang, ...body] = mcp.split("\n");
want.set(join(PKG, "lib", "mcp.mjs"), [shebang, "// Generated from server/mcp.mjs by scripts/build-packages.mjs. Edit that file, then run the script.", ...body].join("\n"));

// 2. Licence and attribution travel with the package (Apache-2.0 section 4).
want.set(join(PKG, "LICENSE"), lf(read(join(ROOT, "LICENSE"))));
want.set(join(PKG, "NOTICE"), lf(read(join(ROOT, "NOTICE"))));

// 3. The version, everywhere.
const pkg = JSON.parse(read(join(PKG, "package.json")));
pkg.version = version;
want.set(join(PKG, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

const server = JSON.parse(read(join(PKG, "server.json")));
server.version = version;
for (const p of server.packages || []) p.version = version;
want.set(join(PKG, "server.json"), JSON.stringify(server, null, 2) + "\n");

// 4. The release zip `lazycow install` accepts.
const zipName = `Lazycow-Studio-${version}.zip`;
const old = JSON.parse(read(join(PKG, "lib", "release.json")) || "{}");
let sha = old.version === version ? old.sha256 : "";
if (zipArg) {
  if (!zipArg.endsWith(zipName)) throw new Error(`--zip must be ${zipName} for version ${version}`);
  sha = createHash("sha256").update(readFileSync(zipArg)).digest("hex");
}
const releaseJson = { version, zip: zipName, url: `https://github.com/${REPO}/releases/download/v${version}/${zipName}`, sha256: sha };
want.set(join(PKG, "lib", "release.json"), JSON.stringify(releaseJson, null, 2) + "\n");

const stale = [];
for (const [p, text] of want) {
  const now = read(p);
  if (now === null || lf(now) !== text) stale.push(p.slice(ROOT.length + 1).replace(/\\/g, "/"));
  if (!check && (now === null || lf(now) !== text)) writeFileSync(p, text);
}
if (!/^[0-9a-f]{64}$/.test(sha)) stale.push(`packages/lazycow/lib/release.json: no SHA-256 for ${zipName} (run with --zip)`);

if (check) {
  if (stale.length) { console.error("Out of step with the studio:\n  " + stale.join("\n  ") + "\nRun: node scripts/build-packages.mjs [--zip <zip>]"); process.exit(1); }
  console.log(`packages/lazycow ${version} is in step with the studio.`);
} else {
  console.log(stale.length ? `Updated:\n  ${stale.join("\n  ")}` : "Nothing to update.");
  if (!/^[0-9a-f]{64}$/.test(sha)) process.exitCode = 1;
}
