/**
 * FILE: src/Post.tsx
 * PURPOSE: Photo posts: one still the width of every slide side by side (panels x 1080 by 1350), drawn in one of the
 *          looks in shared/post-templates.json. py/studio/stills.py cuts it into exact 1080 px slides afterwards, so
 *          a title or a print can lie across a join and the slides line up when someone swipes.
 * OVERVIEW: Post picks the look's component. Every look reads the same props: the photos (already sized and stripped
 *           of location data by stills.py), the theme's words and a seed, so the same set always draws the same way.
 * DEPENDENCIES: remotion (Img, staticFile, delayRender), public/fonts (OFL, with their licences)
 * USAGE: rendered by scripts/post-stills.mjs (bundle once, renderStill per set); registered in src/Root.tsx as "Post".
 */
import React, { createContext, useContext, useEffect, useState } from "react";
import { AbsoluteFill, Img, cancelRender, continueRender, delayRender, staticFile } from "remotion";

export type PostPhoto = { src: string; w: number; h: number; fx?: number; fy?: number };
export type PostItem = { head: string; line: string };
export type PostProps = {
  style: string; panels: number; w: number; h: number; seed: number;
  photos: PostPhoto[];
  title: string; titleJa: string; sub: string; kicker: string;
  notes: string[]; notesJa: string[]; poem: string[]; items: PostItem[];
  hookJa: string; hookEn: string; handle: string; brand: string; date: string;
  palette: { bg: string; ink: string; accent: string; paper: string };
  /* Per set, so no two runs look alike: colours taken from its own photos (most vivid first), true facts for the
     number looks, and a layout variant each look reads its own way. */
  photoPalette?: string[]; facts?: { big: string; unit: string; ja: string; en: string }[]; variant?: number;
  /* Where the post is from, for the looks that print a place (a masthead, a postmark, a boarding pass). The ranch
     workspace passes TSUMAGOI / 嬬恋 / 1,444 / GUNMA · JAPAN; any other brand its own name and no altitude or region. */
  place?: string; placeJa?: string; placeLong?: string; alt?: string; region?: string; origin?: { code: string; ja: string };
  ticket?: { seat: string; gate: string; cls: string; code?: string };
};
const PLACE = (p: PostProps) => (p.place || p.brand || "HELLO").toUpperCase().slice(0, 16);
/* A short form for labels and stamps: the first word of a long name ("CAFE" of "CAFE KUMO & BAKERY"), never cut mid-word. */
const SHORT = (p: PostProps) => { const full = PLACE(p); return full.length <= 10 ? full : (full.split(/[\s&,・]+/).find(Boolean) || full).slice(0, 10); };
const PLACEJA = (p: PostProps) => p.placeJa || p.brand || p.titleJa;
const titleCase = (s: string) => s.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());

export const emptyPost: PostProps = {
  style: "pano", panels: 5, w: 1080, h: 1350, seed: 1, photos: [], title: "", titleJa: "", sub: "", kicker: "",
  notes: [], notesJa: [], poem: [], items: [], hookJa: "", hookEn: "", handle: "", brand: "", date: "",
  palette: { bg: "#8a2a14", ink: "#2b1d14", accent: "#e07b39", paper: "#f4ece0" },
};

/* ---------- fonts: only the faces a look uses, loaded before the still is taken ---------- */
const FACES: Record<string, [string, string, string?][]> = {
  Fraunces: [["Fraunces.ttf", "100 900"], ["Fraunces-Italic.ttf", "100 900", "italic"]],
  Caveat: [["Caveat.ttf", "400 700"]],
  "Klee One": [["KleeOne-SemiBold.ttf", "600"]],
  "Shippori Mincho": [["ShipporiMincho-Medium.ttf", "500"], ["ShipporiMincho-Bold.ttf", "700"]],
  "Zen Old Mincho": [["ZenOldMincho-Medium.ttf", "500"], ["ZenOldMincho-Bold.ttf", "700"]],
  "Zen Kaku Gothic New": [["ZenKakuGothicNew-Medium.ttf", "500"], ["ZenKakuGothicNew-Bold.ttf", "700"]],
  "Playfair Display": [["PlayfairDisplay.ttf", "400 900"], ["PlayfairDisplay-Italic.ttf", "400 900", "italic"]],
  "Bodoni Moda": [["BodoniModa.ttf", "400 900"]],
  "DM Sans": [["DMSans.ttf", "100 1000"]],
  "Dela Gothic One": [["DelaGothicOne-Regular.ttf", "400"]],
  "IBM Plex Mono": [["IBMPlexMono-Medium.ttf", "500"]],
  "Special Elite": [["SpecialElite-Regular.ttf", "400"]],
  VT323: [["VT323-Regular.ttf", "400"]],
  Anton: [["Anton-Regular.ttf", "400"]],
  "Bebas Neue": [["BebasNeue-Regular.ttf", "400"]],
  DotGothic16: [["DotGothic16-Regular.ttf", "400"]],
  "Barlow Condensed": [["BarlowCondensed-SemiBold.ttf", "600"]],
  "Zen Maru Gothic": [["ZenMaruGothic-Medium.ttf", "500"], ["ZenMaruGothic-Bold.ttf", "700"]],
  Jost: [["Jost.ttf", "100 900"]],
  "Kaisei Decol": [["KaiseiDecol-Bold.ttf", "700"]],
  Cinzel: [["Cinzel.ttf", "400 900"]],
};
const USES: Record<string, string[]> = {
  pano: ["Fraunces", "Caveat", "Shippori Mincho"],
  polaroid: ["Caveat", "Klee One", "Fraunces"],
  film: ["IBM Plex Mono", "VT323", "Special Elite", "Klee One"],
  magazine: ["Bodoni Moda", "Playfair Display", "Zen Old Mincho", "DM Sans"],
  dump: ["Caveat", "Klee One", "DM Sans"],
  scrapbook: ["Caveat", "Klee One", "Special Elite"],
  gallery: ["DM Sans", "Zen Kaku Gothic New", "Fraunces"],
  tategaki: ["Shippori Mincho", "Fraunces"],
  guide: ["Zen Kaku Gothic New", "Dela Gothic One", "DM Sans"],
  newspaper: ["Playfair Display", "Zen Old Mincho", "IBM Plex Mono", "Bodoni Moda"],
  bento: ["Zen Kaku Gothic New", "DM Sans", "Anton", "Fraunces"],
  shapes: ["Anton", "Dela Gothic One", "Jost", "Zen Maru Gothic"],
  brutal: ["Anton", "IBM Plex Mono", "Zen Kaku Gothic New", "Bebas Neue"],
  riso: ["Anton", "Special Elite", "Bodoni Moda", "Dela Gothic One", "Caveat", "Zen Old Mincho", "IBM Plex Mono"],
  typeclip: ["Anton", "Dela Gothic One", "Jost", "Zen Kaku Gothic New"],
  ticket: ["IBM Plex Mono", "Barlow Condensed", "Zen Kaku Gothic New", "Caveat", "Special Elite"],
  contact: ["IBM Plex Mono", "Caveat", "Zen Kaku Gothic New"],
  aura: ["Fraunces", "Zen Maru Gothic", "Jost"],
  maximal: ["Anton", "Dela Gothic One", "Caveat", "Kaisei Decol", "Bebas Neue"],
  numbers: ["Anton", "Zen Kaku Gothic New", "DM Sans"],
  phone: ["DM Sans", "Zen Kaku Gothic New"],
  pixel: ["DotGothic16", "VT323"],
};
const loaded = new Map<string, Promise<unknown>>();
const loadFace = (family: string, file: string, weight: string, style = "normal") => {
  const key = `${family}|${file}`;
  if (!loaded.has(key)) {
    const face = new FontFace(family, `url(${staticFile(`fonts/${file}`)})`, { weight, style });
    loaded.set(key, face.load().then((f) => (document.fonts as unknown as { add: (x: FontFace) => void }).add(f)));
  }
  return loaded.get(key)!;
};
const useFonts = (families: string[]) => {
  const [handle] = useState(() => delayRender("post fonts"));
  useEffect(() => {
    Promise.all(families.flatMap((fam) => (FACES[fam] || []).map(([file, weight, style]) => loadFace(fam, file, weight, style))))
      .then(() => continueRender(handle))
      .catch((err) => cancelRender(err));
  }, [handle, families]);
};

/* ---------- helpers ---------- */
const rng = (seed: number) => {
  let a = (seed >>> 0) || 1;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
};
const at = <T,>(list: T[], i: number): T => list[((i % list.length) + list.length) % list.length];
/* The frame a photo is drawn in, so it can put the photo's subject (fx, fy from stills.focal_point) in the middle of
   the frame instead of cutting it off: the object-position imgix's focal-point crop would choose, clamped so the
   photo still covers the frame. A frame of unknown size falls back to percentages of the focal point. */
const FrameCtx = createContext<{ w: number; h: number } | null>(null);
const Frame: React.FC<{ w: number; h: number; children?: React.ReactNode }> = ({ w, h, children }) => <FrameCtx.Provider value={{ w, h }}>{children}</FrameCtx.Provider>;
const focus = (p: PostPhoto, frame: { w: number; h: number } | null): string => {
  const fx = p.fx ?? 0.5, fy = p.fy ?? 0.5;
  if (!frame || !p.w || !p.h) return `${(fx * 100).toFixed(1)}% ${(fy * 100).toFixed(1)}%`;
  const s = Math.max(frame.w / p.w, frame.h / p.h), rw = p.w * s, rh = p.h * s;
  const ox = Math.min(0, Math.max(frame.w - rw, frame.w / 2 - fx * rw)), oy = Math.min(0, Math.max(frame.h - rh, frame.h / 2 - fy * rh));
  return `${ox.toFixed(1)}px ${oy.toFixed(1)}px`;
};
const Photo: React.FC<{ p: PostPhoto | undefined; style?: React.CSSProperties; filter?: string }> = ({ p, style, filter }) => {
  const frame = useContext(FrameCtx);
  return p ? <Img src={staticFile(p.src)} style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: focus(p, frame), display: "block", filter, ...style }} />
    : <div style={{ width: "100%", height: "100%", background: "#ccc", ...style }} />;
};
const Box: React.FC<{ x: number; y: number; w: number; h: number; style?: React.CSSProperties; children?: React.ReactNode }> = ({ x, y, w, h, style, children }) => (
  <div style={{ position: "absolute", left: x, top: y, width: w, height: h, overflow: "hidden", ...style }}><Frame w={w} h={h}>{children}</Frame></div>
);
const Text: React.FC<{ x: number; y: number; w?: number; style: React.CSSProperties; children: React.ReactNode }> = ({ x, y, w, style, children }) => (
  <div style={{ position: "absolute", left: x, top: y, width: w, ...style }}>{children}</div>
);
const SHADOW = "0 18px 40px rgba(0,0,0,0.42), 0 2px 6px rgba(0,0,0,0.3)";
const softText = "0 2px 18px rgba(0,0,0,0.35)";

/* ---------- 1. Seamless panorama: photos edge to edge, a colour panel, a thin title over the joins ---------- */
const Pano: React.FC<PostProps> = (p) => {
  const { w, h, panels } = p;
  const lead = false;  // 21 Nov: a title starting on slide 1 read as cut off ("Fire, flour, a…"); slide 1 gets its own hook
  const mid = Math.floor(panels / 2);
  let k = 0;
  return (
    <AbsoluteFill style={{ background: p.palette.bg }}>
      {Array.from({ length: panels }, (_, i) => i === mid ? null : (
        <Box key={i} x={i * w} y={0} w={w} h={h}><Photo p={p.photos[k++]} /></Box>
      ))}
      <Box x={0} y={h * 0.58} w={w} h={h * 0.42} style={{ background: "linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.55) 100%)" }} />
      <Text x={60} y={h - 250} w={w - 120} style={{ color: "#fff", textShadow: softText }}>
        <div style={{ fontFamily: "Shippori Mincho", fontWeight: 700, fontSize: 60, lineHeight: 1.35 }}>{p.hookJa}</div>
        <div style={{ fontFamily: "Caveat", fontSize: 44, marginTop: 8 }}>{p.hookEn} →</div>
      </Text>
      <Text x={mid * w} y={h * 0.27} w={w} style={{ textAlign: "center", fontFamily: "Shippori Mincho", fontWeight: 500, fontSize: 34, letterSpacing: "0.5em", color: "rgba(255,255,255,0.85)" }}>{p.kicker}</Text>
      <Text x={lead ? 80 : 0} y={h * 0.37} w={lead ? panels * w - 80 : panels * w} style={{ textAlign: lead ? "left" : "center", whiteSpace: "nowrap", fontFamily: "Fraunces", fontWeight: 200, fontSize: 250, lineHeight: 1, color: "#fff", letterSpacing: "0.01em", textShadow: softText, fontVariationSettings: "'opsz' 144, 'SOFT' 0" }}>{p.title}</Text>
      <Text x={mid * w} y={h * 0.6} w={w} style={{ textAlign: "center", fontFamily: "Caveat", fontWeight: 500, fontSize: 64, color: "#fff" }}>{p.sub}</Text>
      <Text x={mid * w} y={h * 0.9} w={w} style={{ textAlign: "center", fontFamily: "Shippori Mincho", fontSize: 30, color: "rgba(255,255,255,0.75)", letterSpacing: "0.2em" }}>{p.handle}</Text>
      <Text x={w * 0.54} y={h * 0.3} w={w * 0.42} style={{ fontFamily: "Caveat", fontSize: 58, color: "#fff", textShadow: softText }}>{at(p.notes, 0)}</Text>
      <Text x={w * 0.06} y={h * 0.5} w={w * 0.6} style={{ fontFamily: "Caveat", fontSize: 58, color: "#fff", textShadow: softText }}>{at(p.notes, 1)}</Text>
      <Text x={(panels - 1) * w + w * 0.18} y={h * 0.4} w={w * 0.76} style={{ fontFamily: "Caveat", fontSize: 54, color: "#fff", textShadow: softText, textAlign: "right" }}>{at(p.notes, 2)}</Text>
    </AbsoluteFill>
  );
};

/* ---------- 2. Polaroid collage: prints over a blurred photo; one print lies across each join ---------- */
const Polaroid: React.FC<PostProps> = (p) => {
  const { w, h, panels } = p;
  const r = rng(p.seed);
  const fw = w * 0.5, pad = fw * 0.055, pic = fw - pad * 2;
  const frames: { x: number; y: number; t: number; i: number; note?: string }[] = [];
  let n = 1;
  for (let i = 0; i < panels; i++) {
    frames.push({ x: i * w + w * (0.06 + r() * 0.06), y: h * (0.05 + r() * 0.05), t: (r() - 0.5) * 14, i: n++ });
    if (i < panels - 1) frames.push({ x: i * w + w * (0.72 + r() * 0.04), y: h * (0.46 + r() * 0.05), t: (r() - 0.5) * 14, i: n++, note: at(p.notes, i) });
    else frames.push({ x: i * w + w * 0.3, y: h * 0.5, t: (r() - 0.5) * 12, i: n++, note: at(p.notes, i) });
  }
  return (
    <AbsoluteFill style={{ background: "#222", overflow: "hidden" }}>
      <AbsoluteFill style={{ transform: "scale(1.08)" }}><Photo p={p.photos[0]} filter="blur(26px) brightness(0.88) saturate(1.1)" /></AbsoluteFill>
      {frames.map((f) => (
        <div key={f.i} style={{ position: "absolute", left: f.x, top: f.y, width: fw, padding: pad, paddingBottom: fw * 0.2, background: "#f7f4ec", boxShadow: SHADOW, transform: `rotate(${f.t.toFixed(2)}deg)` }}>
          <div style={{ width: pic, height: pic }}><Frame w={pic} h={pic}><Photo p={at(p.photos.slice(1).length ? p.photos.slice(1) : p.photos, f.i - 1)} /></Frame></div>
          {f.note ? <div style={{ position: "absolute", left: pad, right: pad, bottom: fw * 0.04, fontFamily: "Caveat", fontSize: 44, color: "#3b3b3b", textAlign: "center" }}>{f.note}</div> : null}
        </div>
      ))}
      <div style={{ position: "absolute", left: w * 0.1, top: h * 0.62, padding: "22px 36px", background: "rgba(247,244,236,0.94)", boxShadow: SHADOW, transform: "rotate(-3deg)" }}>
        <div style={{ fontFamily: "Fraunces", fontWeight: 300, fontSize: 74, color: p.palette.ink, lineHeight: 1.05 }}>{p.title}</div>
        <div style={{ fontFamily: "Klee One", fontSize: 36, color: p.palette.ink, marginTop: 10 }}>{p.titleJa} · {p.handle}</div>
      </div>
    </AbsoluteFill>
  );
};

/* ---------- 3. Film strip: two frames a slide, sprocket holes running through every join ---------- */
const Film: React.FC<PostProps> = (p) => {
  const { w, h, panels } = p;
  const holes = (top: number) => (
    <div style={{ position: "absolute", left: 0, top, width: panels * w, height: 44, background: "repeating-linear-gradient(90deg, transparent 0 26px, #e9e2d0 26px 58px, transparent 58px 84px)", opacity: 0.92, borderRadius: 6 }} />
  );
  const fh = h * 0.36, fwid = w * 0.86;
  return (
    <AbsoluteFill style={{ background: "#111" }}>
      {holes(h * 0.035)}{holes(h * 0.492)}{holes(h * 0.935)}
      {Array.from({ length: panels * 2 }, (_, k) => {
        const i = Math.floor(k / 2), row = k % 2;
        const x = i * w + (w - fwid) / 2, y = row ? h * 0.53 : h * 0.1;
        return (
          <React.Fragment key={k}>
            <Box x={x} y={y} w={fwid} h={fh} style={{ borderRadius: 10 }}><Photo p={at(p.photos, k)} filter="contrast(1.06) saturate(1.12) sepia(0.08)" /></Box>
            <Text x={x + 6} y={y + fh + 6} style={{ fontFamily: "IBM Plex Mono", fontSize: 22, color: "#f2a33a", letterSpacing: "0.2em" }}>{`${PLACE(p)} 400   ▸ ${k + 1}   ${k + 1}A`}</Text>
            <Text x={x + fwid - 210} y={y + fh - 64} style={{ fontFamily: "VT323", fontSize: 54, color: "#ff8a1f", textShadow: "0 0 8px rgba(255,120,20,0.8)" }}>{p.date}</Text>
          </React.Fragment>
        );
      })}
      <div style={{ position: "absolute", left: w * 0.08, top: h * 0.135, width: w * 0.62, padding: "26px 30px", background: "rgba(17,17,17,0.82)", border: "2px solid #f2a33a", borderRadius: 8 }}>
        <div style={{ fontFamily: "Special Elite", fontSize: 58, color: "#f4ead2", lineHeight: 1.1 }}>{p.title}</div>
        <div style={{ fontFamily: "Klee One", fontSize: 34, color: "#f2a33a", marginTop: 10 }}>{p.titleJa} — roll 01</div>
      </div>
    </AbsoluteFill>
  );
};

/* ---------- 4. Magazine: a cover with a masthead, then pages with a photo and a short story ---------- */
const Magazine: React.FC<PostProps> = (p) => {
  const { w, h, panels } = p;
  const pages = Array.from({ length: panels - 1 }, (_, i) => i + 1);
  return (
    <AbsoluteFill style={{ background: p.palette.paper }}>
      <Box x={0} y={0} w={w} h={h}><Photo p={p.photos[0]} /></Box>
      <Box x={0} y={0} w={w} h={h} style={{ background: "linear-gradient(180deg, rgba(0,0,0,0.38) 0%, rgba(0,0,0,0) 32%, rgba(0,0,0,0) 60%, rgba(0,0,0,0.55) 100%)" }} />
      <Text x={0} y={56} w={w} style={{ textAlign: "center", fontFamily: "Bodoni Moda", fontWeight: 700, fontSize: 142, color: "#fff", letterSpacing: "0.02em", lineHeight: 1, textShadow: softText, whiteSpace: "nowrap" }}>{SHORT(p)}</Text>
      <Text x={60} y={236} w={w - 120} style={{ display: "flex", justifyContent: "space-between", fontFamily: "DM Sans", fontWeight: 600, fontSize: 24, letterSpacing: "0.24em", color: "#fff", borderTop: "2px solid rgba(255,255,255,0.8)", paddingTop: 12 }}>
        <span>NO. 11</span><span>{p.kicker}</span><span>{p.alt ? `${p.alt} M` : p.date}</span>
      </Text>
      <Text x={64} y={h * 0.7} w={w * 0.78} style={{ color: "#fff" }}>
        <div style={{ fontFamily: "Playfair Display", fontStyle: "italic", fontSize: 84, lineHeight: 1.02 }}>{p.title}</div>
        <div style={{ fontFamily: "Zen Old Mincho", fontWeight: 700, fontSize: 40, marginTop: 18 }}>{p.hookJa}</div>
        <div style={{ fontFamily: "DM Sans", fontSize: 26, marginTop: 16, letterSpacing: "0.14em" }}>SWIPE →</div>
      </Text>
      {pages.map((i) => {
        const x = i * w, last = i === panels - 1, item = at(p.items, i - 1);
        return (
          <React.Fragment key={i}>
            <Box x={x + 70} y={110} w={w - 140} h={h * 0.56}><Photo p={at(p.photos, i)} /></Box>
            <Text x={x + 70} y={50} w={w - 140} style={{ display: "flex", justifyContent: "space-between", fontFamily: "DM Sans", fontWeight: 600, fontSize: 20, letterSpacing: "0.26em", color: p.palette.ink }}>
              <span>{PLACE(p)}</span><span>{String(i + 1).padStart(2, "0")}</span>
            </Text>
            <Text x={x + 70} y={110 + h * 0.56 + 44} w={w - 140} style={{ color: p.palette.ink }}>
              <div style={{ fontFamily: "Playfair Display", fontStyle: "italic", fontSize: 62, lineHeight: 1.05 }}>{last ? p.hookEn : at(p.notes, i - 1)}</div>
              <div style={{ display: "flex", gap: 36, marginTop: 22 }}>
                <div style={{ flex: 1.25, fontFamily: "Zen Old Mincho", fontWeight: 700, fontSize: 34, lineHeight: 1.5 }}>{last ? p.brand : item.head}</div>
                <div style={{ flex: 1.1, fontFamily: "Zen Old Mincho", fontWeight: 500, fontSize: 30, lineHeight: 1.7, borderLeft: `2px solid ${p.palette.accent}`, paddingLeft: 22 }}>{last ? `${p.handle} をフォローして、次の号も。` : item.line}</div>
              </div>
            </Text>
          </React.Fragment>
        );
      })}
    </AbsoluteFill>
  );
};

/* ---------- 5. Photo dump: a different grid each slide, thin white gaps, handwritten notes ---------- */
const DUMP_LAYOUTS: [number, number, number, number][][] = [
  [[0, 0, 1, 1]],
  [[0, 0, 1, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]],
  [[0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]],
  [[0, 0, 0.58, 1], [0.58, 0, 0.42, 0.5], [0.58, 0.5, 0.42, 0.5]],
  [[0, 0, 1, 0.62], [0, 0.62, 1, 0.38]],
];
const Dump: React.FC<PostProps> = (p) => {
  const { w, h, panels } = p;
  const gap = 12, m = 40, foot = 110;
  let k = 0;
  return (
    <AbsoluteFill style={{ background: "#f6f3ec" }}>
      {Array.from({ length: panels }, (_, i) => {
        const cells = at(DUMP_LAYOUTS, i);
        const iw = w - m * 2, ih = h - m - foot;
        return (
          <React.Fragment key={i}>
            {cells.map(([cx, cy, cw, ch], j) => (
              <Box key={j} x={i * w + m + cx * iw + (cx ? gap / 2 : 0)} y={m + cy * ih + (cy ? gap / 2 : 0)} w={cw * iw - (cx ? gap / 2 : 0) - (cx + cw < 1 ? gap / 2 : 0)} h={ch * ih - (cy ? gap / 2 : 0) - (cy + ch < 1 ? gap / 2 : 0)}>
                <Photo p={at(p.photos, k++)} />
              </Box>
            ))}
            <Text x={i * w + m} y={h - foot + 18} w={iw} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", color: "#3a3631" }}>
              <span style={{ fontFamily: "Caveat", fontSize: 58 }}>{i === 0 ? `${p.title} ✶` : at(p.notes, i - 1)}</span>
              <span style={{ fontFamily: "DM Sans", fontSize: 22, letterSpacing: "0.2em" }}>{i === 0 ? p.date : `${i + 1}/${panels}`}</span>
            </Text>
          </React.Fragment>
        );
      })}
    </AbsoluteFill>
  );
};

/* ---------- 6. Scrapbook: paper, taped prints, handwritten notes, doodles and a stamp ---------- */
const Tape: React.FC<{ x: number; y: number; r: number; w?: number }> = ({ x, y, r, w = 190 }) => (
  <div style={{ position: "absolute", left: x, top: y, width: w, height: 54, background: "rgba(240,226,170,0.78)", transform: `rotate(${r}deg)`, boxShadow: "0 1px 3px rgba(0,0,0,0.15)" }} />
);
const Scrapbook: React.FC<PostProps> = (p) => {
  const { w, h, panels } = p;
  const r = rng(p.seed + 7);
  let k = 0;
  return (
    <AbsoluteFill style={{ background: `${p.palette.paper} repeating-linear-gradient(180deg, transparent 0 62px, rgba(120,140,170,0.18) 62px 64px)` }}>
      {Array.from({ length: panels }, (_, i) => {
        const x = i * w, two = i % 2 === 1;
        const t1 = (r() - 0.5) * 8, t2 = (r() - 0.5) * 8;
        return (
          <React.Fragment key={i}>
            <div style={{ position: "absolute", left: x + (two ? 70 : 120), top: two ? 90 : 210, width: two ? 600 : 840, height: two ? 520 : 700, padding: 18, background: "#fff", boxShadow: SHADOW, transform: `rotate(${t1}deg)` }}>
              <Photo p={at(p.photos, k++)} />
            </div>
            {two ? <div style={{ position: "absolute", left: x + 380, top: 640, width: 600, height: 500, padding: 18, background: "#fff", boxShadow: SHADOW, transform: `rotate(${t2}deg)` }}><Photo p={at(p.photos, k++)} /></div> : null}
            <Tape x={x + (two ? 260 : 400)} y={two ? 60 : 180} r={-4 + t1} />
            {two ? <Tape x={x + 820} y={620} r={38} w={160} /> : null}
            <Text x={x + 90} y={two ? h - 160 : h - 300} w={w - 180} style={{ fontFamily: i % 2 ? "Klee One" : "Caveat", fontSize: i % 2 ? 46 : 64, color: p.palette.ink, transform: "rotate(-2deg)" }}>
              {i === 0 ? p.title : i % 2 ? at(p.notesJa, i) : at(p.notes, i)}
            </Text>
            <svg style={{ position: "absolute", left: x + w - 260, top: two ? h - 260 : 70 }} width={200} height={160} viewBox="0 0 200 160">
              <path d={two ? "M10 30 C 80 0, 160 40, 150 120 M150 120 l-24 -8 M150 120 l8 -24" : "M100 20 l14 40 42 0 -34 26 13 40 -35 -25 -35 25 13 -40 -34 -26 42 0 z"} fill="none" stroke={p.palette.accent} strokeWidth={5} strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </React.Fragment>
        );
      })}
      <div style={{ position: "absolute", left: w * 0.7, top: h * 0.7, width: 230, height: 230, background: "rgba(255,255,255,0.35)", borderRadius: "50%", border: `5px solid ${p.palette.accent}`, color: p.palette.accent, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", transform: "rotate(12deg)", fontFamily: "Special Elite" }}>
        <div style={{ fontSize: 28, letterSpacing: "0.2em" }}>{p.alt ? "ALTITUDE" : "POSTED"}</div>
        <div style={{ fontSize: p.alt ? 56 : 40 }}>{p.alt ? `${p.alt}m` : PLACEJA(p).slice(0, 6)}</div>
        <div style={{ fontSize: 24 }}>{p.date}</div>
      </div>
      <Text x={(panels - 1) * w + 90} y={h - 80} w={w - 180} style={{ fontFamily: "Klee One", fontSize: 36, color: p.palette.ink, textAlign: "right" }}>{p.handle}</Text>
    </AbsoluteFill>
  );
};

/* ---------- 7. Gallery: one photo a slide on white, numbered like an exhibition ---------- */
const Gallery: React.FC<PostProps> = (p) => {
  const { w, h, panels } = p;
  return (
    <AbsoluteFill style={{ background: "#fbfaf7" }}>
      {Array.from({ length: panels }, (_, i) => (
        <React.Fragment key={i}>
          <Text x={i * w + 90} y={64} w={w - 180} style={{ display: "flex", justifyContent: "space-between", fontFamily: "DM Sans", fontWeight: 500, fontSize: 21, letterSpacing: "0.3em", color: "#555" }}>
            <span>{(p.placeLong || p.brand || "").toUpperCase()}</span><span>{String(i + 1).padStart(2, "0")} / {String(panels).padStart(2, "0")}</span>
          </Text>
          <Box x={i * w + 90} y={130} w={w - 180} h={h - 380}><Photo p={at(p.photos, i)} /></Box>
          <Text x={i * w + 90} y={h - 220} w={w - 180} style={{ color: "#222" }}>
            <div style={{ fontFamily: "Fraunces", fontWeight: 300, fontSize: 46 }}>{i === 0 ? p.title : at(p.notes, i - 1)}</div>
            <div style={{ fontFamily: "Zen Kaku Gothic New", fontWeight: 500, fontSize: 28, color: "#666", marginTop: 10 }}>{i === 0 ? p.hookJa : at(p.notesJa, i - 1)}</div>
          </Text>
        </React.Fragment>
      ))}
    </AbsoluteFill>
  );
};

/* ---------- 8. Vertical poem: full photos, a short poem set top to bottom, a red seal ---------- */
const Tategaki: React.FC<PostProps> = (p) => {
  const { w, h, panels } = p;
  const lines = [p.titleJa, ...p.poem];
  return (
    <AbsoluteFill style={{ background: "#000" }}>
      {Array.from({ length: panels }, (_, i) => (
        <React.Fragment key={i}>
          <Box x={i * w} y={0} w={w} h={h}><Photo p={at(p.photos, i)} /></Box>
          <Box x={i * w} y={0} w={w} h={h} style={{ background: "linear-gradient(270deg, rgba(0,0,0,0.5) 0%, rgba(0,0,0,0) 45%)" }} />
          <div style={{ position: "absolute", left: i * w + w - (i === 0 ? 300 : 210), top: 150, height: h - 300, writingMode: "vertical-rl", fontFamily: "Shippori Mincho", fontWeight: i === 0 ? 700 : 500, fontSize: i === 0 ? 112 : 72, lineHeight: 1.6, letterSpacing: "0.18em", color: "#fff", textShadow: "0 2px 14px rgba(0,0,0,0.5)" }}>
            {i === 0 ? lines[0] : at(lines, i)}
          </div>
          {i === 0 ? (
            <div style={{ position: "absolute", left: w - 160, top: h - 330, width: 92, padding: "12px 0", background: "#b8281f", color: "#fff", writingMode: "vertical-rl", fontFamily: "Shippori Mincho", fontWeight: 700, fontSize: 40, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 6, letterSpacing: "0.1em" }}>{PLACEJA(p).slice(0, 3)}</div>
          ) : null}
          <Text x={i * w + 60} y={h - 90} style={{ fontFamily: "Fraunces", fontStyle: "italic", fontSize: 30, color: "rgba(255,255,255,0.85)" }}>{i === panels - 1 ? p.handle : i === 0 ? p.title : ""}</Text>
        </React.Fragment>
      ))}
    </AbsoluteFill>
  );
};

/* ---------- 9. Save-worthy guide: a hook cover, one tip a slide, then "save this" ---------- */
const Guide: React.FC<PostProps> = (p) => {
  const { w, h, panels } = p;
  const tips = Array.from({ length: panels - 2 }, (_, i) => i + 1);
  const n = panels - 2;
  return (
    <AbsoluteFill style={{ background: p.palette.paper }}>
      <Box x={0} y={0} w={w} h={h}><Photo p={p.photos[0]} filter="brightness(0.9)" /></Box>
      <Box x={0} y={0} w={w} h={h} style={{ background: "linear-gradient(180deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.25) 45%, rgba(0,0,0,0.05) 70%, rgba(0,0,0,0.45) 100%)" }} />
      <Text x={80} y={h * 0.12} w={w - 160} style={{ color: "#fff", textShadow: softText }}>
        <div style={{ display: "inline-block", fontFamily: "DM Sans", fontWeight: 700, fontSize: 26, letterSpacing: "0.2em", padding: "10px 20px", background: p.palette.accent, color: "#1a1a1a", borderRadius: 40 }}>GUIDE · 保存版</div>
        <div style={{ fontFamily: "Zen Kaku Gothic New", fontWeight: 700, fontSize: 96, lineHeight: 1.25, marginTop: 40 }}>{[p.titleJa, `${n}つのたのしみ`].map((l, i) => <div key={i}>{l}</div>)}</div>{/* 21 Nov: "{subject}で" read 「雲より上でで」 */}
        <div style={{ fontFamily: "DM Sans", fontSize: 38, marginTop: 30, opacity: 0.9 }}>{n} things to do · {p.title}</div>
      </Text>
      <Text x={80} y={h - 150} w={w - 160} style={{ fontFamily: "DM Sans", fontWeight: 600, fontSize: 30, color: "#fff", letterSpacing: "0.1em" }}>{p.handle}　→ スワイプ</Text>
      {tips.map((i) => {
        const x = i * w, item = at(p.items, i - 1);
        return (
          <React.Fragment key={i}>
            <Box x={x} y={0} w={w} h={h * 0.6}><Photo p={at(p.photos, i)} /></Box>
            <div style={{ position: "absolute", left: x + 70, top: h * 0.6 - 90, width: 180, height: 180, borderRadius: "50%", background: p.palette.accent, color: "#1a1a1a", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "Dela Gothic One", fontSize: 96, boxShadow: SHADOW }}>{i}</div>
            <Text x={x + 80} y={h * 0.6 + 120} w={w - 160} style={{ color: p.palette.ink }}>
              <div style={{ fontFamily: "Zen Kaku Gothic New", fontWeight: 700, fontSize: 66, lineHeight: 1.3 }}>{item.head}</div>
              <div style={{ fontFamily: "Zen Kaku Gothic New", fontWeight: 500, fontSize: 40, lineHeight: 1.6, marginTop: 18, opacity: 0.85 }}>{item.line}</div>
            </Text>
          </React.Fragment>
        );
      })}
      <Box x={(panels - 1) * w} y={0} w={w} h={h} style={{ background: p.palette.bg }} />
      <Box x={(panels - 1) * w + 190} y={130} w={w - 380} h={500} style={{ borderRadius: 24 }}><Photo p={at(p.photos, panels - 1)} /></Box>
      <Text x={(panels - 1) * w + 90} y={700} w={w - 180} style={{ textAlign: "center", color: "#fff" }}>
        <div style={{ fontFamily: "Zen Kaku Gothic New", fontWeight: 700, fontSize: 70, lineHeight: 1.35 }}>保存して、<br />次の週末の候補に。</div>
        <div style={{ fontFamily: "Zen Kaku Gothic New", fontWeight: 500, fontSize: 34, marginTop: 30, opacity: 0.9 }}>空き状況はプロフィールのリンクから</div>
        <div style={{ fontFamily: "DM Sans", fontWeight: 700, fontSize: 36, marginTop: 34, letterSpacing: "0.12em" }}>{p.handle}</div>
      </Text>
    </AbsoluteFill>
  );
};

/* ---------- 10. Newspaper: masthead, headline, black and white photos, columns ---------- */
const Newspaper: React.FC<PostProps> = (p) => {
  const { w, h, panels } = p;
  const ink = "#1b1b1b", bw = "grayscale(1) contrast(1.18) brightness(1.04)";
  const rule = (x: number, y: number, ww: number, t = 2) => <div style={{ position: "absolute", left: x, top: y, width: ww, height: t, background: ink }} />;
  return (
    <AbsoluteFill style={{ background: "#eee8da" }}>
      <Text x={60} y={50} w={w - 120} style={{ textAlign: "center", fontFamily: "Bodoni Moda", fontWeight: 800, fontSize: Math.min(92, Math.floor((w - 120) / ((SHORT(p).length + 10) * 0.5))), color: ink, lineHeight: 1, whiteSpace: "nowrap" }}>{`The ${titleCase(SHORT(p))} Times`}</Text>
      {rule(60, 160, w - 120, 4)}{rule(60, 214, w - 120)}
      <Text x={60} y={174} w={w - 120} style={{ display: "flex", justifyContent: "space-between", fontFamily: "IBM Plex Mono", fontSize: 21, color: ink }}><span>VOL. XI</span><span>{p.date}</span><span>{p.alt ? `${p.alt} M ABOVE SEA LEVEL` : p.handle}</span></Text>
      <Text x={60} y={240} w={w - 120} style={{ fontFamily: "Playfair Display", fontWeight: 800, fontSize: 82, lineHeight: 1.02, color: ink }}>{p.hookEn}</Text>
      <Box x={60} y={460} w={w - 120} h={560}><Photo p={p.photos[0]} filter={bw} /></Box>
      <Text x={60} y={1036} w={w - 120} style={{ display: "flex", gap: 34, fontFamily: "Zen Old Mincho", fontWeight: 500, fontSize: 27, lineHeight: 1.65, color: ink }}>
        <div style={{ flex: 1 }}><b>{p.titleJa}</b>　{at(p.items, 0).line}{at(p.items, 1).line}</div>
        <div style={{ flex: 1, borderLeft: `1px solid ${ink}`, paddingLeft: 30 }}>{p.hookJa}{at(p.items, 2).line}</div>
      </Text>
      {Array.from({ length: panels - 1 }, (_, j) => {
        const i = j + 1, x = i * w, item = at(p.items, j);
        return (
          <React.Fragment key={i}>
            {rule(x + 60, 70, w - 120, 4)}
            <Text x={x + 60} y={92} w={w - 120} style={{ display: "flex", justifyContent: "space-between", fontFamily: "IBM Plex Mono", fontSize: 21, color: ink }}><span>{`THE ${SHORT(p)} TIMES`}</span><span>PAGE {i + 1}</span></Text>
            <Text x={x + 60} y={150} w={w - 120} style={{ fontFamily: "Zen Old Mincho", fontWeight: 700, fontSize: 70, lineHeight: 1.25, color: ink }}>{item.head}</Text>
            <Box x={x + 60} y={i === panels - 1 ? 290 : 290} w={w - 120} h={700}><Photo p={at(p.photos, i)} filter={bw} /></Box>
            <Text x={x + 60} y={1010} w={w - 120} style={{ fontFamily: "Playfair Display", fontStyle: "italic", fontSize: 30, color: ink }}>{at(p.notes, j)}</Text>
            <Text x={x + 60} y={1070} w={w - 120} style={{ fontFamily: "Zen Old Mincho", fontWeight: 500, fontSize: 30, lineHeight: 1.7, color: ink, borderTop: `1px solid ${ink}`, paddingTop: 16 }}>
              {i === panels - 1 ? `購読はフォローで。${p.handle}` : item.line}
            </Text>
          </React.Fragment>
        );
      })}
    </AbsoluteFill>
  );
};

/* ================= the 2026 looks: bento, shapes, neo-brutal, riso zine, photo-in-letters, travel ephemera,
   contact sheet, aura, maximal, numbers, phone widgets, pixel game. Each reads p.variant and the seed for its own
   arrangement and takes its colours from the set's photos plus a bold ink, so two sets of one look still differ. === */
const POPS = ["#ff5a36", "#ffd23f", "#3bceac", "#5b5bd6", "#ee4266", "#0ead69", "#f15bb5", "#00bbf9", "#ff8c42", "#c3f73a"];
const RISO = [["#ff48b0", "#0078bf"], ["#ff6c2f", "#00838a"], ["#ffe800", "#ff48b0"], ["#00a95c", "#ff48b0"], ["#0078bf", "#ff6c2f"], ["#ff48b0", "#00a95c"]];
const lum = (hex: string) => {
  const n = parseInt(hex.replace("#", "").padEnd(6, "0").slice(0, 6), 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
};
const inkOn = (bg: string) => (lum(bg) > 0.6 ? "#141414" : "#ffffff");
const pickOf = <T,>(r: () => number, list: T[]): T => list[Math.floor(r() * list.length) % list.length];
const colours = (p: PostProps, r: () => number) => {
  const own = (p.photoPalette || []).filter(Boolean);
  const pops = [...POPS].sort(() => r() - 0.5);
  return { a: own[0] || pops[0], b: own[1] || pops[1], pop: pops[2], pop2: pops[3], dark: "#151515", paper: p.palette.paper };
};
/* No facts (any brand but the ranch): number the notes instead of inventing numbers. */
const factsOf = (p: PostProps) => (p.facts && p.facts.length ? p.facts
  : p.notes.map((n, i) => ({ big: String(i + 1).padStart(2, "0"), unit: "", ja: at(p.notesJa, i), en: n })));
const Hidden: React.FC<{ photos: PostPhoto[] }> = ({ photos }) => (  // CSS backgrounds are not waited for: these make the still wait
  <>{photos.map((ph, i) => <Img key={i} src={staticFile(ph.src)} style={{ position: "absolute", width: 2, height: 2, opacity: 0, left: 0, top: 0 }} />)}</>
);

/* 11. Bento grid */
const BENTO: [number, number, number, number, string][][] = [
  [[0, 0, 1, 0.56, "photo"], [0, 0.56, 0.5, 0.44, "fact"], [0.5, 0.56, 0.5, 0.44, "photo"]],
  [[0, 0, 0.5, 0.5, "photo"], [0.5, 0, 0.5, 0.32, "fact"], [0.5, 0.32, 0.5, 0.68, "photo"], [0, 0.5, 0.5, 0.5, "note"]],
  [[0, 0, 0.6, 1, "photo"], [0.6, 0, 0.4, 0.42, "fact"], [0.6, 0.42, 0.4, 0.58, "photo"]],
  [[0, 0, 1, 0.34, "note"], [0, 0.34, 0.5, 0.66, "photo"], [0.5, 0.34, 0.5, 0.66, "photo"]],
  [[0, 0, 0.5, 0.62, "photo"], [0.5, 0, 0.5, 0.62, "photo"], [0, 0.62, 1, 0.38, "fact"]],
];
const Bento: React.FC<PostProps> = (p) => {
  const { w, h, panels } = p, r = rng(p.seed + 11), c = colours(p, r), facts = factsOf(p);
  const m = 44, g = 18, iw = w - m * 2, ih = h - m * 2;
  let k = 0, f = 0, n = 0;
  const tileBg = [c.a, c.b, c.pop, c.pop2];
  return (
    <AbsoluteFill style={{ background: p.palette.paper }}>
      {Array.from({ length: panels }, (_, i) => {
        const cells = i === 0 ? [[0, 0, 1, 0.6, "photo"], [0, 0.6, 0.64, 0.4, "title"], [0.64, 0.6, 0.36, 0.4, "fact"]] as [number, number, number, number, string][]
          : BENTO[(i + (p.variant || 0)) % BENTO.length];
        return cells.map(([cx, cy, cw, ch, kind], j) => {
          const x = i * w + m + cx * iw + (cx ? g / 2 : 0), y = m + cy * ih + (cy ? g / 2 : 0);
          const ww = cw * iw - (cx ? g / 2 : 0) - (cx + cw < 1 ? g / 2 : 0), hh = ch * ih - (cy ? g / 2 : 0) - (cy + ch < 1 ? g / 2 : 0);
          const bg = tileBg[(i + j) % tileBg.length], ink = inkOn(bg);
          if (kind === "photo") return <Box key={`${i}-${j}`} x={x} y={y} w={ww} h={hh} style={{ borderRadius: 40 }}><Photo p={at(p.photos, k++)} /></Box>;
          if (kind === "fact") { const ft = at(facts, f++); return (
            <Box key={`${i}-${j}`} x={x} y={y} w={ww} h={hh} style={{ borderRadius: 40, background: bg, color: ink, padding: 34, boxSizing: "border-box", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
              <div style={{ fontFamily: "DM Sans", fontWeight: 600, fontSize: 24, letterSpacing: "0.14em", opacity: 0.8 }}>{ft.en.toUpperCase()}</div>
              <div style={{ fontFamily: "Anton", fontSize: ft.big.length > 3 ? 120 : 170, lineHeight: 0.9 }}>{ft.big}<span style={{ fontSize: 60 }}>{ft.unit}</span></div>
              <div style={{ fontFamily: "Zen Kaku Gothic New", fontWeight: 700, fontSize: 32 }}>{ft.ja}</div>
            </Box>); }
          if (kind === "title") return (
            <Box key={`${i}-${j}`} x={x} y={y} w={ww} h={hh} style={{ borderRadius: 40, background: c.dark, color: "#fff", padding: 40, boxSizing: "border-box" }}>
              <div style={{ fontFamily: "Fraunces", fontWeight: 300, fontSize: 70, lineHeight: 1.02 }}>{p.title}</div>
              <div style={{ fontFamily: "Zen Kaku Gothic New", fontWeight: 700, fontSize: 34, marginTop: 18, color: c.a }}>{p.titleJa}</div>
              <div style={{ fontFamily: "DM Sans", fontSize: 24, marginTop: 14, opacity: 0.7 }}>{p.handle} · swipe →</div>
            </Box>);
          const note = n++;
          return (
            <Box key={`${i}-${j}`} x={x} y={y} w={ww} h={hh} style={{ borderRadius: 40, background: bg, color: ink, padding: 40, boxSizing: "border-box", display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
              <div style={{ fontFamily: "Zen Kaku Gothic New", fontWeight: 700, fontSize: 56, lineHeight: 1.25 }}>{at(p.notesJa, note)}</div>
              <div style={{ fontFamily: "DM Sans", fontSize: 30, marginTop: 10, opacity: 0.8 }}>{at(p.notes, note)}</div>
            </Box>);
        });
      })}
    </AbsoluteFill>
  );
};

/* 12. Arch windows: one tall arched window a slide (two on some), lined up on the same baseline, a keyline arch
   around each like a window frame, the caption under the window's left edge. Replaced random blobs and stray circles
   (owner, 21 Nov: "cut out shapes are nice but look so weird... what about plain windows"). */
const Arch: React.FC<{ x: number; y: number; w: number; h: number; ph?: PostPhoto; line: string }> = ({ x, y, w, h, ph, line }) => (
  <>
    <div style={{ position: "absolute", left: x - 18, top: y - 18, width: w + 36, height: h + 36, borderRadius: `${(w + 36) / 2}px ${(w + 36) / 2}px 6px 6px`, border: `3px solid ${line}`, opacity: 0.7 }} />
    <Box x={x} y={y} w={w} h={h} style={{ borderRadius: `${w / 2}px ${w / 2}px 4px 4px` }}><Photo p={ph} /></Box>
  </>
);
const Shapes: React.FC<PostProps> = (p) => {
  const { w, h, panels } = p;
  const mix = (hex: string, k: number) => "#" + [0, 2, 4].map((i) => Math.round(parseInt(hex.slice(1 + i, 3 + i), 16) * (1 - k) + 255 * k).toString(16).padStart(2, "0")).join("");
  const bg = [p.palette.bg, mix(p.palette.bg, 0.12)], line = p.palette.paper;  // the subject's own tone, not a photo's sky blue
  let k = 0;
  return (
    <AbsoluteFill style={{ background: bg[0] }}>
      {Array.from({ length: panels }, (_, i) => {
        const x = i * w, two = i > 0 && (i + (p.variant || 0)) % 3 === 2, ink = inkOn(bg[i % 2]);
        const aw = two ? 380 : 620, ah = two ? 760 : i === 0 ? 820 : 900, top = i === 0 ? 330 : 150;
        const left = two ? x + (w - (aw * 2 + 80)) / 2 : x + (w - aw) / 2;
        return (
          <React.Fragment key={i}>
            <Box x={x} y={0} w={w} h={h} style={{ background: bg[i % 2] }} />
            <Arch x={left} y={top} w={aw} h={ah} ph={at(p.photos, k++)} line={line} />
            {two ? <Arch x={left + aw + 80} y={top} w={aw} h={ah} ph={at(p.photos, k++)} line={line} /> : null}
            {i === 0 ? (
              <Text x={x + 80} y={90} w={w - 160} style={{ color: ink, textAlign: "center" }}>
                <div style={{ fontFamily: "Jost", fontWeight: 500, fontSize: 26, letterSpacing: "0.32em" }}>{p.kicker}</div>
                <div style={{ fontFamily: "Zen Maru Gothic", fontWeight: 700, fontSize: 82, marginTop: 14, textWrap: "balance" } as React.CSSProperties}>{p.titleJa}</div>
              </Text>
            ) : null}
            <Text x={two ? left : x + (w - aw) / 2} y={top + ah + 44} w={two ? aw * 2 + 80 : aw} style={{ color: ink }}>
              <div style={{ fontFamily: "Zen Maru Gothic", fontWeight: 700, fontSize: 44 }}>{i === 0 ? p.hookJa : at(p.notesJa, i - 1)}</div>
              <div style={{ fontFamily: "Jost", fontSize: 28, letterSpacing: "0.06em", marginTop: 6, opacity: 0.85 }}>{i === 0 ? p.handle : at(p.notes, i - 1)}</div>
            </Text>
            <Text x={x + w - 160} y={h - 70} style={{ fontFamily: "Jost", fontWeight: 500, fontSize: 24, letterSpacing: "0.2em", color: ink, opacity: 0.7 }}>{`${String(i + 1).padStart(2, "0")} / ${String(panels).padStart(2, "0")}`}</Text>
          </React.Fragment>
        );
      })}
    </AbsoluteFill>
  );
};

/* 13. Neo-brutal */
const Brutal: React.FC<PostProps> = (p) => {
  const { w, h, panels } = p, r = rng(p.seed + 13), c = colours(p, r), facts = factsOf(p);
  const hard = "16px 16px 0 #111", line = "8px solid #111";
  const fs = p.title.length > 18 ? 132 : p.title.length > 11 ? 168 : 210;
  const lines = Math.min(3, Math.ceil((p.title.length * fs * 0.47) / (w - 120)));
  const tagY = 50 + lines * fs * 0.88 + 24, firstY = tagY + 90;
  return (
    <AbsoluteFill style={{ background: "#f1efe7", backgroundImage: "linear-gradient(#d9d5c9 2px, transparent 2px), linear-gradient(90deg, #d9d5c9 2px, transparent 2px)", backgroundSize: "90px 90px" }}>
      {Array.from({ length: panels }, (_, i) => {
        const x = i * w, flip = (i + (p.variant || 0)) % 2 === 1, ft = at(facts, i);
        return (
          <React.Fragment key={i}>
            <Box x={x + (flip ? 300 : 70)} y={i === 0 ? firstY : 120} w={700} h={i === 0 ? Math.max(420, 1180 - firstY) : 760} style={{ border: line, boxShadow: hard, background: "#fff" }}><Photo p={at(p.photos, i)} filter="contrast(1.08)" /></Box>
            <Text x={x + (flip ? 70 : 640)} y={i === 0 ? Math.min(1000, firstY + 300) : 820} style={{ padding: "18px 26px", background: c.pop, border: line, boxShadow: hard, fontFamily: "Anton", fontSize: 92, lineHeight: 1, color: inkOn(c.pop), transform: `rotate(${flip ? -4 : 3}deg)` }}>{ft.big}{ft.unit}</Text>
            <Text x={x + 70} y={i === 0 ? 1220 : 1110} w={w - 140} style={{ fontFamily: "Zen Kaku Gothic New", fontWeight: 700, fontSize: 44, color: "#111" }}>
              <span style={{ background: c.a, color: inkOn(c.a), padding: "0 12px", boxDecorationBreak: "clone" }}>{i === 0 ? p.hookJa : at(p.notesJa, i - 1)}</span>
            </Text>
            <Text x={x + 70} y={i === 0 ? 1290 : 1190} style={{ fontFamily: "IBM Plex Mono", fontSize: 24, color: "#111" }}>{`FIG. ${String(i + 1).padStart(2, "0")} — ${ft.en.toUpperCase()}`}</Text>
          </React.Fragment>
        );
      })}
      <Text x={60} y={50} w={w - 120} style={{ fontFamily: "Anton", fontSize: fs, lineHeight: 0.86, color: "#111", textTransform: "uppercase" }}>{p.title}</Text>
      <Text x={60} y={tagY} style={{ border: line, padding: "8px 18px", background: "#fff", fontFamily: "IBM Plex Mono", fontSize: 26, boxShadow: "8px 8px 0 #111" }}>{`STATUS: OPEN${p.alt ? ` · ${p.alt} M` : ""} · ${p.handle}`}</Text>
    </AbsoluteFill>
  );
};

/* 14. Riso zine: two inks, halftone, misregistration, a cut-letter title */
const Riso: React.FC<PostProps> = (p) => {
  const { w, h, panels } = p, r = rng(p.seed + 14);
  const [ink1, ink2] = RISO[((p.variant || 0) + Math.floor(r() * RISO.length)) % RISO.length];
  const dots = { backgroundImage: "radial-gradient(rgba(0,0,0,0.28) 1.3px, transparent 1.8px)", backgroundSize: "10px 10px", mixBlendMode: "multiply" as const };
  const duo = (ph: PostPhoto | undefined, tint: string, x: number, y: number, ww: number, hh: number, rot: number, key: string) => (
    <div key={key} style={{ position: "absolute", left: x, top: y, width: ww, height: hh, transform: `rotate(${rot}deg)`, background: tint, overflow: "hidden" }}>
      <Photo p={ph} filter="grayscale(1) contrast(1.35) brightness(1.08)" style={{ mixBlendMode: "multiply" }} />
      <div style={{ position: "absolute", inset: 0, ...dots }} />
    </div>
  );
  const FONTS = ["Anton", "Special Elite", "Bodoni Moda", "Dela Gothic One", "IBM Plex Mono"];
  return (
    <AbsoluteFill style={{ background: "#f3eee2" }}>
      <AbsoluteFill style={{ backgroundImage: "radial-gradient(rgba(0,0,0,0.06) 1px, transparent 1px)", backgroundSize: "5px 5px" }} />
      {Array.from({ length: panels }, (_, i) => {
        const x = i * w;
        return (
          <React.Fragment key={i}>
            {duo(at(p.photos, i * 2), i % 2 ? ink2 : ink1, x + 60 + r() * 60, 120 + r() * 80, 640, 820, (r() - 0.5) * 6, `a${i}`)}
            {duo(at(p.photos, i * 2 + 1), i % 2 ? ink1 : ink2, x + 520 + r() * 60, 640 + r() * 80, 560, 520, (r() - 0.5) * 8, `b${i}`)}
            <Text x={x + 70} y={h - 230} w={w * 0.6} style={{ display: "flex", flexDirection: "column", gap: 6, padding: "10px 14px", background: "rgba(243,238,226,0.92)" }}>
              <span style={{ fontFamily: "Caveat", fontSize: 46, color: ink2, lineHeight: 1.05 }}>{at(p.notes, i)}</span>
              <span style={{ fontFamily: "Zen Old Mincho", fontWeight: 700, fontSize: 32, color: "#222" }}>{at(p.notesJa, i)}</span>
            </Text>
          </React.Fragment>
        );
      })}
      <div style={{ position: "absolute", left: 50, top: 40, display: "flex", flexWrap: "wrap", gap: "10px 34px", width: 1000 }}>
        {p.title.toUpperCase().split(" ").map((word, wi) => (
          <span key={wi} style={{ display: "flex", gap: 6, whiteSpace: "nowrap" }}>
            {[...word].map((ch, ci) => { const i = wi * 7 + ci; return (
              <span key={ci} style={{ fontFamily: FONTS[i % FONTS.length], fontSize: p.title.length > 16 ? 74 : 90, lineHeight: 1, padding: "4px 10px", background: i % 3 === 0 ? ink1 : i % 3 === 1 ? "#111" : "#fff", color: i % 3 === 2 ? "#111" : "#fff", transform: `rotate(${((i * 37) % 9) - 4}deg)` }}>{ch}</span>
            ); })}
          </span>
        ))}
      </div>
      <Text x={(panels - 1) * w + 70} y={60} w={w - 140} style={{ textAlign: "right", fontFamily: "IBM Plex Mono", fontSize: 26, color: "#222" }}>ZINE NO.{1 + ((p.seed >>> 0) % 40)} · {p.handle}</Text>
      <Text x={66} y={h * 0.7 + 6} w={w - 120} style={{ fontFamily: "Dela Gothic One", fontSize: Math.min(120, Math.floor((w - 140) / Math.max(4, p.titleJa.length))), color: ink1, opacity: 0.85, whiteSpace: "nowrap" }}>{p.titleJa}</Text>
      <Text x={60} y={h * 0.7} w={w - 120} style={{ fontFamily: "Dela Gothic One", fontSize: Math.min(120, Math.floor((w - 140) / Math.max(4, p.titleJa.length))), color: ink2, mixBlendMode: "multiply", whiteSpace: "nowrap" }}>{p.titleJa}</Text>
    </AbsoluteFill>
  );
};

/* 15. Photos through one giant word */
const TypeClip: React.FC<PostProps> = (p) => {
  const { w, h, panels } = p, r = rng(p.seed + 15), c = colours(p, r);
  const word = (p.variant || 0) % 3 === 2 ? p.titleJa : PLACE(p).replace(/\s+/g, "").slice(0, 10);
  const ja = /[^\x00-\x7f]/.test(word);
  const bg = (p.variant || 0) % 2 ? "#111" : p.palette.paper, ink = inkOn(bg);
  return (
    <AbsoluteFill style={{ background: bg }}>
      <Hidden photos={p.photos} />
      <div style={{ position: "absolute", left: 0, top: ja ? 60 : 30, width: panels * w, height: h * 0.74, display: "flex", justifyContent: "space-around", alignItems: "center" }}>
        {[...word].map((ch, i) => (
          <span key={i} style={{ fontFamily: ja ? "Dela Gothic One" : "Anton", fontSize: ja ? Math.min(980, (panels * w) / word.length * 0.95) : Math.min(1050, (panels * w) / (word.length * 0.52)), lineHeight: 1, color: "transparent",
            backgroundImage: `url(${staticFile(at(p.photos, i).src)})`, backgroundSize: "cover", backgroundPosition: "center", WebkitBackgroundClip: "text", backgroundClip: "text" }}>{ch}</span>
        ))}
      </div>
      <Text x={70} y={34} style={{ padding: "10px 22px", background: c.pop, color: inkOn(c.pop), fontFamily: "Jost", fontWeight: 600, fontSize: 30, letterSpacing: "0.16em", zIndex: 2 }}>{`${p.titleJa} · ${p.handle}`}</Text>
      {Array.from({ length: panels }, (_, i) => (
        <Text key={i} x={i * w + 70} y={h * 0.8} w={w - 140} style={{ color: ink, display: "flex", justifyContent: "space-between", alignItems: "flex-end", borderTop: `3px solid ${c.pop}`, paddingTop: 22 }}>
          <div>
            <div style={{ fontFamily: "Zen Kaku Gothic New", fontWeight: 700, fontSize: 46 }}>{i === 0 ? p.hookJa : at(p.notesJa, i - 1)}</div>
            <div style={{ fontFamily: "Jost", fontSize: 28, marginTop: 8, opacity: 0.8 }}>{i === 0 ? p.hookEn : at(p.notes, i - 1)}</div>
          </div>
          <div style={{ fontFamily: "Jost", fontWeight: 600, fontSize: 26, letterSpacing: "0.2em" }}>{String(i + 1).padStart(2, "0")}/{String(panels).padStart(2, "0")}</div>
        </Text>
      ))}
    </AbsoluteFill>
  );
};

/* 16. Travel ephemera on a desk: boarding pass, stamps, luggage tag, postmark */
const Stamp: React.FC<{ ph?: PostPhoto; x: number; y: number; s: number; rot: number; label: string; c: string }> = ({ ph, x, y, s, rot, label, c }) => (
  <div style={{ position: "absolute", left: x, top: y, width: s, height: s * 1.22, transform: `rotate(${rot}deg)`, filter: "drop-shadow(0 10px 14px rgba(0,0,0,0.35))" }}>
    <div style={{ width: "100%", height: "100%", background: "#fbf8f1", padding: s * 0.07, boxSizing: "border-box",
      WebkitMaskImage: "radial-gradient(circle at 50% 50%, #000 62%, transparent 64%)", WebkitMaskSize: "28px 28px", WebkitMaskPosition: "-14px -14px",
      maskImage: "linear-gradient(#000,#000)" }}>
      <div style={{ position: "relative", width: "100%", height: "100%" }}>
        <Photo p={ph} />
        <div style={{ position: "absolute", right: 10, bottom: 8, fontFamily: "Barlow Condensed", fontWeight: 600, fontSize: s * 0.1, color: "#fff", textShadow: "0 1px 4px rgba(0,0,0,.6)" }}>{label}</div>
      </div>
    </div>
    <div style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, border: `3px dashed ${c}`, borderRadius: 4, opacity: 0.0 }} />
  </div>
);
const Ticket: React.FC<PostProps> = (p) => {
  const { w, h, panels } = p, r = rng(p.seed + 16), c = colours(p, r);
  const desk = (p.variant || 0) % 2 ? "#2f3a36" : "#c9a57c";
  const bars = "repeating-linear-gradient(90deg, #111 0 3px, transparent 3px 6px, #111 6px 10px, transparent 10px 12px, #111 12px 13px, transparent 13px 17px)";
  return (
    <AbsoluteFill style={{ background: desk, backgroundImage: "repeating-linear-gradient(90deg, rgba(0,0,0,0.04) 0 2px, transparent 2px 22px)" }}>
      {/* boarding pass across the first join */}
      <div style={{ position: "absolute", left: 120, top: 170, width: 1500, height: 560, background: "#fbf8f1", borderRadius: 26, boxShadow: "0 30px 50px rgba(0,0,0,0.35)", transform: "rotate(-4deg)", display: "flex", overflow: "hidden" }}>
        <div style={{ width: 1100, padding: 48, boxSizing: "border-box", borderRight: "4px dashed #c9c1b0", position: "relative" }}>
          <div style={{ fontFamily: "Barlow Condensed", fontWeight: 600, fontSize: 34, letterSpacing: "0.3em", color: c.dark }}>BOARDING PASS · 搭乗券</div>
          <div style={{ display: "flex", alignItems: "center", gap: 40, marginTop: 30 }}>
            <div><div style={{ fontFamily: "Barlow Condensed", fontWeight: 600, fontSize: 170, lineHeight: 0.9, color: "#111" }}>{p.origin?.code || "HOME"}</div><div style={{ fontFamily: "Zen Kaku Gothic New", fontSize: 32 }}>{p.origin?.ja || "いつもの街"}</div></div>
            <div style={{ fontFamily: "IBM Plex Mono", fontSize: 70, color: c.pop }}>✈︎ ─ ─ →</div>
            <div><div style={{ fontFamily: "Barlow Condensed", fontWeight: 600, fontSize: 170, lineHeight: 0.9, color: "#111" }}>{p.ticket?.code || PLACE(p).replace(/[^A-Z]/g, "").slice(0, 3) || "GO!"}</div><div style={{ fontFamily: "Zen Kaku Gothic New", fontSize: 32 }}>{PLACEJA(p)}{p.alt ? ` · ${p.alt} m` : ""}</div></div>
          </div>
          <div style={{ display: "flex", gap: 60, marginTop: 40, fontFamily: "IBM Plex Mono", fontSize: 26, color: "#333" }}>
            <div>SEAT<br /><b style={{ fontSize: 40 }}>{p.ticket?.seat || "01A"}</b></div><div>GATE<br /><b style={{ fontSize: 40 }}>{p.ticket?.gate || "A"}</b></div><div>DATE<br /><b style={{ fontSize: 40 }}>{p.date.replace("'", "")}</b></div><div>CLASS<br /><b style={{ fontSize: 40 }}>{p.ticket?.cls || "WEEKEND"}</b></div>
          </div>
        </div>
        <div style={{ flex: 1, padding: 40, display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
          <div style={{ fontFamily: "Caveat", fontSize: 54, color: c.dark, lineHeight: 1.05 }}>{p.title}</div>
          <div style={{ height: 120, backgroundImage: bars }} />
        </div>
      </div>
      <Text x={160} y={850} w={900} style={{ fontFamily: "Zen Kaku Gothic New", fontWeight: 700, fontSize: 52, color: inkOn(desk) }}>{p.hookJa}</Text>
      <Text x={160} y={930} w={900} style={{ fontFamily: "Caveat", fontSize: 50, color: inkOn(desk), opacity: 0.85 }}>{p.hookEn}</Text>
      {Array.from({ length: panels - 1 }, (_, j) => {
        const i = j + 1, x = i * w;
        return (
          <React.Fragment key={i}>
            <Stamp ph={at(p.photos, j * 2)} x={x + (i === 1 ? 640 : 110) + r() * 60} y={i === 1 ? 760 : 140 + r() * 80} s={i === 1 ? 360 : 460} rot={(r() - 0.5) * 14} label={`${SHORT(p)} ${j + 1}`} c={c.pop} />
            {i > 1 ? <Stamp ph={at(p.photos, j * 2 + 1)} x={x + 560 + r() * 60} y={520 + r() * 120} s={380} rot={(r() - 0.5) * 14} label={p.alt ? `${p.alt}m` : p.date.replace("'", "")} c={c.pop} /> : null}
            <div style={{ position: "absolute", left: x + 380 + r() * 200, top: 360 + r() * 300, width: 300, height: 300, borderRadius: "50%", border: `6px solid ${c.pop}`, color: c.pop, opacity: 0.75, transform: `rotate(${(r() - 0.5) * 40}deg)`,
              display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontFamily: "IBM Plex Mono", mixBlendMode: "multiply" }}>
              <div style={{ fontSize: 28, letterSpacing: "0.2em" }}>{SHORT(p)}</div><div style={{ fontSize: 44, fontWeight: 600 }}>{p.date.replace("'", "")}</div><div style={{ fontSize: 24 }}>{p.region || p.handle}</div>
            </div>
            <Text x={x + 100} y={h - 230} w={w - 200} style={{ fontFamily: "Caveat", fontSize: 58, color: inkOn(desk), transform: "rotate(-2deg)" }}>{at(p.notes, j)}</Text>
          </React.Fragment>
        );
      })}
      {/* a luggage tag on the last slide */}
      <div style={{ position: "absolute", left: (panels - 1) * w + 120, top: h - 560, width: 420, height: 240, background: c.a, borderRadius: "30px 120px 120px 30px", transform: "rotate(8deg)", boxShadow: "0 20px 30px rgba(0,0,0,0.3)", padding: 30, boxSizing: "border-box", color: inkOn(c.a) }}>
        <div style={{ fontFamily: "Barlow Condensed", fontWeight: 600, fontSize: 30, letterSpacing: "0.2em" }}>DESTINATION</div>
        <div style={{ fontFamily: "Zen Kaku Gothic New", fontWeight: 700, fontSize: 52 }}>{p.brand}</div>
        <div style={{ fontFamily: "IBM Plex Mono", fontSize: 24 }}>{p.handle}</div>
      </div>
    </AbsoluteFill>
  );
};

/* 17. Contact sheet: the roll, then the picks (owner, 21 Nov: the old one "doesn't make sense": random crosses on good
   photos, a loupe over a picture, labels on every frame). Slide 1 is the sheet as a photographer prints it: four film
   strips of four frames on photo paper, sprocket holes and frame numbers on the film's edge, and the picks circled in
   red grease pencil and numbered. Every next slide is one pick, enlarged as a print with its black film border, its
   frame number, and its line. */
const GREASE = "#d8261c";
const loop = (cx: number, cy: number, rx: number, ry: number, r: () => number) => {
  // a hand-drawn loop: a slightly wobbly ellipse that overshoots where it started, as a grease pencil does
  const pts: string[] = [], turns = 1.12, n = 40, start = r() * Math.PI * 2;
  for (let k = 0; k <= n; k++) {
    const a = start + (k / n) * turns * Math.PI * 2, wob = 1 + (r() - 0.5) * 0.05 + (k / n) * 0.05;
    pts.push(`${(cx + Math.cos(a) * rx * wob).toFixed(1)},${(cy + Math.sin(a) * ry * wob).toFixed(1)}`);
  }
  return `M${pts.join(" L")}`;
};
const FilmStrip: React.FC<{ x: number; y: number; w: number; h: number; band: number; paper: string }> = ({ x, y, w, h, band, paper }) => {
  const hw = 12, hh = 17, holes = Math.floor((w - 20) / (hw * 2.4)), step = (w - 20) / holes;
  return (
    <div style={{ position: "absolute", left: x, top: y, width: w, height: h, background: "#141414" }}>
      {[(band - hh) / 2, h - band + (band - hh) / 2].map((top, b) => Array.from({ length: holes }, (_, k) => (
        <div key={`${b}-${k}`} style={{ position: "absolute", left: 10 + k * step + (step - hw) / 2, top, width: hw, height: hh, borderRadius: 3, background: paper }} />
      )))}
    </div>
  );
};
const Contact: React.FC<PostProps> = (p) => {
  const { w, h, panels } = p, r = rng(p.seed + 17);
  const paper = "#eeebe4", ink = "#161616", edge = "#e39a3b", grey = "#6b665e";
  const picks = Math.max(1, panels - 1), cols = 4, rows = 4, frames = cols * rows;
  const sx = 40, sw = w - 80, band = 34, gap = 10, pad = 12;
  const fw = Math.floor((sw - 2 * pad - (cols - 1) * gap) / cols), fh = Math.round(fw / 1.5), sh = fh + 2 * band, top = 262, sgap = 20;
  // which frames were picked: one per strip while there are strips, somewhere along it
  const order = Array.from({ length: rows }, (_, i) => i).sort(() => r() - 0.5);
  const pickAt = Array.from({ length: picks }, (_, k) => order[k % rows] * cols + Math.floor(r() * cols)).sort((a, b) => a - b);
  // the picks show the set's best photos (stills.cover_first puts them first); the rest fill the other frames in order
  let next = picks;
  const photoOf = Array.from({ length: frames }, (_, f) => { const k = pickAt.indexOf(f); return k >= 0 ? k : next++; });
  const num = (f: number) => String(f + 1).padStart(2, "0");
  const edgeText: React.CSSProperties = { fontFamily: "IBM Plex Mono", fontSize: 15, color: edge, background: "#141414", padding: "0 6px", letterSpacing: "0.08em", fontVariantNumeric: "tabular-nums", lineHeight: "20px" };
  return (
    <AbsoluteFill style={{ background: paper }}>
      {/* slide 1: the sheet */}
      <Text x={sx} y={58} w={sw} style={{ fontFamily: "IBM Plex Mono", fontSize: 22, color: grey, letterSpacing: "0.18em" }}>{`CONTACT SHEET · ROLL 01 · ${p.date}`}</Text>
      <Text x={sx} y={100} w={sw} style={{ fontFamily: "Zen Kaku Gothic New", fontWeight: 700, fontSize: 56, lineHeight: 1.25, color: ink }}>{p.hookJa || p.titleJa}</Text>
      {Array.from({ length: rows }, (_, row) => {
        const y = top + row * (sh + sgap);
        return (
          <React.Fragment key={row}>
            <FilmStrip x={sx} y={y} w={sw} h={sh} band={band} paper={paper} />
            {Array.from({ length: cols }, (_, c) => {
              const f = row * cols + c, fx = sx + pad + c * (fw + gap);
              return (
                <React.Fragment key={c}>
                  <Box x={fx} y={y + band} w={fw} h={fh}><Photo p={at(p.photos, photoOf[f])} /></Box>
                  <Text x={fx + 4} y={y + sh - band + 7} style={edgeText}>{`${num(f)}  ▸${num(f)}A`}</Text>
                </React.Fragment>
              );
            })}
            <Text x={sx + sw - 200} y={y + 7} style={edgeText}>{`${SHORT(p)} 400`}</Text>
          </React.Fragment>
        );
      })}
      <svg style={{ position: "absolute", left: 0, top: 0, overflow: "visible" }} width={w} height={h}>
        {pickAt.map((f, k) => {
          const row = Math.floor(f / cols), c = f % cols, cx = sx + pad + c * (fw + gap) + fw / 2, cy = top + row * (sh + sgap) + band + fh / 2;
          return <path key={k} d={loop(cx, cy, fw * 0.6, fh * 0.7, r)} fill="none" stroke={GREASE} strokeWidth={7} strokeLinecap="round" strokeLinejoin="round" opacity={0.92} />;
        })}
      </svg>
      {pickAt.map((f, k) => {
        const row = Math.floor(f / cols), c = f % cols, cx = sx + pad + c * (fw + gap) + fw / 2, cy = top + row * (sh + sgap) + band;
        return <Text key={k} x={Math.min(w - 70, cx + fw * 0.46)} y={cy - 66} style={{ fontFamily: "Caveat", fontWeight: 700, fontSize: 64, color: GREASE, transform: "rotate(-8deg)" }}>{k + 1}</Text>;
      })}
      <Text x={sx} y={h - 80} w={sw / 2} style={{ fontFamily: "IBM Plex Mono", fontSize: 22, color: grey }}>{p.handle}</Text>
      <Text x={w / 2} y={h - 98} w={sw / 2} style={{ fontFamily: "Caveat", fontWeight: 700, fontSize: 46, color: GREASE, textAlign: "right" }}>{`picks ${pickAt.map((f) => num(f)).join(" · ")} →`}</Text>

      {/* slides 2...: one pick each, printed with its film border */}
      {pickAt.map((f, k) => {
        const x = (k + 1) * w, ph = at(p.photos, k), tall = !!ph && ph.h > ph.w;
        const pw = tall ? 640 : sw - 60, phh = tall ? 853 : Math.round((sw - 60) / 1.5), b = 24;
        // the print and its line, centred on the slide between the header and the handle
        const block = phh + 2 * b + 30 + 210, py = Math.max(120, Math.round(110 + (h - 200 - block) / 2)), px = x + (w - pw) / 2 - b, below = py + phh + 2 * b + 30;
        return (
          <React.Fragment key={k}>
            <Text x={x + sx} y={58} w={sw} style={{ fontFamily: "IBM Plex Mono", fontSize: 22, color: grey, letterSpacing: "0.18em" }}>{`PICK ${k + 1} / ${picks} · FRAME ${num(f)}`}</Text>
            <div style={{ position: "absolute", left: px, top: py, width: pw + 2 * b, height: phh + 2 * b + 30, background: "#141414", boxShadow: "0 20px 40px rgba(0,0,0,0.18)" }} />
            <Box x={px + b} y={py + b} w={pw} h={phh}><Photo p={ph} /></Box>
            <Text x={px + b} y={py + phh + b + 10} style={{ ...edgeText, fontSize: 17 }}>{`${num(f)}  ▸${num(f)}A   ${SHORT(p)} 400`}</Text>
            <Text x={px + pw + 2 * b - 60} y={py - 56} style={{ fontFamily: "Caveat", fontWeight: 700, fontSize: 76, color: GREASE, transform: "rotate(-8deg)" }}>{k + 1}</Text>
            <Text x={x + sx + 20} y={below + 50} w={sw - 40} style={{ fontFamily: "Zen Kaku Gothic New", fontWeight: 700, fontSize: 52, lineHeight: 1.35, color: ink }}>{at(p.notesJa, k)}</Text>
            <Text x={x + sx + 20} y={below + 130} w={sw - 40} style={{ fontFamily: "IBM Plex Mono", fontSize: 24, color: grey }}>{at(p.notes, k)}</Text>
            {k === picks - 1 ? <Text x={x + sx + 20} y={h - 80} style={{ fontFamily: "IBM Plex Mono", fontSize: 22, color: grey }}>{p.handle}</Text> : null}
          </React.Fragment>
        );
      })}
    </AbsoluteFill>
  );
};

/* 18. Aura blur */
const Aura: React.FC<PostProps> = (p) => {
  const { w, h, panels } = p;
  return (
    <AbsoluteFill style={{ background: "#222" }}>
      {Array.from({ length: panels }, (_, i) => {
        const x = i * w, ph = at(p.photos, i);
        return (
          <React.Fragment key={i}>
            <Box x={x} y={0} w={w} h={h}><Photo p={ph} filter="blur(70px) saturate(1.7) brightness(1.05)" style={{ transform: "scale(1.5)" }} /></Box>
            <Box x={x} y={0} w={w} h={h} style={{ backgroundImage: "radial-gradient(rgba(255,255,255,0.08) 1px, transparent 1px)", backgroundSize: "4px 4px" }} />
            <Box x={x + 170} y={250} w={w - 340} h={760} style={{ borderRadius: 48, boxShadow: "0 40px 80px rgba(0,0,0,0.35)" }}><Photo p={ph} /></Box>
            <div style={{ position: "absolute", left: x + 170, top: 1050, width: w - 340, padding: "20px 28px", boxSizing: "border-box", borderRadius: 28, background: "rgba(255,255,255,0.22)", backdropFilter: "blur(18px)", border: "1px solid rgba(255,255,255,0.4)", color: "#fff" }}>
              <div style={{ fontFamily: "Zen Maru Gothic", fontWeight: 700, fontSize: 40 }}>{i === 0 ? p.titleJa : at(p.notesJa, i - 1)}</div>
              <div style={{ fontFamily: "Jost", fontSize: 26, opacity: 0.9, marginTop: 4 }}>{i === 0 ? p.handle : at(p.notes, i - 1)}</div>
            </div>
          </React.Fragment>
        );
      })}
      <Text x={170} y={70} w={w - 340} style={{ fontFamily: "Fraunces", fontStyle: "italic", fontWeight: 600, fontSize: Math.min(150, Math.floor((w - 340) / (p.title.length * 0.5))), lineHeight: 1.05, color: "#fff", whiteSpace: "nowrap", fontVariationSettings: "'SOFT' 100, 'WONK' 1, 'opsz' 144", textShadow: "0 6px 40px rgba(0,0,0,0.25)" }}>{p.title}</Text>
    </AbsoluteFill>
  );
};

/* 19. Poster grid: bold, but ordered (owner, 21 Nov: the maximal collage's fonts and layout "trigger my OCD").
   Each slide is a 2 x 6 grid with even 14 px gutters and square corners; cells are photos, colour blocks with one big
   word or number, or a text cell; one display face (Anton) and one Japanese face, all left-aligned to the cell. */
const POSTER: [number, number, number, number, string][][] = [
  [[0, 0, 2, 4, "photo"], [0, 4, 1, 2, "fact"], [1, 4, 1, 2, "note"]],
  [[0, 0, 2, 1, "word"], [0, 1, 1, 5, "photo"], [1, 1, 1, 3, "photo"], [1, 4, 1, 2, "note"]],
  [[0, 0, 1, 3, "photo"], [1, 0, 1, 3, "photo"], [0, 3, 2, 1, "fact"], [0, 4, 2, 2, "photo"]],
  [[0, 0, 1, 2, "note"], [1, 0, 1, 4, "photo"], [0, 2, 1, 4, "photo"], [1, 4, 1, 2, "fact"]],
];
const Maximal: React.FC<PostProps> = (p) => {
  const { w, h, panels } = p, r = rng(p.seed + 19), c = colours(p, r), facts = factsOf(p);
  const m = 40, g = 14, cw = (w - m * 2 - g) / 2, rh = (h - m * 2 - g * 5) / 6;
  const blocks = [c.pop, c.a, c.pop2, c.b];
  let k = 0, f = 0, n = 0;
  return (
    <AbsoluteFill style={{ background: "#f4f1ea" }}>
      {Array.from({ length: panels }, (_, i) => {
        const cells = i === 0 ? [[0, 0, 2, 2, "title"], [0, 2, 2, 3, "photo"], [0, 5, 1, 1, "fact"], [1, 5, 1, 1, "photo"]] as [number, number, number, number, string][]
          : POSTER[(i - 1 + (p.variant || 0)) % POSTER.length];
        return cells.map(([cx, cy, cwN, chN, kind], j) => {
          const x = i * w + m + cx * (cw + g), y = m + cy * (rh + g), ww = cwN * cw + (cwN - 1) * g, hh = chN * rh + (chN - 1) * g;
          const bg = blocks[(i + j) % blocks.length], ink = inkOn(bg);
          const pad = { padding: "26px 30px", boxSizing: "border-box" as const, display: "flex", flexDirection: "column" as const, justifyContent: "flex-end" };
          if (kind === "photo") return <Box key={`${i}-${j}`} x={x} y={y} w={ww} h={hh}><Photo p={at(p.photos, k++)} /></Box>;
          if (kind === "title") return (
            <Box key={`${i}-${j}`} x={x} y={y} w={ww} h={hh} style={{ background: "#151515", color: "#fff", ...pad }}>
              <div style={{ fontFamily: "Anton", fontSize: p.title.length > 16 ? 112 : 140, lineHeight: 0.9, textTransform: "uppercase", textWrap: "balance" } as React.CSSProperties}>{p.title}</div>
              <div style={{ fontFamily: "Zen Kaku Gothic New", fontWeight: 700, fontSize: 36, marginTop: 14, color: bg }}>{p.titleJa}　{p.handle}</div>
            </Box>);
          if (kind === "fact" || kind === "word") { const ft = at(facts, f++); return (
            <Box key={`${i}-${j}`} x={x} y={y} w={ww} h={hh} style={{ background: bg, color: ink, ...pad }}>
              <div style={{ fontFamily: "Anton", fontSize: Math.min(hh * 0.62, 150), lineHeight: 0.9 }}>{ft.big}<span style={{ fontSize: Math.min(hh * 0.3, 64) }}>{ft.unit}</span></div>
              <div style={{ fontFamily: "Zen Kaku Gothic New", fontWeight: 700, fontSize: 28, marginTop: 8 }}>{ft.ja}</div>
            </Box>); }
          const note = n++;
          return (
            <Box key={`${i}-${j}`} x={x} y={y} w={ww} h={hh} style={{ background: "#fff", color: "#151515", ...pad, borderLeft: `10px solid ${bg}` }}>
              <div style={{ fontFamily: "Zen Kaku Gothic New", fontWeight: 700, fontSize: 44, lineHeight: 1.3 }}>{at(p.notesJa, note)}</div>
              <div style={{ fontFamily: "Anton", fontSize: 30, marginTop: 10, letterSpacing: "0.02em", textTransform: "uppercase", color: "#555" }}>{at(p.notes, note)}</div>
            </Box>);
        });
      })}
    </AbsoluteFill>
  );
};

/* 20. In numbers: one true number a slide */
const Numbers: React.FC<PostProps> = (p) => {
  const { w, h, panels } = p, r = rng(p.seed + 20), facts = factsOf(p);
  const own = (p.photoPalette || []);
  const cols = [...own.slice(0, 2), ...[...POPS].sort(() => r() - 0.5)].slice(0, panels);
  return (
    <AbsoluteFill>
      {Array.from({ length: panels }, (_, i) => {
        const x = i * w, bg = cols[i % cols.length], ink = inkOn(bg), last = i === panels - 1, ft = at(facts, i - 1);
        const ph = at(p.photos, i), circle = (i + (p.variant || 0)) % 2 === 0;
        return (
          <React.Fragment key={i}>
            <Box x={x} y={0} w={w} h={h} style={{ background: bg }} />
            <Box x={x + (circle ? 420 : 520)} y={circle ? 700 : 620} w={circle ? 760 : 640} h={circle ? 760 : 860} style={{ borderRadius: circle ? "50%" : "320px 320px 0 0", overflow: "hidden" }}><Photo p={ph} /></Box>
            {i === 0 ? (
              <Text x={x + 70} y={90} w={w - 140} style={{ color: ink }}>
                <div style={{ fontFamily: "DM Sans", fontWeight: 700, fontSize: 30, letterSpacing: "0.3em" }}>{p.handle.toUpperCase()}</div>
                <div style={{ fontFamily: "Anton", fontSize: 220, lineHeight: 0.9, marginTop: 20 }}>{SHORT(p)}<br />IN NUMBERS</div>
                <div style={{ fontFamily: "Zen Kaku Gothic New", fontWeight: 700, fontSize: 60, marginTop: 24 }}>{`数字で見る${PLACEJA(p)}`}</div>
              </Text>
            ) : last ? (
              <Text x={x + 70} y={110} w={w - 140} style={{ color: ink }}>
                <div style={{ fontFamily: "Zen Kaku Gothic New", fontWeight: 700, fontSize: 80, lineHeight: 1.3 }}>次の数字は、<br />あなたの泊数。</div>
                <div style={{ fontFamily: "DM Sans", fontSize: 36, marginTop: 24 }}>The next number is your nights. {p.handle}</div>
              </Text>
            ) : (
              <Text x={x + 70} y={90} w={w - 140} style={{ color: ink }}>
                <div style={{ fontFamily: "DM Sans", fontWeight: 700, fontSize: 30, letterSpacing: "0.3em" }}>{String(i).padStart(2, "0")} / {String(panels - 2).padStart(2, "0")}</div>
                <div style={{ fontFamily: "Anton", fontSize: ft.big.length > 4 ? 260 : 420, lineHeight: 0.92, marginTop: 10 }}>{ft.big}<span style={{ fontSize: 140 }}>{ft.unit}</span></div>
                <div style={{ fontFamily: "Zen Kaku Gothic New", fontWeight: 700, fontSize: 56, marginTop: 14 }}>{ft.ja}</div>
                <div style={{ fontFamily: "DM Sans", fontSize: 34, marginTop: 8, opacity: 0.85 }}>{ft.en}</div>
              </Text>
            )}
          </React.Fragment>
        );
      })}
    </AbsoluteFill>
  );
};

/* 21. Phone widgets: home-screen collage */
const Phone: React.FC<PostProps> = (p) => {
  const { w, h, panels } = p, r = rng(p.seed + 21), c = colours(p, r);
  const glass = { background: "rgba(255,255,255,0.72)", backdropFilter: "blur(20px)", borderRadius: 44, boxShadow: "0 18px 40px rgba(0,0,0,0.18)" };
  return (
    <AbsoluteFill style={{ background: "#ddd" }}>
      {Array.from({ length: panels }, (_, i) => {
        const x = i * w, ft = p.facts && p.facts.length ? at(p.facts, i) : null;
        const stat = ft ? { big: ft.big, unit: ft.unit, label: ft.ja } : { big: String(p.photos.length), unit: "", label: "枚の写真 · photos" };
        return (
          <React.Fragment key={i}>
            <Box x={x} y={0} w={w} h={h}><Photo p={at(p.photos, i)} filter="blur(28px) brightness(1.05)" style={{ transform: "scale(1.2)" }} /></Box>
            {/* a notification banner */}
            <div style={{ position: "absolute", left: x + 60, top: 70, width: w - 120, padding: "22px 26px", boxSizing: "border-box", display: "flex", gap: 20, alignItems: "center", ...glass, borderRadius: 34 }}>
              <div style={{ width: 70, height: 70, borderRadius: 18, background: c.a, color: inkOn(c.a), display: "grid", placeItems: "center", fontFamily: "DM Sans", fontWeight: 800, fontSize: 40 }}>{PLACEJA(p).slice(0, 1)}</div>
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "DM Sans", fontWeight: 700, fontSize: 26, color: "#222" }}><span>{p.brand}</span><span style={{ fontWeight: 400, color: "#666" }}>now</span></div>
                <div style={{ fontFamily: "Zen Kaku Gothic New", fontWeight: 500, fontSize: 30, color: "#111", marginTop: 4 }}>{i === 0 ? p.hookJa : at(p.notesJa, i - 1)}</div>
              </div>
            </div>
            {/* a big photo widget and a small stat widget */}
            <Box x={x + 60} y={260} w={i % 2 ? 960 : 600} h={600} style={{ borderRadius: 52, boxShadow: "0 18px 40px rgba(0,0,0,0.25)" }}><Photo p={at(p.photos, i + panels)} /></Box>
            {i % 2 ? null : (
              <div style={{ position: "absolute", left: x + 690, top: 260, width: 330, height: 600, padding: 34, boxSizing: "border-box", ...glass, display: "flex", flexDirection: "column", justifyContent: "space-between", color: "#111" }}>
                <div style={{ fontFamily: "DM Sans", fontWeight: 600, fontSize: 26 }}>{`📍 ${PLACEJA(p)}`}</div>
                <div style={{ fontFamily: "DM Sans", fontWeight: 300, fontSize: stat.big.length > 4 ? 88 : 120, lineHeight: 1 }}>{stat.big}<span style={{ fontSize: 44 }}>{stat.unit}</span></div>
                <div style={{ fontFamily: "Zen Kaku Gothic New", fontSize: 28 }}>{stat.label}</div>
              </div>
            )}
            {/* chat bubbles */}
            <div style={{ position: "absolute", left: x + 60, top: 920, width: w - 120, display: "flex", flexDirection: "column", gap: 16 }}>
              <div style={{ alignSelf: "flex-start", maxWidth: 700, padding: "20px 30px", borderRadius: "36px 36px 36px 10px", background: "rgba(255,255,255,0.92)", fontFamily: "Zen Kaku Gothic New", fontSize: 34, color: "#111" }}>{at(p.notesJa, i + 1)}</div>
              <div style={{ alignSelf: "flex-end", maxWidth: 700, padding: "20px 30px", borderRadius: "36px 36px 10px 36px", background: "#2f80ff", fontFamily: "Zen Kaku Gothic New", fontSize: 34, color: "#fff" }}>{i === panels - 1 ? `${p.handle} 見てみる👀` : at(p.notes, i + 2)}</div>
            </div>
          </React.Fragment>
        );
      })}
    </AbsoluteFill>
  );
};

/* 22. Pixel game */
const Pixel: React.FC<PostProps> = (p) => {
  const { w, h, panels } = p, r = rng(p.seed + 22);
  const px = (col: string) => `0 -8px 0 0 ${col}, 0 8px 0 0 ${col}, -8px 0 0 0 ${col}, 8px 0 0 0 ${col}`;
  const meters = [["あたたかさ", 0.9], ["しずけさ", 1], ["Wi-Fi", 0.8], ["ねむけ", 0.6 + r() * 0.3]] as [string, number][];
  return (
    <AbsoluteFill style={{ background: "#0e0e1a" }}>
      {Array.from({ length: panels }, (_, i) => {
        const x = i * w;
        return (
          <React.Fragment key={i}>
            <div style={{ position: "absolute", left: x + 90, top: 140, width: 900, height: 720, overflow: "hidden", boxShadow: px("#fff"), background: "#000" }}>
              <Frame w={900} h={720}><Photo p={at(p.photos, i)} /></Frame>
            </div>
            <div style={{ position: "absolute", left: x + 90, top: 920, width: 900, padding: "30px 40px", boxSizing: "border-box", background: "#1a1a3a", boxShadow: px("#fff"), color: "#fff" }}>
              <div style={{ fontFamily: "DotGothic16", fontSize: 44, lineHeight: 1.5 }}>{i === 0 ? `${p.titleJa}に とうちゃく した！` : at(p.notesJa, i - 1)}</div>
              <div style={{ fontFamily: "VT323", fontSize: 40, color: "#ffd23f", marginTop: 10 }}>{i === panels - 1 ? `▶ SAVE POINT · ${p.handle}` : "▼"}</div>
            </div>
            <Text x={x + 90} y={50} w={900} style={{ display: "flex", justifyContent: "space-between", fontFamily: "VT323", fontSize: 48, color: "#3bceac" }}>
              <span>{i === 0 ? `STAGE 1-1${p.alt ? `  ALT ${p.alt.replace(",", "")}M` : ""}` : `STAGE 1-${i + 1}`}</span><span>♥♥♥</span>
            </Text>
            {i === 1 ? (
              <div style={{ position: "absolute", left: x + 560, top: 180, width: 400, padding: 24, background: "rgba(14,14,26,0.86)", boxShadow: px("#ffd23f") }}>
                {meters.map(([name, v]) => (
                  <div key={name} style={{ fontFamily: "DotGothic16", fontSize: 28, color: "#fff", marginBottom: 10 }}>{name}
                    <div style={{ display: "flex", gap: 4, marginTop: 4 }}>{Array.from({ length: 10 }, (_, k) => <i key={k} style={{ width: 30, height: 18, background: k < Math.round(v * 10) ? "#3bceac" : "#333" }} />)}</div>
                  </div>
                ))}
              </div>
            ) : null}
          </React.Fragment>
        );
      })}
    </AbsoluteFill>
  );
};

const LOOKS: Record<string, React.FC<PostProps>> = { pano: Pano, polaroid: Polaroid, film: Film, magazine: Magazine, dump: Dump, scrapbook: Scrapbook, gallery: Gallery, tategaki: Tategaki, guide: Guide, newspaper: Newspaper,
  bento: Bento, shapes: Shapes, brutal: Brutal, riso: Riso, typeclip: TypeClip, ticket: Ticket, contact: Contact, aura: Aura, maximal: Maximal, numbers: Numbers, phone: Phone, pixel: Pixel };

export const Post: React.FC<PostProps> = (props) => {
  useFonts(USES[props.style] || USES.pano);
  const Look = LOOKS[props.style] || Pano;
  // lang="ja" + auto-phrase: Japanese lines break between phrases, never mid-word (21 Nov: bubbles broke at odd places);
  // balance: lines of even length, so no lone 「山」 on the last line (Chromium balances up to 6 lines, longer text wraps as usual)
  return <AbsoluteFill lang="ja" style={{ wordBreak: "auto-phrase", lineBreak: "strict", textWrap: "balance" } as React.CSSProperties}><Look {...props} /></AbsoluteFill>;
};
