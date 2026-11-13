/**
 * FILE: test/geo.test.mjs
 * PURPOSE: The series map's sums (shared/geo.mjs) put places where an atlas has them, and its data
 *          (public/geo/east-africa-50m.json) holds the countries a safari through Kenya and Tanzania crosses.
 * USAGE: npm test
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { along, drawn, fit, greatCircle, lineLength, linePath, ringPath, routePoints } from "../shared/geo.mjs";

const geo = JSON.parse(readFileSync(new URL("../public/geo/east-africa-50m.json", import.meta.url), "utf8"));
const NAIROBI = [36.93, -1.32], DOHA = [51.61, 25.27], MARA = [35.14, -1.49], ARUSHA = [36.68, -3.37];

test("a fitted map keeps every point inside the box and north up", () => {
  const p = fit([NAIROBI, DOHA, MARA, ARUSHA], 800, 600, 40);
  for (const pt of [NAIROBI, DOHA, MARA, ARUSHA]) {
    const [x, y] = p(pt);
    assert.ok(x >= 39.9 && x <= 760.1 && y >= 39.9 && y <= 560.1, `${pt} -> ${x},${y}`);
  }
  assert.ok(p(DOHA)[1] < p(NAIROBI)[1], "Doha is north of Nairobi: higher on the map");
  assert.ok(p(DOHA)[0] > p(MARA)[0], "and east of the Mara");
  const one = fit([MARA], 200, 200, 10);
  assert.deepEqual(one(MARA).map(Math.round), [100, 100], "a single place sits in the middle");
});

test("a flight follows the great circle and ends where it lands", () => {
  const arc = greatCircle([37.07, -3.43], DOHA, 16);
  assert.equal(arc.length, 17);
  assert.deepEqual(arc[0].map((v) => Math.round(v * 100) / 100), [37.07, -3.43]);
  assert.deepEqual(arc.at(-1).map((v) => Math.round(v * 100) / 100), DOHA);
  const mid = arc[8];
  assert.ok(mid[1] > -3.43 && mid[1] < 25.27 && mid[0] > 37 && mid[0] < 52, "the middle of the arc lies between the two airports");
  const pts = routePoints([{ lon: 37.07, lat: -3.43 }, { lon: 39.2, lat: -6.88, by: "flight" }, { lon: DOHA[0], lat: DOHA[1], by: "flight" }]);
  assert.equal(pts.length, 1 + 24 + 24, "two flights, 24 steps each");
  assert.deepEqual(routePoints([{ lon: 1, lat: 1 }, { lon: 2, lat: 2, by: "road" }]), [[1, 1], [2, 2]], "a road is the straight line");
});

test("a line draws itself and a glyph rides along it", () => {
  const xy = [[0, 0], [30, 40], [30, 100]];
  assert.equal(lineLength(xy), 110);
  assert.equal(linePath(xy), "M0 0L30 40L30 100");
  assert.deepEqual(drawn(110, 0), { strokeDasharray: "110 110", strokeDashoffset: "110" });
  assert.deepEqual(drawn(110, 1), { strokeDasharray: "110 110", strokeDashoffset: "0" });
  const half = along(xy, 0.5);
  assert.ok(Math.abs(half.x - 30) < 1e-9 && Math.abs(half.y - 45) < 1e-9 && Math.round(half.angle) === 90, JSON.stringify(half));
});

test("the map data holds the trip's countries by their ISO numbers, and stays small", () => {
  const ids = Object.fromEntries(geo.countries.map((c) => [c.name, c.id]));
  assert.equal(ids.Kenya, "404");
  assert.equal(ids.Tanzania, "834");
  assert.equal(ids.Qatar, "634");
  assert.ok(readFileSync(new URL("../public/geo/east-africa-50m.json", import.meta.url)).length < 200_000, "small enough to read on every frame");
  const kenya = geo.countries.find((c) => c.name === "Kenya");
  const path = ringPath(kenya.rings[0], fit(kenya.rings[0], 400, 400));
  assert.match(path, /^M[\d.]+ [\d.]+(L[\d.]+ [\d.]+)+Z$/);
});
