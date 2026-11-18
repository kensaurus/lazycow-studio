// The Claude Desktop extension (scripts/build-mcpb.mjs): in step with server.json, the same bytes every build, and the
// server inside it answers MCP over stdio with the settings Claude Desktop passes when they are left empty.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "build-mcpb.mjs");
const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const NAME = `lazycow-${version}.mcpb`;

/** Read a zip of stored entries (what build-mcpb writes) through its central directory: name -> Buffer. */
function unzip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, "no end-of-central-directory record");
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20), nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30), comment = buf.readUInt16LE(p + 32), at = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    assert.equal(method, 0, `${name} is stored, not compressed`);
    const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
    out.set(name, buf.subarray(start, start + size));
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

function build(out) {
  const r = spawnSync(process.execPath, [SCRIPT, "--out", out], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return readFileSync(join(out, NAME));
}

test("the bundle, its manifest and the registry's mcpb entry are in step (build-mcpb --check)", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--check"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("two builds give the same bytes, and server.json names their SHA-256 and release URL", (t) => {
  const a = mkdtempSync(join(tmpdir(), "mcpb-a-")), b = mkdtempSync(join(tmpdir(), "mcpb-b-"));
  t.after(() => { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); });
  const one = build(a), two = build(b);
  const sha = createHash("sha256").update(one).digest("hex");
  assert.equal(createHash("sha256").update(two).digest("hex"), sha);
  assert.equal(readFileSync(join(a, `${NAME}.sha256`), "utf8"), `${sha}  ${NAME}\n`);
  assert.deepEqual(readFileSync(join(a, "lazycow.mcpb")), one, "lazycow.mcpb (the /releases/latest/download/ name) is the same file");
  const server = JSON.parse(readFileSync(join(ROOT, "packages", "lazycow", "server.json"), "utf8"));
  assert.equal(server.packages[0].registryType, "npm", "npm stays the first package");
  const entry = server.packages.find((p) => p.registryType === "mcpb");
  assert.equal(entry.fileSha256, sha);
  assert.equal(entry.identifier, `https://github.com/kensaurus/lazycow-studio/releases/download/v${version}/${NAME}`);
  assert.equal(entry.transport.type, "stdio");
});

test("the bundle holds the manifest, icon, licence and a server that starts with empty settings", async (t) => {
  const out = mkdtempSync(join(tmpdir(), "mcpb-run-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const files = unzip(build(out));
  assert.deepEqual([...files.keys()].sort(), ["LICENSE", "NOTICE", "icon.png", "manifest.json", "server/index.js", "server/lib/mcp.mjs", "server/package.json"]);
  assert.match(files.get("NOTICE").toString(), /kensaurus/);

  const m = JSON.parse(files.get("manifest.json"));
  assert.equal(m.manifest_version, "0.3");
  assert.equal(m.version, version);
  assert.equal(m.server.type, "node");
  assert.ok(files.has(m.server.entry_point) && files.has(m.icon));
  assert.deepEqual(m.server.mcp_config.args, ["${__dirname}/server/index.js"]);
  assert.deepEqual(Object.keys(m.server.mcp_config.env).sort(), ["LAZYCOW_DIR", "STUDIO_API_TOKEN", "STUDIO_PORT"]);
  for (const [key, c] of Object.entries(m.user_config)) {
    assert.equal(c.required, false, `${key} is optional: the studio's .env is found by itself`);
    assert.ok(Object.values(m.server.mcp_config.env).includes(`\${user_config.${key}}`), `${key} reaches the server`);
  }
  assert.equal(m.user_config.studio_api_token.sensitive, true);
  assert.equal(m.user_config.lazycow_dir.type, "directory");
  assert.ok(!m.tools.some((x) => /approve/.test(x.name)), "no approve tool");

  // Unpack it as Claude Desktop would, then run it with every setting left empty: the port comes from LAZYCOW_DIR's .env.
  const dir = join(out, "unpacked");
  for (const [name, data] of files) { mkdirSync(dirname(join(dir, name)), { recursive: true }); writeFileSync(join(dir, name), data); }
  const studio = join(out, "studio");
  mkdirSync(studio);
  writeFileSync(join(studio, ".env"), "STUDIO_PORT=49999\n");  // never called: the handshake and tools/list need no studio
  const child = spawn(process.execPath, [join(dir, "server", "index.js")], {
    env: { ...process.env, STUDIO_PORT: "${user_config.studio_port}", STUDIO_API_TOKEN: "", LAZYCOW_DIR: studio }, stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (c) => { stdout += c; });
  child.stderr.on("data", (c) => { stderr += c; });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }) + "\n");
  child.stdin.end(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
  await new Promise((r) => child.on("close", r));
  const [init, list] = stdout.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(init.result.serverInfo.version, version);
  assert.match(stderr, /127\.0\.0\.1:49999\b/, "an empty port setting falls back to the studio's .env");
  assert.deepEqual(list.result.tools.map((x) => x.name), m.tools.map((x) => x.name), "the manifest lists the server's tools");
});
