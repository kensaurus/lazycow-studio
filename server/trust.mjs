/**
 * FILE: server/trust.mjs
 * PURPOSE: Who may talk to the studio, and with what. The loopback Host rule, the same-origin rule for writes,
 *          no cross-site reads or GET side effects from another site's page, bounded JSON bodies, slugs and
 *          network ids that can never become a command-line option, byte ranges, the folder allow-list and the
 *          approval gate every posting route shares.
 * DEPENDENCIES: node:path
 * USAGE: import { refusal, trustRules, readJson, isSlug, ... } from "./trust.mjs" (server/review.mjs).
 * NOTES: Pure functions, so test/trust.test.mjs checks each rule without starting the server.
 */
import { timingSafeEqual } from "node:crypto";
import { resolve, sep } from "node:path";

/* A slug or network id goes on Python's command line (`studio reels --build <slug>`, `studio publish <slug> <net>`).
   It must never start with "-", or argparse reads it as an option (`--due`, `--force`, `-h`). */
export const SLUG_RX = /^[a-z0-9][a-z0-9-]*$/;
export const NET_RX = /^[a-z][a-z-]*$/;
export const isSlug = (s) => typeof s === "string" && s.length <= 120 && SLUG_RX.test(s);
export const isNet = (s) => typeof s === "string" && s.length <= 40 && NET_RX.test(s);

/** The loopback Host and Origin patterns for this port, and the API token when the owner set one (STUDIO_API_TOKEN). */
export function trustRules(port, token = "") {
  return {
    host: new RegExp(`^(127\\.0\\.0\\.1|localhost|\\[::1\\]):${port}$`, "i"),
    origin: new RegExp(`^http://(127\\.0\\.0\\.1|localhost|\\[::1\\]):${port}$`, "i"),
    token: String(token || ""),
  };
}

/* The optional API token. Off by default: one person on their own computer. With STUDIO_API_TOKEN set, every request
   carries it, so another program (or another user of a shared computer) cannot drive the studio just by knowing its
   port: a program sends "Authorization: Bearer <token>"; the browser gets it once from /?token=<token> (the address the
   studio prints when it starts), which sets the TOKEN_COOKIE cookie. Origin and Sec-Fetch headers are no proof here:
   any local program can send them. /api/health stays open (it only says whether the studio runs). /share/<id> links
   are answered before these rules (server/review.mjs): each id is 192 random bits and expires after 15 minutes. */
export const TOKEN_COOKIE = "lazycow_token";
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
export function tokenOk(headers, token) {
  if (!token) return true;
  const bearer = /^Bearer\s+(\S+)$/i.exec(headers.authorization || "")?.[1] || "";
  let cookie = new RegExp(`(?:^|;\\s*)${TOKEN_COOKIE}=([^;]+)`).exec(headers.cookie || "")?.[1] || "";
  try { cookie = decodeURIComponent(cookie); } catch { cookie = ""; }
  return (bearer !== "" && same(bearer, token)) || (cookie !== "" && same(cookie, token));
}
const OPEN_WITHOUT_TOKEN = /^\/api\/health(\?|$)/;

/**
 * Why a request may not go on, or null when it may.
 * - Host must be loopback with this port (a DNS-rebinding page sends its own name).
 * - GET/HEAD: another site may link to the studio (a top-level navigation, e.g. Google returning to /oauth/youtube),
 *   but its page may not load or fetch studio URLs (an <img>, fetch or EventSource from another site): those GETs
 *   start Python and ffmpeg, cancel a sign-in in progress, or open a stream. Browsers say so in Sec-Fetch-Site.
 * - Every other method: Origin, when sent, must be the studio's own; with no Origin, Sec-Fetch-Site (sent by every
 *   current browser) must be same-origin. A request with neither is a local program (curl, a script), let through.
 * - With an API token set (trustRules(port, token)), every request but /api/health must carry it (tokenOk): "token".
 */
export function refusal({ method, headers, url = "" }, rules) {
  if (!rules.host.test(headers.host || "")) return "host";
  if (rules.token && !OPEN_WITHOUT_TOKEN.test(url) && !tokenOk(headers, rules.token)) return "token";
  const site = headers["sec-fetch-site"];
  if (method === "GET" || method === "HEAD") {
    if ((site === "cross-site" || site === "same-site") && headers["sec-fetch-mode"] !== "navigate") return "cross-site";
    return null;
  }
  const origin = headers.origin;
  if (origin) return rules.origin.test(origin) ? null : "origin";
  return site && site !== "same-origin" ? "cross-site" : null;
}

/** Default cap on a JSON body: a reel project or a 2 MB CSV fits many times over; a runaway upload does not. */
export const BODY_LIMIT = 8 * 1024 * 1024;

/**
 * The request body as a JSON object. Bad JSON, or JSON that is not an object (null, a list, a number), is {}
 * as before. Over `limit` bytes rejects with status 413 and stops reading.
 */
export function readJson(req, limit = BODY_LIMIT) {
  return new Promise((ok, fail) => {
    const declared = Number(req.headers?.["content-length"] || 0);
    const tooBig = () => Object.assign(new Error(`The request is too large (over ${Math.round(limit / 1024 / 1024)} MB).`), { status: 413 });
    if (declared > limit) { req.resume?.(); return fail(tooBig()); }
    const chunks = [];
    let size = 0, over = false;
    req.on("data", (c) => {
      if (over) return;
      size += c.length;
      if (size > limit) { over = true; chunks.length = 0; return fail(tooBig()); }
      chunks.push(c);
    });
    req.on("end", () => {
      if (over) return;
      let v = null;
      try { v = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { v = null; }
      ok(v && typeof v === "object" && !Array.isArray(v) ? v : {});
    });
    req.on("error", (e) => { if (!over) fail(e); });
  });
}

/**
 * A Range header against a file of `size` bytes: null (no usable range: send the whole file),
 * {start, end} (inclusive), or "unsatisfiable" (answer 416). Handles "bytes=a-b", "bytes=a-" and "bytes=-n".
 */
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || "").trim());
  if (!m || (!m[1] && !m[2]) || size <= 0) return null;
  let start, end;
  if (!m[1]) {  // the last n bytes
    const n = Number(m[2]);
    if (n === 0) return "unsatisfiable";
    start = Math.max(0, size - n); end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (!Number.isSafeInteger(start) || start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

/* A path's spelling for comparing folders: resolved, and folded to lower case only where the file system ignores case
   (Windows, macOS). On Linux /data/RENDERS is another folder than /data/renders, so folding there would let a
   differently-cased sibling through the allow-list. Roots must be made with the same function. */
const FOLD = process.platform === "win32" || process.platform === "darwin";
export const pathKey = (p) => (FOLD ? resolve(p).toLowerCase() : resolve(p));
/** Is `path` one of the roots or inside one? Roots are made with pathKey. */
export function insideRoots(path, roots) {
  if (typeof path !== "string" || !path || path.includes("\0")) return false;
  const key = pathKey(path);
  return roots.some((root) => key === root || key.startsWith(root + sep));
}

/**
 * The approval gate (same words as py/studio/publish.py assert_approved and helper.mjs scheduleRefusal).
 * rows: the review list (`studio review-list`); drafts are stored as "story-<slug>", older ones under the bare slug.
 * Returns null when the reel is approved, else the plain reason.
 */
export function approvalRefusal(rows, slug) {
  const bare = String(slug || "").replace(/^story-/, "");
  const list = Array.isArray(rows) ? rows : [];
  const row = list.find((r) => r?.slug === `story-${bare}`) || list.find((r) => r?.slug === bare);
  if (!row) return `There is no review record for ${bare}, so it cannot be confirmed as approved. Only approved reels are posted.`;
  if (row.status !== "approved") return `${bare} is "${row.status}", not approved. Approve it in the studio first; only approved reels are posted.`;
  return null;
}

/**
 * Does a reel from a shared project file name a path outside this computer's footage folder? A network share
 * (\host\share or //host) makes Windows sign in to that host with the owner's account the moment the studio looks at
 * the file; a drive path, a rooted path or a ".." reads files the owner never chose (security review 13 Nov). Footage
 * never travels in a project file, so an imported reel keeps relative paths only.
 */
export function strayPath(reel) {
  let bad = false;
  JSON.stringify(reel ?? null, (key, v) => {
    if (typeof v !== "string") return v;
    if (/^(\\|\/\/)/.test(v)) bad = true;  // a network share, under any key
    if ((key === "src" || key === "path") && (/^[a-zA-Z]:|^[\/]/.test(v) || /(^|[\/])\.\.([\/]|$)/.test(v))) bad = true;
    return v;
  });
  return bad;
}
