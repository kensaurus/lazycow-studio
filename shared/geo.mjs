/**
 * FILE: shared/geo.mjs
 * PURPOSE: The few map sums the long-video series graphics need (src/SeriesMap.tsx), with no map library: a Mercator
 *          projection fitted to a box, SVG paths for country rings and a route, a great-circle arc for a flight, and
 *          how much of a drawn line to show at a given moment (a line that draws itself).
 * OVERVIEW: Everything works in [lon, lat] degrees in and [x, y] pixels out; no network, no tiles, same result on
 *           every frame. Mercator suits a window of East Africa and the Gulf (40 degrees of latitude across the
 *           equator): shapes look as people know them from atlases.
 * USAGE: import { fit, ringPath, linePath, greatCircle, lineLength, drawn } from "../shared/geo.mjs"
 * NOTES: Tested in test/geo.test.mjs.
 */

const RAD = Math.PI / 180;

/** Plain Mercator, unscaled: [x, y] with y growing northwards. */
export function mercator([lon, lat]) {
  const phi = Math.max(-85, Math.min(85, lat)) * RAD;
  return [lon * RAD, Math.log(Math.tan(Math.PI / 4 + phi / 2))];
}

/**
 * A projection that fits `points` ([lon, lat]) inside a width x height box with `pad` pixels on each side, keeping
 * the shape (one scale for both axes) and centring the rest. Returns project([lon, lat]) -> [x, y] in pixels (y down).
 */
export function fit(points, width, height, pad = 0) {
  const xy = (points.length ? points : [[0, 0]]).map(mercator);
  let x0 = Math.min(...xy.map((p) => p[0])), x1 = Math.max(...xy.map((p) => p[0]));
  let y0 = Math.min(...xy.map((p) => p[1])), y1 = Math.max(...xy.map((p) => p[1]));
  const minSpan = 0.5 * RAD;  // a single point (or two very close) still gets a sensible zoom
  if (x1 - x0 < minSpan) { const c = (x0 + x1) / 2; x0 = c - minSpan / 2; x1 = c + minSpan / 2; }
  if (y1 - y0 < minSpan) { const c = (y0 + y1) / 2; y0 = c - minSpan / 2; y1 = c + minSpan / 2; }
  const w = Math.max(1, width - 2 * pad), h = Math.max(1, height - 2 * pad);
  const k = Math.min(w / (x1 - x0), h / (y1 - y0));
  const ox = pad + (w - k * (x1 - x0)) / 2, oy = pad + (h - k * (y1 - y0)) / 2;
  const project = (p) => {
    const [x, y] = mercator(p);
    return [ox + k * (x - x0), oy + k * (y1 - y)];
  };
  project.scale = k;
  return project;
}

const num = (v) => (Math.round(v * 10) / 10).toString();

/** A closed country ring as an SVG path. */
export function ringPath(ring, project) {
  if (!ring || ring.length < 2) return "";
  return ring.map((p, i) => { const [x, y] = project(p); return `${i ? "L" : "M"}${num(x)} ${num(y)}`; }).join("") + "Z";
}

/** An open line through pixel points as an SVG path. */
export function linePath(xy) {
  return xy.map(([x, y], i) => `${i ? "L" : "M"}${num(x)} ${num(y)}`).join("");
}

/** Length of a line through pixel points. */
export function lineLength(xy) {
  let s = 0;
  for (let i = 1; i < xy.length; i++) s += Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]);
  return s;
}

/** The great circle from a to b ([lon, lat]) as n+1 points: how a long flight really runs on a map. */
export function greatCircle(a, b, n = 32) {
  const [l1, p1] = [a[0] * RAD, a[1] * RAD], [l2, p2] = [b[0] * RAD, b[1] * RAD];
  const v1 = [Math.cos(p1) * Math.cos(l1), Math.cos(p1) * Math.sin(l1), Math.sin(p1)];
  const v2 = [Math.cos(p2) * Math.cos(l2), Math.cos(p2) * Math.sin(l2), Math.sin(p2)];
  const dot = Math.max(-1, Math.min(1, v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2]));
  const om = Math.acos(dot);
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    if (om < 1e-9) { out.push([a[0], a[1]]); continue; }
    const s1 = Math.sin((1 - t) * om) / Math.sin(om), s2 = Math.sin(t * om) / Math.sin(om);
    const v = [s1 * v1[0] + s2 * v2[0], s1 * v1[1] + s2 * v2[1], s1 * v1[2] + s2 * v2[2]];
    out.push([Math.atan2(v[1], v[0]) / RAD, Math.atan2(v[2], Math.hypot(v[0], v[1])) / RAD]);
  }
  return out;
}

/**
 * The route through stops ([{lon, lat, by, via}]) as [lon, lat] points: a flight follows its great circle; a road the
 * real road when a Google Maps Timeline import gave it (`via`, [lon, lat] points before the stop), else the straight line
 * between the two places (the line says so by being dotted).
 */
export function routePoints(stops) {
  const out = [];
  for (let i = 0; i < stops.length; i++) {
    const s = stops[i];
    if (!i) { out.push([s.lon, s.lat]); continue; }
    const prev = stops[i - 1];
    if (s.by === "flight") out.push(...greatCircle([prev.lon, prev.lat], [s.lon, s.lat], 24).slice(1));
    else {
      if (Array.isArray(s.via)) for (const p of s.via) if (Array.isArray(p) && p.length >= 2) out.push([p[0], p[1]]);
      out.push([s.lon, s.lat]);
    }
  }
  return out;
}

/**
 * How much of a line of `length` pixels shows at progress t (0-1), as SVG stroke-dasharray / -dashoffset: the line
 * draws itself from its start.
 */
export function drawn(length, t) {
  const p = Math.max(0, Math.min(1, t));
  return { strokeDasharray: `${num(length)} ${num(length)}`, strokeDashoffset: num(length * (1 - p)) };
}

/** The point at progress t (0-1) along pixel points, and the direction there in degrees (for a plane glyph). */
export function along(xy, t) {
  const total = lineLength(xy);
  if (!xy.length) return { x: 0, y: 0, angle: 0 };
  let want = Math.max(0, Math.min(1, t)) * total;
  for (let i = 1; i < xy.length; i++) {
    const [ax, ay] = xy[i - 1], [bx, by] = xy[i];
    const seg = Math.hypot(bx - ax, by - ay);
    if (want <= seg || i === xy.length - 1) {
      const u = seg ? Math.min(1, want / seg) : 0;
      return { x: ax + (bx - ax) * u, y: ay + (by - ay) * u, angle: Math.atan2(by - ay, bx - ax) / RAD };
    }
    want -= seg;
  }
  const [x, y] = xy[xy.length - 1];
  return { x, y, angle: 0 };
}
