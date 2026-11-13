/**
 * FILE: test/mcp.test.mjs
 * PURPOSE: The MCP server (server/mcp.mjs) speaks the protocol, lists its tools, reads through the
 *          studio's HTTP API, refuses to publish a reel that is not approved, and says plainly when
 *          the studio is not running.
 * OVERVIEW: A tiny fake studio (node:http on a random port) stands in for server/review.mjs; the MCP
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

/* ---------- a fake studio ---------- */
function fakeStudio() {
  const calls = [];
  const reels = [
    { slug: "fire-1107", title: "焚き火", theme: "fire", status: "approved", house: false, rendered: true, seconds: 14, clips: 7, job: { status: "none" } },
    { slug: "view-1107", title: "景色", theme: "view", status: "rendered", house: false, rendered: true, seconds: 12, clips: 6, job: { status: "none" } },
    { slug: "field-1108", title: "", theme: "field", status: "draft", house: false, rendered: false, seconds: 0, clips: 0, job: { status: "running", kind: "build", pct: 40, label: "grading" } },
  ];
  const routes = {
    "GET /api/health": () => ({ version: "9.9.9", build: "abc", stale: false, queue: { running: "field-1108", queued: 0 }, verdict: "ok", checks: [] }),
    "GET /api/about": () => ({ name: "Lazycow Studio", version: "9.9.9" }),
    "GET /api/config": () => ({ workspace: "Test ranch", audienceTz: "Asia/Tokyo" }),
    "GET /api/overview": () => ({ reels, library: {}, filmNext: [] }),
    "GET /api/drafts": () => [
      { slug: "story-fire-1107", status: "approved", faces: 0, consent: 0, notes: "" },
      { slug: "story-view-1107", status: "rendered", faces: 0, consent: 0, notes: "" },
    ],
    "GET /api/connections": () => ({ bluesky: { name: "Bluesky", connected: true, account: "@ranch", canSchedule: false, error: null, access_token: "SHOULD-NOT-LEAK",
      fields: [{ key: "app_password", label: "App password", secret: true }] } }),
    "GET /api/channels": () => ({ channels: [{ id: "bluesky", name: "Bluesky", account: "ranch" }, { id: "instagram", name: "Instagram Reels", off: true }] }),
    "GET /api/youtube": () => ({ app: true, connected: false }),
    "POST /api/publish": (b) => ({ slug: `post-${b.slug}-${b.network}`, kind: "post", status: "running", pct: 4, label: "starting", position: 0 }),
    "POST /api/helper/schedule": (b) => ({ slug: `helper-${b.slug}-${b.network}`, kind: "helper", status: "queued", pct: 0, label: "waiting for the helper", position: 0 }),
    "POST /api/research/ideas": (b) => ({ summary: `2 recent pages about ${b.topic || "the default topic"}.`, items: [{ title: "紅葉", url: "https://a.example/1" }],
      angles: [{ title: "紅葉の嬬恋", why: "trending", sources: ["https://a.example/1"], from: "template" }], hashtags: [], keywords: [],
      sources: ["https://a.example/1", "https://b.example/2"], note: "Suggestions for a person.", cached: true, cost: { firecrawlCalls: 0, fromCache: 2, credits: 0 } }),
    "POST /api/research/site-check": () => ({ summary: "Checked 2 pages of tsumagoi.kensaur.us: 1 facts match, 1 differ, 0 not stated on the website.",
      facts: [{ fact: "field_first_yen", status: "mismatch", message: "Field only: first adult per night: the website says ¥5,500; your copy says ¥5,200 (the view post).", source: "https://tsumagoi.kensaur.us/" }],
      mismatches: ["Field only: first adult per night: the website says ¥5,500; your copy says ¥5,200 (the view post)."], inclusions: [], booking: {},
      sources: ["https://tsumagoi.kensaur.us/", "https://tsumagoi.kensaur.us/reserve"], cached: false, cost: { firecrawlCalls: 2, fromCache: 0, credits: 10 } }),
    "POST /api/research/page": () => ({ summary: "A glamping site.", title: "Glamp", sellingPoints: ["sauna"], theySayWeDont: ["sauna"], sources: ["https://glamp.example/"] }),
    "POST /api/research/events": () => ({ summary: "1 events near Tsumagoi.", window: {}, events: [{ title: "Marathon", url: "https://ev.example/1", dates: ["2026-11-21"] }], undated: [], sources: ["https://ev.example/1"] }),
    "POST /api/research/links": () => ({ summary: "All 3 links that could be checked load.", broken: [], unsure: [], checked: 3, sources: ["https://ok.example/"] }),
    "POST /api/ai/estimate": (b) => {
      const big = b.tools.includes("living") && b.slug === "pricey-1";
      return { summary: big ? "2 AI steps for pricey-1: $2.40. Refused: over the limit." : `${b.tools.length} AI steps for ${b.options?.into || b.slug}: $0.23. Fits the limits.`,
        tools: b.tools.map((t) => ({ tool: t, usd: 0.1, model: "m", labelRequired: t === "voice", items: [{ what: `${t} on shot 1` }] })),
        total: big ? 2.4 : 0.23, fits: !big, refusal: big ? "That would spend $2.40 on pricey-1, over its $2.00 AI limit." : null,
        caps: { reel: 2, total: 20, daily: 20 }, spent: { reel: 0, total: 0, today: 0 }, labelRequired: b.tools.includes("voice") };
    },
    "POST /api/ai/run": (b) => ({ job: { slug: `ai-${b.options?.into || b.slug}`, kind: "ai", status: "running", pct: 0, label: "pricing" }, estimate: {} }),
    "POST /api/ai/review": (b) => ({ slug: b.slug, hook: { score: 6, notes: "slow start" }, look: { score: 8, notes: "" }, mismatches: [{ line: "星", why: "daytime" }],
      claims: [], fixes: [{ action: "swap clip", detail: "swap shot 4" }], summary: "Fine.", usd: 0.012, cached: false, guard: [] }),
    "GET /api/ai/review": () => ({ slug: "day-1108", review: null }),
  };
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const path = new URL(req.url, "http://x").pathname;
      const body = raw ? JSON.parse(raw) : undefined;
      calls.push({ method: req.method, path, origin: req.headers.origin, auth: req.headers.authorization, body });
      const route = routes[`${req.method} ${path}`];
      // Same rule as review.mjs: a POST must come from the studio's own origin.
      if (req.method === "POST" && req.headers.origin !== `http://127.0.0.1:${server.address().port}`) {
        res.writeHead(403, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "the studio only answers its own page on this machine" }));
      }
      if (!route) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("no"); }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(route(body)));
    });
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ server, port: server.address().port, calls })));
}

/** A port nothing listens on. */
function closedPort() {
  return new Promise((ok) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => ok(port)); }); });
}

/* ---------- a minimal MCP client over stdio ---------- */
function startMcp(port, env = {}) {
  const child = spawn(process.execPath, [MCP], { env: { ...process.env, STUDIO_PORT: String(port), ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map();
  const stray = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);  // every stdout line must be one JSON-RPC message
    const w = waiting.get(msg.id);
    if (w) { waiting.delete(msg.id); w(msg); } else stray.push(msg);
  });
  child.stderr.resume();
  let next = 0;
  const call = (method, params) => new Promise((ok, fail) => {
    const id = ++next;
    const timer = setTimeout(() => fail(new Error(`no answer to ${method}`)), 10_000);
    waiting.set(id, (m) => { clearTimeout(timer); ok(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) + "\n");
  });
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }) + "\n");
  const stop = () => new Promise((ok) => { child.once("exit", ok); child.stdin.end(); });
  const tool = async (name, args = {}) => (await call("tools/call", { name, arguments: args })).result;
  return { call, notify, stop, tool, stray };
}
async function session(port, env) {
  const c = startMcp(port, env);
  const init = await c.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  c.notify("notifications/initialized");
  return { ...c, init };
}

test("mcp: initialize negotiates a version, declares tools, and answers ping", async () => {
  const studio = await fakeStudio();
  const c = await session(studio.port);
  try {
    assert.equal(c.init.result.protocolVersion, "2025-06-18");
    assert.ok(c.init.result.capabilities.tools, "tools capability");
    assert.equal(c.init.result.serverInfo.name, "lazycow-studio");
    const odd = await c.call("initialize", { protocolVersion: "1999-01-01", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    assert.equal(odd.result.protocolVersion, "2025-11-25", "an unknown version gets the newest one the server speaks");
    assert.deepEqual((await c.call("ping")).result, {});
    assert.equal((await c.call("no/such/method")).error.code, -32601);
    // Modern (per-request _meta) clients: discover works, an unknown version is refused with the supported list.
    const meta = (v) => ({ _meta: { "io.modelcontextprotocol/protocolVersion": v, "io.modelcontextprotocol/clientInfo": { name: "t", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } });
    const disc = await c.call("server/discover", meta("2026-07-28"));
    assert.ok(disc.result.supportedVersions.includes("2026-07-28"));
    const bad = await c.call("tools/list", meta("1900-01-01"));
    assert.equal(bad.error.code, -32022);
    assert.equal((await c.call("tools/list", meta("2026-07-28"))).result.resultType, "complete");
    assert.equal(c.stray.length, 0, "a notification gets no answer");
  } finally { await c.stop(); studio.server.close(); }
});

test("mcp: tools/list has the tool set with schemas and honest annotations", async () => {
  const studio = await fakeStudio();
  const c = await session(studio.port);
  try {
    const { tools } = (await c.call("tools/list")).result;
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const name of ["studio_status", "list_reels", "reel_details", "list_posts", "plan_post", "list_accounts", "publish_reel", "make_reels", "remix_reel", "job_status", "list_projects", "switch_project", "read_log"]) {
      assert.ok(by[name], `missing tool ${name}`);
      assert.equal(by[name].inputSchema.type, "object");
      assert.ok(by[name].description.length > 40, `${name} needs a plain description`);
      assert.equal(by[name].run, undefined, "no internals on the wire");
    }
    for (const name of ["studio_status", "list_reels", "reel_details", "list_posts", "list_accounts", "job_status", "list_projects", "read_log"]) assert.equal(by[name].annotations.readOnlyHint, true, name);
    assert.equal(by.publish_reel.annotations.readOnlyHint, false);
    assert.equal(by.publish_reel.annotations.destructiveHint, false);
    assert.equal(by.publish_reel.annotations.openWorldHint, true);
    assert.match(by.publish_reel.description, /approved/i);
    assert.deepEqual(by.publish_reel.inputSchema.required, ["slug", "network"]);
  } finally { await c.stop(); studio.server.close(); }
});

test("mcp: read tools go through the studio API and never return secrets", async () => {
  const studio = await fakeStudio();
  const c = await session(studio.port);
  try {
    const status = await c.tool("studio_status");
    assert.equal(status.isError, false);
    assert.match(status.content[0].text, /9\.9\.9.*running/);
    const approved = await c.tool("list_reels", { status: "approved" });
    assert.equal(approved.isError, false);
    assert.match(approved.content[0].text, /^1 reel match/);
    assert.match(approved.content[0].text, /fire-1107/);
    assert.doesNotMatch(approved.content[0].text, /view-1107/);
    const making = await c.tool("list_reels", { status: "making" });
    assert.match(making.content[0].text, /field-1108/);
    const accounts = await c.tool("list_accounts");
    assert.equal(accounts.isError, false);
    assert.match(accounts.content[0].text, /bluesky/);
    assert.doesNotMatch(accounts.content[0].text, /SHOULD-NOT-LEAK/);
    const bad = await c.tool("list_reels", { status: "nope" });
    assert.equal(bad.isError, true, "bad arguments are a tool error the model can fix");
    assert.ok(studio.calls.some((x) => x.method === "GET" && x.path === "/api/overview"));
  } finally { await c.stop(); studio.server.close(); }
});

test("mcp: publish_reel refuses a reel that is not approved, and posts an approved one", async () => {
  const studio = await fakeStudio();
  const c = await session(studio.port);
  try {
    const refused = await c.tool("publish_reel", { slug: "view-1107", network: "bluesky" });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /Refused.*"rendered".*not "approved"/);
    const unknown = await c.tool("publish_reel", { slug: "ghost-1", network: "bluesky" });
    assert.equal(unknown.isError, true, "no review record: fail closed");
    assert.ok(!studio.calls.some((x) => x.path === "/api/publish"), "nothing was sent to publish");
    assert.ok(studio.calls.some((x) => x.path === "/api/drafts"), "the review status was checked");

    const ok = await c.tool("publish_reel", { slug: "fire-1107", network: "bluesky" });
    assert.equal(ok.isError, false, ok.content[0].text);
    const sent = studio.calls.find((x) => x.path === "/api/publish");
    assert.deepEqual(sent.body, { slug: "fire-1107", network: "bluesky" });
    assert.equal(sent.origin, `http://127.0.0.1:${studio.port}`, "POSTs carry the studio's own Origin");
    assert.match(ok.content[0].text, /post-fire-1107-bluesky/);
  } finally { await c.stop(); studio.server.close(); }
});

test("mcp: schedule_reel (browser helper) refuses a reel that is not approved, and queues an approved one", async () => {
  const studio = await fakeStudio();
  const c = await session(studio.port);
  try {
    const { tools } = (await c.call("tools/list")).result;
    const tool = tools.find((t) => t.name === "schedule_reel");
    assert.ok(tool, "schedule_reel is listed");
    assert.deepEqual(tool.inputSchema.required, ["slug", "network", "at"]);
    assert.deepEqual(tool.inputSchema.properties.network.enum, ["x", "tiktok", "gbp"]);
    assert.match(tool.description, /approved/i);
    const refused = await c.tool("schedule_reel", { slug: "view-1107", network: "x", at: "2026-11-16T19:00+09:00" });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /Refused.*"rendered".*not "approved"/);
    const unknown = await c.tool("schedule_reel", { slug: "ghost-1", network: "tiktok", at: "2026-11-16T19:00+09:00" });
    assert.equal(unknown.isError, true, "no review record: fail closed");
    const naive = await c.tool("schedule_reel", { slug: "fire-1107", network: "x", at: "2026-11-16T19:00" });
    assert.equal(naive.isError, true, "a time without its zone is refused");
    assert.ok(!studio.calls.some((x) => x.path === "/api/helper/schedule"), "nothing was sent to the helper");

    const ok = await c.tool("schedule_reel", { slug: "fire-1107", network: "gbp", at: "2026-11-13T12:00+09:00" });
    assert.equal(ok.isError, false, ok.content[0].text);
    const sent = studio.calls.find((x) => x.path === "/api/helper/schedule");
    assert.deepEqual(sent.body, { slug: "fire-1107", network: "gbp", at: "2026-11-13T12:00+09:00" });
    assert.match(ok.content[0].text, /helper-fire-1107-gbp/);
  } finally { await c.stop(); studio.server.close(); }
});

test("mcp: research tools are read-only, go through the studio, and cite their sources", async () => {
  const studio = await fakeStudio();
  const c = await session(studio.port);
  try {
    const { tools } = (await c.call("tools/list")).result;
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const name of ["research_ideas", "research_site_check", "research_page", "research_events", "research_links"]) {
      assert.ok(by[name], `missing tool ${name}`);
      assert.equal(by[name].annotations.readOnlyHint, true, `${name} is read-only`);
      assert.equal(by[name].annotations.destructiveHint, false);
      assert.equal(by[name].annotations.openWorldHint, true, `${name} reads the web`);
      assert.ok(by[name].description.length > 40);
    }
    assert.deepEqual(by.research_page.inputSchema.required, ["url"]);

    const ideas = await c.tool("research_ideas", { topic: "冬キャンプ", days: 14 });
    assert.equal(ideas.isError, false, ideas.content[0].text);
    assert.match(ideas.content[0].text, /^2 recent pages about 冬キャンプ\. \(from the 24 h cache\)/);
    assert.match(ideas.content[0].text, /Sources \(2\):\n- https:\/\/a\.example\/1\n- https:\/\/b\.example\/2/);
    const sent = studio.calls.find((x) => x.path === "/api/research/ideas");
    assert.deepEqual(sent.body, { topic: "冬キャンプ", days: 14 }, "only the arguments given, no undefined fields");
    assert.equal(sent.origin, `http://127.0.0.1:${studio.port}`, "POSTs carry the studio's own Origin");

    const check = await c.tool("research_site_check");
    assert.match(check.content[0].text, /Differs:\n- Field only: first adult per night: the website says ¥5,500; your copy says ¥5,200/);
    assert.match(check.content[0].text, /- https:\/\/tsumagoi\.kensaur\.us\/reserve/);
    for (const [name, args] of [["research_page", { url: "https://glamp.example/" }], ["research_events", { days: 30 }], ["research_links", {}]]) {
      const r = await c.tool(name, args);
      assert.equal(r.isError, false, `${name}: ${r.content[0].text}`);
      assert.match(r.content[0].text, /Sources \(1\):\n- https:\/\//, `${name} cites its source`);
    }
    const bad = await c.tool("research_page", { url: "ftp://nope" });
    assert.equal(bad.isError, true, "a bad address is a tool error the model can fix");
    assert.ok(!studio.calls.some((x) => /publish|posts\/plan/.test(x.path)), "research never posts or plans");
  } finally { await c.stop(); studio.server.close(); }
});

test("mcp: ai tools price first, refuse over the caps without spending, and never approve", async () => {
  const studio = await fakeStudio();
  const c = await session(studio.port);
  try {
    const { tools } = (await c.call("tools/list")).result;
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const name of ["ai_estimate", "ai_review", "ai_run"]) assert.ok(by[name] && by[name].description.length > 40, `missing tool ${name}`);
    assert.equal(by.ai_estimate.annotations.readOnlyHint, true);
    assert.equal(by.ai_review.annotations.readOnlyHint, true, "the reviewer only suggests");
    assert.equal(by.ai_run.annotations.readOnlyHint, false);
    assert.deepEqual(by.ai_run.inputSchema.required, ["slug", "tools"]);

    const est = await c.tool("ai_estimate", { slug: "day-1108", tools: ["music", "voice"], into: "day-1108-ai" });
    assert.equal(est.isError, false, est.content[0].text);
    assert.match(est.content[0].text, /^2 AI steps for day-1108-ai: \$0\.23\. Fits the limits\./);
    assert.deepEqual(studio.calls.find((x) => x.path === "/api/ai/estimate").body, { slug: "day-1108", tools: ["music", "voice"], options: { into: "day-1108-ai" } });

    const refused = await c.tool("ai_run", { slug: "pricey-1", tools: ["living", "music"] });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /^Refused, nothing spent: .*over its \$2\.00 AI limit/);
    const capped = await c.tool("ai_run", { slug: "day-1108", tools: ["music"], into: "day-1108-ai", max_usd: 0.1 });
    assert.equal(capped.isError, true);
    assert.match(capped.content[0].text, /more than max_usd/);
    assert.ok(!studio.calls.some((x) => x.path === "/api/ai/run"), "nothing was started");

    const ok = await c.tool("ai_run", { slug: "day-1108", tools: ["voice"], into: "day-1108-ai" });
    assert.equal(ok.isError, false, ok.content[0].text);
    assert.match(ok.content[0].text, /ai-day-1108-ai/);
    assert.match(ok.content[0].text, /label it when posting/);
    assert.deepEqual(studio.calls.find((x) => x.path === "/api/ai/run").body, { slug: "day-1108", tools: ["voice"], options: { into: "day-1108-ai" }, render: true });

    const rv = await c.tool("ai_review", { slug: "day-1108" });
    assert.equal(rv.isError, false, rv.content[0].text);
    assert.match(rv.content[0].text, /^Review of day-1108: hook 6\/10, look 8\/10, 1 caption mismatches, 0 unapproved claims\./);
    const last = await c.tool("ai_review", { slug: "day-1108", last_only: true });
    assert.match(last.content[0].text, /no review yet/);
    const bad = await c.tool("ai_run", { slug: "day-1108", tools: ["text-to-video"] });
    assert.equal(bad.isError, true, "only the studio's tools");
    assert.ok(!studio.calls.some((x) => /approve|publish|posts\/plan/.test(x.path)), "AI never approves or posts");
  } finally { await c.stop(); studio.server.close(); }
});

test("mcp: a studio that is not running gives a plain error that says how to start it", async () => {
  const c = await session(await closedPort());
  try {
    assert.ok(c.init.result, "initialize works without the studio");
    const r = await c.tool("studio_status");
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /not running.*npm run review/);
  } finally { await c.stop(); }
});

test("mcp: with STUDIO_API_TOKEN it sends the studio's token on every call, and none without", async () => {
  const fake = await fakeStudio();
  try {
    const withToken = await session(fake.port, { STUDIO_API_TOKEN: "t0k-123" });
    try { await withToken.tool("studio_status"); } finally { await withToken.stop(); }
    assert.ok(fake.calls.length > 0 && fake.calls.every((c) => c.auth === "Bearer t0k-123"), JSON.stringify(fake.calls.map((c) => c.auth)));
    fake.calls.length = 0;
    const plain = await session(fake.port, { STUDIO_API_TOKEN: "" });
    try { await plain.tool("studio_status"); } finally { await plain.stop(); }
    assert.ok(fake.calls.length > 0 && fake.calls.every((c) => c.auth === undefined));
  } finally { fake.server.close(); }
});
