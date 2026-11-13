#!/usr/bin/env node
// Generated from server/mcp.mjs by scripts/build-packages.mjs. Edit that file, then run the script.
/**
 * FILE: server/mcp.mjs
 * PURPOSE: An MCP (Model Context Protocol) server so AI agents (Claude Code, Claude Desktop, Cursor)
 *          can drive Lazycow Studio: check it, list reels, start renders, watch jobs, plan and
 *          publish approved reels, switch projects and read the log; and research (ideas, a website
 *          check against the approved facts, a page read, local events, a link check), read-only; and AI assist
 *          (ai_estimate, ai_review, ai_run: priced first, inside the studio's caps, docs/ai-api.md); and performance
 *          (perf_summary, perf_suggest: read-only, docs/perf-api.md).
 * OVERVIEW: Zero dependencies. Speaks newline-delimited JSON-RPC 2.0 over stdio. It is a thin
 *           client of the studio's own HTTP API (server/review.mjs on 127.0.0.1:STUDIO_PORT,
 *           default 4317): every tool is one or a few HTTP calls, so the studio stays the one
 *           place that decides anything. Dual-era MCP: answers the legacy `initialize`
 *           handshake (2025-11-25 and earlier) and modern per-request `_meta` versions
 *           (2026-07-28, with `server/discover`).
 * DEPENDENCIES: node:http, node:readline (Node >= 20)
 * USAGE: npm run mcp (an MCP client starts it; see docs/mcp.md), with the studio running (npm run review).
 * NOTES: stdout carries only MCP messages; anything else goes to stderr. Approving a reel stays a
 *        person's job in the studio: there is no approve tool, and publish_reel refuses any reel
 *        whose review status is not "approved". Account secrets never leave the studio; the
 *        account list is scrubbed again here in case a field ever carries one.
 */
import { request } from "node:http";
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/* stdout is the protocol channel: a stray console.log would corrupt it. */
console.log = (...a) => console.error(...a);
console.info = (...a) => console.error(...a);

/* Where the studio is: its .env says its port and its optional API token. Run from the studio's folder (npm run mcp),
   that is ../.env; installed from npm (npx @lazycow/mcp), it is LAZYCOW_DIR's .env, else the folder the double-click
   setup recorded (installed.json). So a Claude or Cursor config never has to hold a copy of the token. */
function studioEnv() {
  const dirs = [fileURLToPath(new URL("..", import.meta.url))];
  if (process.env.LAZYCOW_DIR) dirs.unshift(process.env.LAZYCOW_DIR);
  const home = process.platform === "win32" ? join(process.env.LOCALAPPDATA || "", "Lazycow")
    : process.platform === "darwin" ? join(homedir(), "Library", "Application Support", "Lazycow") : join(homedir(), ".local", "share", "lazycow");
  try { const root = JSON.parse(readFileSync(join(home, "installed.json"), "utf8")).root; if (root) dirs.push(root); } catch { /* not installed that way */ }
  for (const d of dirs) {
    try { return readFileSync(join(d, ".env"), "utf8"); } catch { /* next */ }
  }
  return "";
}
const ENV_TEXT = studioEnv();
const fromEnv = (key) => (new RegExp(`^${key}\\s*=\\s*["']?([^"'\\r\\n]*)`, "m").exec(ENV_TEXT)?.[1] || "").trim();
const PORT_RAW = process.env.STUDIO_PORT || fromEnv("STUDIO_PORT");
const PORT = /^\d{4,5}$/.test(PORT_RAW) ? Number(PORT_RAW) : 4317;
const BASE = `http://127.0.0.1:${PORT}`;
/* The studio's optional API token (server/trust.mjs): this process's STUDIO_API_TOKEN, else the studio's .env. Empty =
   the studio asks for none. */
const TOKEN = (process.env.STUDIO_API_TOKEN || fromEnv("STUDIO_API_TOKEN")).trim();
let VERSION = "0.0.0";
try { VERSION = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")).version || VERSION; } catch { /* optional */ }
const SERVER_INFO = { name: "lazycow-studio", title: "Lazycow Studio", version: VERSION };

/* Protocol versions. Modern ones carry the version on every request; legacy ones negotiate it once in initialize. */
const MODERN = ["2026-07-28"];
const LEGACY = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const META_VERSION = "io.modelcontextprotocol/protocolVersion";

const INSTRUCTIONS = [
  "Lazycow Studio makes short vertical videos (reels) from the owner's footage on this computer.",
  "Flow: make_reels (or make_reel) renders drafts -> a person reviews and approves them in the studio -> plan_post or publish_reel.",
  "Renders and uploads are background jobs: poll job_status with the slug the tool returns.",
  "Only reels whose review status is \"approved\" can be published; approving is done by a person in the studio, never by an agent.",
  "research_* tools read the web through the studio (Firecrawl) and return suggestions with their source URLs; they never post, and their words are not approved copy.",
  "ai_* tools spend money (fal.ai, OpenRouter) only inside the studio's AI limits: call ai_estimate first; ai_run refuses over a limit and never changes an approved reel (use into: a new slug); ai_review only suggests.",
  "perf_summary and perf_suggest are read-only: how posted reels did per network and what to try next; suggestions only steer how drafts are made.",
  `The studio must be running (npm run review in the studio folder) at ${BASE}.`,
].join(" ");

/* ---------- the studio's HTTP API ---------- */
class ToolError extends Error {}
const NOT_RUNNING = `Lazycow Studio is not running at ${BASE}. Start it with \`npm run review\` in the studio folder, wait until it prints its address, then try again.`;

/** One call to the studio. Resolves with parsed JSON (or text); rejects with a plain-English ToolError. */
function studio(method, path, payload, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const data = payload === undefined ? null : Buffer.from(JSON.stringify(payload), "utf8");
    const headers = { accept: "application/json" };
    if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
    if (method !== "GET") {
      // The studio answers a POST only from its own origin (fromStudio in review.mjs).
      headers.origin = BASE;
      headers["content-type"] = "application/json";
      headers["content-length"] = data ? data.length : 0;
    }
    const req = request(`${BASE}${path}`, { method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let body = text;
        if (/json/.test(res.headers["content-type"] || "")) { try { body = JSON.parse(text); } catch { /* keep text */ } }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(body);
        const why = (body && typeof body === "object" && body.error) || String(text || "").trim().slice(0, 500) || `HTTP ${res.statusCode}`;
        if (res.statusCode === 401) return reject(new ToolError(`The studio at ${BASE} asks for its API token (${why}). Set STUDIO_API_TOKEN in this MCP server's env, or in the studio's .env.`));
        if (res.statusCode === 403) return reject(new ToolError(`The studio at ${BASE} refused the request (${why}). Is STUDIO_PORT the port the studio prints when it starts?`));
        reject(new ToolError(`The studio said: ${why} (HTTP ${res.statusCode} on ${method} ${path})`));
      });
      res.on("error", (err) => reject(new ToolError(`The studio's answer was cut off: ${err.message}`)));
    });
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error("timeout"), { code: "STUDIO_TIMEOUT" })));
    req.on("error", (err) => {
      if (["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENOTFOUND"].includes(err.code)) return reject(new ToolError(NOT_RUNNING));
      if (err.code === "STUDIO_TIMEOUT") return reject(new ToolError(`The studio did not answer ${method} ${path} within ${Math.round(timeoutMs / 1000)} s. It may be busy loading; try again shortly.`));
      reject(new ToolError(`Could not talk to the studio: ${err.message}`));
    });
    if (data) req.write(data);
    req.end();
  });
}

/* ---------- small helpers ---------- */
// Never a leading "-": the studio passes slugs and networks to Python's command line (server/trust.mjs).
const SLUG = "^[a-z0-9][a-z0-9-]*$";
const NETWORK = "^[a-z][a-z-]*$";
const TIME = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}([+-]\\d{2}:\\d{2})?$";
const DATE = "^\\d{4}-\\d{2}-\\d{2}$";
const MAX_TEXT = 60_000;
const bare = (slug) => (slug.startsWith("story-") ? slug.slice(6) : slug);
const pretty = (x) => JSON.stringify(x, null, 2);
function reply(lead, data) {
  let text = data === undefined ? lead : `${lead}\n\n${pretty(data)}`;
  if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT) + `\n\n[cut at ${MAX_TEXT} characters: ask for fewer rows]`;
  // The same data as structuredContent (MCP 2025-06-18), so a program can read it without parsing the text. It must be
  // an object: a list goes in { items }. Only data the text already shows: nothing new leaves the studio.
  const structured = Array.isArray(data) ? { items: data } : data && typeof data === "object" ? data : undefined;
  return { text, structured };
}
/* Keys that would hold a credential. Booleans (e.g. a field descriptor's "secret": true) are kept. */
const SECRET_KEY = /(token|secret|password|passwd|cookie|credential|bearer|api[_-]?key|private[_-]?key|refresh|session)/i;
function scrub(x) {
  if (Array.isArray(x)) return x.map(scrub);
  if (!x || typeof x !== "object") return x;
  const out = {};
  for (const [k, v] of Object.entries(x)) {
    if (SECRET_KEY.test(k) && typeof v !== "boolean") continue;
    out[k] = scrub(v);
  }
  return out;
}
function jobLine(job) {
  if (!job || job.status === "none") return "no job";
  const eta = job.eta ? `, about ${Math.max(1, Math.round(job.eta / 60))} min left` : "";
  const pos = job.position ? `, number ${job.position} in the queue` : "";
  return `${job.status} (${job.pct ?? 0}%: ${job.label || ""}${pos}${eta})`;
}
const slimJob = (j) => (j && j.status !== "none" ? { status: j.status, kind: j.kind, pct: j.pct, label: j.label, position: j.position, eta: j.eta } : null);
function slimReel(r) {
  return {
    slug: r.slug, title: r.title, theme: r.theme, status: r.status, house: !!r.house, rendered: !!r.rendered,
    seconds: r.seconds, clips: r.clips, faces: r.faces, consent: r.consent, blurFaces: r.blurFaces,
    music: r.music, channels: r.channels, notes: r.notes || undefined,
    updated: r.updated ? new Date(r.updated * 1000).toISOString() : null, job: slimJob(r.job),
  };
}
/** The review row for a reel: drafts are stored as "story-<slug>" (older ones under the bare slug). */
async function draftRow(slug) {
  const rows = await studio("GET", "/api/drafts");
  if (!Array.isArray(rows)) return null;
  const b = bare(slug);
  return rows.find((r) => r.slug === `story-${b}`) || rows.find((r) => r.slug === b) || null;
}
/** One research call through the studio (POST /api/research/<action>). Web reads take up to ~2 minutes. */
function research(action, args) {
  const payload = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
  return studio("POST", `/api/research/${action}`, payload, { timeoutMs: 170_000 });
}
const AI_TOOLS = ["review", "sharpen", "slowmo", "living", "foley", "behind", "music", "voice"];
/** {slug, tools, options: {into}} for /api/ai/estimate and /api/ai/run. */
const aiBody = (a) => ({ slug: a.slug, tools: a.tools, ...(a.into ? { options: { into: a.into } } : {}) });
/** The research summary, then every source URL (each answer cites where it came from). */
function withSources(r, extra = "") {
  const src = Array.isArray(r.sources) ? r.sources : [];
  return `${r.summary || ""}${extra}${r.cached ? " (from the 24 h cache)" : ""}\n\nSources (${src.length}):\n${src.map((u) => `- ${u}`).join("\n") || "- none"}`;
}

/* ---------- tools ---------- */
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
/* Research reads the open web (openWorld) but changes nothing and posts nothing. */
const RO_WEB = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const LOCAL_WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const noArgs = { type: "object", properties: {}, additionalProperties: false };

const TOOLS = [
  {
    name: "studio_status",
    title: "Studio status",
    description: "Check that Lazycow Studio is running and healthy: version, which project is open, whether this computer can render (with a fix for each problem), and what the render queue is doing. Call this first if anything else fails.",
    inputSchema: noArgs,
    annotations: { title: "Studio status", ...RO },
    async run() {
      const [health, about, config] = await Promise.all([studio("GET", "/api/health"), studio("GET", "/api/about"), studio("GET", "/api/config").catch(() => ({}))]);
      const q = health.queue || {};
      const lead = `${about.name || "Lazycow Studio"} ${health.version || about.version || ""} is running at ${BASE}` +
        `${config.workspace ? ` (project: ${config.workspace})` : ""}. Machine: ${health.verdict || "unknown"}. ` +
        `Render queue: ${q.running ? `rendering ${q.running}` : "idle"}, ${q.queued || 0} waiting.` +
        (health.stale ? " The studio's code changed on disk since it started: restart it to pick that up." : "");
      return reply(lead, { version: health.version, build: health.build, stale: health.stale, started: health.started, queue: health.queue,
        verdict: health.verdict, service: health.service, checks: health.checks, machine: health.machine, workspace: config.workspace, audienceTz: config.audienceTz });
    },
  },
  {
    name: "list_reels",
    title: "List reels",
    description: "List the reels in the open project, newest first, with their review status (draft = not made yet, rendered = waiting for a person to review, approved = ready to post, rejected, reroll = asked to be remade), length, music, faces/consent and any render job in progress. Filter by status or theme.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["any", "draft", "rendered", "approved", "rejected", "reroll", "making"], default: "any", description: "Only reels in this review status. \"making\" = a render is queued or running." },
        theme: { type: "string", description: "Only reels of this theme (see list_themes)." },
        include_house: { type: "boolean", default: false, description: "Also list the built-in house reels (view, fire, field, winter)." },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
      },
      additionalProperties: false,
    },
    annotations: { title: "List reels", ...RO },
    async run(a) {
      const o = await studio("GET", "/api/overview");
      let reels = (o.reels || []).filter((r) => a.include_house || !r.house);
      const counts = {};
      for (const r of reels) counts[r.status] = (counts[r.status] || 0) + 1;
      const status = a.status || "any";
      if (status === "making") reels = reels.filter((r) => ["queued", "running"].includes(r.job?.status));
      else if (status !== "any") reels = reels.filter((r) => r.status === status);
      if (a.theme) reels = reels.filter((r) => r.theme === a.theme);
      const total = reels.length;
      const rows = reels.slice(0, a.limit || 50).map(slimReel);
      const tally = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ") || "none";
      return reply(`${total} reel${total === 1 ? "" : "s"} match${rows.length < total ? ` (showing ${rows.length})` : ""}. All reels by status: ${tally}.`, rows);
    },
  },
  {
    name: "reel_details",
    title: "Reel details",
    description: "Everything about one reel: title, review status and notes, every shot (file, timing, role), music and sound, the files prepared for each network, and its current render job.",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string", pattern: SLUG, description: "The reel's slug, e.g. \"fire-1107\" (from list_reels)." } },
      required: ["slug"],
      additionalProperties: false,
    },
    annotations: { title: "Reel details", ...RO },
    async run(a) {
      const slug = bare(a.slug);
      const [o, job, draft] = await Promise.all([studio("GET", "/api/overview"), studio("GET", `/api/job?slug=${encodeURIComponent(slug)}`), draftRow(slug)]);
      const row = (o.reels || []).find((r) => r.slug === slug);
      let manifest = null;
      try { manifest = await studio("GET", `/api/reel?slug=${encodeURIComponent(slug)}`); } catch (err) { if (!row) throw err; }
      if (!row && !manifest) throw new ToolError(`No reel called ${slug}. list_reels shows the slugs.`);
      const status = draft?.status || row?.status || (manifest ? "rendered" : "draft");
      const lead = `${slug}: ${status}${row?.title ? ` (${row.title})` : ""}. Job: ${jobLine(job)}.${manifest ? "" : " Not rendered yet, so there is no manifest."}`;
      return reply(lead, { overview: row ? slimReel(row) : null, review: draft ? { status: draft.status, faces: draft.faces, consent: !!draft.consent, notes: draft.notes } : null,
        job: slimJob(job), manifest });
    },
  },
  {
    name: "list_themes",
    title: "List themes",
    description: "The themes the studio can make a reel for (each is one story with a number of shot slots). Use a theme key with make_reels or make_reel.",
    inputSchema: noArgs,
    annotations: { title: "List themes", ...RO },
    async run() {
      const themes = await studio("GET", "/api/themes");
      const keys = Object.keys(themes || {});
      if (!keys.length) return reply("This project has no themes yet. A person adds one in the studio: Reels › Make reels › New theme.", {});
      return reply(`${keys.length} theme${keys.length === 1 ? "" : "s"}: ${keys.join(", ")}.`, themes);
    },
  },
  {
    name: "make_reels",
    title: "Make reels (autopilot)",
    description: "Start making new reels: one per theme from the newest footage (clips picked by the studio, approved words, licence-clean music), each queued to render one after another. Returns the new slugs; follow each with job_status. Rendering takes minutes per reel. The new reels still need a person's review and approval in the studio before they can be published.",
    inputSchema: {
      type: "object",
      properties: {
        themes: { type: "array", items: { type: "string" }, description: "Theme keys from list_themes. Leave out for every theme." },
        since: { type: "string", pattern: DATE, description: "Use footage shot on or after this date (YYYY-MM-DD). Default: the last 60 days." },
        faces: { type: "boolean", default: false, description: "Allow clips with faces (they then need consent or Blur faces before approval)." },
        cut: { type: "string", enum: ["short", "long"], default: "short", description: "short = the looping reel; long = a 40-60 s explainer for LinkedIn and Facebook." },
        vary: { type: "boolean", default: true, description: "Give each reel a different text layout and effects." },
      },
      additionalProperties: false,
    },
    annotations: { title: "Make reels (autopilot)", ...LOCAL_WRITE },
    async run(a) {
      const r = await studio("POST", "/api/autopilot", { themes: a.themes || [], since: a.since || null, faces: !!a.faces, cut: a.cut || "short", vary: a.vary !== false }, { timeoutMs: 600_000 });
      const made = r.made || [];
      if (!made.length) return reply("No reels were made: no theme matched, or there was no usable footage in that window. Try list_themes, or an earlier since date.");
      return reply(`Queued ${made.length} reel${made.length === 1 ? "" : "s"} to render: ${made.map((m) => m.slug).join(", ")}. Check progress with job_status.`, made);
    },
  },
  {
    name: "make_reel",
    title: "Make one reel",
    description: "Make one reel for a theme under a slug you choose, from the tagged footage, and queue it to render. Use make_reels to make one per theme automatically.",
    inputSchema: {
      type: "object",
      properties: {
        theme: { type: "string", description: "Theme key from list_themes." },
        slug: { type: "string", pattern: SLUG, description: "A new name: lowercase letters, digits and dashes, e.g. \"fire-1108\"." },
        faces: { type: "boolean", default: false, description: "Allow clips with faces." },
        since: { type: "string", pattern: DATE, description: "Use footage shot on or after this date (YYYY-MM-DD)." },
      },
      required: ["theme", "slug"],
      additionalProperties: false,
    },
    annotations: { title: "Make one reel", ...LOCAL_WRITE },
    async run(a) {
      const r = await studio("POST", "/api/assemble", { theme: a.theme, slug: a.slug, faces: !!a.faces, since: a.since || null }, { timeoutMs: 600_000 });
      return reply(`Made ${a.slug} and queued it to render (${r.job?.status || "queued"}). Check progress with job_status slug=${a.slug}.`, { slug: a.slug, theme: a.theme, clips: r.project?.shots?.length, job: r.job });
    },
  },
  {
    name: "remix_reel",
    title: "Remix a reel's sound",
    description: "Re-render only the sound of a reel (music and effects mix), keeping the picture. Queued behind any running render; follow it with job_status.",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string", pattern: SLUG, description: "The reel's slug." } },
      required: ["slug"],
      additionalProperties: false,
    },
    annotations: { title: "Remix a reel's sound", ...LOCAL_WRITE },
    async run(a) {
      const slug = bare(a.slug);
      const job = await studio("POST", "/api/remix", { slug });
      return reply(`Sound remix for ${slug}: ${jobLine(job)}.`, slimJob(job));
    },
  },
  {
    name: "job_status",
    title: "Job status",
    description: "Progress of background jobs. With a slug: that job (a render or remix uses the reel slug; a post uses \"post-<slug>-<network>\"; a YouTube upload uses the reel slug; footage scans use \"footage\"). Without a slug: every render that is queued or running.",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string", pattern: SLUG, description: "Job key; leave out to list active renders." } },
      additionalProperties: false,
    },
    annotations: { title: "Job status", ...RO },
    async run(a) {
      if (a.slug) {
        const job = await studio("GET", `/api/job?slug=${encodeURIComponent(a.slug)}`);
        if (!job || job.status === "none") return reply(`No job for ${a.slug} since the studio last started. Finished jobs are in read_log.`);
        return reply(`${a.slug}: ${jobLine(job)}.`, job);
      }
      const [health, o] = await Promise.all([studio("GET", "/api/health"), studio("GET", "/api/overview")]);
      const active = (o.reels || []).filter((r) => ["queued", "running"].includes(r.job?.status)).map((r) => ({ slug: r.slug, ...slimJob(r.job) }));
      const q = health.queue || {};
      return reply(active.length ? `${active.length} render${active.length === 1 ? "" : "s"} active (${q.running ? `${q.running} running` : "none running"}, ${q.queued || 0} waiting).` : "Nothing is rendering.", active);
    },
  },
  {
    name: "cancel_job",
    title: "Stop a render",
    description: "Stop a queued or running render or sound remix. A stopped render may leave half-made files: render the reel again before anyone approves it. Uploads, posts and footage scans cannot be stopped.",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string", pattern: SLUG, description: "The reel slug of the render to stop." } },
      required: ["slug"],
      additionalProperties: false,
    },
    annotations: { title: "Stop a render", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async run(a) {
      const job = await studio("POST", "/api/job/cancel", { slug: a.slug });
      return reply(`${a.slug}: ${jobLine(job)}.`, slimJob(job));
    },
  },
  {
    name: "list_posts",
    title: "List posts",
    description: "The posting log: every planned reminder, queued, scheduled, posted, failed or dropped post, newest first, with network, time and link. Filter by reel, network or status.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", pattern: SLUG, description: "Only posts of this reel." },
        network: { type: "string", pattern: NETWORK, description: "Only this network, e.g. youtube, bluesky, facebook, instagram." },
        status: { type: "string", description: "Only this status, e.g. planned, queued, scheduled, posted, failed, dropped." },
        limit: { type: "integer", minimum: 1, maximum: 500, default: 50 },
      },
      additionalProperties: false,
    },
    annotations: { title: "List posts", ...RO },
    async run(a) {
      let rows = await studio("GET", "/api/posts");
      if (!Array.isArray(rows)) rows = [];
      if (a.slug) rows = rows.filter((r) => r.slug === bare(a.slug));
      if (a.network) rows = rows.filter((r) => r.network === a.network);
      if (a.status) rows = rows.filter((r) => r.status === a.status);
      const total = rows.length;
      rows = rows.slice(0, a.limit || 50);
      return reply(`${total} post${total === 1 ? "" : "s"} match${rows.length < total ? ` (showing ${rows.length})` : ""}.`, scrub(rows));
    },
  },
  {
    name: "plan_post",
    title: "Plan a post",
    description: "Add a reminder to the posting log: post this reel on this network at this time. Nothing is posted; a person (or publish_reel later) does the posting. Times are in the audience's time zone unless an offset is given.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", pattern: SLUG, description: "The reel's slug." },
        network: { type: "string", pattern: NETWORK, description: "e.g. youtube, instagram, tiktok, facebook, bluesky, x, linkedin, threads." },
        at: { type: "string", pattern: TIME, description: "When: YYYY-MM-DDTHH:MM, optionally with +HH:MM, e.g. 2026-11-09T19:00+09:00." },
      },
      required: ["slug", "network", "at"],
      additionalProperties: false,
    },
    annotations: { title: "Plan a post", ...LOCAL_WRITE },
    async run(a) {
      const slug = bare(a.slug);
      const draft = await draftRow(slug).catch(() => null);
      const r = await studio("POST", "/api/posts/plan", { slug, network: a.network, at: a.at });
      const warn = draft?.status === "approved" ? "" : ` Note: ${slug} is not approved yet (status: ${draft?.status || "unknown"}); it must be approved in the studio before it can be published.`;
      return reply(`Planned ${slug} on ${a.network} at ${a.at} (post id ${r.id}).${warn}`, { id: r.id });
    },
  },
  {
    name: "list_accounts",
    title: "List accounts",
    description: "Which networks are switched on for this project and under which account name, which networks the studio can post to by itself and whether each is connected, and the YouTube connection. Never returns passwords, tokens or keys.",
    inputSchema: noArgs,
    annotations: { title: "List accounts", ...RO },
    async run() {
      const [conn, chans, yt] = await Promise.allSettled([studio("GET", "/api/connections"), studio("GET", "/api/channels"), studio("GET", "/api/youtube")]);
      if (chans.status === "rejected" && /not running/.test(chans.reason?.message || "")) throw chans.reason;
      const direct = conn.status === "fulfilled"
        ? Object.fromEntries(Object.entries(conn.value || {}).map(([id, c]) => [id, { name: c.name, connected: !!c.connected, account: c.account || null, canSchedule: !!c.canSchedule, error: c.error || null }]))
        : { error: conn.reason?.message };
      const networks = chans.status === "fulfilled"
        ? (chans.value.channels || []).map((c) => ({ id: c.id, name: c.name, on: !c.off, account: c.account || null, who: c.who || null }))
        : { error: chans.reason?.message };
      const youtube = yt.status === "fulfilled" ? { connected: !!yt.value.connected, channel: yt.value.channel || null, app: !!yt.value.app, error: yt.value.error || null } : { error: yt.reason?.message };
      const on = Array.isArray(networks) ? networks.filter((n) => n.on).map((n) => n.id) : [];
      const self = Object.entries(direct).filter(([, c]) => c && c.connected).map(([id]) => id);
      if (youtube.connected) self.push("youtube");
      return reply(`Networks on: ${on.join(", ") || "none"}. The studio can post by itself to: ${self.join(", ") || "none connected"}.`, scrub({ networks, direct, youtube }));
    },
  },
  {
    name: "publish_reel",
    title: "Publish a reel",
    description: "Post an APPROVED reel to a network now, or schedule it with `at`. Only reels a person has approved in the studio can be published: this tool checks the review status first and refuses anything that is not \"approved\". Networks the studio posts to itself: youtube (or youtube-shorts), and any connected network in list_accounts (e.g. bluesky, facebook). Runs as a background job; follow it with job_status.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", pattern: SLUG, description: "The approved reel's slug." },
        network: { type: "string", pattern: NETWORK, description: "youtube, bluesky, facebook, … (see list_accounts)." },
        at: { type: "string", pattern: TIME, description: "Schedule for this time (YYYY-MM-DDTHH:MM, optionally +HH:MM). Leave out to post now." },
        privacy: { type: "string", enum: ["private", "unlisted", "public"], description: "YouTube only. Default private; a scheduled upload stays private until its time." },
        post_id: { type: "integer", description: "Optional: the id of a planned post from list_posts that this post fulfils." },
      },
      required: ["slug", "network"],
      additionalProperties: false,
    },
    annotations: { title: "Publish a reel", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async run(a) {
      const slug = bare(a.slug);
      const draft = await draftRow(slug);
      if (!draft) throw new ToolError(`Refused: no review record for ${slug}, so it cannot be confirmed as approved. Only approved reels can be published; check the slug with list_reels.`);
      if (draft.status !== "approved") {
        throw new ToolError(`Refused: ${slug} is "${draft.status}", not "approved". Only reels a person has approved in the studio can be published. Ask the owner to review and approve it in the studio first.`);
      }
      if (a.network === "youtube" || a.network === "youtube-shorts") {
        const job = await studio("POST", "/api/youtube/upload", { slug, at: a.at || undefined, privacy: a.privacy || "private" });
        return reply(`YouTube upload of ${slug} started${a.at ? `, scheduled for ${a.at}` : ""} (${a.privacy || "private"}): ${jobLine(job)}. Follow it with job_status slug=${slug}.`, slimJob(job));
      }
      if (a.privacy) throw new ToolError("privacy applies to YouTube only; leave it out for other networks.");
      const job = await studio("POST", "/api/publish", { slug, network: a.network, at: a.at || undefined, id: Number.isInteger(a.post_id) ? a.post_id : undefined });
      const key = `post-${slug}-${a.network}`;
      return reply(`Posting ${slug} to ${a.network}${a.at ? ` for ${a.at}` : " now"}: ${jobLine(job)}. Follow it with job_status slug=${key}; the result lands in list_posts.`, { job: key, ...slimJob(job) });
    },
  },
  {
    name: "schedule_reel",
    title: "Schedule a reel (browser helper)",
    description: "Schedule an APPROVED reel on X, TikTok or Google Maps (gbp) through the studio's browser helper, which has no API: it attaches the reel's file, writes its approved text, sets the date and time, checks what the site shows, presses Schedule, and records the post as scheduled in the posting log with a proof link. Refuses any reel whose review status is not \"approved\", a second copy of the same reel on the same network at the same time, and times outside the site's window. Runs as a background helper job, one at a time; follow it with job_status slug=helper-<slug>-<network>. If the helper window is not signed in to the site, the job ends asking the owner to sign in once (Accounts in the studio).",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", pattern: SLUG, description: "The approved reel's slug." },
        network: { type: "string", enum: ["x", "tiktok", "gbp"], description: "x, tiktok or gbp (Google Maps / Business Profile)." },
        at: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}[+-]\\d{2}:\\d{2}$", description: "When, with its zone: e.g. 2026-11-16T19:00+09:00 (19:00 JST). The helper converts it to the browser's clock." },
        rehearse: { type: "boolean", description: "Do every step but the final press (nothing is scheduled or logged)." },
      },
      required: ["slug", "network", "at"],
      additionalProperties: false,
    },
    annotations: { title: "Schedule a reel (browser helper)", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async run(a) {
      const slug = bare(a.slug);
      const draft = await draftRow(slug);
      if (!draft) throw new ToolError(`Refused: no review record for ${slug}, so it cannot be confirmed as approved. Only approved reels can be scheduled; check the slug with list_reels.`);
      if (draft.status !== "approved") {
        throw new ToolError(`Refused: ${slug} is "${draft.status}", not "approved". Only reels a person has approved in the studio can be scheduled. Ask the owner to review and approve it in the studio first.`);
      }
      const job = await studio("POST", "/api/helper/schedule", { slug, network: a.network, at: a.at, ...(a.rehearse ? { rehearse: true } : {}) });
      const key = `helper-${slug}-${a.network}`;
      return reply(`${a.rehearse ? "Rehearsing" : "Scheduling"} ${slug} on ${a.network} for ${a.at}: ${jobLine(job)}. Follow it with job_status slug=${key}; once scheduled it is in list_posts.`, { job: key, ...slimJob(job) });
    },
  },
  {
    name: "list_projects",
    title: "List projects",
    description: "The studio's projects (one per brand or account: its own reels, posts and logins) and which one is open.",
    inputSchema: noArgs,
    annotations: { title: "List projects", ...RO },
    async run() {
      const w = await studio("GET", "/api/workspaces");
      const list = (w.list || []).map((p) => ({ id: p.id, name: p.name, main: !!p.main, open: p.id === w.running, footage: p.source || null }));
      const open = list.find((p) => p.open);
      return reply(`${list.length} project${list.length === 1 ? "" : "s"}; open: ${open ? `${open.name} (${open.id})` : w.running}.`, list);
    },
  },
  {
    name: "switch_project",
    title: "Switch project",
    description: "Open another project. The studio restarts on that project's folders (a few seconds); it refuses while any job is still running. Every later tool call works on the new project.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", pattern: "^[a-z0-9-]+$", description: "Project id from list_projects (\"main\" is the first one)." } },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { title: "Switch project", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async run(a) {
      const before = await studio("GET", "/api/workspaces");
      if (before.running === a.id) return reply(`${a.id} is already open.`);
      await studio("POST", "/api/workspaces/switch", { id: a.id });
      // The studio hands its port to a fresh copy of itself: wait for that copy to answer.
      const until = Date.now() + 30_000;
      while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, 750));
        try {
          const w = await studio("GET", "/api/workspaces", undefined, { timeoutMs: 3_000 });
          if (w.running === a.id) return reply(`Switched to ${a.id}. The studio restarted on it.`);
        } catch { /* restarting */ }
      }
      return reply(`Asked the studio to switch to ${a.id}, but it has not come back within 30 s. Check studio_status; if it stays down, start it again with \`npm run review\`.`);
    },
  },
  {
    name: "read_log",
    title: "Read the log",
    description: "The studio's activity log, newest first: finished jobs (renders, remixes, uploads, posts, footage scans, with how long they took and the last line on failure), paid AI spend, how each reel was assembled, or YouTube quota use.",
    inputSchema: {
      type: "object",
      properties: {
        section: { type: "string", enum: ["jobs", "spend", "reels", "youtube", "all"], default: "jobs" },
        lines: { type: "integer", minimum: 1, maximum: 200, default: 20, description: "How many of the newest rows to return." },
        failed_only: { type: "boolean", default: false, description: "jobs only: just the jobs that ended in an error." },
      },
      additionalProperties: false,
    },
    annotations: { title: "Read the log", ...RO },
    async run(a) {
      const log = await studio("GET", "/api/log");
      const n = a.lines || 20;
      const section = a.section || "jobs";
      let jobs = Array.isArray(log.jobs) ? log.jobs : [];
      if (a.failed_only) jobs = jobs.filter((j) => j.status === "error");
      const spend = log.spend ? { total: log.spend.total, today: log.spend.today, budget: log.spend.budget, byPurpose: log.spend.byPurpose, rows: (log.spend.rows || []).slice(0, n) } : null;
      const reels = (log.reels || []).slice(0, n).map((r) => ({ slug: r.slug, theme: r.theme, title: r.title, madeBy: r.madeBy, madeAt: r.madeAt, music: r.music, words: r.words }));
      const parts = { jobs: jobs.slice(0, n), spend, reels, youtube: log.youtube || null };
      if (section === "all") return reply(`The newest ${n} rows of each log section.`, scrub(parts));
      const lead = { jobs: `The newest ${Math.min(n, jobs.length)} of ${jobs.length} finished jobs${a.failed_only ? " that failed" : ""}.`,
        spend: `Paid AI spend: ${spend?.total ?? 0} USD in all, ${spend?.today ?? 0} today.`, reels: `How the newest ${reels.length} reels were made.`, youtube: "YouTube quota use." }[section];
      return reply(lead, scrub(parts[section]));
    },
  },
  /* ---------- research (Firecrawl through the studio): read the web, never post ---------- */
  {
    name: "research_ideas",
    title: "Research: ideas and trends",
    description: "Search recent web pages and news (Japanese and English) about a topic (default: the open project's name and home place) and return the pages with their URLs, frequent hashtags and keywords, and 3-5 suggested post angles, each citing the pages it came from. Read-only: suggestions for a person, never post copy, never posted. Uses Firecrawl credits (cached 24 h).",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "A few words to search for. Leave out for the project's default topic." },
        days: { type: "integer", minimum: 1, maximum: 365, default: 30, description: "How far back to look." },
        fresh: { type: "boolean", default: false, description: "Skip the 24 h cache (spends credits again)." },
      },
      additionalProperties: false,
    },
    annotations: { title: "Research: ideas and trends", ...RO_WEB },
    async run(a) {
      const r = await research("ideas", { topic: a.topic, days: a.days, fresh: a.fresh || undefined });
      return reply(withSources(r), { angles: r.angles, hashtags: r.hashtags, keywords: r.keywords, items: r.items, note: r.note, cached: r.cached, cost: r.cost });
    },
  },
  {
    name: "research_site_check",
    title: "Research: check the website against our facts",
    description: "Read the brand website (the project's profile link and its booking page) and compare its prices, key facts, inclusions and booking link with the facts the studio's approved copy uses. Returns each fact as match, mismatch, not on the site or only on the site, in plain words (e.g. \"the website says ¥5,500; your copy says ¥5,200\"). Read-only: it changes no copy and posts nothing.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", pattern: "^https?://", description: "Another page to check instead of the brand website (optional)." },
        fresh: { type: "boolean", default: false, description: "Skip the 24 h cache (spends credits again)." },
      },
      additionalProperties: false,
    },
    annotations: { title: "Research: website check", ...RO_WEB },
    async run(a) {
      const r = await research("site-check", { url: a.url, fresh: a.fresh || undefined });
      const differs = Array.isArray(r.mismatches) && r.mismatches.length ? `\nDiffers:\n- ${r.mismatches.join("\n- ")}` : "";
      const facts = (r.facts || []).map((f) => ({ fact: f.fact, status: f.status, message: f.message, source: f.source }));
      return reply(withSources(r, differs), { facts, inclusions: r.inclusions, booking: r.booking, cached: r.cached, cost: r.cost });
    },
  },
  {
    name: "research_page",
    title: "Research: read a page",
    description: "Read one public web page (a competitor, an inspiration) and return its summary, key selling points, amenities, prices it states, and what it says that the studio's approved facts do not. Read-only; their words are for ideas, never to be copied into a post. X and LinkedIn pages are refused (Firecrawl bills them through paid providers).",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", pattern: "^https?://", description: "The page's address." },
        fresh: { type: "boolean", default: false, description: "Skip the 24 h cache (spends credits again)." },
      },
      required: ["url"],
      additionalProperties: false,
    },
    annotations: { title: "Research: read a page", ...RO_WEB },
    async run(a) {
      const r = await research("page", { url: a.url, fresh: a.fresh || undefined });
      return reply(withSources(r), { title: r.title, sellingPoints: r.sellingPoints, amenities: r.amenities, prices: r.prices, theySayWeDont: r.theySayWeDont, note: r.note, cached: r.cached, cost: r.cost });
    },
  },
  {
    name: "research_events",
    title: "Research: local events",
    description: "Find upcoming events near the open project's home place (Settings › Keys & AI › This project) in the next N days, with their dates and a suggested post-by date, as ideas for when to post. Dates come from search text: confirm on the event page. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "integer", minimum: 1, maximum: 90, default: 30, description: "How many days ahead to look." },
        fresh: { type: "boolean", default: false, description: "Skip the 24 h cache (spends credits again)." },
      },
      additionalProperties: false,
    },
    annotations: { title: "Research: local events", ...RO_WEB },
    async run(a) {
      const r = await research("events", { days: a.days, fresh: a.fresh || undefined });
      return reply(withSources(r), { window: r.window, events: r.events, undated: r.undated, note: r.note, cached: r.cached, cost: r.cost });
    },
  },
  {
    name: "research_links",
    title: "Research: check links",
    description: "Check that every link in planned or scheduled posts (their post text and live link) and in the profile kit still loads. Reports broken links with where each is used; sites that refuse automatic checks are listed as unsure. Read-only.",
    inputSchema: {
      type: "object",
      properties: { fresh: { type: "boolean", default: false, description: "Skip the 24 h cache for the few links checked through Firecrawl." } },
      additionalProperties: false,
    },
    annotations: { title: "Research: check links", ...RO_WEB },
    async run(a) {
      const r = await research("links", { fresh: a.fresh || undefined });
      return reply(withSources(r), { broken: r.broken, unsure: r.unsure, checked: r.checked, cached: r.cached, cost: r.cost });
    },
  },
  /* ---------- AI assist (docs/ai-api.md): priced first, inside the studio's caps, never applied to an approved reel ---------- */
  {
    name: "ai_estimate",
    title: "AI: price the tools for a reel",
    description: "Price AI tools on one reel before anything is spent: review (a video model watches the reel and suggests fixes), sharpen (soft or low-res clips), slowmo (smooth slow motion), living (a real still gets a slow camera move), foley (natural sound made from the picture for shots that have none), behind (the headline sits behind the opening shot's subject), music (an instrumental bed made for the reel), voice (a Japanese AI voice reads the approved words). Returns the cost per tool, the total, the per-reel / total / daily limits and whether it fits. Spends nothing.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", pattern: SLUG, description: "The reel, e.g. \"day-1108\"." },
        tools: { type: "array", items: { type: "string", enum: AI_TOOLS }, description: `Some of: ${AI_TOOLS.join(", ")}.` },
        into: { type: "string", pattern: SLUG, description: "Price it as an AI copy under this new slug (e.g. \"day-1108-ai\"); the original stays as it is." },
      },
      required: ["slug", "tools"],
      additionalProperties: false,
    },
    annotations: { title: "AI: price the tools", ...RO },
    async run(a) {
      const e = await studio("POST", "/api/ai/estimate", aiBody(a), { timeoutMs: 130_000 });
      return reply(e.summary, { tools: (e.tools || []).map((t) => ({ tool: t.tool, usd: t.usd, model: t.model, labelRequired: t.labelRequired, items: (t.items || []).map((i) => i.what), note: t.note })),
        total: e.total, fits: e.fits, refusal: e.refusal, caps: e.caps, spent: e.spent, labelRequired: e.labelRequired });
    },
  },
  {
    name: "ai_review",
    title: "AI: review a rendered reel",
    description: "A video model watches the rendered reel (picture, sound, captions with their times) and returns a hook score for the first 3 seconds, a look score, captions that do not match their shot, on-screen claims that are not approved facts, and 1-3 concrete fixes. Suggestions only: nothing in the reel is changed. Costs about $0.01-0.03 (OpenRouter), inside the studio's AI limits; the same render is reviewed once and then answered free from its cache.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", pattern: SLUG, description: "A rendered reel." },
        fresh: { type: "boolean", default: false, description: "Review again even if this render was already reviewed (costs again)." },
        last_only: { type: "boolean", default: false, description: "Only return the last stored review; never spends." },
      },
      required: ["slug"],
      additionalProperties: false,
    },
    annotations: { title: "AI: review a reel", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async run(a) {
      if (a.last_only) {
        const r = await studio("GET", `/api/ai/review?slug=${encodeURIComponent(a.slug)}`);
        return r.review ? reply(`The last review of ${a.slug}${r.review.current === false ? " (of an older render)" : ""}.`, r.review) : `${a.slug} has no review yet.`;
      }
      const r = await studio("POST", "/api/ai/review", { slug: a.slug, ...(a.fresh ? { fresh: true } : {}) }, { timeoutMs: 320_000 });
      const lead = `Review of ${a.slug}: hook ${r.hook?.score ?? "?"}/10, look ${r.look?.score ?? "?"}/10, ${(r.mismatches || []).length} caption mismatches, ${(r.claims || []).length} unapproved claims. ${r.summary || ""}${r.cached ? " (cached, free)" : ` Cost $${r.usd}.`}`;
      return reply(lead, { hook: r.hook, look: r.look, mismatches: r.mismatches, claims: r.claims, fixes: r.fixes, guard: r.guard, model: r.model, note: r.note });
    },
  },
  {
    name: "ai_run",
    title: "AI: apply tools to a reel",
    description: "Apply AI tools to a reel as a background job, only inside the studio's AI limits: it prices the tools first and refuses (nothing spent) when the cost would pass the per-reel, total or daily limit. Tools never change an approved or scheduled reel: pass `into` to make an AI copy under a new slug. The result stays a draft for a person to review; nothing is approved or posted. Voice and living photo need the platform's AI label when posted. Poll job_status with the returned slug.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", pattern: SLUG, description: "The reel." },
        tools: { type: "array", items: { type: "string", enum: AI_TOOLS }, description: `Some of: ${AI_TOOLS.join(", ")}.` },
        into: { type: "string", pattern: SLUG, description: "A new slug for an AI copy (recommended), e.g. \"day-1108-ai\"." },
        max_usd: { type: "number", minimum: 0, description: "Refuse if the estimate is above this (on top of the studio's own limits)." },
        render: { type: "boolean", default: true, description: "Render the reel when the tools finish." },
      },
      required: ["slug", "tools"],
      additionalProperties: false,
    },
    annotations: { title: "AI: apply tools", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async run(a) {
      const body = aiBody(a);
      const e = await studio("POST", "/api/ai/estimate", body, { timeoutMs: 130_000 });
      if (!e.fits) throw new ToolError(`Refused, nothing spent: ${e.refusal}`);
      if (typeof a.max_usd === "number" && e.total > a.max_usd) throw new ToolError(`Refused, nothing spent: the tools would cost $${e.total}, more than max_usd $${a.max_usd}.`);
      const r = await studio("POST", "/api/ai/run", { ...body, render: a.render !== false }, { timeoutMs: 130_000 });
      return reply(`Started: ${e.summary} Poll job_status with slug "${r.job?.slug}".${e.labelRequired ? " This adds AI-made content: label it when posting." : ""}`, { job: slimJob(r.job), total: e.total, caps: e.caps });
    },
  },
  /* ---------- performance (read-only: how posted reels did and what to try next; docs/perf-api.md) ---------- */
  {
    name: "perf_summary",
    title: "Performance: what worked",
    description: "What worked and what did not across posted reels, by choice (look, recipe, text layout, length, hook, music, theme, posting weekday and hour), in plain sentences with their uncertainty, e.g. \"punch look: about 1.6x the median views on TikTok (5 posts; still uncertain)\". Each post is compared with its own network's median. Read-only; below 15 measured posts it says the numbers are early hints.",
    inputSchema: {
      type: "object",
      properties: { network: { type: "string", pattern: NETWORK, description: "One network (youtube, tiktok, facebook, bluesky, x, ...). Leave out for all networks pooled." } },
      additionalProperties: false,
    },
    annotations: { title: "Performance: what worked", ...RO },
    async run(a) {
      const s = await studio("GET", `/api/perf/summary${a.network ? `?network=${encodeURIComponent(a.network)}` : ""}`);
      const lines = Array.isArray(s.sentences) && s.sentences.length ? s.sentences : [s.headline || "No summary."];
      return reply(lines.map((l, i) => (i ? `- ${l}` : l)).join("\n"), { ready: s.ready, measured: s.measured, needed: s.needed, networks: s.networks, worked: s.worked, didnt: s.didnt, method: s.method });
    },
  },
  {
    name: "perf_suggest",
    title: "Performance: what to try next",
    description: "Suggestions for the next reels: picture look, word recipe, text layout, length and posting hour (JST), each with why. Thompson sampling over what has worked, with a share of suggestions (default 30%) that explore less-tested choices on purpose; until 15 posts are measured every suggestion explores. Read-only: suggestions only steer how drafts are made; a person still approves every reel and nothing is posted.",
    inputSchema: {
      type: "object",
      properties: {
        network: { type: "string", pattern: NETWORK, description: "Suggest for one network. Leave out for all networks pooled." },
        n: { type: "integer", minimum: 1, maximum: 10, default: 3, description: "How many suggestions." },
        explore: { type: "number", minimum: 0, maximum: 1, default: 0.3, description: "Share of suggestions that explore." },
        seed: { type: "integer", minimum: 0, maximum: 999999999, description: "Same seed, same suggestions." },
      },
      additionalProperties: false,
    },
    annotations: { title: "Performance: what to try next", ...RO },
    async run(a) {
      const q = new URLSearchParams();
      for (const k of ["network", "n", "explore", "seed"]) if (a[k] !== undefined) q.set(k, String(a[k]));
      const s = await studio("GET", `/api/perf/suggest${q.size ? `?${q}` : ""}`);
      const rows = (s.suggestions || []).map((x, i) => `${i + 1}. [${x.mode}] ${x.look} look, ${x.recipe} recipe, ${x.style} layout, ${x.length}, post ${x.hour} JST`);
      return reply(`${s.note || ""}\n\n${rows.join("\n")}`, { ready: s.ready, measured: s.measured, needed: s.needed, suggestions: s.suggestions, distribution: s.distribution });
    },
  },
];
const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/* ---------- argument check (the subset of JSON Schema the tools above use) ---------- */
function checkArgs(schema, args) {
  if (args === undefined || args === null) args = {};
  if (typeof args !== "object" || Array.isArray(args)) return "arguments must be an object";
  const props = schema.properties || {};
  for (const k of schema.required || []) if (args[k] === undefined) return `${k} is required`;
  for (const [k, v] of Object.entries(args)) {
    const p = props[k];
    if (!p) { if (schema.additionalProperties === false) return `unknown argument ${k}; allowed: ${Object.keys(props).join(", ") || "none"}`; continue; }
    if (v === undefined || v === null) continue;
    const t = p.type;
    if (t === "string" && typeof v !== "string") return `${k} must be a string`;
    if (t === "boolean" && typeof v !== "boolean") return `${k} must be true or false`;
    if (t === "integer" && !Number.isInteger(v)) return `${k} must be a whole number`;
    if (t === "number" && (typeof v !== "number" || !Number.isFinite(v))) return `${k} must be a number`;
    if (t === "array" && !Array.isArray(v)) return `${k} must be a list`;
    if (t === "array" && p.items?.type === "string" && !v.every((x) => typeof x === "string")) return `${k} must be a list of strings`;
    if (t === "array" && p.items?.enum && !v.every((x) => p.items.enum.includes(x))) return `${k} may only hold: ${p.items.enum.join(", ")}`;
    if (p.enum && !p.enum.includes(v)) return `${k} must be one of: ${p.enum.join(", ")}`;
    if (p.pattern && !new RegExp(p.pattern).test(v)) return `${k} has the wrong format (${p.description || p.pattern})`;
    if (p.minimum !== undefined && v < p.minimum) return `${k} must be at least ${p.minimum}`;
    if (p.maximum !== undefined && v > p.maximum) return `${k} must be at most ${p.maximum}`;
  }
  return null;
}
const publicTool = ({ run: _run, ...t }) => t;

/* ---------- JSON-RPC over stdio ---------- */
const cancelled = new Set();
let inflight = 0;
let stdinClosed = false;
function write(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }
const rpcError = (id, code, message, data) => ({ jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } });

async function handle(msg) {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") return rpcError(msg?.id ?? null, -32600, "Invalid Request: expected a JSON-RPC 2.0 object");
  const { id, method } = msg;
  const params = msg.params && typeof msg.params === "object" ? msg.params : {};
  if (typeof method !== "string") return null;  // a response from the client; nothing to answer
  const isNote = id === undefined;
  if (isNote) {
    if (method === "notifications/cancelled" && params.requestId !== undefined) cancelled.add(params.requestId);
    return null;  // notifications/initialized and the rest need no answer
  }
  // Modern (per-request) version, if the client sent one.
  const asked = params._meta?.[META_VERSION];
  const modern = typeof asked === "string";
  if (modern && !MODERN.includes(asked) && method !== "initialize") {
    return rpcError(id, -32022, "Unsupported protocol version", { supported: [...MODERN, ...LEGACY], requested: asked });
  }
  const done = (result) => ({ jsonrpc: "2.0", id, result: modern ? { resultType: "complete", ...result } : result });
  switch (method) {
    case "initialize": {
      const want = params.protocolVersion;
      const protocolVersion = LEGACY.includes(want) ? want : LEGACY[0];
      return { jsonrpc: "2.0", id, result: { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS } };
    }
    case "server/discover":
      return { jsonrpc: "2.0", id, result: { resultType: "complete", supportedVersions: [...MODERN, ...LEGACY], capabilities: { tools: { listChanged: false } },
        _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO }, instructions: INSTRUCTIONS } };
    case "ping":
      return done({});
    case "tools/list":
      return done({ tools: TOOLS.map(publicTool) });
    case "tools/call": {
      const tool = BY_NAME.get(params.name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${params.name}. Available: ${TOOLS.map((t) => t.name).join(", ")}`);
      const problem = checkArgs(tool.inputSchema, params.arguments);
      if (problem) return done({ content: [{ type: "text", text: `Invalid arguments for ${tool.name}: ${problem}.` }], isError: true });
      try {
        const out = await tool.run(params.arguments || {});
        const text = typeof out === "string" ? out : out.text;
        const structured = typeof out === "string" ? undefined : out.structured;
        return done({ content: [{ type: "text", text }], ...(structured ? { structuredContent: structured } : {}), isError: false });
      } catch (err) {
        const text = err instanceof ToolError ? err.message : `Unexpected error in ${tool.name}: ${err?.message || err}`;
        if (!(err instanceof ToolError)) console.error(err);
        return done({ content: [{ type: "text", text }], isError: true });
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

async function onLine(line) {
  const raw = line.trim();
  if (!raw) return;
  let msg;
  try { msg = JSON.parse(raw); } catch { return write(rpcError(null, -32700, "Parse error")); }
  const batch = Array.isArray(msg) ? msg : [msg];
  if (Array.isArray(msg) && !msg.length) return write(rpcError(null, -32600, "Invalid Request: empty batch"));
  await Promise.all(batch.map(async (m) => {
    inflight++;
    try {
      const out = await handle(m);
      if (out && !(m && cancelled.has(m.id))) write(out);
    } catch (err) {
      console.error(err);
      if (m && m.id !== undefined) write(rpcError(m.id, -32603, `Internal error: ${err?.message || err}`));
    } finally {
      if (m && m.id !== undefined) cancelled.delete(m.id);
      inflight--;
      if (stdinClosed && inflight === 0) process.exit(0);
    }
  }));
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => { onLine(line).catch((err) => console.error(err)); });
rl.on("close", () => { stdinClosed = true; if (inflight === 0) process.exit(0); });
process.stdout.on("error", () => process.exit(0));  // the client went away
console.error(`lazycow mcp ${VERSION}: talking to the studio at ${BASE}`);
