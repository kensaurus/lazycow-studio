/**
 * FILE: test/perf-mcp.test.mjs
 * PURPOSE: The MCP performance tools (perf_summary, perf_suggest in server/mcp.mjs) are read-only, go through the
 *          studio's /api/perf* endpoints with only the arguments given, and answer in plain sentences.
 * OVERVIEW: A fake studio (node:http on a random port) answers /api/perf/summary and /api/perf/suggest; the MCP
 *           server is spawned with STUDIO_PORT pointing at it and driven over stdio.
 * USAGE: npm test
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

const MCP = fileURLToPath(new URL("../server/mcp.mjs", import.meta.url));

function fakeStudio() {
  const calls = [];
  const routes = {
    "/api/perf/summary": (q) => ({
      ready: false, measured: 4, needed: 15, networks: { youtube: { name: "YouTube", metric: "views", median: 300, posts: 4 } },
      headline: `Not enough data yet: 4 of 15 measured posts.${q.get("network") ? ` (${q.get("network")})` : ""}`,
      sentences: ["Not enough data yet: 4 of 15 measured posts.", "punch look: about 1.6x the median views on YouTube (3 posts; still uncertain)"],
      worked: [], didnt: [], method: "m",
    }),
    "/api/perf/suggest": (q) => ({
      ready: false, measured: 4, needed: 15, note: "Exploring only: 4 of 15 measured posts so far.",
      suggestions: Array.from({ length: Number(q.get("n") || 3) }, () => ({ mode: "explore", look: "ember", recipe: "pov", style: "split", length: "12-16 s", hour: "18-20", why: {} })),
      distribution: { look: { ember: 0.2 } },
    }),
  };
  const server = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    calls.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams) });
    const route = req.method === "GET" && routes[u.pathname];
    if (!route) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("no"); }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(route(u.searchParams)));
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ server, port: server.address().port, calls })));
}

function startMcp(port) {
  const child = spawn(process.execPath, [MCP], { env: { ...process.env, STUDIO_PORT: String(port) }, stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);
    const w = waiting.get(msg.id);
    if (w) { waiting.delete(msg.id); w(msg); }
  });
  child.stderr.resume();
  let next = 0;
  const call = (method, params) => new Promise((ok, fail) => {
    const id = ++next;
    const timer = setTimeout(() => fail(new Error(`no answer to ${method}`)), 10_000);
    waiting.set(id, (m) => { clearTimeout(timer); ok(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) + "\n");
  });
  const stop = () => new Promise((ok) => { child.once("exit", ok); child.stdin.end(); });
  return { call, stop, tool: async (name, args = {}) => (await call("tools/call", { name, arguments: args })).result };
}

test("mcp: perf_summary and perf_suggest are read-only and go through /api/perf", async () => {
  const studio = await fakeStudio();
  const c = startMcp(studio.port);
  try {
    await c.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    const { tools } = (await c.call("tools/list")).result;
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const name of ["perf_summary", "perf_suggest"]) {
      assert.ok(by[name], `missing tool ${name}`);
      assert.equal(by[name].annotations.readOnlyHint, true, name);
      assert.equal(by[name].annotations.destructiveHint, false, name);
      assert.ok(by[name].description.length > 40);
    }
    assert.match(by.perf_suggest.description, /approves every reel/);

    const s = await c.tool("perf_summary", { network: "youtube" });
    assert.equal(s.isError, false);
    assert.match(s.content[0].text, /^Not enough data yet: 4 of 15/);
    assert.match(s.content[0].text, /- punch look: about 1\.6x the median views on YouTube/);
    assert.deepEqual(studio.calls.at(-1), { method: "GET", path: "/api/perf/summary", query: { network: "youtube" } });

    const g = await c.tool("perf_suggest", { n: 2, seed: 7 });
    assert.equal(g.isError, false);
    assert.match(g.content[0].text, /1\. \[explore\] ember look, pov recipe, split layout, 12-16 s, post 18-20 JST/);
    assert.match(g.content[0].text, /2\. \[explore\]/);
    assert.deepEqual(studio.calls.at(-1).query, { n: "2", seed: "7" });

    const bad = await c.tool("perf_suggest", { explore: 2 });
    assert.equal(bad.isError, true);
    assert.equal(studio.calls.filter((x) => x.path === "/api/perf/suggest").length, 1, "a bad argument never reaches the studio");
    assert.ok(studio.calls.every((x) => x.method === "GET"), "read-only: no POST");
  } finally { await c.stop(); studio.server.close(); }
});
