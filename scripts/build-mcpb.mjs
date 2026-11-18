#!/usr/bin/env node
/**
 * FILE: scripts/build-mcpb.mjs
 * PURPOSE: Build the Claude Desktop extension, dist/lazycow-<version>.mcpb: the npm package's MCP server
 *          (packages/lazycow/lib/mcp.mjs) with the manifest in packages/mcpb/, so Claude Desktop installs it in one
 *          click and asks for the port, token and studio folder only when they cannot be found.
 * USAGE:  node scripts/build-mcpb.mjs [--out <folder>] [--validate]   write the bundle, its .sha256 and lazycow.mcpb;
 *                                                                     keep the manifest and server.json in step
 *         node scripts/build-mcpb.mjs --check                         exit 1 when the manifest (version, tools) or the
 *                                                                     registry's mcpb entry (URL, SHA-256) is stale
 * NOTES:  The bundle is deterministic: sorted entries, stored (no compression), a fixed 1980-01-01 time, LF text. The
 *         same tree gives the same bytes on any OS and Node, so the SHA-256 in packages/lazycow/server.json, written
 *         here, is the one the release workflow uploads (.github/workflows/release.yml). Run it after
 *         scripts/build-packages.mjs. lazycow.mcpb is the same file under a name that /releases/latest/download/ can
 *         link to. --validate also runs the official checker (npx @anthropic-ai/mcpb validate).
 */
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = join(ROOT, "packages", "lazycow");
const SRC = join(ROOT, "packages", "mcpb");
const REPO = "kensaurus/lazycow-studio";
const MCPB_CLI = "@anthropic-ai/mcpb@2.1.2";
const args = process.argv.slice(2);
const check = args.includes("--check");
const validate = args.includes("--validate");
const outDir = resolve(ROOT, args.includes("--out") ? args[args.indexOf("--out") + 1] : "dist");

const lf = (s) => s.replace(/\r\n/g, "\n");
const text = (p) => lf(readFileSync(p, "utf8"));
const json = (p) => JSON.parse(readFileSync(p, "utf8"));
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

const version = json(join(ROOT, "package.json")).version;
if (json(join(PKG, "package.json")).version !== version) {
  console.error(`packages/lazycow is not at ${version}. Run node scripts/build-packages.mjs first.`);
  process.exit(1);
}

/** The tools the server lists, asked of the server itself (no studio needed). */
function listTools() {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [join(PKG, "lib", "mcp.mjs")], {
      env: { ...process.env, STUDIO_PORT: "1", STUDIO_API_TOKEN: "", LAZYCOW_DIR: tmpdir() }, stdio: ["pipe", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.on("data", (c) => { out += c; });
    child.on("error", fail);
    child.on("close", () => {
      const list = out.trim().split("\n").map((l) => JSON.parse(l)).find((m) => m.id === 2);
      if (!list?.result?.tools?.length) return fail(new Error("the MCP server listed no tools"));
      done(list.result.tools.map((t) => ({ name: t.name, description: t.description })));
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "build-mcpb", version } } }) + "\n");
    child.stdin.end(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
  });
}

// CRC-32 (zip's), so the build needs no zlib.crc32 (Node 22.2+).
const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip of stored entries in name order, all dated 1980-01-01 00:00. */
function zip(files) {
  const names = [...files.keys()].sort();
  const local = [], central = [];
  let offset = 0;
  for (const name of names) {
    const data = files.get(name), nameBuf = Buffer.from(name, "utf8"), crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(0, 8);
    head.writeUInt16LE(0, 10); head.writeUInt16LE(0x21, 12); head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(data.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(nameBuf.length, 26); head.writeUInt16LE(0, 28);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(0x0800, 8); dir.writeUInt16LE(0, 10);
    dir.writeUInt16LE(0, 12); dir.writeUInt16LE(0x21, 14); dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24); dir.writeUInt16LE(nameBuf.length, 28); dir.writeUInt16LE(0, 30); dir.writeUInt16LE(0, 32);
    dir.writeUInt16LE(0, 34); dir.writeUInt16LE(0, 36); dir.writeUInt32LE(0, 38); dir.writeUInt32LE(offset, 42);
    local.push(head, nameBuf, data);
    central.push(dir, nameBuf);
    offset += head.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(names.length, 8); end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

// 1. The manifest: hand-edited in packages/mcpb/manifest.json; the version and the tool list are kept in step here.
const manifestPath = join(SRC, "manifest.json");
const manifest = json(manifestPath);
manifest.version = version;
manifest.tools = await listTools();
const manifestText = JSON.stringify(manifest, null, 2) + "\n";

// 2. The bundle. server/package.json makes index.js an ES module and gives lib/mcp.mjs its version (../package.json).
const files = new Map([
  ["manifest.json", Buffer.from(manifestText)],
  ["icon.png", readFileSync(join(ROOT, "server", "brand", "icon-512.png"))],
  ["LICENSE", Buffer.from(text(join(ROOT, "LICENSE")))],
  ["NOTICE", Buffer.from(text(join(ROOT, "NOTICE")))],
  ["server/index.js", Buffer.from(text(join(SRC, "server", "index.js")))],
  ["server/lib/mcp.mjs", Buffer.from(text(join(PKG, "lib", "mcp.mjs")))],
  ["server/package.json", Buffer.from(JSON.stringify({ name: "lazycow-mcpb", version, private: true, type: "module", license: "Apache-2.0" }, null, 2) + "\n")],
]);
const bundle = zip(files);
const sha = sha256(bundle);
const name = `lazycow-${version}.mcpb`;

// 3. The MCP Registry entry: the release asset's URL and SHA-256 (clients check it before installing).
const serverPath = join(PKG, "server.json");
const server = json(serverPath);
const entry = { registryType: "mcpb", identifier: `https://github.com/${REPO}/releases/download/v${version}/${name}`, version, fileSha256: sha, transport: { type: "stdio" } };
const others = (server.packages || []).filter((p) => p.registryType !== "mcpb");
server.packages = [...others, entry];
const serverText = JSON.stringify(server, null, 2) + "\n";

const manifestStale = text(manifestPath) !== manifestText;
const serverStale = text(serverPath) !== serverText;
const stale = [
  ...(manifestStale ? ["packages/mcpb/manifest.json (version or tools)"] : []),
  ...(serverStale ? ["packages/lazycow/server.json (the mcpb entry's URL or SHA-256)"] : []),
];

if (check) {
  if (stale.length) { console.error("Out of step with the bundle:\n  " + stale.join("\n  ") + "\nRun: node scripts/build-mcpb.mjs"); process.exit(1); }
  console.log(`${name} ${sha} is the one server.json names.`);
  process.exit(0);
}

if (manifestStale) writeFileSync(manifestPath, manifestText);
if (serverStale) writeFileSync(serverPath, serverText);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, name), bundle);
writeFileSync(join(outDir, `${name}.sha256`), `${sha}  ${name}\n`);
writeFileSync(join(outDir, "lazycow.mcpb"), bundle);
console.log(`${join(outDir, name)}\n  ${files.size} files, ${bundle.length} bytes, SHA-256 ${sha}${stale.length ? `\nUpdated:\n  ${stale.join("\n  ")}` : ""}`);

if (validate) {
  const tmp = mkdtempSync(join(tmpdir(), "lazycow-mcpb-"));
  try {
    // The checker reads the icon and entry point beside the manifest: give it the bundle's own files.
    for (const [p, data] of files) { mkdirSync(dirname(join(tmp, p)), { recursive: true }); writeFileSync(join(tmp, p), data); }
    // One command line (npx is a .cmd on Windows, which needs a shell); the path is a temp folder this script made.
    const r = spawnSync(`npx -y ${MCPB_CLI} validate "${join(tmp, "manifest.json")}"`, { encoding: "utf8", shell: true });
    process.stdout.write(r.stdout || "");
    process.stderr.write(r.stderr || "");
    if (r.status !== 0) { console.error(`${MCPB_CLI} validate failed (exit ${r.status ?? r.error?.message})`); process.exit(1); }
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  }
}
