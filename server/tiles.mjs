/**
 * FILE: server/tiles.mjs
 * PURPOSE: Map tiles for Footage › "Where it was filmed", fetched through the studio and kept on disk, so the tile
 *          server sees one polite client and a tile is downloaded once a week at most.
 * OVERVIEW: createTileProxy({dir, template, userAgent}) -> { get(z, x, y) } answering {status, headers, body}.
 *           Only tiles a view asks for (no prefetch, no bulk), zoom 3-17, at most 2 downloads at a time, the same
 *           tile asked twice at once downloaded once. Kept for the server's Cache-Control / Expires and never less
 *           than 7 days (OpenStreetMap's tile policy: https://operations.osmfoundation.org/policies/tiles/). Offline
 *           or refused: the kept copy, however old.
 * USAGE: server/review.mjs GET /api/tiles/{z}/{x}/{y}.png. STUDIO_TILE_URL picks another provider ({z} {x} {y},
 *        optional {s}); STUDIO_TILE_CREDIT is its attribution line (docs/self-host.md).
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const DEFAULT_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
export const MIN_ZOOM = 3, MAX_ZOOM = 17, MIN_TTL_S = 7 * 86400;

/** Seconds a response may be kept: max-age (or s-maxage), else Expires, never under the 7-day floor. */
export function keepSeconds(headers, now = Date.now(), floor = MIN_TTL_S) {
  const get = (k) => (typeof headers?.get === "function" ? headers.get(k) : headers?.[k]) || "";
  const cc = String(get("cache-control"));
  const age = /(?:^|[,\s])(?:s-maxage|max-age)\s*=\s*(\d+)/i.exec(cc);
  let s = age ? Number(age[1]) : NaN;
  if (!Number.isFinite(s)) {
    const exp = Date.parse(String(get("expires")));
    s = Number.isFinite(exp) ? Math.round((exp - now) / 1000) : 0;
  }
  return Math.max(floor, s);
}

/** A tile template is http(s) and names {z}, {x} and {y}. */
export function validTemplate(t) {
  return typeof t === "string" && /^https?:\/\/[^\s]+$/i.test(t) && t.includes("{z}") && t.includes("{x}") && t.includes("{y}");
}

export function createTileProxy({ dir, template = DEFAULT_TILE_URL, userAgent, fetchImpl = globalThis.fetch, maxConcurrent = 2,
  now = () => Date.now(), timeoutMs = 15000 } = {}) {
  const url = validTemplate(template) ? template : DEFAULT_TILE_URL;
  const inflight = new Map();
  let active = 0;
  const waiting = [];
  const slot = () => (active < maxConcurrent ? (active++, Promise.resolve()) : new Promise((ok) => waiting.push(ok)));
  const free = () => { const next = waiting.shift(); if (next) next(); else active--; };
  const stats = { fetched: 0, cached: 0, stale: 0, refused: 0 };

  async function kept(file) {
    try {
      const [body, meta] = await Promise.all([readFile(file + ".png"), readFile(file + ".json", "utf8").then(JSON.parse)]);
      return { body, meta };
    } catch { return null; }
  }
  const reply = (status, body, maxAge, how, type = "image/png") => ({
    status, body: body || Buffer.alloc(0),
    headers: { "content-type": body ? type : "text/plain", "cache-control": `private, max-age=${Math.max(60, Math.min(maxAge, 86400))}`, "x-tile": how },
  });

  async function fetchTile(z, x, y, file, old) {
    await slot();
    try {
      const headers = { "user-agent": userAgent, accept: "image/png,image/*;q=0.8" };
      if (old?.meta?.etag) headers["if-none-match"] = old.meta.etag;
      if (old?.meta?.lastModified) headers["if-modified-since"] = old.meta.lastModified;
      const src = url.replace("{s}", "a").replace("{z}", z).replace("{x}", x).replace("{y}", y);
      const res = await fetchImpl(src, { headers, signal: AbortSignal.timeout(timeoutMs) });
      const keep = keepSeconds(res.headers, now());
      if (res.status === 304 && old) {
        const meta = { ...old.meta, expires: now() + keep * 1000 };
        await writeFile(file + ".json", JSON.stringify(meta)).catch(() => {});
        stats.cached++;
        return reply(200, old.body, keep, "revalidated", meta.type);
      }
      const type = (res.headers.get("content-type") || "").split(";")[0].trim();
      if (!res.ok || !/^image\//i.test(type)) throw Object.assign(new Error(`tile server answered ${res.status}`), { status: res.status });
      const body = Buffer.from(await res.arrayBuffer());
      const meta = { expires: now() + keep * 1000, etag: res.headers.get("etag") || "", lastModified: res.headers.get("last-modified") || "", type, from: src };
      await mkdir(join(dir, String(z), String(x)), { recursive: true });
      await writeFile(file + ".png.part", body);
      await rename(file + ".png.part", file + ".png");
      await writeFile(file + ".json", JSON.stringify(meta));
      stats.fetched++;
      return reply(200, body, keep, "fetched", type);
    } catch (err) {
      if (old) { stats.stale++; return reply(200, old.body, 3600, "stale", old.meta?.type); }  // offline: the old copy
      stats.refused++;
      return reply(err.status === 404 ? 404 : 502, null, 300, "missing");
    } finally { free(); }
  }

  async function get(z, x, y) {
    [z, x, y] = [z, x, y].map(Number);
    if (![z, x, y].every(Number.isInteger) || z < MIN_ZOOM || z > MAX_ZOOM || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) {
      return reply(400, null, 60, "out of range");
    }
    const file = join(dir, String(z), String(x), String(y));
    const old = await kept(file);
    if (old && Number(old.meta?.expires) > now()) {
      stats.cached++;
      return reply(200, old.body, Math.round((old.meta.expires - now()) / 1000), "cache", old.meta.type);
    }
    const key = `${z}/${x}/${y}`;
    if (!inflight.has(key)) inflight.set(key, fetchTile(z, x, y, file, old).finally(() => inflight.delete(key)));
    return inflight.get(key);
  }
  return { get, stats, template: url };
}
