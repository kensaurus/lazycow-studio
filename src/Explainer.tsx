/**
 * FILE: src/Explainer.tsx
 * PURPOSE: A short vertical explainer (9:16, 25-45 s) from facts, not only footage: a paper page, hand-drawn lines that
 *          draw themselves and "boil" (redrawn with a little jitter every few frames), a highlighter that wipes behind
 *          the key words, big counting numbers, tally marks, checklists, a "never do this" list, photo cards with a drawn
 *          arrow, a drawn route, a thermometer, two values side by side, a day as a clock, growing bars, a grid of drawn
 *          icons, numbered steps on a dashed path, a hand-lettered quote, and a small drawn mascot sticker. Real footage
 *          stays the picture where it has one (cover, cards, end).
 * OVERVIEW: props.scenes plays one after another; each scene's words are on screen from its first frame (the frame a
 *           feed shows), the drawing finishes within its first second or two, and the source of a number sits under
 *           it. Japanese first, English under it, sound-off friendly. ExplainerSheet draws every scene's settled frame on
 *           one still (the console's preview before a render).
 * DEPENDENCIES: remotion, @remotion/google-fonts (Klee One, Kalam, Dela Gothic One), @remotion/paths (evolvePath for the
 *               clock's arc and the steps' path), @remotion/noise (the mascot's idle wobble)
 * USAGE: <Composition id="Explainer-9x16" component={Explainer} ... /> and "Explainer-Sheet" (src/Root.tsx); props from
 *        py/studio/explainer.py (staged media under public/explainer/<slug>/).
 * NOTES: Made a video type on 27 Nov 2026 from the prototype (owner: "add animation or more graphics"). The script format
 *        and its checks live in py/studio/explainer.py (SCENES); a kind added here is added there too. Techniques:
 *        Vox-style highlighter and kicker, hand-drawn draw-on paths with boil, paper grain from an SVG turbulence filter.
 */
import React from "react";
import { AbsoluteFill, Audio, Easing, Freeze, Img, interpolate, OffthreadVideo, random, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { evolvePath } from "@remotion/paths";
import { noise2D } from "@remotion/noise";
import { loadFont as loadKlee } from "@remotion/google-fonts/KleeOne";
import { loadFont as loadKalam } from "@remotion/google-fonts/Kalam";
import { loadFont as loadDela } from "@remotion/google-fonts/DelaGothicOne";

const { fontFamily: KLEE } = loadKlee("normal", { weights: ["600"] });
const { fontFamily: KALAM } = loadKalam("normal", { weights: ["700"] });
const { fontFamily: DELA } = loadDela("normal", { weights: ["400"] });

const PAPER = "#f3ede1";
const INK = "#1d1b18";
const SOFT = "#5a534a";
const MARK = "rgba(255, 214, 64, 0.85)";
const CLAMP = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

type Words = { ja: string; en?: string };
type Item = Words;
export const ICONS = ["tent", "car", "kotatsu", "laptop", "wifi", "shower", "fire", "star", "snowflake", "mountain", "mug", "sun", "moon", "toilet", "dumbbell", "parking"] as const;
export type IconName = (typeof ICONS)[number];
type Mascot = boolean | "tl" | "tr" | "bl" | "br";
export type ExplainerScene =
  | ({ kind: "cover"; sec: number; src: string; kicker?: string; big?: string; source?: string; mascot?: Mascot } & Words)
  | ({ kind: "number"; sec: number; value: number; decimals?: number; unit?: string; source?: string; kicker?: string } & Words)
  | ({ kind: "tally"; sec: number; count: number; source?: string; kicker?: string } & Words)
  | ({ kind: "checklist"; sec: number; items: Item[]; note?: string; kicker?: string } & Words)
  | ({ kind: "nogo"; sec: number; items: Item[]; note?: string; kicker?: string } & Words)
  | ({ kind: "card"; sec: number; src: string; label?: Words; kicker?: string } & Words)
  | ({ kind: "route"; sec: number; from: Words; to: Words; via?: string; kicker?: string } & Words)
  | ({ kind: "pair"; sec: number; left: Words & { icon: IconName; src?: string }; right: Words & { icon: IconName; src?: string }; kicker?: string } & Words)
  | ({ kind: "thermo"; sec: number; value: number; unit?: string; label?: Words; compare?: { value: number; label?: Words }; min?: number; max?: number; source?: string; kicker?: string } & Words)
  | ({ kind: "compare"; sec: number; left: Words & { value: string }; right: Words & { value: string }; vs?: string; source?: string; kicker?: string } & Words)
  | ({ kind: "clock"; sec: number; hours: (Words & { at: string })[]; kicker?: string } & Words)
  | ({ kind: "bars"; sec: number; bars: (Words & { value: number; shown?: string })[]; unit?: string; source?: string; kicker?: string } & Words)
  | ({ kind: "icons"; sec: number; items: (Words & { icon: IconName })[]; note?: string; kicker?: string } & Words)
  | ({ kind: "steps"; sec: number; steps: Words[]; kicker?: string } & Words)
  | ({ kind: "quote"; sec: number; by?: string; kicker?: string } & Words)
  | ({ kind: "end"; sec: number; src: string; lines: string[]; mascot?: Mascot } & Words);
export type ExplainerProps = {
  scenes: ExplainerScene[]; accent?: string; series?: string;
  music?: { src: string; volume?: number; start?: number }; whoosh?: string; snow?: boolean; pencil?: string;
};
export type SheetProps = ExplainerProps & { frames?: number[] };

const SnowCtx = React.createContext(false);
const PencilCtx = React.createContext<string | undefined>(undefined);

export const explainerFrames = (p: ExplainerProps, fps: number) => Math.max(1, (p.scenes || []).reduce((t, s) => t + Math.round(s.sec * fps), 0));
/* Where each scene starts and the frame the sheet shows for it: near its end, every drawing finished (before the last
   scene's fade back to the cover). */
export const sceneStarts = (p: ExplainerProps, fps: number) => {
  const out: number[] = [];
  (p.scenes || []).reduce((t, s) => (out.push(t), t + Math.round(s.sec * fps)), 0);
  return out;
};
export const settledFrames = (p: ExplainerProps, fps: number) =>
  sceneStarts(p, fps).map((t, i) => t + Math.max(0, Math.round(p.scenes[i].sec * fps) - 16));
export const SHEET = { cols: 4, cell: 270, cellH: 480, label: 44 };
export const sheetSize = (p: SheetProps) => {
  const n = Math.max(1, (p.frames && p.frames.length ? p.frames : p.scenes || []).length);
  return { width: SHEET.cols * SHEET.cell, height: Math.ceil(n / SHEET.cols) * (SHEET.cellH + SHEET.label) };
};

/* ---------- the hand: paths that draw themselves and boil ---------- */
type Pt = [number, number];
const boil = (pts: Pt[], seed: string, frame: number, amp = 2.2): Pt[] => {
  const tick = Math.floor(frame / 4); // a new hand every 4 frames, like redrawn animation
  return pts.map(([x, y], i) => [x + (random(`${seed}-x-${i}-${tick}`) - 0.5) * amp * 2, y + (random(`${seed}-y-${i}-${tick}`) - 0.5) * amp * 2]);
};
const lengthOf = (pts: Pt[]) => pts.slice(1).reduce((t, p, i) => t + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);
const dOf = (pts: Pt[]) => pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
const circlePts = (cx: number, cy: number, r: number, n = 28, a0 = 0, a1 = Math.PI * 2, ry = r): Pt[] =>
  Array.from({ length: n + 1 }, (_, i) => { const a = a0 + ((a1 - a0) * i) / n; return [cx + Math.cos(a) * r, cy + Math.sin(a) * ry] as Pt; });

const Stroke: React.FC<{ pts: Pt[]; seed: string; start?: number; dur?: number; width?: number; color?: string; fill?: string }> = ({ pts, seed, start = 0, dur = 12, width = 9, color = INK, fill }) => {
  const frame = useCurrentFrame();
  const len = lengthOf(pts);
  const t = interpolate(frame, [start, start + dur], [0, 1], { ...CLAMP, easing: Easing.out(Easing.cubic) });
  if (t <= 0) return null;
  const d = dOf(boil(pts, seed, frame));
  return (
    <>
      {fill ? <path d={d + " Z"} fill={fill} opacity={t} stroke="none" /> : null}
      <path d={d} fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round"
        strokeDasharray={len + 40} strokeDashoffset={(len + 40) * (1 - t)} />
    </>
  );
};

/* A highlighter that wipes in behind a word. */
const Marked: React.FC<{ text: string; start?: number; color?: string }> = ({ text, start = 4, color = MARK }) => {
  const frame = useCurrentFrame();
  const w = interpolate(frame, [start, start + 10], [0, 100], { ...CLAMP, easing: Easing.out(Easing.quad) });
  return (
    <span style={{ position: "relative", display: "inline-block" }}>
      <span style={{ position: "absolute", left: -8, right: -8, top: "48%", bottom: "2%", background: color, transform: "rotate(-1.2deg)",
        clipPath: `inset(0 ${100 - w}% 0 0)`, borderRadius: 6 }} />
      <span style={{ position: "relative" }}>{text}</span>
    </span>
  );
};

/* Words with *marked* parts: 「昨冬は*−14.9℃*」. */
const Rich: React.FC<{ text: string; start?: number }> = ({ text, start }) => (
  <>{String(text || "").split(/(\*[^*]+\*)/).map((part, i) => (part.startsWith("*") && part.endsWith("*") && part.length > 2 ? <Marked key={i} text={part.slice(1, -1)} start={start} /> : <React.Fragment key={i}>{part}</React.Fragment>))}</>
);

/* How wide a line of text is, in em: full-width (Japanese) 1, Latin and digits about 0.56. Same measure as
   py/studio/explainer.py text_em, so the checks there and the sizes here agree. */
export const textEm = (s: string) => [...String(s || "").replace(/\*/g, "")].reduce((t, c) => t + (/[　-鿿＀-￯぀-ヿ]/.test(c) ? 1 : c === " " ? 0.3 : 0.56), 0);
/* The largest size (px) at which the longest written line fits `width`, between `min` and `max`. */
export const fitSize = (text: string, width: number, max: number, min = Math.round(max * 0.72)) => {
  const longest = Math.max(1, ...String(text || "").split("\n").map(textEm));
  return Math.max(min, Math.min(max, Math.floor(width / longest)));
};

/* ---------- page furniture ---------- */
const Paper: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const drift = interpolate(frame, [0, Math.max(1, durationInFrames)], [1, 1.035], CLAMP);
  const pencil = React.useContext(PencilCtx);
  return (
    <AbsoluteFill style={{ background: PAPER }}>
      {pencil ? <Sequence from={4} durationInFrames={27}><Audio src={staticFile(pencil)} volume={0.3} /></Sequence> : null}
      <AbsoluteFill style={{ transform: `scale(${drift})`, transformOrigin: "50% 40%" }}>{children}</AbsoluteFill>
      <Snow color="rgba(120,140,165,0.55)" />
      <svg width="100%" height="100%" style={{ position: "absolute", inset: 0, mixBlendMode: "multiply", opacity: 0.35, pointerEvents: "none" }}>
        <filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" /><feColorMatrix values="0 0 0 0 0.45  0 0 0 0 0.4  0 0 0 0 0.33  0 0 0 0.55 0" /></filter>
        <rect width="100%" height="100%" filter="url(#grain)" />
      </svg>
    </AbsoluteFill>
  );
};

/* Slow, sparse snow: only when the film asks for it. */
const Snow: React.FC<{ color: string }> = ({ color }) => {
  const on = React.useContext(SnowCtx);
  const frame = useCurrentFrame();
  if (!on) return null;
  return (
    <svg width="1080" height="1920" style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {Array.from({ length: 46 }, (_, i) => {
        const sp = 1.2 + random(`sp${i}`) * 2.2, r = 3 + random(`r${i}`) * 6;
        const y = ((random(`y${i}`) * 2100 + frame * sp) % 2100) - 90;
        const x = random(`x${i}`) * 1080 + Math.sin(frame / (22 + (i % 7)) + i) * 18;
        return <circle key={i} cx={x} cy={y} r={r} fill={color} />;
      })}
    </svg>
  );
};

/* A strip of masking tape holding a photo to the page. */
const Tape: React.FC<{ x: number; y: number; rot: number }> = ({ x, y, rot }) => (
  <div style={{ position: "absolute", left: x, top: y, width: 190, height: 58, background: "rgba(236,222,180,0.82)", transform: `rotate(${rot}deg)`,
    boxShadow: "0 2px 6px rgba(60,45,25,0.18)" }} />
);

const Kicker: React.FC<{ text?: string; accent: string }> = ({ text, accent }) =>
  text ? (
    <div style={{ position: "absolute", top: 150, left: 80, right: 80, fontFamily: KALAM, fontSize: 40, color: accent, letterSpacing: 1.5, textTransform: "uppercase", whiteSpace: "nowrap", overflow: "hidden" }}>
      {text}
    </div>
  ) : null;

/* The scene's headline: sized so its longest written line fits the page (never larger than `size`). */
const Head: React.FC<{ w: Words; top?: number; size?: number; color?: string; start?: number }> = ({ w, top = 230, size = 82, color = INK, start }) => {
  const px = fitSize(w.ja, 920, size);
  return (
    <div style={{ position: "absolute", top, left: 80, right: 80, color }}>
      <div style={{ fontFamily: KLEE, fontWeight: 600, fontSize: px, lineHeight: 1.32, whiteSpace: "pre-line" }}><Rich text={w.ja} start={start} /></div>
      {w.en ? <div style={{ fontFamily: KALAM, fontSize: Math.round(size * 0.46), lineHeight: 1.25, marginTop: 18, opacity: 0.82 }}>{w.en}</div> : null}
    </div>
  );
};

const Source: React.FC<{ text?: string }> = ({ text }) =>
  text ? <div style={{ position: "absolute", bottom: 210, left: 80, right: 80, fontFamily: KLEE, fontSize: 30, color: "#6b6357" }}>出典 / Source: {text}</div> : null;

const Caption: React.FC<{ w?: Words; top: number; left?: number; right?: number; size?: number; align?: "left" | "center" | "right"; start?: number }> = ({ w, top, left = 80, right = 80, size = 54, align = "center", start }) =>
  w ? (
    <div style={{ position: "absolute", top, left, right, textAlign: align }}>
      <div style={{ fontFamily: KLEE, fontWeight: 600, fontSize: fitSize(w.ja, 1080 - left - right, size), lineHeight: 1.25, color: INK, whiteSpace: "pre-line" }}><Rich text={w.ja} start={start} /></div>
      {w.en ? <div style={{ fontFamily: KALAM, fontSize: Math.round(size * 0.56), lineHeight: 1.2, color: SOFT }}>{w.en}</div> : null}
    </div>
  ) : null;

const isVideo = (src: string) => /\.(mp4|mov|webm|m4v)$/i.test(src || "");
const Picture: React.FC<{ src: string; style?: React.CSSProperties }> = ({ src, style }) =>
  isVideo(src) ? <OffthreadVideo src={staticFile(src)} muted style={{ width: "100%", height: "100%", objectFit: "cover", ...style }} />
    : <Img src={staticFile(src)} style={{ width: "100%", height: "100%", objectFit: "cover", ...style }} />;

/* ---------- the drawn icons (a 200 x 200 box around 0, 0) ---------- */
type Line = { pts: Pt[]; accent?: boolean; w?: number };
const star = (r1: number, r2: number): Pt[] => Array.from({ length: 11 }, (_, i) => {
  const a = -Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 ? r2 : r1;
  return [Math.cos(a) * r, Math.sin(a) * r] as Pt;
});
const flakeArm = (a: number, sg: number): Line => {
  const bx = sg * 58 * Math.cos(a), by = sg * 58 * Math.sin(a), back = a + (sg > 0 ? 0 : Math.PI);
  return { pts: [[bx - 24 * Math.cos(back - 0.8), by - 24 * Math.sin(back - 0.8)], [bx, by], [bx - 24 * Math.cos(back + 0.8), by - 24 * Math.sin(back + 0.8)]], accent: true, w: 7 };
};
const ICON_LINES: Record<IconName, Line[]> = {
  tent: [{ pts: [[-90, 70], [0, -80], [90, 70], [-90, 70]] }, { pts: [[0, -80], [-22, 70]], accent: true }, { pts: [[-110, 76], [110, 72]], w: 7 }],
  car: [{ pts: [[-95, 30], [-95, -2], [-62, -10], [-36, -46], [42, -46], [66, -10], [95, -4], [95, 30], [-95, 30]] },
    { pts: circlePts(-50, 36, 18, 14), accent: true }, { pts: circlePts(50, 36, 18, 14), accent: true }, { pts: [[-30, -40], [-26, -12], [55, -12]], w: 6 }],
  kotatsu: [{ pts: [[-92, -10], [92, -13]] }, { pts: [[-86, -6], [-106, 62], [-62, 52], [-22, 64], [18, 52], [58, 64], [106, 56], [86, -8]], accent: true },
    { pts: [[-42, -16], [-34, -72], [34, -74], [42, -16]], w: 7 }],
  laptop: [{ pts: [[-62, -62], [62, -62], [62, 22], [-62, 22], [-62, -62]] }, { pts: [[-88, 46], [88, 46], [62, 22], [-62, 22], [-88, 46]], accent: true }],
  wifi: [{ pts: circlePts(0, 60, 34, 10, -Math.PI * 0.78, -Math.PI * 0.22) }, { pts: circlePts(0, 60, 70, 14, -Math.PI * 0.78, -Math.PI * 0.22) },
    { pts: circlePts(0, 60, 106, 18, -Math.PI * 0.78, -Math.PI * 0.22) }, { pts: circlePts(0, 60, 7, 8), accent: true, w: 12 }],
  shower: [{ pts: [[-70, 92], [-70, -72], [12, -72], [12, -52]] }, { pts: [[-24, -50], [46, -50]] },
    { pts: [[-12, -28], [-17, -6]], accent: true }, { pts: [[12, -28], [12, -4]], accent: true }, { pts: [[36, -28], [41, -6]], accent: true },
    { pts: [[0, 10], [-4, 32]], accent: true }, { pts: [[24, 10], [28, 32]], accent: true }],
  fire: [{ pts: [[0, -92], [30, -42], [50, 0], [40, 40], [0, 60], [-40, 40], [-50, 0], [-26, -30], [-10, -10], [0, -92]], accent: true },
    { pts: [[0, -20], [16, 12], [0, 42], [-16, 12], [0, -20]] }, { pts: [[-72, 84], [72, 58]] }, { pts: [[-72, 58], [72, 84]] }],
  star: [{ pts: star(92, 38), accent: true }],
  snowflake: [0, 1, 2].flatMap((k): Line[] => {
    const a = (k * Math.PI) / 3;
    return [{ pts: [[-92 * Math.cos(a), -92 * Math.sin(a)], [92 * Math.cos(a), 92 * Math.sin(a)]] }, flakeArm(a, 1), flakeArm(a, -1)];
  }),
  mountain: [{ pts: [[-100, 72], [-42, -36], [-12, 4], [30, -72], [100, 72], [-100, 72]] }, { pts: [[12, -40], [30, -72], [50, -34], [36, -40], [24, -30], [12, -40]], accent: true, w: 7 }],
  mug: [{ pts: [[-52, -48], [-46, 72], [46, 72], [52, -48], [-52, -48]] }, { pts: [[52, -22], [82, -18], [82, 32], [48, 38]] },
    { pts: [[-16, -62], [-6, -80], [-16, -98]], accent: true, w: 7 }, { pts: [[16, -62], [26, -80], [16, -98]], accent: true, w: 7 }],
  sun: [{ pts: circlePts(0, 0, 42, 20), accent: true }, ...Array.from({ length: 8 }, (_, i): Line => {
    const a = (i * Math.PI) / 4;
    return { pts: [[Math.cos(a) * 62, Math.sin(a) * 62], [Math.cos(a) * 92, Math.sin(a) * 92]], w: 8 };
  })],
  moon: [{ pts: [...circlePts(0, 0, 74, 22, Math.PI * 0.32, Math.PI * 1.68), ...circlePts(34, -6, 62, 18, Math.PI * 1.48, Math.PI * 0.55)], accent: true },
    { pts: star(18, 8).map(([x, y]) => [x + 66, y - 62] as Pt), w: 5 }],
  toilet: [{ pts: [[-64, -92], [-12, -92], [-12, -22], [-64, -22], [-64, -92]] }, { pts: [[-64, -22], [74, -22], [62, 18], [22, 40], [32, 92], [-42, 92], [-32, 40], [-64, 18], [-64, -22]], accent: true }],
  dumbbell: [{ pts: [[-58, 0], [58, 0]], w: 12 }, { pts: [[-80, -44], [-58, -44], [-58, 44], [-80, 44], [-80, -44]], accent: true }, { pts: [[58, -44], [80, -44], [80, 44], [58, 44], [58, -44]], accent: true },
    { pts: [[-98, -26], [-80, -26], [-80, 26], [-98, 26]] }, { pts: [[98, -26], [80, -26], [80, 26], [98, 26]] }],
  parking: [{ pts: [[-82, -82], [82, -82], [82, 82], [-82, 82], [-82, -82]] }, { pts: [[-30, 60], [-30, -52], [20, -52], [46, -36], [46, -10], [20, 6], [-30, 6]], accent: true, w: 12 }],
};
/* One icon, drawn on at `start`, `scale` times its 200 px box, centred on (cx, cy). */
const DrawnIcon: React.FC<{ name: IconName; cx: number; cy: number; scale?: number; start?: number; accent: string; seed: string }> = ({ name, cx, cy, scale = 1, start = 0, accent, seed }) => (
  <>{(ICON_LINES[name] || ICON_LINES.star).map((l, k) => (
    <Stroke key={k} seed={`${seed}-${k}`} start={start + k * 3} dur={9} width={(l.w ?? 9) * Math.max(0.7, scale)} color={l.accent ? accent : INK}
      pts={l.pts.map(([x, y]) => [cx + x * scale, cy + y * scale] as Pt)} />
  ))}</>
);

/* ---------- the mascot: a little drawn cow face on a sticker, with an idle wobble (no words on it) ---------- */
const Cow: React.FC<{ at: Mascot; accent: string }> = ({ at, accent }) => {
  const frame = useCurrentFrame();
  const pos = at === true ? "br" : at;
  const x = pos === "tl" || pos === "bl" ? 90 : 760, y = pos === "tl" || pos === "tr" ? 360 : 1250;
  const rot = noise2D("cow-r", frame / 45, 0) * 6, bob = noise2D("cow-y", 0, frame / 38) * 10;
  const pop = interpolate(frame, [2, 12], [0, 1], { ...CLAMP, easing: Easing.out(Easing.back(1.8)) });
  const blink = frame % 70 > 64 ? 0.15 : 1;
  return (
    <svg width="230" height="230" viewBox="-115 -115 230 230" style={{ position: "absolute", left: x, top: y + bob, transform: `rotate(${rot}deg) scale(${pop})`,
      filter: "drop-shadow(0 8px 14px rgba(0,0,0,0.35))" }}>
      <circle r={108} fill="#fff" />
      <ellipse cx={-70} cy={-46} rx={28} ry={16} fill="#fff" stroke={INK} strokeWidth={6} transform="rotate(-24 -70 -46)" />
      <ellipse cx={70} cy={-46} rx={28} ry={16} fill="#fff" stroke={INK} strokeWidth={6} transform="rotate(24 70 -46)" />
      <path d="M -34 -66 Q -40 -92 -26 -98" fill="none" stroke={INK} strokeWidth={6} strokeLinecap="round" />
      <path d="M 34 -66 Q 40 -92 26 -98" fill="none" stroke={INK} strokeWidth={6} strokeLinecap="round" />
      <path d="M -54 -40 C -60 -84 60 -84 54 -40 C 62 0 52 30 0 34 C -52 30 -62 0 -54 -40 Z" fill="#fff" stroke={INK} strokeWidth={6} />
      <path d="M 18 -70 C 40 -72 50 -52 36 -40 C 24 -32 10 -48 18 -70 Z" fill={INK} opacity={0.85} />
      <ellipse cx={-22} cy={-24} rx={7} ry={9 * blink} fill={INK} />
      <ellipse cx={22} cy={-24} rx={7} ry={9 * blink} fill={INK} />
      <ellipse cx={0} cy={30} rx={50} ry={32} fill="#f5b8b0" stroke={INK} strokeWidth={6} />
      <ellipse cx={-17} cy={28} rx={6} ry={8} fill={INK} />
      <ellipse cx={17} cy={28} rx={6} ry={8} fill={INK} />
      <path d="M -14 48 Q 0 56 14 48" fill="none" stroke={INK} strokeWidth={5} strokeLinecap="round" />
      <circle cx={-46} cy={4} r={7} fill={accent} opacity={0.45} />
      <circle cx={46} cy={4} r={7} fill={accent} opacity={0.45} />
    </svg>
  );
};

/* ---------- scenes ---------- */
const Cover: React.FC<{ s: Extract<ExplainerScene, { kind: "cover" }>; accent: string }> = ({ s, accent }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const scale = interpolate(frame, [0, Math.max(1, durationInFrames)], [1.0, 1.08], CLAMP);
  const px = fitSize(s.ja, 920, 96);
  return (
    <AbsoluteFill style={{ background: "#000" }}>
      <AbsoluteFill style={{ transform: `scale(${scale})` }}><Picture src={s.src} /></AbsoluteFill>
      <AbsoluteFill style={{ background: "linear-gradient(180deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.05) 45%, rgba(0,0,0,0.45) 100%)" }} />
      <div style={{ position: "absolute", top: 150, left: 80, right: 80, fontFamily: KALAM, fontSize: 40, color: "#ffd640", textTransform: "uppercase", letterSpacing: 1.5, whiteSpace: "nowrap", overflow: "hidden" }}>{s.kicker}</div>
      <div style={{ position: "absolute", top: 230, left: 80, right: 80, color: "#fff", textShadow: "0 4px 24px rgba(0,0,0,0.5)" }}>
        <div style={{ fontFamily: KLEE, fontWeight: 600, fontSize: px, lineHeight: 1.28, whiteSpace: "pre-line" }}><Rich text={s.ja} start={2} /></div>
        {s.en ? <div style={{ fontFamily: KALAM, fontSize: 46, marginTop: 20 }}>{s.en}</div> : null}
      </div>
      <svg width="1080" height="1920" style={{ position: "absolute", inset: 0 }}>
        {s.big ? null : <Stroke seed="cover-u" start={4} dur={14} width={10} color={accent} pts={[[90, 650], [380, 642], [700, 655], [960, 640]]} />}
      </svg>
      {s.big ? (
        /* The payoff is on screen from frame 0: the number first, the question after. */
        <div style={{ position: "absolute", top: 780, left: 40, right: 40, textAlign: "center", fontFamily: DELA, fontSize: Math.min(190, Math.floor(1500 / Math.max(4, s.big.length))),
          color: "#fff", letterSpacing: -4, textShadow: "0 8px 40px rgba(0,0,0,0.55)", whiteSpace: "nowrap" }}>{s.big}</div>
      ) : null}
      {s.source ? (
        <div style={{ position: "absolute", top: 1050, left: 0, right: 0, display: "flex", justifyContent: "center" }}>
          <div style={{ background: "rgba(20,18,16,0.62)", borderRadius: 14, padding: "10px 22px", maxWidth: 900, textAlign: "center",
            fontFamily: KLEE, fontSize: 30, lineHeight: 1.4, color: "#fff" }}>{s.source}</div>
        </div>
      ) : null}
      <Snow color="rgba(255,255,255,0.85)" />
      {s.mascot ? <Cow at={s.mascot} accent={accent} /> : null}
    </AbsoluteFill>
  );
};

const NumberScene: React.FC<{ s: Extract<ExplainerScene, { kind: "number" }>; accent: string }> = ({ s, accent }) => {
  const frame = useCurrentFrame();
  const v = interpolate(frame, [0, 22], [0, s.value], { ...CLAMP, easing: Easing.out(Easing.cubic) });
  const shown = `${v < 0 ? "−" : ""}${Math.abs(v).toFixed(s.decimals ?? 0)}`;
  const size = Math.min(250, Math.floor(900 / Math.max(1, textEm(shown) + textEm(s.unit || "") * 0.5)));
  return (
    <Paper>
      <Kicker text={s.kicker} accent={accent} />
      <Head w={{ ja: s.ja, en: s.en }} />
      <div style={{ position: "absolute", top: 760, left: 0, right: 0, textAlign: "center", fontFamily: DELA, fontSize: size, color: accent, letterSpacing: -6, whiteSpace: "nowrap" }}>
        {shown}<span style={{ fontSize: Math.round(size * 0.48) }}>{s.unit}</span>
      </div>
      <svg width="1080" height="1920" style={{ position: "absolute", inset: 0 }}>
        <Stroke seed="num-ring" start={8} dur={18} width={8} pts={Array.from({ length: 34 }, (_, i) => {
          const a = (i / 32) * Math.PI * 2 - 0.6;
          return [540 + Math.cos(a) * 470, 930 + Math.sin(a) * 210] as Pt;
        })} />
      </svg>
      <Source text={s.source} />
    </Paper>
  );
};

const Tally: React.FC<{ s: Extract<ExplainerScene, { kind: "tally" }>; accent: string }> = ({ s, accent }) => {
  const marks: React.ReactNode[] = [];
  const per = 3; // frames per mark
  for (let i = 0; i < Math.min(45, s.count); i++) {
    const g = Math.floor(i / 5), k = i % 5, gx = 120 + (g % 3) * 300, gy = 900 + Math.floor(g / 3) * 300;
    const pts: Pt[] = k < 4 ? [[gx + k * 50, gy], [gx + k * 50 + 6, gy + 200]] : [[gx - 30, gy + 150], [gx + 200, gy + 40]];
    marks.push(<Stroke key={i} seed={`t${i}`} start={4 + i * per} dur={6} width={12} color={k === 4 ? accent : INK} pts={pts} />);
  }
  return (
    <Paper>
      <Kicker text={s.kicker} accent={accent} />
      <Head w={{ ja: s.ja, en: s.en }} />
      <svg width="1080" height="1920" style={{ position: "absolute", inset: 0 }}>{marks}</svg>
      <Source text={s.source} />
    </Paper>
  );
};

const ListScene: React.FC<{ s: Extract<ExplainerScene, { kind: "checklist" | "nogo" }>; accent: string }> = ({ s, accent }) => {
  const nogo = s.kind === "nogo";
  return (
    <Paper>
      <Kicker text={s.kicker} accent={accent} />
      <Head w={{ ja: s.ja, en: s.en }} size={74} />
      {s.items.map((it, i) => {
        const y = 760 + i * 190, start = 6 + i * 7;
        return (
          <React.Fragment key={i}>
            <svg width="1080" height="1920" style={{ position: "absolute", inset: 0 }}>
              <Stroke seed={`box${i}`} start={start - 4} dur={8} width={7} pts={[[90, y], [190, y + 4], [186, y + 104], [92, y + 100], [90, y]]} />
              {nogo ? (
                <>
                  <Stroke seed={`x1${i}`} start={start} dur={6} width={12} color="#c8321f" pts={[[100, y + 10], [180, y + 94]]} />
                  <Stroke seed={`x2${i}`} start={start + 3} dur={6} width={12} color="#c8321f" pts={[[180, y + 10], [100, y + 94]]} />
                </>
              ) : (
                <Stroke seed={`tick${i}`} start={start} dur={8} width={13} color={accent} pts={[[100, y + 50], [130, y + 88], [200, y - 16]]} />
              )}
            </svg>
            <div style={{ position: "absolute", top: y - 4, left: 240, right: 60 }}>
              <div style={{ fontFamily: KLEE, fontWeight: 600, fontSize: fitSize(it.ja, 780, 60), color: INK, whiteSpace: "nowrap", textDecoration: nogo ? "line-through" : undefined, textDecorationColor: "rgba(200,50,31,0.7)" }}>{it.ja}</div>
              {it.en ? <div style={{ fontFamily: KALAM, fontSize: 32, color: SOFT, whiteSpace: "nowrap", overflow: "hidden" }}>{it.en}</div> : null}
            </div>
          </React.Fragment>
        );
      })}
      {s.note ? <div style={{ position: "absolute", bottom: 210, left: 80, right: 80, fontFamily: KLEE, fontSize: 36, color: SOFT, whiteSpace: "pre-line" }}>{s.note}</div> : null}
    </Paper>
  );
};

const Card: React.FC<{ s: Extract<ExplainerScene, { kind: "card" }>; accent: string }> = ({ s, accent }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const push = interpolate(frame, [0, Math.max(1, durationInFrames)], [1, 1.07], CLAMP);
  return (
    <Paper>
      <Kicker text={s.kicker} accent={accent} />
      <Head w={{ ja: s.ja, en: s.en }} size={74} />
      <div style={{ position: "absolute", top: 760, left: 70, width: 940, height: 705, background: "#fff", padding: 18, transform: "rotate(-1.6deg)",
        boxShadow: "0 18px 40px rgba(60,45,25,0.28)" }}>
        <div style={{ width: "100%", height: "100%", overflow: "hidden" }}>
          <div style={{ width: "100%", height: "100%", transform: `scale(${push})` }}><Picture src={s.src} /></div>
        </div>
      </div>
      <Tape x={40} y={735} rot={-24} />
      <Tape x={860} y={720} rot={18} />
      {s.label ? (
        <>
          <svg width="1080" height="1920" style={{ position: "absolute", inset: 0 }}>
            <Stroke seed="arrow" start={8} dur={12} width={9} color={accent} pts={[[300, 1620], [420, 1560], [520, 1420]]} />
            <Stroke seed="arrowhead" start={18} dur={6} width={9} color={accent} pts={[[470, 1440], [520, 1420], [522, 1474]]} />
          </svg>
          <div style={{ position: "absolute", top: 1600, left: 80, right: 80 }}>
            <div style={{ fontFamily: KLEE, fontWeight: 600, fontSize: fitSize(s.label.ja, 920, 54), color: INK, whiteSpace: "pre-line" }}>{s.label.ja}</div>
            {s.label.en ? <div style={{ fontFamily: KALAM, fontSize: 32, color: SOFT }}>{s.label.en}</div> : null}
          </div>
        </>
      ) : null}
    </Paper>
  );
};

const Route: React.FC<{ s: Extract<ExplainerScene, { kind: "route" }>; accent: string }> = ({ s, accent }) => {
  const frame = useCurrentFrame();
  // A schematic climb from the city to the mountain: left low, right high, drawn like a sketch on a napkin.
  const pts: Pt[] = [[130, 1450], [260, 1430], [380, 1400], [470, 1330], [560, 1270], [640, 1150], [720, 1060], [800, 960], [880, 900], [950, 860]];
  const t = interpolate(frame, [4, 34], [0, 1], { ...CLAMP, easing: Easing.inOut(Easing.cubic) });
  const at = Math.min(pts.length - 1, t * (pts.length - 1));
  const a = pts[Math.floor(at)], b = pts[Math.min(pts.length - 1, Math.floor(at) + 1)], f = at - Math.floor(at);
  const car: Pt = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  return (
    <Paper>
      <Kicker text={s.kicker} accent={accent} />
      <Head w={{ ja: s.ja, en: s.en }} size={74} />
      <svg width="1080" height="1920" style={{ position: "absolute", inset: 0 }}>
        <Stroke seed="ground" start={0} dur={8} width={5} color="#8a8174" pts={[[100, 1500], [980, 1500]]} />
        <Stroke seed="route" start={4} dur={30} width={12} color={accent} pts={pts} />
        <circle cx={car[0]} cy={car[1]} r={22} fill={INK} />
        <Stroke seed="dot1" start={0} dur={6} width={10} pts={[[124, 1444], [136, 1456]]} />
      </svg>
      <div style={{ position: "absolute", top: 1530, left: 80, fontFamily: KLEE, fontWeight: 600, fontSize: 52 }}>{s.from.ja}<div style={{ fontFamily: KALAM, fontSize: 32 }}>{s.from.en}</div></div>
      <div style={{ position: "absolute", top: 720, right: 80, textAlign: "right", fontFamily: KLEE, fontWeight: 600, fontSize: 52 }}>{s.to.ja}<div style={{ fontFamily: KALAM, fontSize: 32 }}>{s.to.en}</div></div>
      {s.via ? <div style={{ position: "absolute", top: 1180, left: 120, fontFamily: KALAM, fontSize: 44, color: accent, transform: "rotate(-14deg)" }}>{s.via}</div> : null}
    </Paper>
  );
};

/* A thermometer whose mercury rises to the value (a second one beside it for a comparison). */
const signed = (v: number, d = 1) => `${v < 0 ? "−" : ""}${Math.abs(v).toFixed(Number.isInteger(v) ? 0 : d)}`;
const Thermo: React.FC<{ s: Extract<ExplainerScene, { kind: "thermo" }>; accent: string }> = ({ s, accent }) => {
  const frame = useCurrentFrame();
  const vals = [s.value, ...(s.compare ? [s.compare.value] : [])];
  const lo = s.min ?? Math.floor((Math.min(...vals, 0) - 5) / 5) * 5, hi = s.max ?? Math.ceil((Math.max(...vals, 0) + 5) / 5) * 5;
  const top = 860, bottom = 1400, unit = s.unit ?? "℃";
  const yOf = (v: number) => bottom - ((v - lo) / Math.max(1e-6, hi - lo)) * (bottom - top);
  const step = hi - lo > 30 ? 10 : 5;
  const ticks = Array.from({ length: Math.floor((hi - lo) / step) + 1 }, (_, i) => lo + i * step);
  const solo = !s.compare;
  const one = (cx: number, value: number, label: Words | undefined, k: number, cool: boolean) => {
    const t = interpolate(frame, [6 + k * 10, 34 + k * 10], [0, 1], { ...CLAMP, easing: Easing.out(Easing.cubic) });
    const v = lo + (value - lo) * t, level = yOf(v), color = cool ? "#2f6fb0" : accent;
    return (
      <React.Fragment key={k}>
        <svg width="1080" height="1920" style={{ position: "absolute", inset: 0 }}>
          <rect x={cx - 22} y={level} width={44} height={bottom + 40 - level} fill={color} opacity={0.9} rx={10} />
          <circle cx={cx} cy={bottom + 70} r={60} fill={color} opacity={0.9} />
          <Stroke seed={`tube${k}`} start={k * 4} dur={12} width={9} pts={[[cx - 38, bottom + 28], [cx - 38, top - 20], ...circlePts(cx, top - 20, 38, 10, Math.PI, Math.PI * 2), [cx + 38, bottom + 28]]} />
          <Stroke seed={`bulb${k}`} start={k * 4 + 6} dur={12} width={9} pts={circlePts(cx, bottom + 70, 76, 26, -Math.PI * 0.32, Math.PI * 1.32)} />
          {ticks.map((tv, i) => (
            <Stroke key={i} seed={`tick${k}-${i}`} start={8 + i} dur={4} width={tv === 0 ? 7 : 5} color={tv === 0 ? INK : "#8a8174"} pts={[[cx + 40, yOf(tv)], [cx + (tv === 0 ? 80 : 62), yOf(tv)]]} />
          ))}
        </svg>
        {ticks.map((tv, i) => (
          <div key={`l${i}`} style={{ position: "absolute", top: yOf(tv) - 20, left: cx + 88, fontFamily: KALAM, fontSize: 30, color: tv === 0 ? INK : "#8a8174" }}>{signed(tv)}°</div>
        ))}
        <div style={{ position: "absolute", top: solo ? Math.max(700, Math.min(1260, level - 70)) : 700, left: solo ? cx + 170 : cx - 230, width: solo ? 600 : 460, textAlign: solo ? "left" : "center",
          fontFamily: DELA, fontSize: solo ? 130 : 96, color, letterSpacing: -3, whiteSpace: "nowrap" }}>{signed(v)}<span style={{ fontSize: solo ? 64 : 48 }}>{unit}</span></div>
        <Caption w={label} top={1590} left={solo ? 80 : cx - 250} right={solo ? 80 : 1080 - cx - 250} size={46} align={solo ? "left" : "center"} start={20 + k * 10} />
      </React.Fragment>
    );
  };
  return (
    <Paper>
      <Kicker text={s.kicker} accent={accent} />
      <Head w={{ ja: s.ja, en: s.en }} size={74} />
      {s.compare ? [one(290, s.value, s.label, 0, s.value < s.compare.value), one(760, s.compare.value, s.compare.label, 1, s.compare.value < s.value)] : one(240, s.value, s.label, 0, s.value < 0)}
      <Source text={s.source} />
    </Paper>
  );
};

/* Two big values side by side, each with its label; a drawn line between and a circle round the right one. */
const Compare: React.FC<{ s: Extract<ExplainerScene, { kind: "compare" }>; accent: string }> = ({ s, accent }) => {
  const frame = useCurrentFrame();
  const col = (w: Words & { value: string }, cx: number, k: number) => {
    const t = interpolate(frame, [4 + k * 10, 14 + k * 10], [0, 1], { ...CLAMP, easing: Easing.out(Easing.back(1.6)) });
    const size = Math.min(150, Math.floor(420 / Math.max(1, textEm(w.value))));
    return (
      <React.Fragment key={k}>
        <div style={{ position: "absolute", top: 975 - size * 0.62, left: cx - 240, width: 480, textAlign: "center", fontFamily: DELA, fontSize: size, letterSpacing: -3,
          color: k ? accent : INK, transform: `scale(${0.6 + 0.4 * t})`, opacity: t, whiteSpace: "nowrap" }}>{w.value}</div>
        <Caption w={w} top={1150} left={cx - 230} right={1080 - cx - 230} size={50} start={14 + k * 10} />
      </React.Fragment>
    );
  };
  return (
    <Paper>
      <Kicker text={s.kicker} accent={accent} />
      <Head w={{ ja: s.ja, en: s.en }} size={74} />
      {col(s.left, 280, 0)}
      {col(s.right, 800, 1)}
      <svg width="1080" height="1920" style={{ position: "absolute", inset: 0 }}>
        <Stroke seed="cmp-mid" start={2} dur={10} width={6} color="#8a8174" pts={[[540, 800], [536, 1000], [542, 1200], [538, 1380]]} />
        <Stroke seed="cmp-ring" start={22} dur={14} width={8} color={accent} pts={circlePts(800, 975, 250, 30, -2.4, 3.6, 130)} />
      </svg>
      {s.vs ? <div style={{ position: "absolute", top: 1440, left: 0, right: 0, textAlign: "center", fontFamily: KALAM, fontSize: 44, color: accent, transform: "rotate(-3deg)" }}>{s.vs}</div> : null}
      <Source text={s.source} />
    </Paper>
  );
};

/* A day as a clock face: the hand sweeps through the hours in order, an arc keeps the time gone, each hour's row lights. */
export const hourAngle = (at: string) => {
  const [h, m] = String(at).split(":").map((x) => parseInt(x, 10) || 0);
  return (((h % 12) + m / 60) / 12) * Math.PI * 2 - Math.PI / 2;
};
const Clock: React.FC<{ s: Extract<ExplainerScene, { kind: "clock" }>; accent: string }> = ({ s, accent }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const cx = 540, cy = 990, r = 215, n = s.hours.length;
  // Unwrapped angles: the hand only goes forward, even past twelve.
  const angles: number[] = [];
  s.hours.forEach((h, i) => { let a = hourAngle(h.at); while (i && a <= angles[i - 1]) a += Math.PI * 2; angles.push(a); });
  const span = Math.max(30, Math.min(durationInFrames - 24, 30 * n));
  const at = (i: number) => 8 + (i * span) / Math.max(1, n - 1);
  const t = n > 1 ? interpolate(frame, s.hours.map((_, i) => at(i)), angles, { ...CLAMP, easing: Easing.inOut(Easing.cubic) }) : angles[0];
  const reached = Math.max(0, s.hours.filter((_, i) => frame >= at(i) - 1).length - 1);
  const arc = circlePts(cx, cy, r - 34, 60, angles[0], angles[n - 1]).map(([x, y], i) => `${i ? "L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const p = n > 1 ? Math.max(0, Math.min(1, (t - angles[0]) / Math.max(1e-6, angles[n - 1] - angles[0]))) : 1;
  const ev = evolvePath(Math.max(0.001, p), arc);
  return (
    <Paper>
      <Kicker text={s.kicker} accent={accent} />
      <Head w={{ ja: s.ja, en: s.en }} size={74} />
      <svg width="1080" height="1920" style={{ position: "absolute", inset: 0 }}>
        <Stroke seed="face" start={0} dur={14} width={9} pts={circlePts(cx, cy, r, 40)} />
        {Array.from({ length: 12 }, (_, i) => {
          const a = (i / 12) * Math.PI * 2 - Math.PI / 2, long = i % 3 === 0;
          return <Stroke key={i} seed={`ct${i}`} start={4 + i} dur={4} width={long ? 8 : 5} pts={[[cx + Math.cos(a) * (r - (long ? 30 : 18)), cy + Math.sin(a) * (r - (long ? 30 : 18))], [cx + Math.cos(a) * (r - 6), cy + Math.sin(a) * (r - 6)]]} />;
        })}
        {n > 1 ? <path d={arc} fill="none" stroke={accent} strokeWidth={22} strokeLinecap="round" opacity={0.35} strokeDasharray={ev.strokeDasharray} strokeDashoffset={ev.strokeDashoffset} /> : null}
        {s.hours.map((_, i) => (i <= reached ? <circle key={i} cx={cx + Math.cos(angles[i]) * (r - 34)} cy={cy + Math.sin(angles[i]) * (r - 34)} r={13} fill={accent} /> : null))}
        <line x1={cx} y1={cy} x2={cx + Math.cos(t) * (r - 52)} y2={cy + Math.sin(t) * (r - 52)} stroke={INK} strokeWidth={13} strokeLinecap="round" />
        <circle cx={cx} cy={cy} r={16} fill={INK} />
      </svg>
      {s.hours.map((h, i) => {
        const on = i === reached, done = i < reached, y = 1255 + i * Math.min(72, 430 / Math.max(1, n));
        return (
          <div key={i} style={{ position: "absolute", top: y, left: 110, right: 80, display: "flex", alignItems: "baseline", gap: 26, opacity: on ? 1 : done ? 0.55 : 0.32 }}>
            <span style={{ fontFamily: DELA, fontSize: 44, color: on ? accent : INK, width: 150, flexShrink: 0 }}>{h.at}</span>
            <span style={{ fontFamily: KLEE, fontWeight: 600, fontSize: fitSize(h.ja, 420, 44), color: INK, whiteSpace: "nowrap" }}>{on ? <Marked text={h.ja.replace(/\*/g, "")} start={at(i)} /> : h.ja.replace(/\*/g, "")}</span>
            {h.en ? <span style={{ fontFamily: KALAM, fontSize: 28, color: SOFT, whiteSpace: "nowrap", overflow: "hidden" }}>{h.en}</span> : null}
          </div>
        );
      })}
    </Paper>
  );
};

/* 2-5 bars that grow from a drawn baseline, each counting up to its value; the biggest in the accent. */
const Bars: React.FC<{ s: Extract<ExplainerScene, { kind: "bars" }>; accent: string }> = ({ s, accent }) => {
  const frame = useCurrentFrame();
  const n = s.bars.length, base = 1440, tall = 560, left = 110, width = 860, gap = 36;
  const bw = (width - gap * (n - 1)) / n, most = Math.max(1e-6, ...s.bars.map((b) => b.value));
  const grow = (i: number) => interpolate(frame, [6 + i * 6, 28 + i * 6], [0, 1], { ...CLAMP, easing: Easing.out(Easing.cubic) });
  return (
    <Paper>
      <Kicker text={s.kicker} accent={accent} />
      <Head w={{ ja: s.ja, en: s.en }} size={74} />
      <svg width="1080" height="1920" style={{ position: "absolute", inset: 0 }}>
        <Stroke seed="base" start={0} dur={8} width={7} pts={[[left - 20, base], [left + width + 20, base + 3]]} />
        {s.bars.map((b, i) => {
          const h = (b.value / most) * tall * grow(i), x = left + i * (bw + gap), hi = b.value === most;
          return (
            <React.Fragment key={i}>
              <rect x={x} y={base - h} width={bw} height={h} fill={hi ? accent : "rgba(29,27,24,0.16)"} opacity={hi ? 0.85 : 1} />
              {h > 8 ? <path d={dOf(boil([[x, base], [x, base - h], [x + bw, base - h], [x + bw, base]], `bar${i}`, frame, 1.6))} fill="none" stroke={INK} strokeWidth={6} strokeLinejoin="round" /> : null}
            </React.Fragment>
          );
        })}
      </svg>
      {s.bars.map((b, i) => {
        const t = grow(i), x = left + i * (bw + gap), h = (b.value / most) * tall * t;
        const label = b.shown ?? `${(b.value * t).toFixed(Number.isInteger(b.value) ? 0 : 1)}${s.unit ?? ""}`;
        return (
          <React.Fragment key={i}>
            <div style={{ position: "absolute", top: base - h - 82, left: x - 30, width: bw + 60, textAlign: "center", fontFamily: DELA, fontSize: Math.min(64, Math.floor((bw + 50) / Math.max(1, textEm(label)))), color: b.value === most ? accent : INK, whiteSpace: "nowrap" }}>{label}</div>
            <div style={{ position: "absolute", top: base + 22, left: x - 22, width: bw + 44, textAlign: "center" }}>
              <div style={{ fontFamily: KLEE, fontWeight: 600, fontSize: fitSize(b.ja, bw + 44, 40, 26), color: INK, lineHeight: 1.2, whiteSpace: "pre-line" }}>{b.ja}</div>
              {b.en ? <div style={{ fontFamily: KALAM, fontSize: 26, color: SOFT, lineHeight: 1.15 }}>{b.en}</div> : null}
            </div>
          </React.Fragment>
        );
      })}
      <Source text={s.source} />
    </Paper>
  );
};

/* A grid of 3-6 drawn icons with a caption under each. */
const Icons: React.FC<{ s: Extract<ExplainerScene, { kind: "icons" }>; accent: string }> = ({ s, accent }) => {
  const n = s.items.length, cols = n === 4 ? 2 : 3, rows = Math.ceil(n / cols);
  const cw = 920 / cols, ch = rows === 1 ? 520 : 400, y0 = rows === 1 ? 860 : 760;
  const cell = (i: number) => {
    const c = i % cols, r = Math.floor(i / cols);
    const shift = r === rows - 1 && n % cols ? ((cols - (n % cols)) * cw) / 2 : 0;  // a short last row sits in the middle
    return { x: 80 + shift + c * cw, y: y0 + r * ch };
  };
  return (
    <Paper>
      <Kicker text={s.kicker} accent={accent} />
      <Head w={{ ja: s.ja, en: s.en }} size={74} />
      <svg width="1080" height="1920" style={{ position: "absolute", inset: 0 }}>
        {s.items.map((it, i) => <DrawnIcon key={i} name={it.icon} cx={cell(i).x + cw / 2} cy={cell(i).y + 110} scale={cols === 2 ? 1.05 : 0.9} start={4 + i * 5} accent={accent} seed={`ic${i}`} />)}
      </svg>
      {s.items.map((it, i) => (
        <div key={i} style={{ position: "absolute", top: cell(i).y + 230, left: cell(i).x + 6, width: cw - 12, textAlign: "center" }}>
          <div style={{ fontFamily: KLEE, fontWeight: 600, fontSize: fitSize(it.ja, cw - 12, 42, 30), color: INK, lineHeight: 1.2, whiteSpace: "pre-line" }}><Rich text={it.ja} start={10 + i * 5} /></div>
          {it.en ? <div style={{ fontFamily: KALAM, fontSize: 26, color: SOFT, lineHeight: 1.15 }}>{it.en}</div> : null}
        </div>
      ))}
      {s.note ? <div style={{ position: "absolute", bottom: 210, left: 80, right: 80, fontFamily: KLEE, fontSize: 34, color: SOFT, whiteSpace: "pre-line" }}>{s.note}</div> : null}
    </Paper>
  );
};

/* 2-4 numbered steps down the page, a dashed path drawn between them and the reached ones inked in. */
const Steps: React.FC<{ s: Extract<ExplainerScene, { kind: "steps" }>; accent: string }> = ({ s, accent }) => {
  const frame = useCurrentFrame();
  const n = s.steps.length, gapY = Math.min(250, 760 / Math.max(1, n - 1)), x = 170, y0 = 820;
  const ys = s.steps.map((_, i) => y0 + i * gapY);
  const d = ys.map((y, i) => (i ? `C ${x + 90} ${ys[i - 1] + gapY * 0.35} ${x - 90} ${y - gapY * 0.35} ${x} ${y}` : `M ${x} ${y}`)).join(" ");
  const p = interpolate(frame, [6, 6 + 16 * n], [0, 1], { ...CLAMP, easing: Easing.inOut(Easing.quad) });
  const ev = evolvePath(Math.max(0.001, p), n > 1 ? d : `M ${x} ${y0} L ${x} ${y0 + 1}`);
  const reached = Math.min(n - 1, Math.floor(p * (n - 1) + 0.02));
  return (
    <Paper>
      <Kicker text={s.kicker} accent={accent} />
      <Head w={{ ja: s.ja, en: s.en }} size={74} />
      <svg width="1080" height="1920" style={{ position: "absolute", inset: 0 }}>
        <mask id="steps-mask"><path d={d} fill="none" stroke="#fff" strokeWidth={20} strokeDasharray={ev.strokeDasharray} strokeDashoffset={ev.strokeDashoffset} /></mask>
        <path d={d} fill="none" stroke={accent} strokeWidth={8} strokeDasharray="4 22" strokeLinecap="round" mask="url(#steps-mask)" />
        {ys.map((y, i) => <Stroke key={i} seed={`st${i}`} start={4 + i * 16} dur={10} width={8} color={i <= reached ? INK : "#8a8174"} fill={i <= reached ? "#fff" : undefined} pts={circlePts(x, y, 62, 24)} />)}
      </svg>
      {ys.map((y, i) => (
        <React.Fragment key={i}>
          <div style={{ position: "absolute", top: y - 40, left: x - 62, width: 124, textAlign: "center", fontFamily: DELA, fontSize: 60, color: i <= reached ? accent : "#8a8174", lineHeight: "80px" }}>{i + 1}</div>
          <div style={{ position: "absolute", top: y - 44, left: x + 100, right: 70, opacity: i <= reached ? 1 : 0.45 }}>
            <div style={{ fontFamily: KLEE, fontWeight: 600, fontSize: fitSize(s.steps[i].ja, 740, 54, 38), color: INK, lineHeight: 1.22, whiteSpace: "pre-line" }}>{i === reached ? <Rich text={s.steps[i].ja} start={6 + i * 16} /> : s.steps[i].ja.replace(/\*/g, "")}</div>
            {s.steps[i].en ? <div style={{ fontFamily: KALAM, fontSize: 30, color: SOFT, lineHeight: 1.2 }}>{s.steps[i].en}</div> : null}
          </div>
        </React.Fragment>
      ))}
    </Paper>
  );
};

/* A big hand-lettered line between drawn quotation marks, underlined, with a small attribution. */
const Quote: React.FC<{ s: Extract<ExplainerScene, { kind: "quote" }>; accent: string }> = ({ s, accent }) => {
  const frame = useCurrentFrame();
  const px = fitSize(s.ja, 860, 104, 64);
  const lines = String(s.ja).split("\n").length;
  const textTop = 720, under = textTop + lines * px * 1.34 + 24;
  const rise = interpolate(frame, [0, 10], [24, 0], { ...CLAMP, easing: Easing.out(Easing.cubic) });
  const mark = (x: number, y: number, k: number, flip: boolean) => (
    <React.Fragment key={k}>
      <Stroke seed={`q${k}a`} start={k * 4} dur={8} width={16} color={accent} pts={flip ? [[x + 40, y], [x + 18, y + 50], [x + 4, y + 70]] : [[x, y + 70], [x + 22, y + 20], [x + 40, y]]} />
      <Stroke seed={`q${k}b`} start={k * 4 + 3} dur={8} width={16} color={accent} pts={flip ? [[x + 100, y], [x + 78, y + 50], [x + 64, y + 70]] : [[x + 60, y + 70], [x + 82, y + 20], [x + 100, y]]} />
    </React.Fragment>
  );
  return (
    <Paper>
      <Kicker text={s.kicker} accent={accent} />
      <svg width="1080" height="1920" style={{ position: "absolute", inset: 0 }}>
        {mark(90, 560, 0, false)}
        {mark(880, under + 30, 1, true)}
        <Stroke seed="q-under" start={14} dur={14} width={10} color={accent} pts={[[110, under], [400, under - 8], [700, under + 6], [960, under - 4]]} />
      </svg>
      <div style={{ position: "absolute", top: textTop + rise, left: 110, right: 110, fontFamily: KLEE, fontWeight: 600, fontSize: px, lineHeight: 1.34, color: INK, whiteSpace: "pre-line" }}><Rich text={s.ja} start={8} /></div>
      {s.en ? <div style={{ position: "absolute", top: under + 40, left: 110, right: 220, fontFamily: KALAM, fontSize: 40, lineHeight: 1.25, color: SOFT }}>{s.en}</div> : null}
      {s.by ? <div style={{ position: "absolute", top: under + 190, left: 110, right: 110, textAlign: "right", fontFamily: KALAM, fontSize: 38, color: INK }}>— {s.by}</div> : null}
    </Paper>
  );
};

const End: React.FC<{ s: Extract<ExplainerScene, { kind: "end" }>; accent: string }> = ({ s, accent }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const push = interpolate(frame, [0, Math.max(1, durationInFrames)], [1.0, 1.06], CLAMP);
  return (
    <AbsoluteFill style={{ background: "#000" }}>
      <AbsoluteFill style={{ transform: `scale(${push})` }}><Picture src={s.src} /></AbsoluteFill>
      <Snow color="rgba(255,255,255,0.85)" />
      <AbsoluteFill style={{ background: "linear-gradient(180deg, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0.65) 60%, rgba(0,0,0,0.8) 100%)" }} />
      <div style={{ position: "absolute", top: 980, left: 80, right: 80, color: "#fff" }}>
        <div style={{ fontFamily: KLEE, fontWeight: 600, fontSize: fitSize(s.ja, 920, 80), lineHeight: 1.3, whiteSpace: "pre-line" }}><Rich text={s.ja} start={2} /></div>
        {s.en ? <div style={{ fontFamily: KALAM, fontSize: 42, marginTop: 14 }}>{s.en}</div> : null}
        {(s.lines || []).length ? (
          <div style={{ marginTop: 44, borderTop: `4px solid ${accent}`, paddingTop: 28 }}>
            {s.lines.map((l, i) => <div key={i} style={{ fontFamily: KLEE, fontSize: fitSize(l, 920, 42, 30), lineHeight: 1.5, whiteSpace: "nowrap" }}>{l}</div>)}
          </div>
        ) : null}
      </div>
      {s.mascot ? <Cow at={s.mascot === true ? "tr" : s.mascot} accent={accent} /> : null}
    </AbsoluteFill>
  );
};

/* A taped photo with a caption under it: the pair scene's photo mode. */
const Snap: React.FC<{ src: string; w: Words; top: number; rot: number; start: number }> = ({ src, w, top, rot, start }) => {
  const frame = useCurrentFrame();
  const t = interpolate(frame, [start, start + 9], [0, 1], { ...CLAMP, easing: Easing.out(Easing.back(1.4)) });
  const push = interpolate(frame, [start, start + 180], [1.0, 1.08], CLAMP);
  return (
    <>
      <div style={{ position: "absolute", top, left: 90, width: 900, height: 420, background: "#fff", padding: 14, opacity: t,
        transform: `rotate(${rot}deg) scale(${0.92 + 0.08 * t})`, boxShadow: "0 16px 36px rgba(60,45,25,0.26)" }}>
        <div style={{ width: "100%", height: "100%", overflow: "hidden" }}><Picture src={src} style={{ transform: `scale(${push})` }} /></div>
      </div>
      <div style={{ position: "absolute", top: top + 440, left: 80, right: 80, textAlign: "center", opacity: t }}>
        <span style={{ fontFamily: KLEE, fontWeight: 600, fontSize: fitSize(w.ja, 920, 54), color: INK }}><Rich text={w.ja} start={start + 6} /></span>
        {w.en ? <div style={{ fontFamily: KALAM, fontSize: 30, color: SOFT }}>{w.en}</div> : null}
      </div>
    </>
  );
};

const Pair: React.FC<{ s: Extract<ExplainerScene, { kind: "pair" }>; accent: string }> = ({ s, accent }) =>
  s.left.src && s.right.src ? (
    <Paper>
      <Kicker text={s.kicker} accent={accent} />
      <Head w={{ ja: s.ja, en: s.en }} size={74} />
      <Snap src={s.left.src} w={s.left} top={540} rot={-1.4} start={3} />
      <Snap src={s.right.src} w={s.right} top={1130} rot={1.2} start={20} />
    </Paper>
  ) : (
    <Paper>
      <Kicker text={s.kicker} accent={accent} />
      <Head w={{ ja: s.ja, en: s.en }} size={74} />
      <svg width="1080" height="1920" style={{ position: "absolute", inset: 0 }}>
        <DrawnIcon name={s.left.icon} cx={540} cy={790} scale={1.6} start={4} accent={accent} seed="pl" />
        <Stroke seed="mid" start={18} dur={10} width={5} color="#8a8174" pts={[[120, 1150], [960, 1146]]} />
        <DrawnIcon name={s.right.icon} cx={540} cy={1330} scale={1.6} start={22} accent={accent} seed="pr" />
      </svg>
      <Caption w={s.left} top={960} size={58} start={10} />
      <Caption w={s.right} top={1500} size={58} start={28} />
    </Paper>
  );

const LoopTail: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const frame = useCurrentFrame();
  return <AbsoluteFill style={{ opacity: interpolate(frame, [0, 10], [0, 1], CLAMP) }}>{children}</AbsoluteFill>;
};

/* Each scene after the first comes in like a new page: a short rise and fade. */
const Enter: React.FC<{ children: React.ReactNode; first: boolean }> = ({ children, first }) => {
  const frame = useCurrentFrame();
  if (first) return <>{children}</>;
  const t = interpolate(frame, [0, 8], [0, 1], { ...CLAMP, easing: Easing.out(Easing.cubic) });
  return <AbsoluteFill style={{ opacity: t, transform: `translateY(${(1 - t) * 70}px) rotate(${(1 - t) * 0.8}deg)` }}>{children}</AbsoluteFill>;
};

const sceneBody = (s: ExplainerScene, accent: string): React.ReactNode => {
  switch (s.kind) {
    case "cover": return <Cover s={s} accent={accent} />;
    case "number": return <NumberScene s={s} accent={accent} />;
    case "tally": return <Tally s={s} accent={accent} />;
    case "checklist": case "nogo": return <ListScene s={s} accent={accent} />;
    case "card": return <Card s={s} accent={accent} />;
    case "route": return <Route s={s} accent={accent} />;
    case "pair": return <Pair s={s} accent={accent} />;
    case "thermo": return <Thermo s={s} accent={accent} />;
    case "compare": return <Compare s={s} accent={accent} />;
    case "clock": return <Clock s={s} accent={accent} />;
    case "bars": return <Bars s={s} accent={accent} />;
    case "icons": return <Icons s={s} accent={accent} />;
    case "steps": return <Steps s={s} accent={accent} />;
    case "quote": return <Quote s={s} accent={accent} />;
    case "end": return <End s={s} accent={accent} />;
    default: return null;
  }
};

export const Explainer: React.FC<ExplainerProps> = ({ scenes, accent = "#c8321f", series, music, whoosh, snow = false, pencil }) => {
  const { fps } = useVideoConfig();
  const frame = useCurrentFrame();
  // The film's own length (not the composition's): the preview sheet draws it inside a one-frame still.
  const total = explainerFrames({ scenes }, fps);
  const starts = sceneStarts({ scenes }, fps);
  const now = starts.filter((t) => t <= frame).length - 1;
  const chapters = scenes.map((s, i) => ({ s, i })).filter(({ s }) => s.kind !== "cover" && s.kind !== "end");
  const onPaper = !!scenes[now] && scenes[now].kind !== "cover" && scenes[now].kind !== "end";
  return (
    <SnowCtx.Provider value={snow}>
    <PencilCtx.Provider value={pencil}>
    <AbsoluteFill style={{ background: PAPER }}>
      {music ? (
        <Audio src={staticFile(music.src)} startFrom={Math.round((music.start ?? 0) * fps)}
          volume={(f) => (music.volume ?? 0.5) * Math.min(interpolate(f, [0, 12], [0, 1], CLAMP), interpolate(f, [total - 40, total - 2], [1, 0], CLAMP))} />
      ) : null}
      {whoosh ? starts.slice(1).map((t, i) => (
        <Sequence key={`w${i}`} from={Math.max(0, t - 6)} durationInFrames={30}><Audio src={staticFile(whoosh)} volume={0.22} /></Sequence>
      )) : null}
      {scenes.map((s, i) => (
        <Sequence key={i} from={starts[i]} durationInFrames={Math.max(1, Math.round(s.sec * fps))}><Enter first={i === 0}>{sceneBody(s, accent)}</Enter></Sequence>
      ))}
      {/* Seamless loop: the last 12 frames fade into the very first frame, so the replay starts where the film ends. */}
      {scenes[0] && scenes[0].kind === "cover" && total > 24 ? (
        <Sequence from={total - 12} durationInFrames={12}>
          <LoopTail><Freeze frame={0}><Cover s={scenes[0]} accent={accent} /></Freeze></LoopTail>
        </Sequence>
      ) : null}
      {onPaper ? (
        <div style={{ position: "absolute", top: 92, left: 80, right: 80, display: "flex", gap: 14 }}>
          {chapters.map(({ i }) => {
            const end = starts[i + 1] ?? total;
            const fill = i < now ? 1 : i > now ? 0 : (frame - starts[i]) / Math.max(1, end - starts[i]);
            return (
              <div key={i} style={{ flex: 1, height: 10, borderRadius: 5, background: "rgba(29,27,24,0.13)", overflow: "hidden" }}>
                <div style={{ width: `${Math.round(fill * 100)}%`, height: "100%", background: accent, borderRadius: 5 }} />
              </div>
            );
          })}
        </div>
      ) : null}
      {series ? <div style={{ position: "absolute", bottom: 120, right: 80, fontFamily: KALAM, fontSize: 30, color: "rgba(0,0,0,0.0)" }}>{series}</div> : null}
    </AbsoluteFill>
    </PencilCtx.Provider>
    </SnowCtx.Provider>
  );
};

/* The preview before a render: each scene's settled frame, four to a row, numbered with its kind. One still. */
export const ExplainerSheet: React.FC<SheetProps> = (p) => {
  const { fps } = useVideoConfig();
  const frames = p.frames && p.frames.length ? p.frames : settledFrames(p, fps);
  const starts = sceneStarts(p, fps);
  const k = SHEET.cell / 1080;
  return (
    <AbsoluteFill style={{ background: "#2a2622" }}>
      {frames.map((f, i) => {
        const scene = Math.max(0, starts.filter((t) => t <= f).length - 1);
        return (
          <div key={i} style={{ position: "absolute", left: (i % SHEET.cols) * SHEET.cell, top: Math.floor(i / SHEET.cols) * (SHEET.cellH + SHEET.label), width: SHEET.cell, height: SHEET.cellH + SHEET.label }}>
            <div style={{ width: SHEET.cell, height: SHEET.cellH, overflow: "hidden", position: "relative" }}>
              <div style={{ width: 1080, height: 1920, transform: `scale(${k})`, transformOrigin: "0 0", position: "absolute" }}>
                <Freeze frame={f}><Explainer {...p} music={undefined} whoosh={undefined} pencil={undefined} /></Freeze>
              </div>
            </div>
            <div style={{ height: SHEET.label, color: "#f3ede1", fontFamily: KALAM, fontSize: 22, lineHeight: `${SHEET.label}px`, paddingLeft: 10 }}>
              {scene + 1}. {p.scenes[scene]?.kind} · {(f / fps).toFixed(1)}s
            </div>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};
