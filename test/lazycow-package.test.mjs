// The npm package `lazycow` (packages/lazycow): in step with the studio, attributable, and safe to run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = join(ROOT, "packages", "lazycow");
const BIN = join(PKG, "bin", "lazycow.mjs");
const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));

test("the package is in step with the studio (MCP copy, LICENSE, NOTICE, version, registry entry, zip hash)", () => {
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", "build-packages.mjs"), "--check"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(pkg.version, JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version);
});

test("attribution: author, licence, NOTICE, registry name and README credit name kensaurus", () => {
  // An object, not "name (x) (url)": npm reads the first parentheses as the URL, so 0.14.0 went out linking to "Kenji Sakuramoto".
  assert.deepEqual(pkg.author, { name: "kensaurus (Kenji Sakuramoto)", url: "https://kensaur.us" });
  assert.equal(pkg.license, "Apache-2.0");
  assert.equal(pkg.repository.url, "git+https://github.com/kensaurus/lazycow-studio.git");
  assert.ok(pkg.files.includes("NOTICE") && pkg.files.includes("LICENSE"));
  assert.match(readFileSync(join(PKG, "NOTICE"), "utf8"), /kensaurus/);
  assert.match(readFileSync(join(PKG, "README.md"), "utf8"), /Based on Lazycow Studio by kensaurus/);
  const server = JSON.parse(readFileSync(join(PKG, "server.json"), "utf8"));
  assert.equal(server.name, pkg.mcpName);
  assert.ok(server.name.startsWith("io.github.kensaurus/"));
  assert.ok(server.description.length <= 100, `registry description is ${server.description.length} chars (max 100)`);
  assert.equal(server.packages[0].identifier, pkg.name);
});

test("the published files are only the package's own (no .env, no tests, no studio data)", () => {
  const out = execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["pack", "--dry-run", "--json"], { cwd: PKG, encoding: "utf8", shell: process.platform === "win32" });
  const parsed = JSON.parse(out);  // npm 10: [ {...} ]; npm 11: { lazycow: {...} }
  const files = (Array.isArray(parsed) ? parsed[0] : parsed[pkg.name]).files.map((f) => f.path).sort();
  assert.deepEqual(files, ["LICENSE", "NOTICE", "README.md", "bin/lazycow.mjs", "lib/client.d.ts", "lib/client.mjs", "lib/env.mjs",
    "lib/install.mjs", "lib/mcp.mjs", "lib/release.json", "package.json", "server.json"]);
});

test("lazycow --version and help", () => {
  assert.equal(execFileSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).trim(), pkg.version);
  const help = execFileSync(process.execPath, [BIN, "help"], { encoding: "utf8" });
  assert.match(help, /claude mcp add lazycow -- npx -y lazycow mcp/);
  assert.match(help, /cannot approve/);
});

test("lazycow mcp answers the MCP handshake and lists tools without a studio running", async () => {
  const child = spawn(process.execPath, [BIN, "mcp"], { env: { ...process.env, STUDIO_PORT: "1", LAZYCOW_DIR: tmpdir() }, stdio: ["pipe", "pipe", "ignore"] });
  let out = "";
  child.stdout.on("data", (c) => { out += c; });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }) + "\n");
  child.stdin.end(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
  await new Promise((r) => child.on("close", r));
  const [init, list] = out.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(init.result.serverInfo.version, pkg.version);
  assert.ok(list.result.tools.length >= 20);
  assert.ok(!list.result.tools.some((t) => /approve/.test(t.name)), "no approve tool");
  // The npm page is what a stranger reads first: it names every tool, and the count it gives is the real one.
  const readme = readFileSync(join(PKG, "README.md"), "utf8");
  const missing = list.result.tools.map((t) => t.name).filter((n) => !readme.includes("`" + n + "`"));
  assert.deepEqual(missing, [], "tools missing from packages/lazycow/README.md");
  assert.match(readme, new RegExp(`The ${list.result.tools.length} tools`));
});

test("createClient: token, own origin on writes, plain errors", async () => {
  const seen = [];
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; }).on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, origin: req.headers.origin, body });
      if (req.url === "/api/nope") { res.writeHead(401, { "content-type": "application/json" }); return res.end('{"error":"token needed"}'); }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, version: "x" }));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  try {
    const { createClient, StudioError } = await import("../packages/lazycow/lib/client.mjs");
    const c = createClient({ port, token: "t0k", dir: "" });
    assert.equal((await c.health()).version, "x");
    await c.post("/api/posts/plan", { days: 3 });
    await assert.rejects(c.get("/api/nope"), (e) => e instanceof StudioError && e.status === 401 && /token needed/.test(e.message) && /STUDIO_API_TOKEN/.test(e.message));
    await assert.rejects(c.get("api/health"), TypeError);
    assert.equal(seen[0].auth, "Bearer t0k");
    assert.equal(seen[1].origin, `http://127.0.0.1:${port}`);
    assert.equal(seen[1].body, '{"days":3}');
    const down = createClient({ port: 1, dir: "" });
    await assert.rejects(down.health(), /not answering/);
  } finally {
    srv.close();
  }
});

test("lazycow install refuses a download whose SHA-256 is not this release's, and a folder that is not empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "lazycow-pkg-"));
  try {
    const bad = join(dir, `Lazycow-Studio-${pkg.version}.zip`);
    writeFileSync(bad, "not the release");
    const target = join(dir, "studio");
    let r = spawnSync(process.execPath, [BIN, "install", "--zip", bad, "--dir", target, "--no-start"], { encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /does not match this release/);
    assert.ok(!existsSync(target), "nothing installed");
    mkdirSync(target);
    writeFileSync(join(target, "mine.txt"), "keep me");
    r = spawnSync(process.execPath, [BIN, "install", "--zip", bad, "--dir", target, "--no-start"], { encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not empty/);
    assert.equal(readFileSync(join(target, "mine.txt"), "utf8"), "keep me");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the release zip leaves out packages/ and is byte-for-byte reproducible (its hash is baked into the package)", () => {
  const out = mkdtempSync(join(tmpdir(), "lazycow-zip-"));
  try {
    const run = (dir) => execFileSync(process.execPath, [join(ROOT, "scripts", "release-zip.mjs"), "--from", ROOT, "--out", join(out, dir)], { encoding: "utf8" });
    const a = /SHA-256 ([0-9a-f]{64})/.exec(run("a"))[1];
    const b = /SHA-256 ([0-9a-f]{64})/.exec(run("b"))[1];
    assert.equal(a, b);
    const zip = readFileSync(join(out, "a", `Lazycow-Studio-${pkg.version}.zip`));
    assert.ok(!zip.includes(Buffer.from(`Lazycow Studio ${pkg.version}/packages/`)), "no packages/ inside the zip");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
