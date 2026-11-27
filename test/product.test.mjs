/**
 * FILE: test/product.test.mjs
 * PURPOSE: Product videos (docs/product-kit.md): the presets are one list everywhere (shared/product-presets.json, the
 *          MCP tool's enum, docs/openapi.yaml), each preset is inside its store's spec, the make_product_video tool's
 *          schema refuses a bad call before it reaches the studio, and the composition reads the same timeline. The
 *          encoding fields have one range everywhere (shared/product-presets.json encoding.fields, the MCP tool, the
 *          kit schema, docs/openapi.yaml) and the console sends them (test_product_encoding.py checks the rules).
 * USAGE: npm test
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const FILE = JSON.parse(read("shared/product-presets.json"));
const PRESETS = FILE.presets;
const FIELDS = FILE.encoding.fields;
const IDS = Object.keys(PRESETS);
const MCP = fileURLToPath(new URL("../server/mcp.mjs", import.meta.url));

test("one preset list: shared/product-presets.json, the MCP tool's enum (in both copies) and docs/openapi.yaml", () => {
  for (const file of ["server/mcp.mjs", "packages/lazycow/lib/mcp.mjs"]) {
    const inline = /const PRODUCT_PRESETS = \[([^\]]+)\]/.exec(read(file))?.[1];
    assert.ok(inline, `${file} has no PRODUCT_PRESETS`);
    assert.deepEqual([...inline.matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]), IDS, file);
  }
  const spec = /ProductPreset:\s*\n\s*type: string\s*\n\s*enum: \[([^\]]+)\]/.exec(read("docs/openapi.yaml"))?.[1];
  assert.deepEqual(spec.split(",").map((s) => s.trim()), IDS);
  for (const id of IDS) assert.match(read("docs/product-kit.md"), new RegExp("`" + id + "`"), `docs/product-kit.md names ${id}`);
});

test("every preset is inside its store's spec and fits H.264 level 4.0", () => {
  // developer.apple.com app preview specifications (27 Nov 2026): accepted portrait sizes.
  const apple = new Set(["886x1920", "1080x1920", "750x1334", "1200x1600", "900x1200"]);
  for (const [id, p] of Object.entries(PRESETS)) {
    assert.ok(p.width % 2 === 0 && p.height % 2 === 0, `${id}: even sizes for 4:2:0`);
    assert.ok(p.fps <= 30, `${id}: at most 30 fps`);
    assert.ok(p.minSec < p.targetSec && p.targetSec < p.maxSec, `${id}: min < target < max`);
    const mbs = Math.ceil(p.width / 16) * Math.ceil(p.height / 16);
    assert.ok(mbs <= 8192 && mbs * p.fps <= 245760, `${id}: inside H.264 level 4.0`);
    assert.equal(p.encode.level, "4.0");
    if (p.store === "app-store") {
      assert.ok(apple.has(`${p.width}x${p.height}`), `${id}: an accepted App Store size`);
      assert.deepEqual([p.minSec, p.maxSec], [15, 30], `${id}: 15-30 s`);
      assert.equal(p.frame, "none", `${id}: the app itself, no drawn device (Guideline 2.3.4)`);
      assert.ok(p.encode.maxMb <= 500 && p.encode.audioKbps === 256);
    }
  }
  assert.equal(PRESETS["play-promo"].width / PRESETS["play-promo"].height, 16 / 9);
  assert.equal(PRESETS["social-9x16"].width / PRESETS["social-9x16"].height, 9 / 16);
  assert.equal(PRESETS["social-1x1"].width, PRESETS["social-1x1"].height);
});

test("the composition is registered and reads the planned timeline (src/Root.tsx, src/ProductPreview.tsx)", () => {
  const root = read("src/Root.tsx"), comp = read("src/ProductPreview.tsx");
  assert.match(root, /<Composition id="ProductPreview" component=\{ProductPreview\}/);
  assert.match(root, /calculateMetadata=\{\(\{ props \}\) => \(\{ width: props\.preset\.width, height: props\.preset\.height, fps: props\.preset\.fps/);
  // py/studio/product.py plan() keys are the props the composition reads.
  for (const key of ["durationInFrames", "overlap", "scenes", "title", "news", "end", "brand", "fonts", "labels", "logo"]) assert.match(comp, new RegExp(`\\b${key}\\b`));
  assert.doesNotMatch(comp, /dangerouslySetInnerHTML|eval\(|new Function/, "nothing from a kit is run");
  assert.match(read("py/studio/product.py"), /_remotion\("ProductPreview"/);
});

/* The MCP server alone (no studio on port 1): a call with bad arguments is refused before any request; a good one
   gets as far as "the studio is not running". */
function mcp() {
  const child = spawn(process.execPath, [MCP], { env: { ...process.env, STUDIO_PORT: "1", STUDIO_API_TOKEN: "", LAZYCOW_DIR: "" }, stdio: ["pipe", "pipe", "ignore"] });
  const waiting = new Map();
  createInterface({ input: child.stdout }).on("line", (line) => { const m = JSON.parse(line); waiting.get(m.id)?.(m); waiting.delete(m.id); });
  let id = 0;
  const call = (method, params) => new Promise((ok) => { const n = ++id; waiting.set(n, ok); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); });
  return { call, stop: () => new Promise((ok) => { child.once("exit", ok); child.stdin.end(); }) };
}

test("make_product_video: its schema, and a bad call refused before it reaches the studio", { timeout: 60_000 }, async () => {
  const c = mcp();
  try {
    await c.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    const tool = (await c.call("tools/list", {})).result.tools.find((t) => t.name === "make_product_video");
    assert.ok(tool, "listed");
    assert.deepEqual(tool.inputSchema.required, ["kitUrl", "preset"]);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual(tool.inputSchema.properties.preset.enum, IDS);
    // encoding (0.32.0): per-render encoding, optional; everything else as in 0.31.0.
    assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ["encoding", "kitUrl", "name", "preset"]);
    assert.equal(tool.inputSchema.properties.encoding.additionalProperties, false);
    assert.equal(tool.annotations.openWorldHint, true, "it downloads the kit");
    assert.equal(tool.annotations.readOnlyHint, false);
    const bad = async (args, words) => {
      const r = await c.call("tools/call", { name: "make_product_video", arguments: args });
      assert.equal(r.result.isError, true, JSON.stringify(args));
      assert.match(r.result.content[0].text, words);
    };
    await bad({ kitUrl: "https://kits.example/m.json" }, /preset is required/);
    await bad({ kitUrl: "https://kits.example/m.json", preset: "tiktok-8k" }, /preset must be one of: appstore-iphone/);
    await bad({ kitUrl: "http://kits.example/m.json", preset: "social-9x16" }, /kitUrl has the wrong format/);
    await bad({ kitUrl: "https://kits.example/m.json", preset: "social-9x16", name: "Bad Name" }, /name has the wrong format/);
    await bad({ kitUrl: "https://kits.example/m.json", preset: "social-9x16", extra: 1 }, /unknown argument extra/);
    await bad({ kitUrl: "https://kits.example/m.json", preset: "social-9x16", encoding: { fps: 59 } }, /encoding\.fps must be one of: 24, 25, 30/);
    await bad({ kitUrl: "https://kits.example/m.json", preset: "social-9x16", encoding: { videoKbps: 100 } }, /encoding\.videoKbps must be at least 300/);
    await bad({ kitUrl: "https://kits.example/m.json", preset: "social-9x16", encoding: { x264: "--crf 0" } }, /unknown argument encoding\.x264/);
    await bad({ kitUrl: "https://kits.example/m.json", preset: "social-9x16", encoding: { audioBed: { id: "a.mp3" } } }, /encoding\.audioBed\.kind is required/);
    await bad({ kitUrl: "https://kits.example/m.json", preset: "social-9x16", encoding: { audioBed: { kind: "music", id: "a.mp3", file: "/etc" } } }, /unknown argument encoding\.audioBed\.file/);
    await bad({ kitUrl: "https://kits.example/m.json", preset: "social-9x16", encoding: "cbr" }, /encoding must be an object/);
    await bad({ kitUrl: "https://kits.example/m.json", preset: "social-9x16", name: "my-app-1-4" }, /not running/);
    await bad({ kitUrl: "https://kits.example/m.json", preset: "appstore-iphone", encoding: { rateControl: "cbr", videoKbps: 12000, audioBed: { kind: "dither" } } }, /not running/);
  } finally { await c.stop(); }
});

test("one range per encoding field: shared/product-presets.json, the MCP tool (both copies), the kit schema and docs/openapi.yaml", () => {
  const schema = JSON.parse(read("docs/product-kit.schema.json")).$defs.encoding.properties;
  const spec = read("docs/openapi.yaml").replace(/\r\n/g, "\n");
  const api = spec.slice(spec.indexOf("    ProductEncoding:"), spec.indexOf("    ProductEncodingIssue:")).split("\n");
  for (const file of ["server/mcp.mjs", "packages/lazycow/lib/mcp.mjs"]) {
    const src = read(file);
    const at = src.indexOf("const PRODUCT_ENCODING = {");
    assert.ok(at > 0, `${file} has no PRODUCT_ENCODING`);
    const block = src.slice(at, src.indexOf("\n};", at));
    for (const [k, f] of Object.entries(FIELDS)) {
      if (k === "audioBed") { assert.ok(block.includes('kind: { type: "string", enum: ["dither", "music"] }'), `${file}: audioBed.kind`); continue; }
      const want = "enum" in f ? `enum: [${f.enum.map((x) => JSON.stringify(x)).join(", ")}]` : `minimum: ${f.min}, maximum: ${f.max}`;
      assert.ok(block.split("\n").some((l) => l.includes(`${k}: { type: "`) && l.includes(want)), `${file}: ${k} ${want}`);
    }
  }
  for (const [k, f] of Object.entries(FIELDS)) {
    assert.ok(schema[k], `the kit schema has ${k}`);
    if (k === "audioBed") {
      assert.deepEqual(schema[k].properties.kind.enum, f.kind.enum);
      assert.ok(api.some((l) => l.includes("kind: { type: string, enum: [dither, music]")), "docs/openapi.yaml ProductEncoding: audioBed.kind");
      continue;
    }
    if ("enum" in f) assert.deepEqual(schema[k].enum, f.enum, k); else assert.deepEqual([schema[k].minimum, schema[k].maximum], [f.min, f.max], k);
    const want = "enum" in f ? `enum: [${f.enum.join(", ")}]` : `minimum: ${f.min}, maximum: ${f.max}`;
    assert.ok(api.some((l) => l.includes(`${k}: {`) && l.includes(want)), `docs/openapi.yaml ProductEncoding: ${k} ${want}`);
  }
});

test("each preset's default encoding is complete, and the App Store holds 10-12 Mbps by constrained CBR", () => {
  for (const [id, p] of Object.entries(PRESETS)) {
    const e = p.encode;
    for (const k of ["rateControl", "videoKbps", "keyframeSec", "audioKbps", "audioRate", "audioBed"]) assert.ok(e[k] !== undefined, `${id}: encode.${k}`);
    for (const [k, f] of Object.entries(FIELDS)) {
      if (e[k] === undefined || k === "audioBed") continue;
      assert.ok("enum" in f ? f.enum.includes(e[k]) : e[k] >= f.min && e[k] <= f.max, `${id}: ${k} ${e[k]} inside its range`);
    }
    assert.ok(FILE.encoding.stores[p.store], `${id}: its store ${p.store} has rules`);
    if (p.store === "app-store") {
      assert.equal(e.rateControl, "cbr", id);
      assert.ok(e.videoKbps >= 10000 && e.videoKbps <= 12000 && e.maxKbps === undefined && e.minKbps === undefined, id);
    }
  }
});

test("the console's Encoding panel sends its fields with the render and checks them as they are typed", () => {
  const ui = read("server/ui/js/22-product.js");
  assert.ok(ui.includes('post("/api/product/render", { name: PV.kit.name, preset: PV.preset, ...(Object.keys(values).length ? { encoding: values } : {}) })'));
  assert.ok(ui.includes('"/api/product/encoding/check"') && ui.includes('"/api/product/encoding/defaults"'));
  assert.ok(ui.includes('class="pv-adv"'), "an Advanced disclosure");
  assert.ok(ui.includes("function pvMeasuredHtml"), "the measured result");
  const server = read("server/review.mjs");
  assert.ok(server.includes('pvRun("prepare"'));
  assert.ok(server.includes('url.pathname === "/api/product/encoding/check"') && server.includes('url.pathname === "/api/product/encoding/defaults"'));
});
