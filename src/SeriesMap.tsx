/**
 * FILE: src/SeriesMap.tsx
 * PURPOSE: The graphics of a long-video series (py/studio/vlog.py series): where and when each part happens, and
 *          where to go next. The series title over a map of the trip with this episode's leg drawing itself; a place
 *          tag per chapter (day, place, country or the border crossed) with a small locator map, a flight's arc on a
 *          travel day; "previously" with the legs already seen; the next-part card that YouTube's end screen sits on.
 * OVERVIEW: Every map is plain SVG from public/geo/east-africa-50m.json (Natural Earth, public domain) through
 *           shared/geo.mjs (Mercator fitted to a box, great circles): offline, the same on every frame, fast at
 *           --concurrency=8. Words use the documentary look's faces (Fraunces + DM Sans, loaded by src/Vlog.tsx).
 * DEPENDENCIES: remotion, shared/geo.mjs, public/geo/east-africa-50m.json
 * USAGE: used by src/Vlog.tsx when its props carry `series`.
 * NOTES: Places come from the person's trip notes (pins are approximate, about 10 km); nothing here guesses a
 *        place. Words stay inside the title-safe area; the next-part card keeps the right side clear for YouTube's
 *        end-screen elements (a video, a playlist, subscribe) in faint frames sized for them.
 */
import React, { useMemo } from "react";
import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import geo from "../public/geo/east-africa-50m.json";
import { along, drawn, fit, linePath, lineLength, ringPath, routePoints } from "../shared/geo.mjs";

/** A stop; from a Google Maps Timeline import also `via` (the real road before it, [lon, lat] points), `stay` (minutes)
 *  and `leg` ("4 h 08 min drive · 212 km"). */
export type RouteStop = { place: string; country?: string; lat: number; lon: number; by?: string; stop?: boolean; main?: boolean; via?: number[][]; stay?: number; leg?: string };

/** The same words as py/studio/timeline.py stay_words: "2 nights", "3 h 10 min", "40 min". */
export function stayWords(min: number): string {
  if (min >= 20 * 60) { const n = Math.round(min / 1440) || 1; return `${n} night${n > 1 ? "s" : ""}`; }
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h} h ${String(m).padStart(2, "0")} min` : `${m} min`;
}
export type RouteDay = { day: string; place: string; country?: string; lat: number; lon: number; stops?: RouteStop[] };
export type SeriesInfo = { n: number; of: number; name: string; episode: string; kicker: string; dayOf?: number };
export type SeriesRecap = { atSec: number; sec: number; leg: string[] };
export type SeriesNext = { atSec: number; n: number; of: number; first: boolean; leg: string[]; title: string };

const FRAUNCES = "Fraunces, Georgia, serif";
const DM = "'DM Sans', 'Segoe UI', sans-serif";
const PAPER = "#faf8f1";
const GOLD = "#e8c170";
const INK = "#0d0f0b";
const LAND = "#3a3f33";
const LAND_ON = "#d9cfb4";
const SHADOW = "0 2px 18px rgba(0,0,0,0.55), 0 1px 3px rgba(0,0,0,0.6)";
const CLAMP = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const OUT = { ...CLAMP, easing: Easing.out(Easing.cubic) };
const up = (s: string) => s.toUpperCase();
const tracked = (em: number): React.CSSProperties => ({ letterSpacing: `${em}em`, marginRight: `-${em}em` });

type Country = { id: string; name: string; rings: number[][][] };
const COUNTRIES = (geo as unknown as { countries: Country[] }).countries;
/** The names the trip notes use, as Natural Earth spells them. */
const ALIAS: Record<string, string> = { "united republic of tanzania": "Tanzania", "tanzania, united republic of": "Tanzania", "uae": "United Arab Emirates" };
const byName = (name?: string) => {
  const key = (name || "").trim().toLowerCase();
  const want = (ALIAS[key] || name || "").toLowerCase();
  return COUNTRIES.find((c) => c.name.toLowerCase() === want);
};
const bounds = (c?: Country): number[][] => {
  if (!c) return [];
  const pts = c.rings.flat();
  const lons = pts.map((p) => p[0]), lats = pts.map((p) => p[1]);
  return [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]];
};
/** Where a country's name sits: the middle of its largest ring. */
const labelAt = (c: Country): number[] => {
  const ring = [...c.rings].sort((a, b) => b.length - a.length)[0];
  const lons = ring.map((p) => p[0]), lats = ring.map((p) => p[1]);
  return [(Math.min(...lons) + Math.max(...lons)) / 2, (Math.min(...lats) + Math.max(...lats)) / 2];
};
const [W0, S0, E0, N0] = (geo as unknown as { window: number[] }).window;
const inWindow = (s: { lon: number; lat: number }) => s.lon >= W0 && s.lon <= E0 && s.lat >= S0 && s.lat <= N0;

/** Every stop of the trip in order, each with its day, from the route the trip notes give. */
function stopsOf(route: RouteDay[]): Array<RouteStop & { day: string }> {
  const out: Array<RouteStop & { day: string }> = [];
  for (const d of route) {
    const stops = d.stops && d.stops.length ? d.stops : [{ place: d.place, country: d.country, lat: d.lat, lon: d.lon }];
    for (const s of stops) {
      const last = out[out.length - 1];
      if (last && last.lat === s.lat && last.lon === s.lon) continue;  // the same place on the next day: one point
      out.push({ ...s, day: d.day });
    }
  }
  return out.filter(inWindow);
}

/** The route's points for a set of days (from where the day before ended), and the places to pin. */
function legOf(stops: Array<RouteStop & { day: string }>, days: string[]) {
  const set = new Set(days);
  const i0 = stops.findIndex((s) => set.has(s.day));
  if (i0 < 0) return { line: [] as number[][], pins: [] as Array<RouteStop & { day: string }> };
  let i1 = i0;
  while (i1 + 1 < stops.length && set.has(stops[i1 + 1].day)) i1++;
  const from = Math.max(0, i0 - 1);
  return { line: routePoints(stops.slice(from, i1 + 1)), pins: stops.slice(i0, i1 + 1) };
}

type MapProps = {
  route: RouteDay[]; leg?: string[]; glow?: string[]; width: number; height: number; progress?: number; labels?: boolean; pad?: number;
  /** Fit the map to these days' places (else to Kenya, Tanzania and the trip's East African stops). */
  focus?: string[]; plane?: boolean;
};

/** The trip's map: countries (the trip's own in paper tone, neighbours dim), the whole route faint and dotted, the
 *  `glow` days' route in soft gold, the `leg` days' route drawing itself in gold with a pin per place. */
export const RouteMap: React.FC<MapProps> = ({ route, leg = [], glow = [], width, height, progress = 1, labels = true, pad = 40, focus, plane = false }) => {
  const m = useMemo(() => {
    const stops = stopsOf(route);
    const legDays = new Set(leg);
    const far = stops.some((s) => legDays.has(s.day) && s.by === "flight" && Math.abs(s.lat) > 8);  // a flight out of East Africa shows
    const own = new Set(route.map((d) => d.country).concat(stops.map((s) => s.country)).filter(Boolean) as string[]);
    let pts: number[][];
    if (focus && focus.length) {
      const f = new Set(focus);
      pts = stopsOf(route.filter((d) => f.has(d.day))).map((s) => [s.lon, s.lat]);
      const ctry = byName(route.find((d) => f.has(d.day))?.country);
      if (pts.length < 2) pts = [...pts, ...bounds(ctry)];
    } else {
      pts = [...bounds(byName("Kenya")), ...bounds(byName("Tanzania")), ...stops.filter((s) => far || Math.abs(s.lat) < 8).map((s) => [s.lon, s.lat])];
    }
    const project = fit(pts, width, height, pad);
    const lands = COUNTRIES.map((c) => ({ c, d: c.rings.map((r) => ringPath(r, project)).join(""), on: own.has(c.name) }));
    const all = routePoints(stops).map(project);
    const g = legOf(stops, glow);
    const l = legOf(stops, leg);
    const legXY = l.line.map(project);
    return { project, lands, all, glowXY: g.line.map(project), legXY, legLen: lineLength(legXY), pins: l.pins, own };
    // The arrays are made anew on every frame: their contents are the key, so the map is worked out once per part.
  }, [route, leg.join(), glow.join(), (focus || []).join(), width, height, pad]);
  const names = labels ? COUNTRIES.filter((c) => m.own.has(c.name)) : [];
  const dash = drawn(m.legLen, progress);
  const head = m.legXY.length > 1 ? along(m.legXY, progress) : null;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: "block", overflow: "hidden" }}>
      {m.lands.map(({ c, d, on }) => <path key={c.name} d={d} fill={on ? LAND_ON : LAND} fillOpacity={on ? 0.92 : 0.55} stroke={on ? "#8c8268" : "#5a5f52"} strokeWidth={on ? 1.2 : 0.8} />)}
      {names.map((c) => {
        const [x, y] = m.project(labelAt(c));
        return <text key={`n${c.name}`} x={x} y={y} textAnchor="middle" fill="#5b5440" fontFamily={DM} fontWeight={600} fontSize={Math.max(13, Math.min(22, width / 46))} letterSpacing="0.22em">{up(c.name)}</text>;
      })}
      {m.all.length > 1 ? <path d={linePath(m.all)} fill="none" stroke="#2b2a26" strokeOpacity={0.55} strokeWidth={2.4} strokeDasharray="1 9" strokeLinecap="round" /> : null}
      {m.glowXY.length > 1 ? <path d={linePath(m.glowXY)} fill="none" stroke={GOLD} strokeOpacity={0.55} strokeWidth={4} strokeLinecap="round" strokeLinejoin="round" /> : null}
      {m.legXY.length > 1 ? <path d={linePath(m.legXY)} fill="none" stroke="#b5832a" strokeWidth={5} strokeLinecap="round" strokeLinejoin="round" {...dash} /> : null}
      {m.pins.map((s, i) => {
        const [x, y] = m.project([s.lon, s.lat]);
        const show = interpolate(progress, [Math.min(0.95, i / Math.max(1, m.pins.length)), Math.min(1, i / Math.max(1, m.pins.length) + 0.1)], [0, 1], CLAMP);
        return <g key={`p${i}`} opacity={show}>{s.stop ? null : <circle cx={x} cy={y} r={17} fill="none" stroke={GOLD} strokeOpacity={0.7} strokeWidth={2} />}
          <circle cx={x} cy={y} r={s.stop ? 5 : 8} fill={s.stop ? PAPER : "#9a3324"} stroke={PAPER} strokeWidth={2.5} /></g>;
      })}
      {labels && m.pins.length ? (() => {
        // Where this leg ends, by name (the part before a comma: "Mara River"), on a paper halo so it reads on any land.
        const last = [...m.pins].reverse().find((s) => !s.stop) || m.pins[m.pins.length - 1];
        const [x, y] = m.project([last.lon, last.lat]);
        const name = last.place.split(/,|\(/)[0].trim();
        const right = x < width * 0.62;
        return <text x={right ? x + 26 : x - 26} y={y + 7} textAnchor={right ? "start" : "end"} fill="#2b2a26" stroke={PAPER} strokeWidth={6} paintOrder="stroke"
          fontFamily={DM} fontWeight={700} fontSize={Math.max(15, Math.min(24, width / 36))} opacity={interpolate(progress, [0.85, 1], [0, 1], CLAMP)}>{name}</text>;
      })() : null}
      {plane && head && progress > 0.02 && progress < 0.995 ? (
        <g transform={`translate(${head.x} ${head.y}) rotate(${head.angle})`}>
          <path d="M14 0 L-8 -9 L-4 0 L-8 9 Z" fill={PAPER} stroke="#2b2a26" strokeWidth={1.5} />
        </g>
      ) : null}
    </svg>
  );
};

/** The series title: a map of the trip with this leg drawing itself, and the episode's name beside it. */
export const SeriesTitle: React.FC<{ series: SeriesInfo; route: RouteDay[]; leg: string[]; frames: number }> = ({ series, route, leg, frames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const a = Math.min(interpolate(frame, [0, fps * 0.6], [0, 1], OUT), interpolate(frame, [frames - fps * 0.8, frames], [1, 0], CLAMP));
  const draw = interpolate(frame, [fps * 0.5, frames - fps * 1.6], [0, 1], { ...CLAMP, easing: Easing.inOut(Easing.cubic) });
  const rise = (d: number) => ({ opacity: interpolate(frame - d, [0, 16], [0, 1], OUT), transform: `translateY(${(1 - interpolate(frame - d, [0, 16], [0, 1], OUT)) * 24}px)` });
  return (
    <AbsoluteFill style={{ background: `rgba(13,15,11,${0.78 * a})` }}>
      <div style={{ position: "absolute", left: 120, top: 100, width: 860, height: 880, opacity: a, borderRadius: 6, overflow: "hidden", background: "#23271f",
        boxShadow: "0 20px 60px rgba(0,0,0,0.5)" }}>
        <RouteMap route={route} leg={leg} width={860} height={880} progress={draw} pad={56} />
      </div>
      <div style={{ position: "absolute", left: 1060, top: 0, bottom: 0, width: 740, display: "flex", flexDirection: "column", justifyContent: "center", opacity: a, color: PAPER, textShadow: SHADOW }}>
        <div style={{ ...rise(4), fontFamily: DM, fontWeight: 600, fontSize: 24, ...tracked(0.26), color: GOLD }}>{up(series.kicker)}</div>
        <div style={{ ...rise(8), width: 72, height: 2, background: GOLD, margin: "28px 0 26px" }} />
        <div style={{ ...rise(10), fontFamily: FRAUNCES, fontWeight: 500, fontSize: series.episode.length > 34 ? 76 : 92, lineHeight: 1.04, letterSpacing: "-0.012em",
          fontVariationSettings: "'opsz' 144, 'SOFT' 50" }}>{series.episode}</div>
        <div style={{ ...rise(16), fontFamily: DM, fontWeight: 500, fontSize: 30, marginTop: 30, opacity: 0.85 }}>{series.name}</div>
      </div>
    </AbsoluteFill>
  );
};

/** A chapter's place tag: the day, the place, the country (or the border crossed), and a locator map beside it. */
export const PlaceTag: React.FC<{ sub?: string; place?: string; country?: string; border?: string; day?: string; route: RouteDay[]; frames: number }> = ({ sub, place, country, border, day, route, frames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const a = Math.min(interpolate(frame, [0, fps * 0.5], [0, 1], OUT), interpolate(frame, [frames - fps * 0.8, frames], [1, 0], CLAMP));
  const today = route.find((d) => d.day === day);
  const flight = !!today?.stops?.some((s) => s.by === "flight");
  const draw = interpolate(frame, [fps * 0.4, frames - fps * 1.0], [0, 1], { ...CLAMP, easing: Easing.inOut(Easing.cubic) });
  const rise = (d: number) => ({ opacity: interpolate(frame - d, [0, 16], [0, 1], OUT), transform: `translateY(${(1 - interpolate(frame - d, [0, 16], [0, 1], OUT)) * 22}px)` });
  const size = flight ? 230 : 170;
  // From a Google Maps Timeline import: how long they stayed at the day's main place ("2 nights", "3 h 10 min").
  const mainStop = today?.stops?.find((s) => s.main) as (RouteStop & { stay?: number }) | undefined;
  const stayed = mainStop?.stay ? stayWords(mainStop.stay) : "";
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <AbsoluteFill style={{ background: "radial-gradient(ellipse at 0% 100%, rgba(0,0,0,0.62) 0%, rgba(0,0,0,0.32) 38%, rgba(0,0,0,0) 70%)", opacity: a }} />
      <div style={{ position: "absolute", left: 120, bottom: 100, display: "flex", alignItems: "flex-end", gap: 34, opacity: a }}>
        {today ? (
          <div style={{ ...rise(0), width: size, height: size, borderRadius: 4, overflow: "hidden", background: "#23271f", boxShadow: "0 10px 30px rgba(0,0,0,0.45)", outline: `2px solid ${GOLD}` }}>
            <RouteMap route={route} leg={[day as string]} focus={flight ? [day as string] : undefined} width={size} height={size} pad={flight ? 18 : 14}
              progress={draw} labels={false} plane={flight} />
          </div>
        ) : null}
        <div style={{ color: PAPER, textShadow: SHADOW }}>
          {sub ? <div style={{ ...rise(3), fontFamily: DM, fontWeight: 600, fontSize: 24, ...tracked(0.22), color: GOLD }}>{up(sub)}</div> : null}
          {place ? <div style={{ ...rise(7), fontFamily: FRAUNCES, fontWeight: 500, fontSize: place.length > 34 ? 52 : 66, lineHeight: 1.06, margin: "10px 0 8px", maxWidth: 1240,
            fontVariationSettings: "'opsz' 100, 'SOFT' 50" }}>{place}</div> : null}
          {border || country ? <div style={{ ...rise(11), fontFamily: DM, fontWeight: 600, fontSize: 26, ...tracked(0.3) }}>{up(border || country || "")}{stayed ? <span style={{ color: GOLD }}>{`  ·  ${up(stayed)}`}</span> : null}</div> : null}
        </div>
      </div>
    </AbsoluteFill>
  );
};

/** "Previously": a quiet label and the map with the legs already seen glowing, over the part before's moments. */
export const Recap: React.FC<{ route: RouteDay[]; recap: SeriesRecap; frames: number }> = ({ route, recap, frames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const a = Math.min(interpolate(frame, [0, fps * 0.4], [0, 1], OUT), interpolate(frame, [frames - fps * 0.5, frames], [1, 0], CLAMP));
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <AbsoluteFill style={{ background: "linear-gradient(90deg, rgba(0,0,0,0.5) 0%, rgba(0,0,0,0) 45%)", opacity: a }} />
      <div style={{ position: "absolute", left: 120, top: 100, opacity: a, color: PAPER, textShadow: SHADOW }}>
        <div style={{ fontFamily: DM, fontWeight: 600, fontSize: 26, ...tracked(0.4), color: GOLD }}>PREVIOUSLY</div>
        <div style={{ width: 60, height: 2, background: GOLD, marginTop: 18 }} />
      </div>
      <div style={{ position: "absolute", right: 120, bottom: 100, width: 380, height: 380, opacity: a * 0.95, borderRadius: 4, overflow: "hidden", background: "#23271f",
        boxShadow: "0 12px 34px rgba(0,0,0,0.5)" }}>
        <RouteMap route={route} glow={recap.leg} width={380} height={380} pad={22} labels={false} />
      </div>
    </AbsoluteFill>
  );
};

/** YouTube's end-screen elements, in 1920x1080 pixels: a video tile, a playlist tile and the subscribe circle. */
export const END_BOXES = { video: { x: 1236, y: 150, w: 576, h: 324 }, playlist: { x: 1236, y: 540, w: 352, h: 198 }, subscribe: { x: 1640, y: 549, d: 180 } };

/** The next-part card (the last seconds): the next part's opening plays on the left, its name and its leg of the
 *  map; the right stays clear in faint frames sized for YouTube's end-screen elements. The last part points back
 *  to Part 1. */
export const NextCard: React.FC<{ next: SeriesNext; route: RouteDay[]; frames: number }> = ({ next, route, frames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const a = interpolate(frame, [0, fps * 1.0], [0, 1], OUT);
  const draw = interpolate(frame, [fps * 1.0, fps * 5], [0, 1], { ...CLAMP, easing: Easing.inOut(Easing.cubic) });
  const label = next.first ? "Watch the series from Part 1" : `Next · Part ${next.n} of ${next.of}`;
  const B = END_BOXES;
  const frameBox = (style: React.CSSProperties, word: string) => (
    <div style={{ position: "absolute", border: "1.5px solid rgba(250,248,241,0.22)", display: "flex", alignItems: "center", justifyContent: "center",
      fontFamily: DM, fontWeight: 600, fontSize: 18, ...tracked(0.3), color: "rgba(250,248,241,0.35)", ...style }}>{up(word)}</div>
  );
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div style={{ position: "absolute", left: 1056, top: 0, right: 0, bottom: 0, background: INK, opacity: a }} />
      <AbsoluteFill style={{ background: "linear-gradient(0deg, rgba(0,0,0,0.72) 0%, rgba(0,0,0,0.2) 45%, rgba(0,0,0,0) 70%)", width: 1056, opacity: a }} />
      <div style={{ position: "absolute", left: 120, bottom: 100, width: 880, opacity: a, color: PAPER, textShadow: SHADOW }}>
        <div style={{ fontFamily: DM, fontWeight: 600, fontSize: 26, ...tracked(0.32), color: GOLD }}>{up(label)}</div>
        <div style={{ width: 72, height: 2, background: GOLD, margin: "22px 0 20px" }} />
        <div style={{ fontFamily: FRAUNCES, fontWeight: 500, fontSize: next.title.length > 34 ? 60 : 72, lineHeight: 1.06, fontVariationSettings: "'opsz' 144, 'SOFT' 50" }}>{next.title}</div>
      </div>
      <div style={{ position: "absolute", left: 120, top: 100, width: 300, height: 300, opacity: a, borderRadius: 4, overflow: "hidden", background: "#23271f", boxShadow: "0 12px 34px rgba(0,0,0,0.5)" }}>
        <RouteMap route={route} leg={next.leg} width={300} height={300} pad={20} labels={false} progress={draw} />
      </div>
      <div style={{ opacity: a }}>
        {frameBox({ left: B.video.x, top: B.video.y, width: B.video.w, height: B.video.h }, next.first ? "Part 1" : `Part ${next.n}`)}
        {frameBox({ left: B.playlist.x, top: B.playlist.y, width: B.playlist.w, height: B.playlist.h }, "The series")}
        {frameBox({ left: B.subscribe.x, top: B.subscribe.y, width: B.subscribe.d, height: B.subscribe.d, borderRadius: 999, fontSize: 14 }, "Subscribe")}
      </div>
    </AbsoluteFill>
  );
};
