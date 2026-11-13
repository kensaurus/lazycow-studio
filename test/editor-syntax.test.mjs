// The whole page lives in server/editor.html. If its script does not parse, every button is dead, and nothing else
// in the suite notices (a "//" comment once swallowed the rest of a one-line function, and all 76 tests still passed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const html = readFileSync(new URL("../server/editor.html", import.meta.url), "utf8");
const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)].map(([, attrs, body]) => ({ attrs, body }));
const isData = (attrs) => /type=["']?application\/(ld\+)?json/.test(attrs);

test("structured data in editor.html is valid JSON", () => {
  for (const { attrs, body } of inline.filter((s) => isData(s.attrs))) assert.doesNotThrow(() => JSON.parse(body), `invalid JSON in <script${attrs}>`);
});

test("every inline script in editor.html parses", () => {
  const code = inline.filter((s) => !isData(s.attrs));
  assert.ok(code.length >= 1, "editor.html has its script inline");
  const dir = mkdtempSync(join(tmpdir(), "editor-syntax-"));
  code.forEach(({ body }, i) => {
    const file = join(dir, `script-${i}.mjs`);
    writeFileSync(file, body);
    const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    assert.equal(r.status, 0, `script ${i} does not parse:\n${(r.stderr || "").split("\n").slice(0, 6).join("\n")}`);
  });
});

test("links from data are web, mail or in-page only, and the sign-in return toast takes known networks only (review 13 Nov)", () => {
  const def = (name) => { const m = new RegExp(`^const ${name} = .*$`, "m").exec(html); assert.ok(m, name); return m[0]; };
  const escUrl = new Function(`${def("esc")}\n${def("escUrl")}\nreturn escUrl;`)();
  assert.equal(escUrl("https://x.example/a?b=1&c=2"), "https://x.example/a?b=1&amp;c=2");
  assert.equal(escUrl("#/posting"), "#/posting");
  assert.equal(escUrl("/docs/user-guide.md"), "/docs/user-guide.md");
  for (const bad of ["javascript:alert(1)", " JavaScript:alert(1)", "data:text/html,<b>", "//evil.example/x", "vbscript:x"]) assert.equal(escUrl(bad), "#", bad);
  assert.doesNotMatch(html, /href="\$\{esc\(/, "every data link goes through escUrl");
  const back = html.slice(html.indexOf("const back = /^#\\/accounts\\?"), html.indexOf("profilesKit = undefined; loadAccounts();  // fetch the new"));
  assert.match(back, /if \(ok && \(connections\[ok\] \|\| NET_NAME\[ok\]\)\)/, "only a known network");
  assert.match(back, /toast\(`\$\{ico\("check", "sm"\)\} \$\{esc\(tr\(/, "and escaped");
});

test("long videos built from an earlier plan are never offered for upload, on the page or by the server (13 Nov)", () => {
  assert.match(html, /ready = v\.parts\.filter\(\(p\) => p\.built && current\(p\) && !p\.uploaded/);
  assert.match(html, /if \(p\.built\?\.made && plan\?\.made && p\.built\.made < plan\.made\) return "";/);
  const server = readFileSync(new URL("../server/review.mjs", import.meta.url), "utf8");
  assert.match(server, /not built from the current plan yet/);
});
