/**
 * FILE: packages/lazycow/lib/client.mjs
 * PURPOSE: A small client for the Lazycow Studio HTTP API, for your own scripts, bots and dashboards.
 * OVERVIEW: createClient() finds the studio on this computer (lib/env.mjs) and returns typed helpers for the common
 *           calls plus request() for any route in the OpenAPI document (docs/openapi.yaml in the studio). It only talks
 *           to the studio; the studio decides everything. Approving a reel stays a person's job in the studio.
 * DEPENDENCIES: global fetch (Node >= 20)
 * Part of Lazycow Studio by kensaurus (https://kensaur.us). Apache-2.0.
 */
import { studioTarget } from "./env.mjs";

export class StudioError extends Error {
  constructor(message, { status = 0, path = "", body } = {}) {
    super(message);
    this.name = "StudioError";
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

/**
 * @param {{ base?: string, port?: number, token?: string, dir?: string, timeoutMs?: number, fetch?: typeof fetch }} [opts]
 */
export function createClient(opts = {}) {
  const { base, token } = studioTarget(opts);
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const doFetch = opts.fetch || globalThis.fetch;
  if (typeof doFetch !== "function") throw new Error("lazycow needs Node 20 or newer (global fetch).");

  async function request(method, path, body) {
    method = String(method || "GET").toUpperCase();
    if (!String(path).startsWith("/")) throw new TypeError(`path must start with "/": ${path}`);
    const headers = { accept: "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    if (method !== "GET" && method !== "HEAD") {
      headers.origin = base;  // the studio answers a write only from its own origin
      headers["content-type"] = "application/json";
    }
    let res;
    try {
      res = await doFetch(base + path, {
        method, headers,
        body: body === undefined || method === "GET" ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const why = err?.name === "TimeoutError" ? `no answer within ${Math.round(timeoutMs / 1000)} s` : (err?.cause?.code || err?.message || "unreachable");
      throw new StudioError(`Lazycow Studio is not answering at ${base} (${why}). Start it (double-click Start Lazycow, or npm run review) and try again.`, { path });
    }
    const text = await res.text();
    let data = text;
    if (/json/.test(res.headers.get("content-type") || "")) { try { data = JSON.parse(text); } catch { /* keep text */ } }
    if (!res.ok) {
      const why = (data && typeof data === "object" && data.error) || String(text).trim().slice(0, 300) || `HTTP ${res.status}`;
      const hint = res.status === 401 ? " Set STUDIO_API_TOKEN (or pass token) to the studio's API token." : "";
      throw new StudioError(`The studio said: ${why} (HTTP ${res.status} on ${method} ${path}).${hint}`, { status: res.status, path, body: data });
    }
    return data;
  }

  return {
    base,
    request,
    get: (path) => request("GET", path),
    post: (path, body = {}) => request("POST", path, body),
    /** Is it running, which version, is the machine ready. */
    health: () => request("GET", "/api/health"),
    /** Name, version, licence, attribution and support links. */
    about: () => request("GET", "/api/about"),
    /** The open project's dashboard: reels, bookings, problems. */
    overview: () => request("GET", "/api/overview"),
    /** Booked and posted posts. */
    posts: () => request("GET", "/api/posts"),
    /** Story themes the studio can make reels from. */
    themes: () => request("GET", "/api/themes"),
    /** Projects on this computer and the open one. */
    projects: () => request("GET", "/api/workspaces"),
    /** Things that went wrong and need a person (missed posts, unapproved bookings). */
    problems: () => request("GET", "/api/problems"),
  };
}

export default createClient;
