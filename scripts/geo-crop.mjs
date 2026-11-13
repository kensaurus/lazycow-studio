/**
 * FILE: scripts/geo-crop.mjs
 * PURPOSE: The map data the long-video series graphics draw (src/SeriesMap.tsx): country outlines from Natural Earth
 *          (public domain) via world-atlas's TopoJSON (ISC), cut down once to the window a trip's map can show, and the
 *          list of country names the studio accepts in the trip notes.
 * OVERVIEW: countries-50m.json -> GeoJSON (topojson-client) -> every country with a point inside WINDOW, its rings
 *           rounded to 0.01 degree (about 1 km: far finer than a 1920 px map of East Africa needs) with repeats
 *           dropped -> public/geo/east-africa-50m.json. All country names and ISO numeric ids -> shared/countries.json.
 * USAGE: node scripts/geo-crop.mjs   (run again only to change WINDOW; the output files are committed)
 * NOTES: Offline and deterministic. world-atlas and topojson-client are dev dependencies, used only here.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { feature } from "topojson-client";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** [west, south, east, north]: East Africa, the Gulf and Arabia (a safari plus a flight out through Doha or Dubai). */
export const WINDOW = [22, -14, 58, 30];
const topo = JSON.parse(readFileSync(join(ROOT, "node_modules", "world-atlas", "countries-50m.json"), "utf8"));
const all = feature(topo, topo.objects.countries).features;
const [w, s, e, n] = WINDOW;
const inside = ([x, y]) => x >= w && x <= e && y >= s && y <= n;
const round = (v) => Math.round(v * 100) / 100;

const countries = [];
for (const f of all) {
  const polys = f.geometry?.type === "Polygon" ? [f.geometry.coordinates] : f.geometry?.type === "MultiPolygon" ? f.geometry.coordinates : [];
  const rings = [];
  for (const poly of polys) {
    const outer = poly[0];
    if (!outer.some(inside)) continue;  // an island or a part of the country far outside the window
    const ring = [];
    for (const [x, y] of outer) {
      const p = [round(x), round(y)];
      const last = ring[ring.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) ring.push(p);
    }
    if (ring.length >= 4) rings.push(ring);
  }
  if (rings.length) countries.push({ id: f.id == null ? "" : String(f.id), name: f.properties.name, rings });
}
countries.sort((a, b) => a.name.localeCompare(b.name));
mkdirSync(join(ROOT, "public", "geo"), { recursive: true });
writeFileSync(join(ROOT, "public", "geo", "east-africa-50m.json"), JSON.stringify({
  source: "Natural Earth 1:50m Admin 0 countries (public domain), via world-atlas 2.0.2 (ISC)", window: WINDOW, countries }));
const names = all.filter((f) => f.id && f.properties?.name).map((f) => ({ id: String(f.id), name: f.properties.name }))
  .sort((a, b) => a.name.localeCompare(b.name));
writeFileSync(join(ROOT, "shared", "countries.json"), JSON.stringify(names, null, 0).replace(/\},\{/g, "},\n{") + "\n");
console.log(`${countries.length} countries in the window, ${names.length} names`);
