/**
 * FILE: test/fspick.test.mjs
 * PURPOSE: The folder picker reaches any folder (BL-141, 26 Nov): a typed or pasted path is cleaned and checked by the
 *          server (absolute, exists, is a folder) before anything lists it, and "Show hidden folders" asks for them.
 * OVERVIEW: The rules in server/fspick.mjs, then GET /api/fs/list on the real server (review.mjs on a free port with a
 *           throwaway STUDIO_HOME and STUDIO_DATA and a Python that does not exist, so the refusals are the server's own
 *           and a path that passes them gets as far as Python), then the picker's box and switch on the page.
 *           py/tests/test_sources.py checks what Python lists with --hidden.
 * USAGE: npm test
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkFolder, typedFolder } from "../server/fspick.mjs";
import { assemblePage } from "../server/ui.mjs";

const SERVER = fileURLToPath(new URL("../server/review.mjs", import.meta.url));
let child, port, home, data, dir, file;

const freePort = () => new Promise((ok) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const get = (path) => new Promise((ok, fail) => {
  const r = request({ host: "127.0.0.1", port, method: "GET", path, headers: { host: `127.0.0.1:${port}` }, agent: false }, (res) => {
    let b = ""; res.on("data", (c) => { b += c; }); res.on("end", () => ok({ status: res.statusCode, body: b }));
  });
  r.on("error", fail); r.setTimeout(20_000, () => r.destroy(new Error(`timeout on ${path}`))); r.end();
});
const list = (p, extra = "") => get("/api/fs/list?path=" + encodeURIComponent(p) + extra);

before(async () => {
  port = await freePort();
  home = mkdtempSync(join(tmpdir(), "lazycow-home-"));
  data = mkdtempSync(join(tmpdir(), "lazycow-data-"));
  dir = join(data, "My Videos"); mkdirSync(dir);
  file = join(data, "clip.mp4"); writeFileSync(file, "x");
  const env = {
    PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, TEMP: process.env.TEMP, TMP: process.env.TMP,
    STUDIO_PORT: String(port), STUDIO_HOME: home, STUDIO_DATA: data, STUDIO_SOURCE: join(data, "footage"),
    STUDIO_PY: join(data, "no-python.exe"), STUDIO_TOOLS: join(data, "bin"), STUDIO_WATCH_MINUTES: "0", STUDIO_AUTO_DRAFTS: "0", STUDIO_QUIET: "1",
    PLAYWRIGHT_MCP_EXTENSION_TOKEN: "",
  };
  child = spawn(process.execPath, [SERVER], { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  await new Promise((ok, fail) => {
    const t = setTimeout(() => fail(new Error(`review.mjs did not start: ${log}`)), 20_000);
    child.stdout.on("data", (c) => { log += c; if (log.includes(`127.0.0.1:${port}`)) { clearTimeout(t); ok(); } });
    child.stderr.on("data", (c) => { log += c; });
    child.on("exit", (code) => { clearTimeout(t); fail(new Error(`review.mjs exited ${code}: ${log}`)); });
  });
});
after(() => {
  child?.removeAllListeners("exit");
  child?.kill();
  for (const d of [home, data]) try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
});

test("a typed path: spaces, Copy-as-path quotes, ~ and a bare drive are taken; relative, empty and control characters are not", () => {
  assert.deepEqual(typedFolder('  "C:\\Users\\me\\My Videos"  ', { platform: "win32" }), { path: "C:\\Users\\me\\My Videos" });
  assert.deepEqual(typedFolder("'D:/footage/2026/'", { platform: "win32" }), { path: "D:\\footage\\2026" });
  assert.deepEqual(typedFolder("D:", { platform: "win32" }), { path: "D:\\" });
  assert.deepEqual(typedFolder("C:\\a\\..\\b", { platform: "win32" }), { path: "C:\\b" });
  assert.deepEqual(typedFolder("~/Movies", { home: "/Users/me", platform: "darwin" }), { path: "/Users/me/Movies" });
  assert.deepEqual(typedFolder("~", { home: "C:\\Users\\me", platform: "win32" }), { path: "C:\\Users\\me" });
  assert.deepEqual(typedFolder("/Volumes/SD/DCIM", { platform: "darwin" }), { path: "/Volumes/SD/DCIM" });
  for (const bad of ["", "   ", '""', "footage", "./x", "..\\x", "\\\\server\\share", "C:x", "C:\\a\u0000b", "C:\\a\nb", "x".repeat(1100), null, 7]) {
    assert.ok(typedFolder(bad, { platform: "win32" }).error, JSON.stringify(bad));
  }
  assert.match(typedFolder("footage").error, /full folder path/, "says what it wants");
});

test("a folder must exist and be a folder", () => {
  assert.deepEqual(checkFolder(dir), { ok: true });
  assert.match(checkFolder(join(data, "nope")).error, /^no such folder: /);
  assert.match(checkFolder(file).error, /^not a folder: /);
});

test("GET /api/fs/list refuses a missing folder, a file and a relative path with 400 and says why", async () => {
  const miss = await list(join(data, "not here"));
  assert.equal(miss.status, 400); assert.match(JSON.parse(miss.body).error, /no such folder/);
  const f = await list(file);
  assert.equal(f.status, 400); assert.match(JSON.parse(f.body).error, /not a folder/);
  const rel = await list("My Videos");
  assert.equal(rel.status, 400); assert.match(JSON.parse(rel.body).error, /full folder path/);
  assert.equal((await get("/api/fs/list")).status, 400, "no path at all");
  assert.equal((await list(`"${join(data, "not here")}"`)).status, 400, "quotes do not make a missing folder real");
});

test("a pasted path that is a real folder passes the server's checks (quotes and spaces dropped), with or without hidden", async () => {
  // This studio has no Python, so a path that passes every check fails only at Python (500), never at the checks (400).
  for (const extra of ["", "&hidden=1"]) {
    const r = await list(`  "${dir}"  `, extra);
    assert.equal(r.status, 500, r.body);
    assert.match(JSON.parse(r.body).error, /Python/);
  }
  const src = readFileSync(SERVER, "utf8").replace(/\r\n/g, "\n");
  assert.match(src, /\["sources", "ls", path, \.\.\.\(url\.searchParams\.get\("hidden"\) === "1" \? \["--hidden"\] : \[\]\)\]/, "hidden=1 asks Python for hidden folders");
});

test("the picker has a path box and a Show hidden folders switch, both in English and Japanese", () => {
  const html = assemblePage(fileURLToPath(new URL("..", import.meta.url))).replace(/\r\n/g, "\n");
  const script = html.slice(html.indexOf("<script>"), html.lastIndexOf("</script>"));
  const body = (name) => { const at = script.indexOf(`function ${name}(`); assert.ok(at > 0, name); return script.slice(at, script.indexOf("\n}", at) + 2); };
  assert.match(body("pickerHtml"), /<form id="fsType"/);
  assert.match(body("pickerHtml"), /id="fsHidden" \$\{p\.hidden \? "checked" : ""\}/);
  assert.match(body("pickerGo"), /\(p\.hidden \? "&hidden=1" : ""\)/);
  assert.match(script, /if \(e\.target\.id !== "fsType" \|\| !foot\.picker\) return;\n  e\.preventDefault\(\);/);
  const ja = script.indexOf("\n  ja: {\n");
  for (const k of ["hm.pk.typed", "hm.pk.typedph", "hm.pk.go", "hm.pk.hidden"]) {
    assert.ok(script.slice(0, ja).includes(`"${k}": "`), `en ${k}`);
    assert.ok(script.slice(ja).includes(`"${k}": "`), `ja ${k}`);
  }
});
