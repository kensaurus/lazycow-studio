/* ---------- Footage › Health: the runway and where it was filmed (batch B, 17 Nov) ----------
   Runway: the reels of fresh footage left (/api/footage/health reelsLeft) against the pace the schedule uses new reels
   (different reels booked over the next 14 days, from the posting log), after the days already booked. "Film by" is
   when the last of it would have to be cut and booked (3 days before it runs out); it opens "Film next". */
const RW_LEAD = 3;
const PL_DIR = ["pl.dir.n", "pl.dir.ne", "pl.dir.e", "pl.dir.se", "pl.dir.s", "pl.dir.sw", "pl.dir.w", "pl.dir.nw"], PL_Z = { fence: "pl.z.fence", close: "pl.z.close" };
/* The two pictures share Health's width (side by side from 1100 px), drawn about 1:1 so their words keep their size. */
const fhVizW = () => { const hw = document.getElementById("home")?.clientWidth || 900; return Math.round(hw >= 1100 ? Math.min(660, hw / 2 - 64) : Math.max(300, Math.min(680, hw - 60))); };
function runwayOf(h) {
  if (!h || h.reelsLeft == null) return null;
  const now = Date.now(), D = 864e5;
  const ahead = postsLog.filter((p) => p.network !== "all" && p.at && ["scheduled", "queued", "planned"].includes(p.status) && new Date(p.at).getTime() > now);
  const in14 = ahead.filter((p) => new Date(p.at).getTime() <= now + 14 * D);
  const reels14 = new Set(in14.map((p) => p.slug)).size, pace = reels14 / 14;
  const booked = ahead.length ? Math.max(0, (Math.max(...ahead.map((p) => new Date(p.at).getTime())) - now) / D) : 0;
  if (!pace) return { pace: 0, posts14: in14.length, booked, reelsLeft: h.reelsLeft };
  const days = booked + h.reelsLeft / pace, more = h.more ? [booked + (h.reelsLeft + h.more.low) / pace, booked + (h.reelsLeft + h.more.high) / pace] : null;
  return { pace, reels14, posts14: in14.length, booked, days, more, reelsLeft: h.reelsLeft, filmBy: now + Math.max(0, days - RW_LEAD) * D, end: now + days * D };
}
function runwayHtml(h) {
  const r = runwayOf(h); if (!r) return "";
  const L = lang === "ja" ? "ja-JP" : "en-GB", dd = (t) => new Date(t).toLocaleDateString(L, { weekday: "short", day: "numeric", month: "short" });
  if (!r.pace) return `<section class="rw mo-gfx" data-gx="rw"><h4 class="rf-title">${esc(tr("rw.title"))}</h4><p class="meta">${esc(tr("rw.nopace", { n: r.reelsLeft }))}</p></section>`;
  const N = Math.round(r.days), low = r.days < 7, span = Math.min(56, Math.max(21, Math.ceil(Math.max(r.days, r.more?.[1] || 0) / 7) * 7));
  const W = fhVizW(), X0 = 14, X1 = W - 14, px = (d) => X0 + (Math.min(span, Math.max(0, d)) / span) * (X1 - X0), Y = 52, BH = 22;
  const fb = (r.filmBy - Date.now()) / 864e5;
  const ticks = Array.from({ length: span / 7 + 1 }, (_, i) => i * 7).map((d) => `<path class="rw-tk" d="M${px(d)},${Y + BH + 2}v6"/><text class="rw-tl${d ? "" : " now"}" x="${px(d)}" y="${Y + BH + 20}">${d ? esc(new Date(Date.now() + d * 864e5).toLocaleDateString(L, { day: "numeric", month: "short" })) : esc(tr("rw.today"))}</text>`).join("");
  const seg = (a, b, cls, i) => (b > a ? `<rect class="rw-s ${cls}" x="${px(a).toFixed(1)}" y="${Y}" width="${(px(b) - px(a)).toFixed(1)}" height="${BH}" style="--i:${i}"/>` : "");
  const over = r.days > span ? `<path class="rw-over" d="M${X1 - 2},${Y - 3}l10,${BH / 2 + 3}l-10,${BH / 2 + 3}z"/>` : "";
  const svg = `<svg class="rw-svg" viewBox="0 0 ${W} ${Y + BH + 28}" role="img" aria-label="${esc(tr("rw.aria", { n: N, d: dd(r.end), f: dd(r.filmBy) }))}" preserveAspectRatio="xMinYMin meet">
    <defs><pattern id="rwHatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" class="rw-hbg"/><line x1="0" y1="0" x2="0" y2="6" class="rw-hl"/></pattern></defs>
    <rect class="rw-track" x="${X0}" y="${Y}" width="${X1 - X0}" height="${BH}"/>
    ${r.more ? seg(r.days, r.more[1], "more", 2) : ""}${seg(0, r.booked, "booked", 0)}${seg(r.booked, r.days, "foot", 1)}${over}
    <path class="rw-end${low ? " low" : ""}" d="M${px(r.days).toFixed(1)},${Y - 6}V${Y + BH + 4}"/>
    <g class="rw-flag" data-fhshoot="1" tabindex="0" role="button" aria-label="${esc(tr("rw.filmby", { d: dd(r.filmBy) }) + " · " + tr("rw.shoot"))}" style="--x:${px(fb).toFixed(1)}px">
      <path class="rw-pole" d="M${px(fb).toFixed(1)},${Y + BH}V${Y - 30}"/><path class="rw-fl" d="M${px(fb).toFixed(1)},${Y - 30}h${Math.min(150, X1 - px(fb))}v20h${-Math.min(150, X1 - px(fb))}z"/>
      <text class="rw-ft" x="${(px(fb) + 6).toFixed(1)}" y="${Y - 16}">${esc(tr("rw.filmbyshort", { d: new Date(r.filmBy).toLocaleDateString(L, { day: "numeric", month: "short" }) }))} ›</text></g>
    ${ticks}</svg>`;
  const fresh = gxFresh("rw");
  return `<section class="rw mo-gfx ${fresh ? "in" : ""}${low ? " low" : ""}" data-gx="rw" aria-labelledby="rwTitle">
    <h4 class="rf-title" id="rwTitle">${esc(tr("rw.title"))}</h4>
    <p class="rw-big">${tr("rw.days", { n: `<b data-count="${N}">${N}</b>` })}</p>
    <p class="meta">${esc(tr("rw.why", { r: r.reelsLeft, p: r.pace.toFixed(1), n: r.posts14, b: Math.round(r.booked) }))}</p>
    ${svg}
    <div class="px-foot"><span class="px-key"><i class="k-booked"></i>${esc(tr("rw.k.booked"))}</span><span class="px-key"><i class="k-foot"></i>${esc(tr("rw.k.foot", { n: r.reelsLeft }))}</span>${r.more ? `<span class="px-key"><i class="k-more"></i>${esc(tr("rw.k.more", { r: moreReels() }))}</span>` : ""}</div>
    <p class="rw-act"><button type="button" class="${low ? "primary" : ""}" data-fhshoot="1">${ico("camera", "sm")}${esc(tr("rw.filmby", { d: dd(r.filmBy) }))} · ${esc(tr("rw.shoot"))} ›</button></p>
    ${(h.shoot || []).length ? `<ol class="rw-next">${h.shoot.slice(0, 3).map((t) => `<li>${ico(THEME_ICON[t.theme] || "film", "sm")}<span>${esc(t.need)}</span>${t.camera ? `<span class="meta">${esc(t.camera)}</span>` : ""}</li>`).join("")}</ol>` : ""}</section>`;
}
function fhShootGo() {
  if (footTabNow() !== "health") footTabGo("health");
  requestAnimationFrame(() => {
    const el = document.getElementById("fhShoot"); if (!el) return;
    el.scrollIntoView({ block: "center", behavior: moCalm() ? "auto" : "smooth" });
    el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
  });
}
document.addEventListener("click", (e) => { if (e.target.closest?.("[data-fhshoot]")) fhShootGo(); });
document.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && e.target.closest?.("g[data-fhshoot]")) { e.preventDefault(); fhShootGo(); } });
/* Where the footage was filmed (GET /api/footage/places: ~100 m groups, never a file's own position), on a real map
   (24 Nov): OpenStreetMap squares fetched through the studio and kept on disk (GET /api/tiles/z/x/y.png, server/tiles.mjs),
   plain <img> tiles under an SVG of the groups. A dot grows with its files: green for the part not used in a reel yet, grey
   for the used part, hollow when its positions are estimated from a GPS file filmed close in time (py/studio/gps.py).
   Groups closer than ~26 px on screen merge. Drag (or the arrow keys) to move, +/− to zoom; Whole area / Close up fit the
   view again. A dot opens a note on the map: the place (GeoNames names once a person downloaded them, py/studio/places.py;
   else the distance from home), files, dates, Google Maps (opened only on a click) and Show in Library (the place filter). */
foot.places = null; foot.place = null; foot.pzoom = "fence"; foot.pview = null; foot.psel = null; foot.pjob = null; foot.pfresh = false;
let geoDrag = null, geoDragEnd = 0;
const GEO_T = 256, GEO_ZMIN = 3, GEO_ZMAX = 17;
const geoPx = (lat, lon, z) => { const s = GEO_T * 2 ** z, k = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180); return [((lon + 180) / 360) * s, (0.5 - Math.log((1 + k) / (1 - k)) / (4 * Math.PI)) * s]; };
const geoLat = (y, z) => (Math.atan(Math.sinh(Math.PI - (2 * Math.PI * y) / (GEO_T * 2 ** z))) * 180) / Math.PI;
const geoSize = () => { const W = fhVizW(); return [W, Math.round(Math.min(380, Math.max(260, W * 0.66)))]; };
const geoCountry = (cc) => { try { return new Intl.DisplayNames([lang === "ja" ? "ja" : "en"], { type: "region" }).of(cc) || cc; } catch { return cc; } };
const geoName = (p) => `${lang === "ja" ? p.nameJa || p.name : p.name}${p.feature ? " · " + (lang === "ja" ? p.feature.nameJa || p.feature.name : p.feature.name) : ""}`;
/* The deepest zoom (16 at most) where every point fits the frame less a margin, centred on them. */
function geoFit(pts, W, H, zmax = 16, pad = 40) {
  for (let z = zmax; z >= GEO_ZMIN; z--) {
    const xy = pts.map(([la, lo]) => geoPx(la, lo, z)), xs = xy.map((p) => p[0]), ys = xy.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    if ((x1 - x0 <= W - 2 * pad && y1 - y0 <= H - 2 * pad) || z === GEO_ZMIN) return { z, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
  }
}
/* The view: where the person moved it, else the preset (Whole area: every group and the home place; Close up: the groups
   inside the home place, or without one the biggest group and those within ~3 km of it). */
function geoView(P, W, H) {
  if (foot.pview) return foot.pview;
  const h = P.home, all = P.clusters.map((c) => [c.lat, c.lon]), kx = (la) => 111.32 * Math.cos((la * Math.PI) / 180);
  const ring = h ? [[h.lat + h.radiusKm / 110.57, h.lon], [h.lat - h.radiusKm / 110.57, h.lon], [h.lat, h.lon + h.radiusKm / kx(h.lat)], [h.lat, h.lon - h.radiusKm / kx(h.lat)]] : [];
  if (foot.pzoom === "close") {
    const b = P.clusters[0], near = h ? P.clusters.filter((c) => c.home) : P.clusters.filter((c) => Math.hypot((c.lat - b.lat) * 110.57, (c.lon - b.lon) * kx(b.lat)) < 3);
    return geoFit(near.length ? [...near.map((c) => [c.lat, c.lon]), ...(h ? [[h.lat, h.lon]] : [])] : ring.length ? ring : all.slice(0, 1), W, H);
  }
  return geoFit([...all, ...ring], W, H);
}
/* Groups on screen: the ~100 m groups closer than 26 px merge, biggest first. Every ~100 m group within 150 m of the home
   point joins one "at home" group (BL-113, 24 Nov: Close up showed two groups both named "at the home point"). */
function geoGroups(P, v, W, H) {
  const ox = v.cx - W / 2, oy = v.cy - H / 2, out = [], h = P.home;
  const nearHome = (c) => !!h && Math.hypot((c.lat - h.lat) * 110.57, (c.lon - h.lon) * 111.32 * Math.cos((h.lat * Math.PI) / 180)) < 0.15;
  let home = null;
  for (const c of [...P.clusters].sort((a, b) => b.clips - a.clips)) {
    const [px, py] = geoPx(c.lat, c.lon, v.z), x = px - ox, y = py - oy;
    if (nearHome(c)) { if (home) home.list.push(c); else out.push(home = { x, y, list: [c], home: true }); continue; }
    const g = out.find((o) => Math.hypot(o.x - x, o.y - y) < 26);
    if (g) g.list.push(c); else out.push({ x, y, list: [c] });
  }
  return out.map((g) => {
    const L = g.list, top = L[0], sum = (f) => L.reduce((n, c) => n + f(c), 0), w = sum((c) => c.clips) || 1;
    const days = L.flatMap((c) => [c.first, c.last]).filter(Boolean).sort(), gaps = L.flatMap((c) => c.gap || []);
    return { x: g.x, y: g.y, key: `${top.lat},${top.lon}`, list: L, home: !!g.home, clips: sum((c) => c.clips), unused: sum((c) => c.unused),
      real: sum((c) => c.real ?? c.clips), est: sum((c) => c.est || 0), ids: L.flatMap((c) => c.ids),
      lat: sum((c) => c.lat * c.clips) / w, lon: sum((c) => c.lon * c.clips) / w, first: days[0], last: days.at(-1),
      gap: gaps.length ? [Math.min(...gaps), Math.max(...gaps)] : null, one: L.find((c) => c.one)?.one, place: L.find((c) => c.place)?.place };
  });
}
/* A group's name: its place (GeoNames), else how far and which way from home. */
function geoLabel(g, P) {
  if (g.place) return geoName(g.place);
  const h = P.home;
  if (!h) return `${g.lat.toFixed(3)}, ${g.lon.toFixed(3)}`;
  const dy = (g.lat - h.lat) * 110.57, dx = (g.lon - h.lon) * 111.32 * Math.cos((h.lat * Math.PI) / 180), km = Math.hypot(dx, dy);
  // Only the one home group (geoGroups merges everything within 150 m of home) is "at home"; any other says which way.
  if (g.home || (g.home === undefined && km < 0.15)) return tr("pl.athome");
  return tr("pl.where", { km: Math.max(0.1, km < 10 ? Math.round(km * 10) / 10 : Math.round(km)).toLocaleString(), d: tr(PL_DIR[Math.round((((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360) / 45) % 8]) });
}
function geoNote(g, P) {
  const p = g.place, name = geoLabel(g, P), L = lang === "ja" ? "ja-JP" : "en-GB";
  const sub = p ? [lang === "ja" ? p.adminJa || p.admin : p.admin, geoCountry(p.country)].filter(Boolean).join(lang === "ja" ? "、" : ", ") : "";
  const day = (d) => new Date(d + "T12:00:00").toLocaleDateString(L, { day: "numeric", month: "short", year: "numeric" });
  const dates = g.first ? (g.first === g.last ? day(g.first) : `${day(g.first)} – ${day(g.last)}`) : "";
  const k = tr(g.one?.kind === "video" ? "geo.k.video" : "geo.k.photo");
  const est = !g.est ? "" : g.est === 1 && g.one ? tr(g.one.gap < 0 ? "geo.one.before" : g.one.gap > 0 ? "geo.one.after" : "geo.one.same", { m: Math.abs(g.one.gap), k })
    : g.gap ? tr("geo.estn", { n: g.est, a: g.gap[0], b: g.gap[1] }) : tr("geo.estnone", { n: g.est });
  return `<div class="geo-note" role="region" aria-label="${esc(name)}">
    <button type="button" class="geo-x" data-geoclose="1" aria-label="${esc(tr("geo.close"))}">${ico("x", "sm")}</button>
    <b>${esc(name)}</b>${sub ? `<span class="meta">${esc(sub)}</span>` : ""}
    <p>${esc(tr("geo.files", { n: g.clips, r: g.real, u: g.unused }))}</p>${est ? `<p class="meta">${esc(est)}</p>` : ""}${dates ? `<p class="meta">${esc(dates)}</p>` : ""}
    <p class="geo-acts"><button type="button" data-plkey="${esc(g.key)}">${ico("film", "sm")}${esc(tr("geo.lib"))}</button><a href="https://www.google.com/maps?q=${g.lat.toFixed(5)},${g.lon.toFixed(5)}" target="_blank" rel="noopener noreferrer">${esc(tr("geo.gmaps"))} ↗</a></p></div>`;
}
/* The inside of the map (#geoMap): tiles, home place, groups, labels, scale, zoom buttons, the open note and the credits. */
function geoMapInner(P, W, H) {
  const v = geoView(P, W, H), z = v.z, n = 2 ** z, ox = v.cx - W / 2, oy = v.cy - H / 2;
  let tiles = "";
  for (let ty = Math.floor(oy / GEO_T); ty <= Math.floor((oy + H) / GEO_T); ty++) {
    if (ty < 0 || ty >= n) continue;
    for (let tx = Math.floor(ox / GEO_T); tx <= Math.floor((ox + W) / GEO_T); tx++) {
      tiles += `<img class="geo-tile" src="/api/tiles/${z}/${((tx % n) + n) % n}/${ty}.png" alt="" draggable="false" decoding="async" style="left:${Math.round(tx * GEO_T - ox)}px;top:${Math.round(ty * GEO_T - oy)}px" onerror="this.style.visibility='hidden'">`;
    }
  }
  const h = P.home, f = (x) => x.toFixed(1);
  let fence = "", hx = null, hy = null;
  if (h) {
    const [px, py] = geoPx(h.lat, h.lon, z), rr = (h.radiusKm * 1000 * n) / (156543.034 * Math.cos((h.lat * Math.PI) / 180));
    hx = px - ox; hy = py - oy;
    fence = rr < 3 * W ? `<circle class="geo-fence" cx="${f(hx)}" cy="${f(hy)}" r="${f(rr)}"/>` : "";
  }
  const groups = geoGroups(P, v, W, H).filter((g) => g.x > -30 && g.x < W + 30 && g.y > -30 && g.y < H + 30);
  // the one group named "at home": the one within 150 m of it (geoGroups), else the nearest within 26 px of the mark
  const homeG = hx === null ? null : groups.find((g) => g.home) || groups.map((g) => [Math.hypot(g.x - hx, g.y - hy), g]).filter(([d]) => d < 26).sort((a, b) => a[0] - b[0])[0]?.[1];
  const atHome = (g) => g === homeG;
  const sel = groups.find((g) => g.list.some((c) => `${c.lat},${c.lon}` === foot.psel));
  foot.placeKeys = {};
  let dots = "", labels = "";
  const boxes = [];
  groups.forEach((g, i) => {
    const r = Math.min(22, 4 + 2.1 * Math.sqrt(g.clips)), u = g.clips ? (100 * g.unused) / g.clips : 0, on = sel === g, x = f(g.x), y = f(g.y);
    const where = !g.place && atHome(g) ? tr("pl.athome") : geoLabel(g, P), said = tr("geo.read", { w: where, n: g.clips, e: g.est, u: g.unused });
    foot.placeKeys[g.key] = { ids: g.ids, label: where };
    const body = g.real
      ? `<circle class="pl-used" cx="${x}" cy="${y}" r="${f(r)}"/>${u > 0 ? `<circle class="pl-unused" cx="${x}" cy="${y}" r="${f(r / 2)}" stroke-width="${f(r)}" pathLength="100" stroke-dasharray="${u.toFixed(1)} 100"/>` : ""}${g.est ? `<circle class="geo-estring" cx="${x}" cy="${y}" r="${f(r + 3.5)}"/>` : ""}`
      : `<circle class="geo-est${g.unused ? " un" : ""}" cx="${x}" cy="${y}" r="${f(r)}"/>`;
    dots += `<g class="pl-dot${on ? " on" : ""}" data-geog="${esc(g.key)}" tabindex="0" role="button" aria-pressed="${on}" aria-label="${esc(said)}" style="--i:${i}">${body}<circle class="pl-ring" cx="${x}" cy="${y}" r="${f(r + 3)}"/><title>${esc(said)}</title></g>`;
    // the biggest few get a name on the map, where it does not cover another
    const text = tr("geo.lab", { w: where, n: g.clips }), bw = [...text].length * (lang === "ja" ? 11 : 6.8), lx = g.x + r + 4;
    const box = [lx, g.y - 8, lx + bw, g.y + 6];
    if (i < 8 && lx + bw < W - 44 && !boxes.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) {
      boxes.push(box);
      labels += `<text class="geo-lab" x="${f(lx)}" y="${f(g.y + 4)}">${esc(text)}</text>`;
    }
  });
  const mpp = (156543.034 * Math.cos((geoLat(v.cy, z) * Math.PI) / 180)) / n;
  const nice = [1, 2, 5].flatMap((m) => [1, 10, 100, 1e3, 1e4, 1e5, 1e6].map((p) => m * p)).sort((a, b) => a - b).filter((m) => m / mpp <= 110).at(-1) || 1;
  const bar = nice / mpp, bl = nice >= 1000 ? `${(nice / 1000).toLocaleString()} km` : `${nice} m`;
  const mark = hx === null ? "" : `<g class="pl-home" aria-hidden="true"><path d="M${f(hx)},${f(hy - 9)}l8,7v8h-16v-8z"/>${groups.some(atHome) ? "" : `<text x="${f(hx + 12)}" y="${f(hy + 5)}">${esc(tr("pl.homemark"))}</text>`}</g>`;
  const svg = `<svg class="geo-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="group" aria-label="${esc(tr("pl.aria", { n: P.placed + (P.estimated || 0) }))}">${fence}${dots}${mark}<g aria-hidden="true">${labels}</g>
    <g class="pl-scale" aria-hidden="true"><path d="M14,${H - 22}v-5M14,${H - 22}H${f(14 + bar)}v-5"/><text x="${f(14 + bar / 2)}" y="${H - 28}">${bl}</text></g></svg>`;
  const credit = `${TILE_CREDIT ? esc(TILE_CREDIT) : `<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">${esc(tr("geo.osm"))}</a>`}${P.names?.world || P.names?.countries?.length ? ` · <a href="https://www.geonames.org/" target="_blank" rel="noopener">${esc(tr("geo.gncredit"))}</a>` : ""}`;
  return `<div class="geo-layer">${tiles}${svg}</div>
    <div class="geo-ctl"><button type="button" data-geozoom="1" aria-label="${esc(tr("geo.zin"))}" ${z >= GEO_ZMAX ? "disabled" : ""}>+</button><button type="button" data-geozoom="-1" aria-label="${esc(tr("geo.zout"))}" ${z <= GEO_ZMIN ? "disabled" : ""}>−</button></div>
    ${sel ? geoNote(sel, P) : ""}<div class="geo-credit">${credit}</div>`;
}
/* Get place names: one button, the world's towns first, then the detail for the country the footage is in. */
function geoNamesBtn(P) {
  const N = P.names, j = foot.pjob;
  if (!N) return "";
  if (j && isActive(j)) return `<span class="meta geo-nm">${ico("clock", "sm")} ${esc(tr("geo.getting"))}${j.of ? ` ${j.done || 0}/${j.of} MB` : ""}</span>`;
  const btn = (which, text) => `<button type="button" class="geo-nm" data-geoget="${esc(which)}" title="${esc(tr("geo.nameshint"))}">${ico("download", "sm")}${esc(text)}</button>`;
  if (!N.world) return btn("world", tr("geo.getworld", { mb: N.mb?.world || 11 }));
  if (N.suggest) return btn(N.suggest, N.mb?.[N.suggest] ? tr("geo.getcc", { c: geoCountry(N.suggest), mb: N.mb[N.suggest] }) : tr("geo.getccx", { c: geoCountry(N.suggest) }));
  return "";
}
/* Why some files have no place: Google Photos strips it; else the camera never wrote one (py/studio/gps.py report). */
function geoWhy(P) {
  const G = P.gps;
  if (!G) return "";
  const why = G.googlePhotos ? tr(G.none > G.googlePhotos ? "geo.why.gpm" : "geo.why.gp", { n: G.googlePhotos, m: G.none - G.googlePhotos }) : G.none ? tr("geo.why.none") : "";
  return why ? `${lang === "ja" ? "" : " "}<span title="${esc((G.devices || []).map((d) => tr("geo.dev", { d: d.device, r: d.real, e: d.estimated, n: d.none })).join(" · "))}">${esc(why)}</span>` : "";
}
/* The line under the map, in one scope (BL-113, 24 Nov: "226 have GPS, 204 estimated, 1133 have none; 466 via Google
   Photos; 902 saved without one" mixed the map's count with the GPS report's, and 466 + 902 ≠ 1133). Every number comes
   from py/studio/gps.py's report, where GPS + estimated + none = files and Google Photos + saved without = none; one
   sentence, the per-camera split in its tooltip. Without that report (an older engine), the map's own counts. */
function geoSum(P) {
  const G = P.gps, n = (x) => Number(x || 0).toLocaleString(lang === "ja" ? "ja-JP" : "en-GB");
  if (!G?.files) return esc(tr("geo.hint", { n: P.placed, e: P.estimated || 0, u: P.unplaced }));
  const v = { t: n(G.files), n: n(G.real), e: n(G.estimated), u: n(G.none), g: n(G.googlePhotos), m: n(Math.max(0, G.none - G.googlePhotos)) };
  const tip = (G.devices || []).map((d) => tr("geo.dev", { d: d.device, r: d.real, e: d.estimated, n: d.none })).join(" · ");
  return `<span title="${esc(tip)}">${esc(tr(G.googlePhotos ? "geo.sumgp" : G.none ? "geo.sumnone" : "geo.sum", v))}</span>`;
}
function geoPaint() {
  const el = document.getElementById("geoMap"), P = foot.places;
  if (!el || !P?.clusters?.length) { renderHome(true); return; }
  const a = document.activeElement, again = a?.dataset?.geozoom ? `[data-geozoom="${a.dataset.geozoom}"]` : a?.dataset?.geog ? `[data-geog="${CSS.escape(a.dataset.geog)}"]` : "";
  const [W, H] = geoSize();
  el.innerHTML = geoMapInner(P, W, H);
  if (again && el.contains(a) === false) el.querySelector(again)?.focus({ preventScroll: true });
}
const geoSegOff = () => document.querySelectorAll("[data-plzoom]").forEach((b) => { b.classList.remove("on"); b.setAttribute("aria-pressed", "false"); });
function geoMove(dx, dy, dz = 0) {
  const P = foot.places;
  if (!P?.clusters?.length) return;
  const [W, H] = geoSize(), v = geoView(P, W, H), z = Math.max(GEO_ZMIN, Math.min(GEO_ZMAX, v.z + dz)), k = 2 ** (z - v.z);
  foot.pview = { z, cx: (v.cx + dx) * k, cy: (v.cy + dy) * k };
  geoPaint(); geoSegOff();
}
function loadPlaces() {
  if (foot.places !== null) return;
  foot.places = undefined;
  api("/api/footage/places" + (foot.pfresh ? "?fresh=1" : "")).then((p) => { foot.places = p; foot.pfresh = false; }).catch((err) => { foot.places = { error: err.message }; })
    .finally(() => { if (atHome() && page === "footage") renderHome(true); });
}
function placesHtml() {
  loadPlaces();
  const P = foot.places, head = `<h4 class="rf-title" id="plTitle">${esc(tr("pl.title"))}</h4>`;
  if (P === undefined) return `<section class="pl">${head}<div class="skel" style="height:300px"></div></section>`;
  if (P?.error) return `<section class="pl">${head}<p class="meta">${ico("info", "sm")} ${esc(/no such route|^(not found|no|404)$/i.test(P.error) || P.error === tr("sys.oldserver") ? tr("pl.later") : P.error)}</p></section>`;
  if (!P.clusters?.length) return `<section class="pl">${head}<p class="meta">${esc(tr("pl.none"))}${geoWhy(P)}</p></section>`;
  const [W, H] = geoSize(), fresh = gxFresh("pl:" + foot.pzoom);
  const seg = ["fence", "close"].map((z) => { const on = !foot.pview && foot.pzoom === z; return `<button type="button" data-plzoom="${z}" class="${on ? "on" : ""}" aria-pressed="${on}">${esc(tr(PL_Z[z]))}</button>`; }).join("");
  return `<section class="pl mo-gfx ${fresh ? "in" : ""}" data-gx="pl:${esc(foot.pzoom)}" aria-labelledby="plTitle">
    <div class="pl-head">${head}<span class="grow"></span><div class="seg pl-zoom">${seg}</div></div>
    <div class="geo-view" id="geoMap" tabindex="0" role="region" aria-roledescription="map" aria-label="${esc(tr("geo.aria", { n: P.placed + (P.estimated || 0) }))}" style="width:${W}px;height:${H}px">${geoMapInner(P, W, H)}</div>
    <div class="px-foot"><span class="px-key"><i class="k-unused"></i>${esc(tr("pl.k.unused"))}</span><span class="px-key"><i class="k-used"></i>${esc(tr("pl.k.used"))}</span><span class="px-key"><i class="k-est"></i>${esc(tr("geo.k.est"))}</span>${geoNamesBtn(P)}</div>
    <p class="meta bt-read" aria-live="polite">${geoSum(P)}</p></section>`;
}
document.addEventListener("click", (e) => {
  const z = e.target.closest?.("[data-plzoom]");
  if (z) { foot.pzoom = z.dataset.plzoom; foot.pview = null; renderHome(true); return; }
  const gz = e.target.closest?.("[data-geozoom]");
  if (gz) { geoMove(0, 0, +gz.dataset.geozoom); return; }
  const gd = e.target.closest?.("[data-geog]");
  if (gd) { if (performance.now() - geoDragEnd > 350) { foot.psel = foot.psel === gd.dataset.geog ? null : gd.dataset.geog; geoPaint(); } return; }
  if (e.target.closest?.("[data-geoclose]")) { foot.psel = null; geoPaint(); document.getElementById("geoMap")?.focus({ preventScroll: true }); return; }
  const d = e.target.closest?.("[data-plkey]"); if (!d) return;
  const k = d.dataset.plkey, p = foot.placeKeys?.[k];
  foot.place = foot.place?.key === k || !p ? null : { key: k, ids: new Set(p.ids), label: p.label };
  foot.open = null;
  if (foot.place && footTabNow() !== "lib") { footTabGo("lib"); return; }  // the place's files are in the Library tab
  renderHome(true);
  if (foot.place) requestAnimationFrame(() => document.querySelector("#home .fbar, #home .fgrid, #home .fgroups")?.scrollIntoView({ block: "start", behavior: moCalm() ? "auto" : "smooth" }));
});
document.addEventListener("keydown", (e) => {
  const d = e.target.closest?.("g[data-geog]");
  if (d && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); d.dispatchEvent(new MouseEvent("click", { bubbles: true })); return; }
  if (e.target.id !== "geoMap") return;  // the map itself: arrows move it, + and - zoom, Escape closes the note
  const step = { ArrowLeft: [-90, 0], ArrowRight: [90, 0], ArrowUp: [0, -90], ArrowDown: [0, 90] }[e.key];
  if (step) { e.preventDefault(); geoMove(step[0], step[1]); }
  else if (e.key === "+" || e.key === "=") { e.preventDefault(); geoMove(0, 0, 1); }
  else if (e.key === "-" || e.key === "_") { e.preventDefault(); geoMove(0, 0, -1); }
  else if (e.key === "Escape" && foot.psel) { foot.psel = null; geoPaint(); }
});
/* Drag the map: the squares move with the pointer, the view is drawn again where it was let go. */
document.addEventListener("pointerdown", (e) => {
  const m = e.target.closest?.("#geoMap");
  if (!m || e.button !== 0 || e.target.closest(".geo-note, .geo-ctl, .geo-credit")) return;
  geoDrag = { x: e.clientX, y: e.clientY, dx: 0, dy: 0, moved: false, id: e.pointerId, layer: m.querySelector(".geo-layer") };
});
document.addEventListener("pointermove", (e) => {
  const g = geoDrag;
  if (!g || e.pointerId !== g.id) return;
  g.dx = e.clientX - g.x; g.dy = e.clientY - g.y;
  if (!g.moved && Math.hypot(g.dx, g.dy) > 4) { g.moved = true; document.getElementById("geoMap")?.classList.add("dragging"); }
  if (g.moved && g.layer) g.layer.style.transform = `translate(${g.dx}px, ${g.dy}px)`;
});
const geoDrop = (e) => {
  const g = geoDrag;
  if (!g || e.pointerId !== g.id) return;
  geoDrag = null;
  document.getElementById("geoMap")?.classList.remove("dragging");
  if (!g.moved) return;
  geoDragEnd = performance.now();
  geoMove(-g.dx, -g.dy);
};
document.addEventListener("pointerup", geoDrop);
document.addEventListener("pointercancel", geoDrop);
/* Get place names: only ever on this press (POST /api/places/download, a job; the "places" job event redraws the map). */
document.addEventListener("click", async (e) => {
  const b = e.target.closest?.("[data-geoget]");
  if (!b) return;
  b.disabled = true;
  try { foot.pjob = await post("/api/places/download", { which: b.dataset.geoget }); } catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000); }
  if (atHome() && page === "footage") renderHome(true);
});
function footGroupBar() {
  if (!foot.items.length) return "";
  const c = new Map();
  for (const i of foot.items) for (const [t] of footTags(i)) c.set(t, (c.get(t) || 0) + 1);
  const top = [...c].sort((a, b) => b[1] - a[1]).slice(0, 16);
  return `<div class="row wrap fbar"><label class="meta">${ico("layers", "sm")} ${tr("f.groupby")} <select id="footGroup">${FOOT_GROUPS.map((g) => `<option value="${g}" ${foot.group === g ? "selected" : ""}>${tr(FOOT_GROUP_KEY[g])}</option>`).join("")}</select></label>
    <span class="tagbar">${top.map(([t, n]) => `<button class="mp h-tag ${foot.tag === t ? "on" : ""}" data-ftag="${esc(t)}" aria-pressed="${foot.tag === t}">${esc(tagLabel(t))} <span class="meta">${n}</span></button>`).join("")}
    ${foot.tag ? `<button class="mp bad" data-ftag="">${ico("x", "sm")}${esc(tagLabel(foot.tag))}</button>` : ""}
    ${foot.place ? `<button class="mp placechip" data-plkey="${esc(foot.place.key)}" aria-pressed="true">${ico("x", "sm")}${esc(tr("pl.chip", { w: foot.place.label }))}</button>` : ""}</span></div>`;
}
function footGrid() {
  if (foot.loading && !foot.items.length) return `<div class="fgrid">${'<div class="skel skel-tile"></div>'.repeat(18)}</div>`;
  if (foot.error) return `<div class="empty"><b>${ico("alert")} ${esc(foot.error)}</b><button data-foot="${esc(foot.f)}">${ico("refresh", "sm")}${tr("sys.retry")}</button></div>`;
  const items = (foot.tag ? foot.items.filter((i) => footTags(i).some(([k]) => k === foot.tag)) : foot.items).filter((i) => !foot.place || foot.place.ids.has(i.id));
  if (!items.length) return `<div class="empty mascot">${kenji(foot.q || foot.tag || foot.place ? "worried" : "point")}<b>${tr(foot.q || foot.tag || foot.place ? "f.nomatch" : "f.empty")}</b><span>${tr(foot.q || foot.tag || foot.place ? "f.nomatchhint" : "f.emptyhint")}</span></div>`;
  if (foot.group === "none" || foot.q) {
    const all = foot.more.has("*");
    return `<div class="fgrid">${items.slice(0, all ? items.length : 240).map(ftile).join("")}</div>${items.length > 240 && !all ? `<p class="row"><button data-fmore="*">${tr("f.showall", { n: items.length })}</button></p>` : ""}`;
  }
  const groups = new Map();
  for (const i of items) { const k = footKey(i); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); }
  const newest = (l) => l.reduce((m, i) => (i.captured || "") > m ? i.captured : m, "");
  const order = [...groups].sort((a, b) => ["event", "month"].includes(foot.group) ? newest(b[1]).localeCompare(newest(a[1])) || b[0].localeCompare(a[0]) : b[1].length - a[1].length);
  // The newest group open, the rest folded to their one-line summary, ten groups at a time (layout pass, 18 Nov).
  const gN = 10 * (1 + (foot.gPage || 0)), gShown = order.slice(0, gN);
  return `<div class="fgroups">${gShown.map(([k, list], gi) => {
    const all = foot.more.has(k), shown = all ? list : list.slice(0, 16);
    return `<details class="fgroup" data-fg="${esc(k)}" ${foot.openG.has(k) || (gi < 1 && !foot.closedG.has(k)) ? "open" : ""}>${footHead(k, list)}<div class="fgrid">${shown.map(ftile).join("")}</div>
      ${list.length > shown.length ? `<p class="row"><button data-fmore="${esc(k)}">${tr("f.showall", { n: list.length })}</button></p>` : ""}</details>`;
  }).join("")}</div>${order.length > gN ? `<p class="row"><button type="button" data-fgmore="1">${ico("plus", "sm")}${esc(tr("ly_f.moregroups", { n: Math.min(10, order.length - gN), of: order.length - gN }))}</button></p>` : ""}`;
}
foot.openG = new Set(); foot.closedG = new Set();
/* The top of Footage is one line with two parts: Add footage (the ways in and the map of where footage comes from)
   and Fresh footage (how much is left). Each opens its panel under the line (one at a time, remembered); the clips
   follow right after, so adding and browsing never share a box. "places" and "collect" were the old two parts that
   Add footage now holds. */
/* Footage is three tabs (layout pass, 18 Nov; the page was 7.7 screens): Health (#/footage/health), Library
   (#/footage/library) and Sources (#/footage/sources). foot.drawer holds the open one: "health", "lib" or "add";
   "auto" (a fresh visit to #/footage) opens Health when footage is running low, else Library. */
foot.drawer = "auto";
const FOOT_TABS = { health: "health", library: "lib", sources: "add" };
const footAttention = () => { const h = foot.h; return !!h && !h.loading && !h.error && (h.reelsLeft < 4 || (runwayOf(h)?.days ?? Infinity) < 30); };
const footTabNow = () => (foot.drawer === "auto" ? (footAttention() ? "health" : "lib") : foot.drawer || "lib");
function footStrip() {
  const s = foot.src, last = s?.last || {}, counts = new Map((last.sources || []).map((x) => [x.path, x]));
  const files = s ? s.sources.reduce((n, x) => n + (counts.get(x.path)?.files || 0), 0) : null;
  const d = collect?.drop, h = foot.h;
  if (!s && !foot.srcLoading) { foot.srcLoading = true; loadSources().finally(() => { foot.srcLoading = false; }); }
  if (collect === null) { collect = undefined; loadCollect(); }
  const cur = footTabNow();
  const tab = (key, icon, label, info, cls = "") => `<a href="#/footage/${Object.keys(FOOT_TABS).find((k) => FOOT_TABS[k] === key)}" role="tab" class="fs-tab ${cur === key ? "on" : ""} ${cls}" data-fdrawer="${key}" aria-selected="${cur === key}">
      <b>${ico(icon, "sm")} ${label}</b><span>${info}</span></a>`;
  return `<nav class="footstrip" role="tablist" aria-label="${esc(tr("fs.label"))}">
    ${tab("health", "camera", tr("fs.health"), h && !h.loading && !h.error ? esc(runwayOf(h)?.days != null ? tr("rw.tab", { n: Math.round(runwayOf(h).days) }) : h.more ? tr("fh.moreest", { r: moreReels() }) : tr(h.reelsLeft === 1 ? "fs.left1" : "fs.left", { n: h.reelsLeft })) : "…", footAttention() ? "warn" : "")}
    ${tab("lib", "layers", tr("ly_f.lib"), foot.loading && !foot.items.length ? "…" : esc(tr("f.count", { n: foot.items.length })) + tdLibNew())}
    ${tab("add", "plus", tr("ly_f.src"), (s ? esc(tr("fs.placesinfo", { n: s.sources.length, f: Number(files).toLocaleString(), t: ago(last.checked) })) + (last.new ? ` · <em>${esc(tr("src.new", { n: last.new }))}</em>` : "") : "…") + (d?.open ? ` · ${esc(tr("fs.dropopen"))}` : ""), "addtab " + (d?.open ? "live" : ""))}
    <span class="grow"></span>
    <button id="srcWatch" title="${esc(tr("src.checknowtip"))}" ${foot.job?.status === "running" ? "disabled" : ""}>${ico("refresh", "sm")}${tr("src.checknow")}</button>
  </nav>`;
}
/* Open a Footage tab from code (an upload, Film next): its address too, without a second redraw from the hash. */
function footTabGo(key) {
  foot.drawer = key;
  const want = "#/footage/" + Object.keys(FOOT_TABS).find((k) => FOOT_TABS[k] === key);
  if (page === "footage" && atHome()) { if (location.hash !== want) history.replaceState(null, "", want); lyKeepFocus(() => renderHome(true)); } else location.hash = want;
}
document.addEventListener("click", (e) => { if (e.target.closest?.("[data-fgmore]")) { foot.gPage = (foot.gPage || 0) + 1; renderHome(true); } });
// Searching the clips is the Library's job: typing in the search box opens that tab.
document.addEventListener("input", (e) => { if (e.target.id === "footQ" && footTabNow() !== "lib") footTabGo("lib"); });
/* Add footage: four kinds of way in, each with its own colour and icon (the map below uses the same ones), one big
   drop target, the upload bars, and the map. The whole box takes dropped files. */
function addCard(kind, title, desc, actions, extra = "") {
  const k = AH_KIND[kind];
  return `<li class="ah-card ${k.cls} ${extra}"><span class="sn-ico ah-ico" aria-hidden="true">${ico(k.icon)}</span>
    <div class="ah-body"><h4>${title}</h4><p>${desc}</p><div class="ah-acts">${actions}</div></div></li>`;
}
function addHub() {
  const g = foot.g || {}, d = collect?.drop, f = collect?.form;
  const gp = !g.connected ? `<a class="btn" href="${gpConnectHref(g)}">${ico("image", "sm")}${tr(g.app === false ? "f.gsetup" : "f.gconnect")}</a>`
    : `<button type="button" data-gpadd="1" ${foot.session ? "disabled" : ""}>${ico("image", "sm")}${tr("f.gphotos")}</button>`;
  const cards = [
    addCard("pc", tr("ah.pc"), tr("ah.pc.d"), `<button type="button" id="srcAdd">${ico("folder", "sm")}${tr("src.add")}</button>`),
    addCard("cloud", tr("ah.cloud"), tr("ah.cloud.d"), `<button type="button" data-srcadd="cloud">${ico("folder", "sm")}${tr("ah.drive")}</button>${gp}`),
    addCard("people", tr("ah.people"), tr("ah.people.d"), `<button type="button" data-addmore="people" aria-expanded="${foot.addMore === "people"}" aria-controls="ahMore">${ico("wifi", "sm")}${d?.open ? tr("fs.dropopen") : tr("ah.dropbox")}</button><button type="button" data-addmore="people" aria-expanded="${foot.addMore === "people"}" aria-controls="ahMore">${ico("list", "sm")}${tr("col.form")}${f?.url ? ` ${ico("check", "sm")}` : ""}</button>`, d?.open ? "live" : ""),
  ].join("");
  foot.moreShown = foot.addMore;
  return `<section class="panel addhub" id="addhub" aria-labelledby="ahTitle">
    <div class="fh-head"><h3 id="ahTitle">${ico("plus")} ${tr("fs.add")}</h3><span class="meta">${tr("ah.hint")}</span></div>
    <ul class="ah-cards">${cards}</ul>
    ${foot.addMore === "people" ? `<div class="ah-more k-people ${foot.moreShown !== "people" ? "in" : ""}" id="ahMore"><div class="ah-morehead"><b>${ico("users", "sm")} ${tr("col.title")}</b><span class="meta">${tr("col.hint")}</span><span class="grow"></span><button type="button" class="icon" data-addmore="" aria-label="${esc(tr("src.close"))}" title="${esc(tr("src.close"))}">${ico("x", "sm")}</button></div>${collectBody()}</div>` : ""}
    <div class="ah-drop">
      <span class="ah-dropico" aria-hidden="true">${ico("download")}</span>
      <div><b>${tr("ah.drop")}</b><span class="meta">${tr("ah.limits")}</span></div>
      <span class="grow"></span><span class="meta">${tr("ah.or")}</span>
      <button type="button" class="primary" data-choosefiles="1">${ico("plus", "sm")}${tr("ah.choose")}</button>
    </div>
    <div class="ah-ups" id="addUploads"></div>
    <p class="ah-foot">${ico("link", "sm")} ${tr("ah.linknote")}</p>
    <div class="ah-dropmsg" aria-hidden="true"><div class="ah-dmbox"><span class="ah-dmico">${ico("download")}</span><b>${tr("dz.title")}</b><span class="meta">${tr("dz.where")}</span></div></div>
    <h4 class="sm-title">${ico("layers", "sm")} ${tr("src.title")}</h4>
    ${sourceMap()}
  </section>`;
}
document.addEventListener("click", (e) => {
  const a = e.target.closest?.("[data-srcadd]"); if (!a) return;
  e.preventDefault(); foot.picker = { roots: null, list: null, report: null, job: null, mode: "gps", want: a.dataset.srcadd }; pickerGo(null);
});
function renderFootage() {
  tdFootVisit();  // Track D: remember this visit, count what is new since the last one
  // Load once per search and filter; an empty result is an answer, not a reason to ask again.
  if (!foot.loading && foot.loadedKey !== JSON.stringify([foot.q, foot.f])) loadFootage();
  if (!foot.g) { foot.g = { app: true, connected: true }; api("/api/gphotos").then((g) => { foot.g = g; renderHome(true); }).catch(() => {}); }
  loadFootHealth();
  const segs = [["all", "f.all"], ["new", "td_f.new"], ["video", "f.video"], ["photo", "f.photo"], ["360", "f.360"], ["unused", "f.unused"], ["used", "f.used"]];
  const it = foot.open ? foot.items.find((i) => i.id === foot.open) : null;
  const tab = footTabNow();
  $("#home").innerHTML = `
    <div class="pagehead">${crumbs([tr("nav.footage")])}<span class="meta">${foot.loading && !foot.items.length ? "" : tr("f.count", { n: foot.items.length })}</span><span class="grow"></span>
      <div class="search" style="width:min(420px,36vw);margin:0">${ico("search", "sm")}<input id="footQ" data-lyfocus="footq" value="${esc(foot.q)}" placeholder="${esc(trR("f.search"))}"></div></div>
    ${footStrip()}
    ${tab === "add" ? addHub() : tab === "health" ? footHealth() || `<section class="panel"><div class="skel skel-line"></div><div class="skel skel-line"></div></section>` : ""}
    ${foot.job && (foot.job.status !== "done" || (foot.job.result?.added ?? foot.job.result?.downloaded ?? 0) > 0) ? `<div class="jobline s-${foot.job.status === "error" ? "skip" : foot.job.status === "done" ? "posted" : "scheduled"}">${ico(foot.job.status === "done" ? "check" : foot.job.status === "error" ? "alert" : "clock", "sm")} ${esc(foot.job.kind === "import" ? "Google Photos" : tr("src.title"))} · ${esc(foot.job.status === "error" ? (foot.job.lines || []).slice(-1)[0] || "failed" : foot.job.status === "done" && foot.job.result ? tr("src.donemsg", { n: foot.job.result.added ?? foot.job.result.new ?? 0 }) : foot.job.label || "")}${foot.job.status === "running" && foot.job.of ? ` · ${foot.job.done}/${foot.job.of}` : ""}</div>` : ""}
    ${foot.session ? `<div class="jobline s-scheduled">${ico("clock", "sm")} ${tr("f.gwait")} <span class="meta">${trA("f.gpick")}</span> <a href="${escUrl(foot.session.pickerUri)}" target="_blank" rel="noopener">Google Photos ↗</a></div>` : ""}
    ${tab === "lib" ? `<div class="seg">${segs.map(([k, label]) => `<button class="${foot.f === k ? "on" : ""}" data-foot="${k}">${tr(label)}</button>`).join("")}</div>
    ${footGroupBar()}
    ${footGrid()}` : ""}
    ${it ? `<div class="lightbox" data-fclose="1"><div class="lb-card" role="dialog" aria-modal="true" aria-label="${esc(it.file)}">
      ${it.kind === "video" ? `<video src="/proxy?id=${it.id}" controls autoplay muted playsinline></video>` : `<img src="${file(it.thumbs[0] || it.path)}" alt="">`}
      <div class="lb-meta"><b>${esc(it.file)}</b>
        <div class="mps">${footFacts(it)}</div>
        <div class="mps">${footTags(it).map(([k, x]) => `<button class="mp h-tag" data-ftag="${esc(k)}">${ico("tag", "sm")}${esc(x)}</button>`).join("")}</div>
        <h3>${tr("f.usedby")}</h3>${it.usedIn.length ? it.usedIn.map((s) => `<a class="chip" href="#/reel/${esc(s)}">${esc(s)}</a>`).join(" ") : it.inVlogs?.length ? "" : `<p class="note">${tr("f.none")}</p>`}${it.inVlogs?.length ? " " + it.inVlogs.map((n) => `<a class="chip" href="#/videos">${ico("play", "sm")}${tr("f.invlog", { n })}</a>`).join(" ") : ""}
        <h3>${tr("f.addto")}</h3><div class="row"><select id="addToReel"><option value="">${tr("f.choose")}</option>${overview.reels.filter((r) => r.rendered && !r.house).map((r) => `<option value="${esc(r.slug)}">${esc(r.slug)} · ${esc(r.title)}</option>`).join("")}</select>
          <button class="primary" data-addto="${it.id}">${ico("plus", "sm")}${tr("f.addto")}</button></div>
        <p><button data-fclose="1">${ico("x", "sm")}Close</button></p></div></div></div>` : ""}
    ${pickerHtml()}`;
  if (tab === "add") { paintUploads(); watchWires(); }
}
let footTimer = null, logTimer = null;
document.addEventListener("change", (e) => {
  if (e.target.name === "autoCut") { autoCut = e.target.value; return renderHome(true); }
  if (e.target.id === "autoVary") { autoVary = e.target.checked; return; }
  if (e.target.id !== "footGroup") return;
  foot.group = e.target.value; foot.more.clear(); foot.openG.clear(); foot.closedG.clear();
  try { localStorage.setItem("studio.footGroup", foot.group); } catch { /* private window: no memory, still works */ }
  renderHome(true);
});
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-ftag]"), m = e.target.closest("[data-fmore]");
  if (t) { e.stopPropagation(); foot.tag = t.dataset.ftag && foot.tag !== t.dataset.ftag ? t.dataset.ftag : null; foot.open = null; renderHome(true); }
  else if (m) { foot.more.add(m.dataset.fmore); foot.openG.add(m.dataset.fmore); renderHome(true); }
});
// A group folded or opened by hand stays that way through repaints.
document.addEventListener("toggle", (e) => {
  const g = e.target.closest?.(".fgroup"); if (!g) return;
  if (g.open) { foot.openG.add(g.dataset.fg); foot.closedG.delete(g.dataset.fg); } else { foot.openG.delete(g.dataset.fg); foot.closedG.add(g.dataset.fg); }
}, true);

document.addEventListener("input", (e) => {
  if (e.target.id !== "logQ") return;
  clearTimeout(logTimer);
  logTimer = setTimeout(() => { logQ = e.target.value; logPage = 0; logFocus = true; renderHome(true); logFocus = false; }, 250);
});
document.addEventListener("click", (e) => {
  const k = e.target.closest("[data-lkind]"), pg = e.target.closest("[data-lpage]");
  if (k) { logKind = k.dataset.lkind; logPage = 0; renderHome(true); }
  else if (pg && !pg.disabled) { logPage = Math.max(0, +pg.dataset.lpage); renderHome(true); window.scrollTo({ top: 0 }); }
});
document.addEventListener("input", (e) => {
  if (e.target.id !== "footQ") return;
  clearTimeout(footTimer);
  footTimer = setTimeout(() => { foot.q = e.target.value; foot.items = []; loadFootage(); }, 450);
});

/* A private video's signed thumbnail expires; fall back to the public one, then to a play tile. */
document.addEventListener("error", (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.closest(".yt-thumb")) return;
  if (img.dataset.altSrc && img.src !== img.dataset.altSrc) { img.src = img.dataset.altSrc; img.dataset.altSrc = ""; }
  else img.closest(".yt-thumb").classList.add("blank");
}, true);
setInterval(() => { if (atHome() && yt.connected) api("/api/youtube/videos").then((v) => { ytVideos = v; renderHome(); }).catch(() => {}); }, 10 * 60000);
/* A reel card is a link: Enter or Space opens it, like a click. */
document.addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target.matches?.(".rcard[data-open]")) { e.preventDefault(); e.target.click(); }
});
document.addEventListener("click", (e) => { if (e.target.closest("[data-credits]")) loadCredits(true); });
document.addEventListener("click", async (e) => {
  if (e.defaultPrevented || e.target.closest?.(".qvid, [data-qplay]")) return;
  const open = e.target.closest("[data-open]"), hf = e.target.closest("[data-hf]"), at = e.target.closest("[data-auto-theme]"), rm = e.target.closest("[data-remake]"), alt = e.target.closest("[data-alt]");
  const net = e.target.closest("[data-net]"), pg = e.target.closest("[data-page]"), skip = e.target.closest("[data-skip]");
  if (pg) { location.hash = "#/" + pg.dataset.page; return; }
  const gp = e.target.closest("[data-goto]");
  if (gp) { location.hash = "#/" + gp.dataset.goto; return; }
  const goBtn = e.target.closest("[data-go]");
  if (goBtn) { e.stopPropagation(); const r = overview.reels.find((x) => x.slug === goBtn.dataset.go); ltab = r?.status === "rendered" ? "library" : "exports"; return go(goBtn.dataset.go); }
  const chk = e.target.closest("[data-checks]");
  if (chk) {
    const r = overview.reels.find((x) => x.slug === chk.dataset.checks);
    if (!r?.rendered || busyJob(r)) return toast(`${ico("hourglass", "sm")} ${esc(tr("job.making", { s: chk.dataset.checks, l: r?.job?.label || "" }))}`, 4000);
    pendingSelect = lookChecks(r)[0]?.i ?? null; ltab = "reel";
    return go(chk.dataset.checks);
  }
  if (e.target.closest("[data-auto-all]")) {
    const keys = Object.keys(themes || {});
    autoThemes = new Set(autoThemes?.size === keys.length ? [] : keys);
    return renderHome();
  }
  if (e.target.closest("#lang")) { setLang(lang === "en" ? "ja" : "en"); return; }
  if (net) {
    e.preventDefault(); e.stopPropagation();
    // On the Posting page a square is "post this reel there": the post panel opens in place.
    if (net.dataset.ch && atHome() && page === "posting") return openDrawer(net.dataset.net, net.dataset.ch);
    ltab = "exports"; focusChan = net.dataset.ch ? chOf(net.dataset.ch) : null; return go(net.dataset.net);
  }
  if (skip) {
    e.stopPropagation();
    const on = !isSkipped(skip.dataset.skip);
    try { await post("/api/posts/skip", { slug: skip.dataset.skip, on }); }
    catch (err) { return toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000); }
    toast(`${ico(on ? "x" : "check", "sm")} ${esc(tr(on ? "toast.skip" : "toast.unskip", { s: skip.dataset.skip }))}`);
    return loadPosting();
  }
  if (e.target.closest("[data-foot]")) { foot.f = e.target.closest("[data-foot]").dataset.foot; foot.items = []; foot.loadedKey = null; return loadFootage(); }
  if (e.target.closest("#logRefresh")) { logData = null; return renderHome(true); }
  if (e.target.closest("#srcWatch, [data-srcwatch]")) {
    e.preventDefault();
    try { foot.job = await post("/api/sources/watch", {}); } catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000); }
    return renderHome(true);
  }
  if (e.target.closest("#srcAdd")) { e.preventDefault(); foot.picker = { roots: null, list: null, report: null, job: null, mode: "gps" }; return pickerGo(null); }
  const srcDel = e.target.closest("[data-srcdel]");
  if (srcDel) {
    e.preventDefault();
    if (!confirm(tr("src.removeask", { p: srcDel.dataset.srcdel }))) return;
    try { await post("/api/sources/remove", { path: srcDel.dataset.srcdel }); } catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000); }
    return loadSources();
  }
  if (foot.picker) {
    const go = e.target.closest("[data-fsgo]");
    if (go) return pickerGo(go.dataset.fsgo);
    if (e.target.closest("#fsDiscover")) {
      foot.picker.report = null;
      try { foot.picker.job = await post("/api/sources/discover", { path: e.target.closest("#fsDiscover").dataset.path }); } catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000); }
      return renderHome(true);
    }
    const inc = e.target.closest("#fsInclude");
    if (inc) {
      const mode = document.querySelector("input[name=srcMode]:checked")?.value || "gps";
      inc.disabled = true;
      try {
        await post("/api/sources/add", { path: inc.dataset.path, mode });
        toast(`${ico("check", "sm")} ${esc(tr("src.added"))}`, 7000);
        foot.picker = null; foot.job = { status: "running", kind: "watch", label: tr("src.adding") };
        return await loadSources();
      } catch (err) { inc.disabled = false; return toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000); }
    }
    const pc = e.target.closest("[data-pclose]");
    if (pc && (pc.matches("button") || e.target.classList.contains("lightbox"))) { foot.picker = null; return renderHome(true); }
  }
  if (e.target.closest("#gpAdd, [data-gpadd]")) {
    try {
      foot.session = await post("/api/gphotos/session", {});
      window.open(foot.session.pickerUri, "_blank", "noopener");
      renderHome(true);
      const started = Date.now();
      while (foot.session && Date.now() - started < 30 * 60000) {
        await new Promise((r) => setTimeout(r, 5000));
        const s = await api("/api/gphotos/session?id=" + encodeURIComponent(foot.session.id));
        if (s.mediaItemsSet) { foot.job = await post("/api/gphotos/import", { id: foot.session.id }); break; }
      }
    } catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000); }
    foot.session = null; return renderHome(true);
  }
  const addto = e.target.closest("[data-addto]");
  if (addto) {
    const slug = $("#addToReel").value, item = foot.items.find((i) => i.id === +addto.dataset.addto);
    if (!slug || !item) return toast(tr("f.choose"));
    foot.open = null; pendingAdd = item; ltab = "library"; return go(slug);
  }
  if (e.target.closest("[data-fopen]")) { foot.open = +e.target.closest("[data-fopen]").dataset.fopen; return renderHome(true); }
  const fclose = e.target.closest("[data-fclose]");
  if (fclose && (fclose.matches("button") || e.target.classList.contains("lightbox"))) { foot.open = null; return renderHome(true); }
  if (e.target.closest("#ytSort")) {
    const b = e.target.closest("#ytSort"); b.disabled = true;
    try {
      const r = await post("/api/youtube/sort", {});
      toast(`${ico("check", "sm")} ${r.created.length} playlists created · ${r.added.length} added${r.skippedPrivate.length ? ` · ${r.skippedPrivate.length} private left out` : ""}`, 7000);
      ytLists = null; loadYtLists();
    } catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000); }
    b.disabled = false; return;
  }
  if (e.target.closest("#toggleMaker")) { showMaker = !showMaker; return renderHome(); }
  if (e.target.closest("#newReelInline")) return $("#newReel").click();
  if (alt) { e.stopPropagation(); return otherOpening(alt.dataset.alt); }
  if (rm) { e.stopPropagation(); if (!rm.dataset.remake) return; return autopilot([rm.dataset.remake]); }
  if (hf) { homeFilter = hf.dataset.hf; if (!atHome() || page !== "reels") { location.hash = "#/reels"; } return renderHome(); }
  const thEdit = e.target.closest("[data-theme-edit], [data-theme-new]");
  if (thEdit) { e.stopPropagation(); return openThemeEditor(thEdit.dataset.themeEdit || null); }
  if (at) { const k = at.dataset.autoTheme; autoThemes.has(k) ? autoThemes.delete(k) : autoThemes.add(k); return renderHome(); }
  if (e.target.closest("#autoGo")) { autoDays = +$("#autoDays").value; autoFaces = $("#autoFaces").checked; return autopilot([...autoThemes]); }
  if (e.target.closest("[data-act=review]")) { const q = needsReview(); if (q.length) go(q[0].slug); return; }
  const mk = e.target.closest("[data-render]");
  if (mk) {
    e.stopPropagation(); mk.disabled = true;
    try { const p = await api("/api/project?slug=" + encodeURIComponent(mk.dataset.render)); const r = await post("/api/project", { project: p, render: true }); if (r.problems?.length) throw new Error(r.problems.join("; ")); await loadOverview(); }
    catch (err) { mk.disabled = false; toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000); }
    return;
  }
  if (open) {
    const r = overview.reels.find((x) => x.slug === open.dataset.open);
    if (r?.rendered && !busyJob(r)) go(r.slug);
    else toast(`${ico("hourglass", "sm")} ${esc(busyJob(r || {}) ? tr("job.making", { s: r.slug, l: r.job.label || "" }) : tr("card.draft"))}`, 4000);
  }
});
async function otherOpening(slug) {
  toast(`${ico("clapper", "sm")} Cutting another opening of ${esc(slug)}…`, 4000);
  try {
    const made = await post("/api/alternate", { slug });
    homeFilter = "making";
    toast(`${ico("check", "sm")} ${esc(made.slug)} starts on ${esc(made.opening)}`, 4000);
    await loadOverview();
  } catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 5000); }
}
/* Batches wait their turn: pressing Make again while one is picking footage queues the next one (the button says how
   many are waiting), so no batch is lost. */
let autoChain = Promise.resolve(), autoWaiting = 0;
function autopilot(list) {
  const pre = window.makerPreset, preset = pre && (pre.look || pre.style || pre.recipe) ? { look: pre.look, style: pre.style, recipe: pre.recipe, mode: pre.mode } : undefined;
  const opts = { since: new Date(Date.now() - autoDays * 864e5).toISOString().slice(0, 10), faces: autoFaces, cut: autoCut, vary: autoVary, learned: lpaLearnedNow(), preset };
  if (pre) window.makerPreset = null;  // used once: this batch is made like the suggestion
  autoWaiting++; renderHome(true);
  autoChain = autoChain.then(() => runAutopilot(list, opts)).finally(() => { autoWaiting--; renderHome(true); });
  return autoChain;
}
async function runAutopilot(list, { since, faces, cut, vary, learned, preset }) {
  toast(`${ico("clapper", "sm")} ${esc(tr("mk.picking", { n: list.length }))}`, 5000);
  try {
    const res = await post("/api/autopilot", { themes: list, since, faces, cut, vary, learned, preset });  // learned undefined: the setting decides
    // Nothing made (no usable footage for the theme, ...): say why, never "Queued ." for an empty list.
    if (!res.made?.length) throw new Error(tr("mk.nonemade", { why: (res.failed || []).join("; ") || "-" }));
    homeFilter = "making";
    toast(`${ico("check", "sm")} ${esc(tr("mk.queued", { list: res.made.map((m) => m.slug).join(", ") }))}${res.failed?.length ? `<br>${ico("alert", "sm")} ${esc(tr("mk.somefailed", { why: res.failed.join("; ") }))}` : ""}`, res.failed?.length ? 9000 : 5000);
    await loadOverview();
  } catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 6000); }
}
/* The finished masters' quality check (manifest.qa, py/studio/verify.py): one line, the worst finding first, with its fix. */
function qaLine(qa) {
  if (!qa || typeof qa !== "object") return `<span class="meta">checked on the next render</span>`;
  const found = Object.entries(qa).flatMap(([aspect, v]) => (v?.checks || []).filter((c) => c.level !== "ok").map((c) => ({ ...c, aspect })));
  if (!found.length) return `${ico("check", "sm")} sound level, peaks, black and frozen frames, silence and format OK on every size`;
  found.sort((a, b) => (a.level === "bad" ? 0 : 1) - (b.level === "bad" ? 0 : 1));
  return found.slice(0, 4).map((c) => `<span style="color:var(--${c.level === "bad" ? "bad" : "warn"})">${esc(c.aspect.replace("x", ":"))} · ${esc(c.found)}</span>${c.fix ? ` <span class="meta">${esc(c.fix)}</span>` : ""}`).join("<br>")
    + (found.length > 4 ? `<br><span class="meta">+${found.length - 4} more</span>` : "");
}
function toEdit(spec, m) {
  const shots = spec.shots.map((s, i) => {
    const ms = m.shots[i] || {};
    return { src: s.src, sec: s.sec, start: s.start ?? null, pan: s.pan ?? null, role: s.role || "", path: ms.path || MEDIA + s.src.replaceAll("/", "\\"),
      assetId: ms.assetId ?? null, file: ms.file || s.src.split("/").pop(), thumb: ms.thumb || null, kind: /\.(jpe?g|png|heic|webp)$/i.test(s.src) ? "photo" : "video",
      picked: ms.in ?? null, srcDur: ms.source?.duration ?? null, mezz: !!ms.thumb, mezzIndex: i };
  });
  return { slug: spec.slug, title_ja: spec.title_ja, season: spec.season, shots, beats: JSON.parse(JSON.stringify(spec.beats)), bed: spec.bed ?? null,
    tags: spec.tags, yt_title: spec.yt_title, posts: spec.posts ?? null, theme: spec.theme ?? null, made_by: spec.made_by ?? null,
    music: spec.music === undefined ? "auto" : spec.music, sfx: spec.sfx !== false, style: spec.style || "column",
    blurFaces: !!spec.blurFaces, bpm: spec.bpm || null, coverAt: spec.coverAt ?? null, variant: spec.variant ?? null,
    /* Picture look settings travel as-is, and only when the reel has them: a missing key means "use the theme's look". */
    fx: Object.fromEntries(["look", "recipe", "kicker", "loop"].filter((k) => k in spec).map((k) => [k, spec[k]])),
    /* Kept as they came, so a save does not lose them: when it was made (words avoid what was used lately), how, and its layers. */
    keep: Object.fromEntries(["made_at", "seed", "variety", "trace", "words", "spokenWords", "colorMatch", "stabilize"].filter((k) => k in spec).map((k) => [k, spec[k]])),
    layers: JSON.parse(JSON.stringify(spec.layers || [])) };
}
const total = () => edit.shots.reduce((a, s) => a + s.sec, 0);
const starts = () => { let acc = 0; return edit.shots.map((s) => { const v = acc; acc += s.sec; return v; }); };
const isDirty = () => JSON.stringify(edit) !== saved;
/* A sound-only change keeps the rendered player (the edit preview has no sound); clips or words switch to the preview. */
const pictureDirty = () => {
  try {
    const drop = (o) => { const c = { ...o }; delete c.music; delete c.sfx; delete c.blurFaces; delete c.bpm; delete c.coverAt; return JSON.stringify(c); };
    return drop(edit) !== drop(JSON.parse(saved));
  } catch { return isDirty(); }
};

