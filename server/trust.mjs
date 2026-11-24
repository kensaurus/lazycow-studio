/**
 * FILE: server/trust.mjs
 * PURPOSE: Who may talk to the studio, and with what. The loopback Host rule, the same-origin rule for writes,
 *          no cross-site reads or GET side effects from another site's page, bounded JSON bodies, slugs and
 *          network ids that can never become a command-line option, byte ranges, the folder allow-list and the
 *          approval gate every posting route shares.
 * DEPENDENCIES: node:crypto, node:path
 * USAGE: import { refusal, trustRules, readJson, isSlug, ... } from "./trust.mjs" (server/review.mjs).
 * NOTES: Pure functions, so test/trust.test.mjs checks each rule without starting the server.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { resolve, sep } from "node:path";

/* A slug or network id goes on Python's command line (`studio reels --build <slug>`, `studio publish <slug> <net>`).
   It must never start with "-", or argparse reads it as an option (`--due`, `--force`, `-h`). */
export const SLUG_RX = /^[a-z0-9][a-z0-9-]*$/;
export const NET_RX = /^[a-z][a-z-]*$/;
export const isSlug = (s) => typeof s === "string" && s.length <= 120 && SLUG_RX.test(s);
export const isNet = (s) => typeof s === "string" && s.length <= 40 && NET_RX.test(s);

/**
 * The Host and Origin patterns for this port, and the API token when the owner set one (STUDIO_API_TOKEN).
 * `extra` (STUDIO_ALLOWED_HOSTS, server mode) adds names the studio may also be reached by, each exactly as the browser
 * sends it in Host: `studio.example.ts.net` behind an HTTPS proxy, or `192.168.1.20:4317` on a LAN. Its Origin may be
 * http or https. `*` takes any Host, and only with a token (serverMode refuses to start otherwise).
 */
export function trustRules(port, token = "", extra = []) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const names = extra.filter((h) => h && h !== "*").map(esc);
  const any = extra.includes("*");
  const loop = `(127\\.0\\.0\\.1|localhost|\\[::1\\]):${port}`;
  const more = names.length ? `|${names.join("|")}` : "";
  return {
    host: any ? /^[^\s/@]+$/ : new RegExp(`^(${loop}${more})$`, "i"),
    origin: any ? /^https?:\/\/[^\s/@]+$/i : new RegExp(`^(http://${loop}${names.length ? `|https?://(${names.join("|")})` : ""})$`, "i"),
    token: String(token || ""),
  };
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
/** Shortest STUDIO_API_TOKEN accepted for server mode: 24 random characters (`openssl rand -hex 16` gives 32). */
export const MIN_TOKEN = 24;
/**
 * Server mode, read once at start from STUDIO_HOST (bind address, default 127.0.0.1) and STUDIO_ALLOWED_HOSTS
 * (comma-separated). Off by default: one person on their own computer, loopback only, as before. A bind address other
 * than loopback, or any allowed host, needs STUDIO_API_TOKEN of MIN_TOKEN characters or more; without one the studio
 * refuses to start (`error`) instead of opening its API to the network. Returns {bind, extra, remote, error}.
 */
export function serverMode(env = {}, token = "") {
  const bind = String(env.STUDIO_HOST || "127.0.0.1").trim() || "127.0.0.1";
  const extra = String(env.STUDIO_ALLOWED_HOSTS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const remote = !LOOPBACK.has(bind) || extra.length > 0;
  let error = null;
  if (remote && String(token || "").length < MIN_TOKEN) {
    error = `STUDIO_HOST=${bind}${extra.length ? ` and STUDIO_ALLOWED_HOSTS=${extra.join(",")}` : ""} open the studio beyond this computer, so `
      + `STUDIO_API_TOKEN must be set to at least ${MIN_TOKEN} random characters (for example: openssl rand -hex 16). Not starting.`;
  } else if (remote && !LOOPBACK.has(bind) && !extra.length) {
    error = `STUDIO_HOST=${bind} listens beyond this computer, but STUDIO_ALLOWED_HOSTS is empty, so every browser would be refused. `
      + "Set it to the name you open the studio by (for example studio.example.ts.net or 192.168.1.20:4317), or * to accept any. Not starting.";
  }
  return { bind, extra, remote, error };
}

/* The optional API token. Off by default: one person on their own computer. With STUDIO_API_TOKEN set, every request
   carries it, so another program (or another user of a shared computer) cannot drive the studio just by knowing its
   port: a program sends "Authorization: Bearer <token>"; the browser gets it once from /?token=<token> (the address the
   studio prints when it starts), which sets the TOKEN_COOKIE cookie. Origin and Sec-Fetch headers are no proof here:
   any local program can send them. /api/health stays open (without the token it says only that the studio runs;
   review.mjs healthFor). /share/<id> links
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

/* ---------- Wrong tokens, the cookie, and who asked (docs/self-host.md, 0.24.1) ---------- */

/* X-Forwarded-For and X-Forwarded-Proto are written by whoever sends the request, and believing them would let a
   guesser pick the address that gets paused or banned. So they are believed only with STUDIO_TRUST_PROXY=1 and only
   from a proxy next to the studio: a TCP peer on loopback or a private network (Docker, LAN), see proxyPeer(). Without
   it, behind a proxy (or Docker's port mapping) every visitor has the proxy's address. */

/** Is the TCP peer on loopback or a private network (where a reverse proxy in front of the studio lives)?
 *  10/8, 172.16/12, 192.168/16, 127/8, ::1, fc00::/7, and those written as IPv4-in-IPv6. */
export function proxyPeer(req) {
  const ip = String(req?.socket?.remoteAddress || "").replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "").toLowerCase();
  const v4 = ip.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return ip === "::1" || /^f[cd][0-9a-f]{2}:/.test(ip);
}

/** The address a request came from, safe to put in a log line: the TCP peer, or with trustProxy the address the
 *  nearest proxy added last to X-Forwarded-For. IPv4 in IPv6 (::ffff:1.2.3.4) is written as IPv4. */
export function clientIp(req, trustProxy = false) {
  let ip = String(req?.socket?.remoteAddress || "");
  if (trustProxy) {
    const fwd = String(req?.headers?.["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean).pop();
    if (fwd) ip = fwd;
  }
  ip = ip.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
  return /^[0-9a-fA-F:.]{2,45}$/.test(ip) ? ip : "unknown";
}

/** Did the request come over HTTPS? A TLS socket, or X-Forwarded-Proto: https from a trusted proxy. */
export function overHttps(req, trustProxy = false) {
  if (req?.socket?.encrypted) return true;
  return trustProxy && String(req?.headers?.["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase() === "https";
}

/** How long the browser keeps the token after /?token=…: 30 days, then it opens that address again. */
export const COOKIE_DAYS = 30;
/** The Set-Cookie value that keeps the token in the browser; Secure when the request came over HTTPS. */
export function tokenCookie(token, secure = false) {
  return `${TOKEN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_DAYS * 86400}${secure ? "; Secure" : ""}`;
}

/**
 * Which token a request presents (Authorization, the cookie, or ?token=) and whether it is right.
 * Returns {state: "none"} (nothing presented, or no token set), {state: "ok"} (one of them is the token), or
 * {state: "wrong", key} where key is a short hash of the wrong values: the limiter counts each wrong value once, so
 * a browser that still holds an old cookie after the token changed is one failure, not one per request. The key is
 * never logged, and the token never is.
 */
export function tokenAttempt(headers = {}, query = "", token = "") {
  if (!token) return { state: "none" };
  const auth = String(headers.authorization || "");
  const rawCookie = new RegExp(`(?:^|;\\s*)${TOKEN_COOKIE}=([^;]+)`).exec(headers.cookie || "")?.[1] || "";
  const q = String(query || "");
  if (!auth && !rawCookie && !q) return { state: "none" };
  if (tokenOk(headers, token) || (q !== "" && same(q, token))) return { state: "ok" };
  const key = createHash("sha256").update(`${auth}\n${rawCookie}\n${q}`).digest("hex").slice(0, 16);
  return { state: "wrong", key };
}

/** Wrong tokens allowed per address in one window before it is paused (answered 429 without looking at the token). */
export const AUTH_LIMIT = { tries: 10, windowMs: 10 * 60e3, maxIps: 10_000 };

/**
 * A per-address count of wrong tokens. The window starts at an address's first failure; after `tries` different wrong
 * values inside it, wait() gives the seconds left until the window ends. Another address's success or failure changes
 * nothing here. At most `maxIps` addresses are kept: expired ones go first, then the oldest.
 */
export function authLimiter({ tries, windowMs, maxIps } = AUTH_LIMIT) {
  const seen = new Map();  // ip -> { since, keys: Set }
  const live = (ip, now) => {
    const e = seen.get(ip);
    if (e && now - e.since >= windowMs) { seen.delete(ip); return null; }
    return e || null;
  };
  const prune = (now) => {
    for (const [ip, e] of seen) if (now - e.since >= windowMs) seen.delete(ip);
    for (const ip of seen.keys()) { if (seen.size < maxIps) break; seen.delete(ip); }
  };
  return {
    /** Seconds until this address may try again; 0 when it may now. */
    wait(ip, now = Date.now()) {
      const e = live(ip, now);
      return e && e.keys.size >= tries ? Math.max(1, Math.ceil((e.since + windowMs - now) / 1000)) : 0;
    },
    /** Count a wrong token. True when this wrong value is new for this address in this window (log it). */
    fail(ip, key, now = Date.now()) {
      let e = live(ip, now);
      if (!e) {
        if (seen.size >= maxIps) prune(now);
        e = { since: now, keys: new Set() };
        seen.set(ip, e);
      }
      if (e.keys.has(key)) return false;
      if (e.keys.size < tries) e.keys.add(key);
      return true;
    },
    size: () => seen.size,
  };
}

/** One line per wrong token, for fail2ban or CrowdSec. Never the token: the URL path only (no query), at most 200 characters. */
export function authFailLine(ip, method, path, now = new Date()) {
  const p = String(path || "/").replace(/[^\x21-\x7e]/g, "?").slice(0, 200);
  const m = String(method || "").replace(/[^A-Za-z]/g, "").slice(0, 10) || "?";
  return `${now.toISOString()} lazycow auth failed ip=${ip} method=${m} path=${p}`;
}

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

/** The review queue's one-tap reasons for sending a reel back (py/studio/review_actions.py REASONS). */
export const REJECT_REASONS = ["weak-hook", "wrong-clip", "repeats"];
/**
 * A rejection's options for `studio reject`: --reason only when it is one of REJECT_REASONS, --look only when it is a
 * plain look id (letters, digits, dashes). Anything else is left out, so a page can never pass its own option.
 */
export function rejectOptions(payload = {}) {
  const out = [];
  if (REJECT_REASONS.includes(payload?.reason)) out.push("--reason", payload.reason);
  const look = typeof payload?.look === "string" ? payload.look : "";
  if (/^[a-z0-9][a-z0-9-]{0,39}$/i.test(look)) out.push("--look", look);
  return out;
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
