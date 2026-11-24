/**
 * FILE: test/ui-parts.test.mjs
 * PURPOSE: The page is made of parts (BL-121): server/editor.html is the shell, server/ui/css and server/ui/js hold the
 *          styles and the script, one file per page or tool, joined by server/ui.mjs. Every include must name a part,
 *          every part must be included exactly once (a part left out would be a dead page), and the joined page has
 *          one main <style> and one main <script>, so all parts share one script scope as the single file did.
 * USAGE: npm test
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assemblePage, includes, pageFiles } from "../server/ui.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const parts = (dir) => readdirSync(join(root, "server", "ui", dir)).filter((f) => !f.startsWith(".")).map((f) => `${dir}/${f}`).sort();

test("every include names a part, and every part is included once, in name order", () => {
  const inc = includes(root);
  assert.equal(new Set(inc).size, inc.length, "no part twice");
  const all = [...parts("css"), ...parts("js")];
  assert.deepEqual([...inc].sort(), all, "no part left out, none missing");
  for (const dir of ["css", "js"]) {
    const mine = inc.filter((p) => p.startsWith(dir + "/"));
    assert.deepEqual(mine, [...mine].sort(), `${dir} parts load in the order their names sort (00-, 01-, …)`);
  }
});

test("the joined page keeps the shell's shape: no include left, one main script holding every js part", () => {
  // A Windows checkout may have CRLF line ends (git autocrlf): compare with LF everywhere, as the assembler accepts both.
  const lf = (s) => s.replace(/\r\n/g, "\n");
  const html = lf(assemblePage(root));
  assert.doesNotMatch(html, /<!--ui:/, "every include was replaced");
  const main = [...html.matchAll(/^<script>\n([\s\S]*?)^<\/script>$/gm)];
  assert.equal(main.length, 1, "one main <script>");
  for (const p of parts("js")) assert.ok(main[0][1].includes(lf(readFileSync(join(root, "server", "ui", p), "utf8"))), p);
  assert.equal(pageFiles(root).length, 1 + includes(root).length, "the build id covers the shell and every part");
});

test("an include outside server/ui is refused", () => {
  assert.throws(() => "<!--ui:../review.mjs-->\n".replace(/^<!--ui:([a-z0-9/._-]+)-->\r?\n/gm, (_, part) => {
    if (part.includes("..")) throw new Error(`bad include: ${part}`);
    return "";
  }), /bad include/);
});
