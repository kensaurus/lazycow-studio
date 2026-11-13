/**
 * FILE: scripts/geo-world.mjs
 * PURPOSE: Every country's outline at 1:110m (Natural Earth, public domain, via world-atlas's TopoJSON, ISC), so a
 *          Google Maps Timeline import can name the country of any visit offline (py/studio/timeline.py). Nothing is
 *          looked up on the internet.
 * USAGE: node scripts/geo-world.mjs   (the output, shared/geo/world-110m.json, is committed; run again only to rebuild)
 * NOTES: Same shape as public/geo/east-africa-50m.json (scripts/geo-crop.mjs): {countries: [{id, name, rings}]}, rings
 *        rounded to 0.01 degree. The finer East Africa file is tried first; this one covers the rest of the world.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { feature } from "topojson-client";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const topo = JSON.parse(readFileSync(join(ROOT, "node_modules", "world-atlas", "countries-110m.json"), "utf8"));
const round = (v) => Math.round(v * 100) / 100;
const countries = [];
for (const f of feature(topo, topo.objects.countries).features) {
  const polys = f.geometry?.type === "Polygon" ? [f.geometry.coordinates] : f.geometry?.type === "MultiPolygon" ? f.geometry.coordinates : [];
  const rings = [];
  for (const poly of polys) {
    const ring = [];
    for (const [x, y] of poly[0]) {
      const p = [round(x), round(y)];
      const last = ring[ring.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) ring.push(p);
    }
    if (ring.length >= 4) rings.push(ring);
  }
  if (rings.length && f.properties?.name) countries.push({ id: f.id == null ? "" : String(f.id), name: f.properties.name, rings });
}
countries.sort((a, b) => a.name.localeCompare(b.name));
mkdirSync(join(ROOT, "shared", "geo"), { recursive: true });
writeFileSync(join(ROOT, "shared", "geo", "world-110m.json"), JSON.stringify({
  source: "Natural Earth 1:110m Admin 0 countries (public domain), via world-atlas 2.0.2 (ISC)", countries }));
console.log(`${countries.length} countries`);
