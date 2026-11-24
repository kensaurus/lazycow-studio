/**
 * FILE: test/env-example.test.mjs
 * PURPOSE: A new install learns every setting from .env.example: each variable the server, the scripts or the Python
 *          engine reads is listed there (with a comment), so nothing works only on the machine that wrote it.
 * USAGE: npm test
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SYSTEM = new Set(["HOME", "USER", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMFILES", "PATH", "TEMP", "TMP", "NODE_ENV"]);
const READS = [
  /process\.env\.([A-Z][A-Z0-9_]{2,})/g, /process\.env\[["']([A-Z][A-Z0-9_]{2,})["']\]/g, /\bpick\(["']([A-Z][A-Z0-9_]{2,})["']/g,
  /FILE_ENV\.([A-Z][A-Z0-9_]{2,})/g, /environ\.get\(["']([A-Z][A-Z0-9_]{2,})["']/g, /environ\[["']([A-Z][A-Z0-9_]{2,})["']\]/g,
  /getenv\(["']([A-Z][A-Z0-9_]{2,})["']/g,
];
const files = (dir, ext) => readdirSync(join(ROOT, dir)).filter((f) => ext.some((e) => f.endsWith(e))).map((f) => join(ROOT, dir, f));

test("every environment variable the code reads is documented in .env.example", () => {
  const sources = [...files("server", [".mjs"]), ...files("scripts", [".mjs"]), ...files("py/studio", [".py"]), ...files("py/studio/connectors", [".py"]), ...files("py/studio/providers", [".py"])];
  const used = new Set();
  for (const f of sources) {
    const text = readFileSync(f, "utf8");
    for (const rx of READS) for (const m of text.matchAll(rx)) if (!SYSTEM.has(m[1])) used.add(m[1]);
  }
  const listed = new Set([...readFileSync(join(ROOT, ".env.example"), "utf8").matchAll(/^([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]));
  assert.ok(used.size > 20, `only found ${used.size} variables: the patterns above no longer match the code`);
  assert.deepEqual([...used].filter((k) => !listed.has(k)).sort(), [], "read by the code but missing from .env.example");
});

// BL-119: docs/self-host.md › Advanced settings has one line for every variable in .env.example, and no line for one
// that is not there (a renamed variable would leave a stale row).
test("every .env.example variable has a line in docs/self-host.md › Advanced settings", () => {
  const listed = [...readFileSync(join(ROOT, ".env.example"), "utf8").matchAll(/^([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]);
  const doc = readFileSync(join(ROOT, "docs", "self-host.md"), "utf8");
  const start = doc.indexOf("## Advanced settings"), end = doc.indexOf("\n## ", start + 1);
  assert.ok(start > 0, "docs/self-host.md has no Advanced settings section");
  const rows = new Set([...doc.slice(start, end < 0 ? undefined : end).matchAll(/^\| `([A-Z][A-Z0-9_]+)` \| \S/gm)].map((m) => m[1]));
  assert.deepEqual(listed.filter((k) => !rows.has(k)), [], "in .env.example but not in the table");
  assert.deepEqual([...rows].filter((k) => !listed.includes(k)), [], "in the table but not in .env.example");
});
