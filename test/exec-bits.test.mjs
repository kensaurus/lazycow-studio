// The Mac double-click starter and the shell bootstraps must be committed as executable: Windows cannot keep the bit on
// disk, and a zip made by `git archive` (scripts/release-zip.mjs) takes each file's mode from git. Without it a Mac
// says "you do not have appropriate access privileges" on Start Lazycow.command (17 Nov).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("the Mac starter and every shell bootstrap are executable in git", () => {
  const rows = execFileSync("git", ["ls-files", "-s", "--", "Start Lazycow.command", "scripts/bootstrap"], { cwd: ROOT }).toString().split("\n").filter(Boolean);
  const want = rows.map((r) => r.split(/\s+/)).filter((c) => /\.(command|sh)$/.test(c.slice(3).join(" ")));
  assert.ok(want.length >= 3, "the starter and the bootstraps are tracked");
  for (const c of want) assert.equal(c[0], "100755", `${c.slice(3).join(" ")} is not executable`);
});
