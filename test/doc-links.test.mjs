/**
 * FILE: test/doc-links.test.mjs
 * PURPOSE: Every local link in the Markdown docs opens a file that exists, and no doc a stranger reads links into the
 *          maintainer's private folders (which the public copy leaves out, so the link would be dead there).
 * USAGE: npm test (runs in this repository and in the public copy alike).
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Folders the public copy leaves out (scripts/public-export.json "exclude"): their own files may link each other.
const PRIVATE = ["docs/research/", "docs/gtm/", "docs/launch/", "projects/", "examples/public/"];
const SKIP_DIRS = new Set(["node_modules", ".git", ".claude", "dist", "out", "data"]);

function markdown(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) markdown(p, out);
    else if (e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

const rel = (p) => relative(ROOT, p).split(sep).join("/");
const docs = markdown(ROOT).filter((p) => !PRIVATE.some((d) => rel(p).startsWith(d)) && !["docs/HANDOFF.md", "docs/ranch-workspace.md"].includes(rel(p)));

function links(file) {
  const text = readFileSync(file, "utf8").replace(/```[\s\S]*?```/g, "");  // code blocks are examples, not links
  const out = [];
  for (const m of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)|(?:href|src)="([^"]+)"/g)) {
    const u = m[1] || m[2];
    if (/^(https?:|mailto:|#|data:|<)/.test(u)) continue;
    const path = decodeURIComponent(u.split("#")[0]);
    if (path) out.push(path);
  }
  return out;
}

test("every local link in the docs opens a file that exists", () => {
  assert.ok(docs.length > 20, `read ${docs.length} docs`);
  const broken = [];
  for (const f of docs) for (const l of links(f)) if (!existsSync(resolve(dirname(f), l))) broken.push(`${rel(f)} -> ${l}`);
  assert.deepEqual(broken, []);
});

test("no public doc links into a private folder (the link would be dead in the public copy)", () => {
  const leaks = [];
  for (const f of docs) {
    for (const l of links(f)) {
      const target = rel(resolve(dirname(f), l));
      if (PRIVATE.some((d) => target.startsWith(d)) || ["docs/HANDOFF.md", "docs/ranch-workspace.md"].includes(target)) leaks.push(`${rel(f)} -> ${l}`);
    }
  }
  assert.deepEqual(leaks, []);
});
