/**
 * FILE: test/mcp-every-tool.test.mjs
 * PURPOSE: Every MCP tool works end to end, and every studio route the MCP server calls is a real, documented route.
 * OVERVIEW: (1) A static contract: each "/api/..." path in server/mcp.mjs is a path in docs/openapi.yaml (which
 *           test/openapi-routes.test.mjs ties to server/review.mjs). (2) A fake studio answers every route the tools use;
 *           each of the 27 tools is called once with valid arguments, through the packaged copy too (npx lazycow mcp),
 *           and must answer without an error, with text, and through the routes it is documented to use.
 * USAGE: npm test
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../server/mcp.mjs", import.meta.url));
const BIN = fileURLToPath(new URL("../packages/lazycow/bin/lazycow.mjs", import.meta.url));
const code = readFileSync(SERVER, "utf8");
const spec = readFileSync(new URL("../docs/openapi.yaml", import.meta.url), "utf8");
const specPaths = new Set([...spec.matchAll(/^ {2}(\/[^\s:]*):\s*$/gm)].map((m) => m[1]));

test("every studio route the MCP server calls is in docs/openapi.yaml", () => {
  const used = new Set();
  for (const m of code.matchAll(/studio\("(GET|POST)",\s*[`"](\/api\/[^`"?$]*)/g)) used.add(`${m[1]} ${m[2]}`);
  // The research tools share one helper: POST /api/research/<action>.
  for (const m of code.matchAll(/research\("([a-z-]+)"/g)) used.add(`POST /api/research/${m[1]}`);
  assert.ok(used.size >= 25, `found ${used.size} routes`);
  const missing = [...used].map((r) => r.split(" ")[1]).filter((p) => !specPaths.has(p.replace(/\/$/, "")));
  assert.deepEqual(missing, [], "MCP calls a route the API documents nowhere");
});

/* ---------- a fake studio that answers every route the tools use ---------- */
function fakeStudio() {
  const calls = [];
  const reel = { slug: "fire-1107", title: "Fire", theme: "fire", status: "approved", house: false, rendered: true, seconds: 14, clips: 7, job: { status: "none" } };
  let running = "main";
  const job = (slug, status = "running") => ({ slug, kind: "build", status, pct: 10, label: "working", position: 0 });
  const routes = {
    "GET /api/health": () => ({ version: "9.9.9", build: "abc", stale: false, queue: { running: null, queued: 0 }, verdict: "ok", checks: [] }),
    "GET /api/about": () => ({ name: "Lazycow Studio", version: "9.9.9" }),
    "GET /api/config": () => ({ workspace: "Test", audienceTz: "Asia/Tokyo" }),
    "GET /api/overview": () => ({ reels: [reel], library: {}, filmNext: [] }),
    "GET /api/drafts": () => [{ slug: "story-fire-1107", status: "approved", faces: 0, consent: 0, notes: "" }],
    "GET /api/job": (q) => (q.get("slug") === "fire-1107" ? job("fire-1107") : { status: "none" }),
    "GET /api/reel": () => ({ slug: "fire-1107", shots: [{ path: "a.mp4" }], words: ["Hello"] }),
    "GET /api/themes": () => ({ fire: { title: "Fire", slots: 6 }, view: { title: "View", slots: 5 } }),
    "POST /api/autopilot": () => ({ made: [{ slug: "fire-1113", theme: "fire" }] }),
    "POST /api/assemble": () => ({ project: { shots: [1, 2, 3] }, job: job("fire-1114", "queued") }),
    "POST /api/remix": (q, b) => job(b.slug, "queued"),
    "POST /api/job/cancel": (q, b) => job(b.slug, "cancelled"),
    "GET /api/posts": () => [{ id: 1, slug: "fire-1107", network: "bluesky", status: "posted", at: "2026-11-10T19:00", url: "https://bsky.app/x" }],
    "POST /api/posts/plan": () => ({ id: 42 }),
    "GET /api/connections": () => ({ bluesky: { name: "Bluesky", connected: true, account: "@test", canSchedule: false, error: null } }),
    "GET /api/channels": () => ({ channels: [{ id: "bluesky", name: "Bluesky", account: "test" }] }),
    "GET /api/youtube": () => ({ app: true, connected: true }),
    "POST /api/youtube/upload": (q, b) => ({ ...job(b.slug), kind: "youtube" }),
    "POST /api/publish": (q, b) => ({ ...job(`post-${b.slug}-${b.network}`), kind: "post" }),
    "POST /api/helper/schedule": (q, b) => ({ ...job(`helper-${b.slug}-${b.network}`, "queued"), kind: "helper" }),
    "GET /api/workspaces": () => ({ running, list: [{ id: "main", name: "Main", main: true }, { id: "trip", name: "Trip" }] }),
    "POST /api/workspaces/switch": (q, b) => { running = b.id; return { ok: true }; },
    "GET /api/log": () => ({ jobs: [{ slug: "fire-1107", status: "ok" }, { slug: "x", status: "error" }], spend: { total: 1.2, today: 0, rows: [] }, reels: [reel], youtube: { used: 1600 } }),
    "POST /api/research/ideas": () => ({ summary: "Ideas.", angles: [], sources: ["https://a.example/"] }),
    "POST /api/research/site-check": () => ({ summary: "Checked.", facts: [], mismatches: [], sources: ["https://a.example/"] }),
    "POST /api/research/page": () => ({ summary: "A page.", title: "T", sellingPoints: [], sources: ["https://a.example/"] }),
    "POST /api/research/events": () => ({ summary: "1 event.", events: [{ title: "E", url: "https://e.example/", dates: ["2026-12-01"] }], undated: [], sources: ["https://e.example/"] }),
    "POST /api/research/links": () => ({ summary: "All links load.", broken: [], unsure: [], checked: 2, sources: [] }),
    "POST /api/ai/estimate": (q, b) => ({ summary: "Fits.", tools: b.tools.map((t) => ({ tool: t, usd: 0.1 })), total: 0.1, fits: true, refusal: null, caps: {}, spent: {} }),
    "POST /api/ai/run": (q, b) => ({ job: { slug: `ai-${b.options?.into || b.slug}`, kind: "ai", status: "running", pct: 0, label: "pricing" }, estimate: {} }),
    "GET /api/ai/review": () => ({ slug: "fire-1107", review: { hook: { score: 7 }, summary: "Good.", fixes: [] } }),
    "POST /api/ai/review": () => ({ slug: "fire-1107", hook: { score: 7 }, summary: "Good.", fixes: [], usd: 0.01 }),
    "GET /api/perf/summary": () => ({ ready: false, measured: 3, needed: 15, sentences: ["Early hints only."] }),
    "GET /api/perf/suggest": () => ({ ready: false, measured: 3, needed: 15, note: "Exploring.", suggestions: [{ mode: "explore", look: "punch", recipe: "r", style: "s", length: "short", hour: 19 }] }),
  };
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const u = new URL(req.url, "http://x");
      const body = raw ? JSON.parse(raw) : undefined;
      calls.push(`${req.method} ${u.pathname}`);
      const route = routes[`${req.method} ${u.pathname}`];
      if (req.method === "POST" && req.headers.origin !== `http://127.0.0.1:${server.address().port}`) {
        res.writeHead(403, { "content-type": "application/json" });
        return res.end('{"error":"not from the studio"}');
      }
      if (!route) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("no such route"); }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(route(u.searchParams, body)));
    });
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ server, port: server.address().port, calls })));
}

function client(args, port) {
  const child = spawn(process.execPath, args, { env: { ...process.env, STUDIO_PORT: String(port), STUDIO_API_TOKEN: "", LAZYCOW_DIR: "" }, stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg);
    waiting.delete(msg.id);
  });
  child.stderr.resume();
  let id = 0;
  const call = (method, params) => new Promise((ok, fail) => {
    const n = ++id;
    const timer = setTimeout(() => fail(new Error(`no answer to ${method} ${params?.name || ""}`)), 40_000);
    waiting.set(n, (m) => { clearTimeout(timer); ok(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, ...(params ? { params } : {}) }) + "\n");
  });
  const stop = () => new Promise((ok) => { child.once("exit", ok); child.stdin.end(); });
  return { call, stop };
}

/** One valid call per tool, and a route each one must reach. */
const CASES = {
  studio_status: [{}, "GET /api/health"],
  list_reels: [{ status: "approved", limit: 5 }, "GET /api/overview"],
  reel_details: [{ slug: "fire-1107" }, "GET /api/reel"],
  list_themes: [{}, "GET /api/themes"],
  make_reels: [{ themes: ["fire"], since: "2026-10-01" }, "POST /api/autopilot"],
  make_reel: [{ theme: "fire", slug: "fire-1114" }, "POST /api/assemble"],
  remix_reel: [{ slug: "fire-1107" }, "POST /api/remix"],
  job_status: [{ slug: "fire-1107" }, "GET /api/job"],
  cancel_job: [{ slug: "fire-1107" }, "POST /api/job/cancel"],
  list_posts: [{ network: "bluesky" }, "GET /api/posts"],
  plan_post: [{ slug: "fire-1107", network: "bluesky", at: "2026-11-20T19:00+09:00" }, "POST /api/posts/plan"],
  list_accounts: [{}, "GET /api/connections"],
  publish_reel: [{ slug: "fire-1107", network: "bluesky" }, "POST /api/publish"],
  schedule_reel: [{ slug: "fire-1107", network: "x", at: "2026-11-20T19:00+09:00" }, "POST /api/helper/schedule"],
  list_projects: [{}, "GET /api/workspaces"],
  switch_project: [{ id: "trip" }, "POST /api/workspaces/switch"],
  read_log: [{ section: "jobs", failed_only: true }, "GET /api/log"],
  research_ideas: [{ topic: "autumn" }, "POST /api/research/ideas"],
  research_site_check: [{}, "POST /api/research/site-check"],
  research_page: [{ url: "https://a.example/" }, "POST /api/research/page"],
  research_events: [{ days: 30 }, "POST /api/research/events"],
  research_links: [{}, "POST /api/research/links"],
  ai_estimate: [{ slug: "fire-1107", tools: ["sharpen"] }, "POST /api/ai/estimate"],
  ai_review: [{ slug: "fire-1107", last_only: true }, "GET /api/ai/review"],
  ai_run: [{ slug: "fire-1107", tools: ["sharpen"], into: "fire-1107-ai" }, "POST /api/ai/run"],
  perf_summary: [{ network: "tiktok" }, "GET /api/perf/summary"],
  perf_suggest: [{ n: 1, seed: 1 }, "GET /api/perf/suggest"],
};

for (const [label, args] of [["server/mcp.mjs", [SERVER]], ["the npm package (lazycow mcp)", [BIN, "mcp"]]]) {
  test(`every tool answers through ${label}`, { timeout: 120_000 }, async () => {
    const { server, port, calls } = await fakeStudio();
    const c = client(args, port);
    try {
      const init = await c.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
      assert.ok(init.result?.serverInfo, "initialize");
      const tools = (await c.call("tools/list", {})).result.tools.map((t) => t.name).sort();
      assert.deepEqual(tools, Object.keys(CASES).sort(), "the test covers exactly the tools the server lists");
      const structured = {};
      for (const [name, [a, route]] of Object.entries(CASES)) {
        const before = calls.length;
        const r = await c.call("tools/call", { name, arguments: a });
        assert.ok(!r.error, `${name}: protocol error ${JSON.stringify(r.error)}`);
        assert.ok(!r.result.isError, `${name}: ${r.result.content?.[0]?.text}`);
        assert.ok(r.result.content?.[0]?.text?.length > 0, `${name}: no text`);
        assert.ok(calls.slice(before).includes(route), `${name} did not call ${route}: ${calls.slice(before).join(", ")}`);
        const sc = r.result.structuredContent;
        if (sc !== undefined) {
          assert.ok(sc && typeof sc === "object" && !Array.isArray(sc), `${name}: structuredContent must be an object`);
          assert.doesNotMatch(JSON.stringify(sc), /access_token|refresh_token|"app_password":"/, `${name}: no secrets`);
        }
        structured[name] = sc;
      }
      assert.ok(Array.isArray(structured.list_reels?.items) && structured.list_reels.items[0].slug === "fire-1107", "a list arrives as { items }");
      assert.equal(structured.plan_post?.id, 42, "an object arrives as itself");
      assert.ok(Object.values(structured).filter(Boolean).length >= 20, "most tools give data a program can read");
      // A bad argument is refused by the server, never sent to the studio.
      const before = calls.length;
      const bad = await c.call("tools/call", { name: "reel_details", arguments: { slug: "-rf /" } });
      assert.ok(bad.error || bad.result?.isError, "a slug that is not a slug is refused");
      assert.equal(calls.length, before);
    } finally {
      await c.stop();
      server.close();
    }
  });
}
