/**
 * FILE: src/Vlog.tsx
 * PURPOSE: A long-form travel film for YouTube (16:9, 3-12 minutes) from a trip's own clips and photos, in one of nine
 *          art directions (py/studio/vlog.py LOOKS), and its thumbnail in the same design (VlogThumb).
 * OVERVIEW: A cold open (the strongest moments, with one hook line), the title, then one chapter per part of the trip,
 *           each opened by a lower third; shots in order with the look's transition (dissolve, long dissolve, hard cut
 *           on the beat). Over the pictures, never two at once: an animal's name the first time it is clearly in shot,
 *           and one caption per chapter (py/studio/vlog.py overlays). The clips keep their own sound; the music bed is
 *           laid under it afterwards (py/studio/sound.py mix). The last 15 seconds stay calm for YouTube's end screen.
 *   Each look is one typeface pairing, used for every word of that film (public/fonts, all open licence):
 *   documentary  Fraunces + DM Sans      full frame, slow dissolves, a gold rule beside the lower third.
 *   cinematic    Cinzel + Cormorant      2.39:1 letterbox, long dissolves, wide-tracked capitals, grain.
 *   energetic    Anton + DM Sans         hard cuts on the beat with a punch-in, poster capitals on yellow.
 *   journal      Caveat + Special Elite  each shot a print on paper, handwriting, a rubber day stamp.
 *   retro        VT323 + Special Elite   4:3 home movie: grain and flicker, a camcorder date, typed captions.
 *   fieldguide   Playfair + Plex Mono    a chapter per animal on a cream plate; a thin cream frame.
 *   monochrome   Bodoni Moda + DM Sans   black-and-white prints on black; every word in the margin.
 *   slow         Jost                    long holds, no push, no music; small quiet words low on the left.
 *   roadmovie    Bebas Neue + Barlow     warm grade, road-sign capitals, the trip's days as dots along the top.
 * DEPENDENCIES: remotion, public/fonts (see the OFL-*.txt / LICENSE-*.txt beside each face)
 * USAGE: <Vlog {...VlogProps} /> as "Vlog-16x9"; <VlogThumb {...ThumbProps} /> as "Vlog-Thumb" (py/studio/vlog.py)
 *   A series episode (props.series) adds its maps and links (src/SeriesMap.tsx): the title card becomes the series
 *   title over a map with this leg drawing itself, each chapter opens with a place tag (day, place, country, a
 *   locator), parts 2 on start with "previously", and the last 20 seconds are the next-part card.
 * NOTES: Words come from the plan only (chapter labels say what is in the pictures, never a claim about the trip);
 *        places come from the person (or a sign they confirmed), never from a guess. All words keep inside the
 *        title-safe area (120 px from the sides, 100 px from the bottom) and enter with one quiet move.
 */
import React from "react";
import "./Story"; // loads the Cormorant face
import { AbsoluteFill, Audio, Easing, Img, OffthreadVideo, Sequence, continueRender, delayRender, interpolate, random, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { NextCard, PlaceTag, Recap, SeriesTitle, type RouteDay, type SeriesInfo, type SeriesNext, type SeriesRecap } from "./SeriesMap";

export type VlogLook = "documentary" | "cinematic" | "energetic" | "journal" | "retro" | "fieldguide" | "monochrome" | "slow" | "roadmovie";
export type VlogShot = {
  src: string;
  durationSec: number;
  /** A photo: rendered still, played with a slow push. */
  photo?: boolean;
  /** Clip sound level (0-1); photos and silent clips 0. */
  volume?: number;
  push?: number;
  /** The day it was shot (YYYY-MM-DD): the retro look's camcorder date. */
  date?: string;
  /** The clip's sound with a lead-in and a tail (a J and an L cut): heard audioLead s before the picture, audioTail s after. */
  audio?: string;
  audioLead?: number;
  audioTail?: number;
};
export type VlogChapter = { title: string; sub?: string; atSec: number; place?: string; day?: string; country?: string; border?: string };
export type VlogOverlay = { kind: "subject" | "note"; atSec: number; sec: number; title: string; sub?: string };
export type VlogProps = {
  shots: VlogShot[];
  chapters: VlogChapter[];
  title: string;
  subtitle?: string;
  /** Where the title card sits (seconds): after the cold open. */
  titleAtSec?: number;
  /** One line over the cold open: what is coming. */
  hook?: string;
  outro?: string;
  overlays?: VlogOverlay[];
  look?: VlogLook;
  /** Frames each shot dissolves over the one before (0: a hard cut). */
  fade?: number;
  /** A series episode: its place in the series, the trip's route, this episode's days, "previously" and the next part. */
  series?: SeriesInfo;
  route?: RouteDay[];
  leg?: string[];
  titleSec?: number;
  recap?: SeriesRecap;
  next?: SeriesNext;
};
export type ThumbProps = { src: string; title: string; kicker?: string; look?: VlogLook };

/* ---------- typefaces ---------- */

const FACES: Array<[string, string, FontFaceDescriptors]> = [
  ["Fraunces", "Fraunces.ttf", { weight: "100 900" }], ["Fraunces", "Fraunces-Italic.ttf", { weight: "100 900", style: "italic" }],
  ["DM Sans", "DMSans.ttf", { weight: "100 1000" }], ["Cinzel", "Cinzel.ttf", { weight: "400 900" }], ["Anton", "Anton-Regular.ttf", {}],
  ["Caveat", "Caveat.ttf", { weight: "400 700" }], ["VT323", "VT323-Regular.ttf", {}], ["Special Elite", "SpecialElite-Regular.ttf", {}],
  ["Playfair Display", "PlayfairDisplay.ttf", { weight: "400 900" }], ["Playfair Display", "PlayfairDisplay-Italic.ttf", { weight: "400 900", style: "italic" }],
  ["IBM Plex Mono", "IBMPlexMono-Medium.ttf", { weight: "500" }], ["Bodoni Moda", "BodoniModa.ttf", { weight: "400 900" }],
  ["Jost", "Jost.ttf", { weight: "100 900" }], ["Bebas Neue", "BebasNeue-Regular.ttf", {}], ["Barlow Condensed", "BarlowCondensed-SemiBold.ttf", { weight: "600" }],
];
if (typeof document !== "undefined") {
  const handle = delayRender("vlog fonts");
  Promise.all(FACES.map(([family, file, d]) => new FontFace(family, `url(${staticFile(`fonts/${file}`)})`, d).load()))
    .then((faces) => { faces.forEach((f) => (document.fonts as unknown as { add(face: FontFace): void }).add(f)); continueRender(handle); })
    .catch(() => continueRender(handle)); // a missing face falls back to the next in its stack; the film still renders
}
const FRAUNCES = "Fraunces, Georgia, serif";
const DM = "'DM Sans', 'Segoe UI', sans-serif";
const CINZEL = "Cinzel, 'Times New Roman', serif";
const CORMORANT = "Cormorant, Georgia, serif";
const ANTON = "Anton, Impact, sans-serif";
const CAVEAT = "Caveat, 'Segoe Print', cursive";
const VT = "VT323, Consolas, monospace";
const ELITE = "'Special Elite', 'Courier New', monospace";
const PLAYFAIR = "'Playfair Display', Georgia, serif";
const PLEX = "'IBM Plex Mono', Consolas, monospace";
const BODONI = "'Bodoni Moda', Didot, serif";
const JOST = "Jost, 'Segoe UI', sans-serif";
const BEBAS = "'Bebas Neue', Impact, sans-serif";
const BARLOW = "'Barlow Condensed', 'Arial Narrow', sans-serif";

const PAPER = "#faf8f1";
const INK = "#2b2a26";
const GOLD = "#e8c170";
const YELLOW = "#ffd400";
const STAMP = "#9a3324";
const AMBER = "#ff9d2e";
const CREAM = "#f4ecd8";
const SHADOW = "0 2px 18px rgba(0,0,0,0.55), 0 1px 3px rgba(0,0,0,0.6)";
const QUIET = "0 1px 10px rgba(0,0,0,0.7), 0 1px 2px rgba(0,0,0,0.7)";
export const VLOG_FADE = 12; // frames of dissolve between shots (the documentary look)
const CLAMP = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const OUT = { ...CLAMP, easing: Easing.out(Easing.cubic) };
/** Title-safe: words never sit closer to the frame's edge than this. */
const SX = 120, SY = 100;
/** A soft dark corner behind lower-left words, and a soft dark foot behind centred ones. */
const CORNER = "radial-gradient(ellipse at 0% 100%, rgba(0,0,0,0.58) 0%, rgba(0,0,0,0.3) 36%, rgba(0,0,0,0) 68%)";
const FOOT = "linear-gradient(180deg, rgba(0,0,0,0) 58%, rgba(0,0,0,0.62) 100%)";
const BAR = 138; // 2.39:1 inside 1920x1080
const RETRO_W = 1440; // 4:3 inside 1920x1080
const MONO_W = 1600, MONO_H = 900; // the black-and-white print inside 1920x1080 (a 90 px margin for the words)
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const up = (s: string) => s.toUpperCase();
const tracked = (em: number): React.CSSProperties => ({ letterSpacing: `${em}em`, marginRight: `-${em}em` });

const fadeOf = (p: Pick<VlogProps, "fade">) => (typeof p.fade === "number" ? p.fade : VLOG_FADE);

export function vlogFrames(props: VlogProps, fps: number): number {
  const shots = props.shots || [];
  if (!shots.length) return fps;
  const sum = shots.reduce((a, s) => a + Math.round(s.durationSec * fps), 0);
  return Math.max(fps, sum - fadeOf(props) * (shots.length - 1));
}

/** In and out: 0 to 1 over `inF` frames, back to 0 over the last `outF`. */
function useInOut(frames: number, inF: number, outF: number, ease = true) {
  const frame = useCurrentFrame();
  const a = interpolate(frame, [0, inF], [0, 1], ease ? OUT : CLAMP);
  return Math.min(a, interpolate(frame, [frames - outF, frames], [1, 0], CLAMP));
}

/** One line of words coming in: it rises a little and clears, `delay` frames after its block. */
const Rise: React.FC<{ delay?: number; by?: number; children: React.ReactNode; style?: React.CSSProperties }> = ({ delay = 0, by = 26, children, style }) => {
  const frame = useCurrentFrame();
  const t = interpolate(frame - delay, [0, 16], [0, 1], OUT);
  return <div style={{ opacity: t, transform: `translateY(${(1 - t) * by}px)`, ...style }}>{children}</div>;
};
/** A rule that draws itself (from the left, or from the top when `tall`). */
const Rule: React.FC<{ delay?: number; w: number; h: number; color: string; tall?: boolean; style?: React.CSSProperties }> = ({ delay = 0, w, h, color, tall, style }) => {
  const frame = useCurrentFrame();
  const t = interpolate(frame - delay, [0, 18], [0, 1], OUT);
  return <div style={{ width: w, height: h, background: color, transform: tall ? `scaleY(${t})` : `scaleX(${t})`, transformOrigin: tall ? "top" : "left", ...style }} />;
};

/* ---------- the pictures ---------- */

const Shot: React.FC<{ shot: VlogShot; frames: number; first: boolean; fade: number; look: VlogLook; index: number }> = ({ shot, frames, first, fade, look, index }) => {
  const frame = useCurrentFrame();
  const opacity = first || fade === 0 ? 1 : interpolate(frame, [0, fade], [0, 1], CLAMP);
  const push = look === "slow" ? 0 : shot.push ?? (shot.photo ? (look === "monochrome" ? 0.04 : 0.07) : 0.025);
  let scale = interpolate(frame, [0, frames], [1, 1 + push], { ...CLAMP, easing: Easing.inOut(Easing.sin) });
  if (look === "energetic") scale *= interpolate(frame, [0, 7], [1.09, 1], OUT); // the punch-in on every cut
  // The sound rises and falls with the picture, so a dissolve is also a sound crossfade (no clicks at the cuts).
  const edge = Math.max(3, fade);
  const vol = (shot.volume ?? 0) * Math.min(interpolate(frame, [0, edge], [0, 1], CLAMP), interpolate(frame, [frames - edge, frames], [1, 0], CLAMP));
  const media = (
    <OffthreadVideo src={staticFile(shot.src)} volume={shot.photo ? 0 : vol} muted={shot.photo || !shot.volume || Boolean(shot.audio)}
      style={{ width: "100%", height: "100%", objectFit: "cover", transform: `scale(${scale})` }} />
  );
  if (look === "journal") {
    const tilt = index % 3 === 0 ? -1.4 : index % 3 === 1 ? 1.1 : -0.4;
    return (
      <AbsoluteFill style={{ opacity, alignItems: "center", justifyContent: "center" }}>
        <div style={{ width: 1360, height: 765, padding: 22, background: "#fdfbf6", boxShadow: "0 18px 40px rgba(40,30,10,0.35), 0 2px 6px rgba(40,30,10,0.25)",
          transform: `rotate(${tilt}deg) translateY(-14px)`, boxSizing: "content-box" }}>
          <div style={{ width: "100%", height: "100%", overflow: "hidden" }}>{media}</div>
        </div>
      </AbsoluteFill>
    );
  }
  if (look === "retro") {
    return (
      <AbsoluteFill style={{ opacity, alignItems: "center" }}>
        <div style={{ width: RETRO_W, height: "100%", overflow: "hidden", borderRadius: 34 }}>{media}</div>
      </AbsoluteFill>
    );
  }
  if (look === "monochrome") {
    return (
      <AbsoluteFill style={{ opacity, alignItems: "center", justifyContent: "center", background: "#0b0b0b" }}>
        <div style={{ width: MONO_W, height: MONO_H, overflow: "hidden", outline: "1px solid rgba(255,255,255,0.55)" }}>{media}</div>
      </AbsoluteFill>
    );
  }
  return <AbsoluteFill style={{ opacity }}>{media}</AbsoluteFill>;
};

/** Film grain: a noise field that changes every frame. */
const Grain: React.FC<{ strength: number }> = ({ strength }) => {
  const frame = useCurrentFrame();
  const id = `g${frame % 12}`;
  return (
    <AbsoluteFill style={{ pointerEvents: "none", opacity: strength, mixBlendMode: "overlay" }}>
      <svg width="100%" height="100%"><filter id={id}><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves={2} seed={frame % 12} /></filter>
        <rect width="100%" height="100%" filter={`url(#${id})`} /></svg>
    </AbsoluteFill>
  );
};

/** What lies over the pictures for the whole film: bars, grain, flicker, a frame. */
const LookLayer: React.FC<{ look: VlogLook }> = ({ look }) => {
  const frame = useCurrentFrame();
  if (look === "cinematic") {
    return (
      <AbsoluteFill style={{ pointerEvents: "none" }}>
        <Grain strength={0.07} />
        <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: BAR, background: "#000" }} />
        <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: BAR, background: "#000" }} />
      </AbsoluteFill>
    );
  }
  if (look === "retro") {
    const flick = 0.03 * random(`f${Math.floor(frame / 2)}`);
    return (
      <AbsoluteFill style={{ pointerEvents: "none", alignItems: "center" }}>
        <div style={{ width: RETRO_W, height: "100%", borderRadius: 34, overflow: "hidden", position: "relative" }}>
          <Grain strength={0.14} />
          <AbsoluteFill style={{ background: `rgba(255,236,200,${flick})` }} />
        </div>
      </AbsoluteFill>
    );
  }
  if (look === "fieldguide") return <AbsoluteFill style={{ pointerEvents: "none", boxShadow: `inset 0 0 0 16px ${CREAM}` }} />;
  if (look === "monochrome") return <AbsoluteFill style={{ pointerEvents: "none", alignItems: "center", justifyContent: "center" }}><div style={{ width: MONO_W, height: MONO_H, position: "relative" }}><Grain strength={0.07} /></div></AbsoluteFill>;
  if (look === "roadmovie") return <AbsoluteFill style={{ pointerEvents: "none", background: "linear-gradient(180deg, rgba(0,0,0,0.3) 0%, rgba(0,0,0,0) 15%)" }} />;
  return null;
};

/** The retro look's camcorder date, from the day the shot on screen was taken. */
const DateStamp: React.FC<{ marks: Array<[number, string]> }> = ({ marks }) => {
  const frame = useCurrentFrame();
  let date = "";
  for (const [at, d] of marks) { if (at <= frame) date = d || date; else break; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const [y, m, d] = date.split("-");
  return (
    <div style={{ position: "absolute", right: (1920 - RETRO_W) / 2 + 56, top: 40, fontFamily: VT, fontSize: 62, color: AMBER, letterSpacing: "0.06em",
      textShadow: "0 0 10px rgba(255,140,30,0.55), 2px 2px 0 rgba(0,0,0,0.6)" }}>{`${MONTHS[Number(m) - 1]} ${Number(d)} ${y}`}</div>
  );
};

/** The road movie's line along the top: one dot per chapter of the trip, filled up to the one on screen. */
const RouteBar: React.FC<{ chapters: VlogChapter[] }> = ({ chapters }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const n = chapters.length;
  if (n < 2) return null;
  let now = -1;
  chapters.forEach((c, i) => { if (Math.round(c.atSec * fps) <= frame) now = i; });
  const w = 1920 - 2 * SX;
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div style={{ position: "absolute", left: SX, top: 62, width: w, height: 3, background: "rgba(255,255,255,0.4)" }} />
      <div style={{ position: "absolute", left: SX, top: 62, width: now < 0 ? 0 : (w * now) / (n - 1), height: 3, background: AMBER }} />
      {chapters.map((_, i) => (
        <div key={i} style={{ position: "absolute", left: SX + (w * i) / (n - 1) - (i === now ? 11 : 7), top: i === now ? 52 : 56, width: i === now ? 22 : 14, height: i === now ? 22 : 14,
          borderRadius: 99, background: i <= now ? AMBER : "#fff", boxShadow: "0 1px 6px rgba(0,0,0,0.6)" }} />
      ))}
    </AbsoluteFill>
  );
};

/* ---------- words ---------- */

const TitleCard: React.FC<{ title: string; subtitle?: string; frames: number; look: VlogLook }> = ({ title, subtitle, frames, look }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const a = useInOut(frames, fps * 0.6, fps * 0.8);
  const centre = (dim: number, children: React.ReactNode, bg = "0,0,0") => (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", background: `rgba(${bg},${dim * a})` }}><div style={{ opacity: a, textAlign: "center", maxWidth: 1620 }}>{children}</div></AbsoluteFill>
  );
  if (look === "energetic") {
    const slam = interpolate(frame, [0, 6], [1.45, 1], { ...CLAMP, easing: Easing.out(Easing.back(1.6)) });
    return centre(0.4, (
      <div style={{ transform: `scale(${slam})` }}>
        {up(title).split(/\s+/).filter(Boolean).slice(0, 5).map((w, i) => (
          <div key={i} style={{ display: "inline-block", margin: "8px 12px", padding: "6px 30px 2px", background: i % 2 ? "#111" : YELLOW, color: i % 2 ? YELLOW : "#111",
            fontFamily: ANTON, fontSize: 168, lineHeight: 1.04, transform: `rotate(${i % 2 ? 1.5 : -1.5}deg)` }}>{w}</div>
        ))}
        {subtitle ? <div style={{ marginTop: 26, fontFamily: DM, fontWeight: 800, fontSize: 34, color: "#fff", ...tracked(0.28), textShadow: SHADOW }}>{up(subtitle)}</div> : null}
      </div>
    ));
  }
  if (look === "cinematic") {
    return centre(0.46, (
      <div style={{ color: PAPER, textShadow: SHADOW }}>
        <Rise><div style={{ fontFamily: CINZEL, fontWeight: 500, fontSize: 112, lineHeight: 1.1, ...tracked(0.3) }}>{up(title)}</div></Rise>
        <Rule delay={8} w={150} h={1} color={PAPER} style={{ margin: "34px auto 28px", transformOrigin: "center" }} />
        {subtitle ? <Rise delay={12}><div style={{ fontFamily: CORMORANT, fontStyle: "italic", fontWeight: 600, fontSize: 52, letterSpacing: "0.04em" }}>{subtitle}</div></Rise> : null}
      </div>
    ));
  }
  if (look === "journal") {
    const draw = interpolate(frame, [fps * 0.4, fps * 1.5], [600, 0], CLAMP);
    return centre(0.86, (
      <div style={{ color: INK, transform: "rotate(-2deg)" }}>
        <div style={{ fontFamily: CAVEAT, fontWeight: 700, fontSize: 176, lineHeight: 1.0 }}>{title}</div>
        <svg width="620" height="40" viewBox="0 0 620 40"><path d="M10 25 C 150 5, 300 38, 610 14" stroke={STAMP} strokeWidth="6" fill="none" strokeLinecap="round" strokeDasharray="600" strokeDashoffset={draw} /></svg>
        {subtitle ? <div style={{ fontFamily: CAVEAT, fontWeight: 500, fontSize: 60, marginTop: 4 }}>{subtitle}</div> : null}
      </div>
    ), "236,227,207");
  }
  if (look === "retro") {
    const blink = Math.floor(frame / (fps / 2)) % 2 === 0;
    return (
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", background: `rgba(0,0,0,${0.45 * a})` }}>
        <div style={{ position: "absolute", left: (1920 - RETRO_W) / 2 + 60, top: 44, fontFamily: VT, fontSize: 64, color: "#fff", opacity: blink ? a : 0 }}>▶ PLAY</div>
        <div style={{ opacity: a, textAlign: "center", fontFamily: VT, color: "#f4efe2", textShadow: "4px 0 0 rgba(255,40,60,0.7), -4px 0 0 rgba(40,220,255,0.7)", maxWidth: RETRO_W - 160 }}>
          <div style={{ fontSize: 168, lineHeight: 0.95, letterSpacing: "0.03em" }}>{up(title)}</div>
          {subtitle ? <div style={{ fontSize: 60, marginTop: 14 }}>{up(subtitle)}</div> : null}
        </div>
      </AbsoluteFill>
    );
  }
  if (look === "fieldguide") {
    return centre(0.95, (
      <div style={{ color: INK }}>
        <Rise><div style={{ fontFamily: PLEX, fontWeight: 500, fontSize: 28, ...tracked(0.3), color: STAMP }}>{up(subtitle || "")}</div></Rise>
        <Rule delay={4} w={560} h={2} color={INK} style={{ margin: "28px auto 22px", transformOrigin: "center" }} />
        <Rise delay={6}><div style={{ fontFamily: PLAYFAIR, fontWeight: 800, fontSize: 124, lineHeight: 1.04 }}>{title}</div></Rise>
        <Rule delay={10} w={560} h={2} color={INK} style={{ margin: "28px auto 0", transformOrigin: "center" }} />
      </div>
    ), "244,236,216");
  }
  if (look === "monochrome") {
    return centre(0.74, (
      <div style={{ color: "#fff" }}>
        <Rise><div style={{ fontFamily: BODONI, fontWeight: 500, fontSize: 126, lineHeight: 1.08, ...tracked(0.14) }}>{up(title)}</div></Rise>
        <Rule delay={8} w={90} h={1} color="#fff" style={{ margin: "34px auto 28px", transformOrigin: "center" }} />
        {subtitle ? <Rise delay={12}><div style={{ fontFamily: DM, fontWeight: 400, fontSize: 26, ...tracked(0.4) }}>{up(subtitle)}</div></Rise> : null}
      </div>
    ), "11,11,11");
  }
  if (look === "slow") {
    return (
      <AbsoluteFill style={{ pointerEvents: "none" }}>
        <AbsoluteFill style={{ background: CORNER, opacity: a * 0.85 }} />
        <div style={{ position: "absolute", left: SX, bottom: SY, opacity: a, color: "#fff", textShadow: QUIET, maxWidth: 1300 }}>
          <Rise><div style={{ fontFamily: JOST, fontWeight: 300, fontSize: 76, lineHeight: 1.12 }}>{title}</div></Rise>
          {subtitle ? <Rise delay={8}><div style={{ fontFamily: JOST, fontWeight: 500, fontSize: 24, ...tracked(0.26), marginTop: 14, opacity: 0.9 }}>{up(subtitle)}</div></Rise> : null}
        </div>
      </AbsoluteFill>
    );
  }
  if (look === "roadmovie") {
    return (
      <AbsoluteFill style={{ justifyContent: "center", background: `rgba(0,0,0,${0.42 * a})` }}>
        <div style={{ opacity: a, marginLeft: SX, color: "#fff", textShadow: SHADOW, maxWidth: 1600 }}>
          {subtitle ? <Rise><div style={{ display: "inline-block", background: AMBER, color: "#111", fontFamily: BARLOW, fontWeight: 600, fontSize: 40, letterSpacing: "0.08em", padding: "4px 18px", textShadow: "none" }}>{up(subtitle)}</div></Rise> : null}
          <Rise delay={5}><div style={{ fontFamily: BEBAS, fontSize: 170, lineHeight: 0.95, marginTop: 20, letterSpacing: "0.01em" }}>{up(title)}</div></Rise>
          <Rule delay={10} w={900} h={10} color={AMBER} style={{ marginTop: 18 }} />
        </div>
      </AbsoluteFill>
    );
  }
  return centre(0.44, (
    <div style={{ color: PAPER, textShadow: SHADOW }}>
      {subtitle ? <Rise><div style={{ fontFamily: DM, fontWeight: 600, fontSize: 26, ...tracked(0.34), color: GOLD }}>{up(subtitle)}</div></Rise> : null}
      <Rule delay={4} w={72} h={2} color={GOLD} style={{ margin: "26px auto 22px", transformOrigin: "center" }} />
      <Rise delay={6}><div style={{ fontFamily: FRAUNCES, fontWeight: 500, fontSize: 150, lineHeight: 1.0, letterSpacing: "-0.015em", fontVariationSettings: "'opsz' 144, 'SOFT' 50" }}>{title}</div></Rise>
    </div>
  ));
};

/** Typed out, one letter after another (the retro look's words). */
const typed = (text: string, frame: number, perFrame = 1.6) => text.slice(0, Math.max(0, Math.floor(frame * perFrame)));

/** A chapter's lower third: the day, what it holds, and where. */
const ChapterLabel: React.FC<{ chapter: VlogChapter; frames: number; look: VlogLook }> = ({ chapter, frames, look }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const a = useInOut(frames, fps * 0.5, fps * 0.8);
  const day = (chapter.sub || "").split(" · ")[0] || "";
  if (look === "energetic") {
    const slide = interpolate(frame, [0, 8], [-700, 0], OUT);
    const flash = interpolate(frame, [0, 5], [0.7, 0], CLAMP);
    return (
      <AbsoluteFill style={{ pointerEvents: "none" }}>
        <AbsoluteFill style={{ background: "#fff", opacity: flash }} />
        <AbsoluteFill style={{ background: CORNER, opacity: a }} />
        <div style={{ position: "absolute", left: SX, bottom: SY, opacity: a, transform: `translateX(${slide}px)` }}>
          <div style={{ fontFamily: ANTON, fontSize: 168, lineHeight: 0.95, color: "#fff", textShadow: SHADOW }}>{up(day)}</div>
          <Rule delay={6} w={300} h={14} color={YELLOW} style={{ margin: "6px 0 14px" }} />
          {chapter.place ? <div style={{ fontFamily: ANTON, fontSize: 56, lineHeight: 1.05, color: YELLOW, textShadow: SHADOW }}>{up(chapter.place)}</div> : null}
          <div style={{ fontFamily: DM, fontWeight: 800, fontSize: 32, color: "#fff", ...tracked(0.12), marginTop: 8, textShadow: SHADOW }}>{up(chapter.title)}</div>
        </div>
      </AbsoluteFill>
    );
  }
  if (look === "cinematic") {
    return (
      <AbsoluteFill style={{ pointerEvents: "none", alignItems: "center" }}>
        <AbsoluteFill style={{ background: FOOT, opacity: a }} />
        <div style={{ position: "absolute", bottom: BAR + 48, opacity: a, textAlign: "center", color: PAPER, textShadow: SHADOW }}>
          <Rise><div style={{ fontFamily: CINZEL, fontWeight: 500, fontSize: 26, ...tracked(0.42) }}>{up(chapter.place ? `${chapter.place} · ${day}` : chapter.sub || "")}</div></Rise>
          <Rise delay={6}><div style={{ fontFamily: CORMORANT, fontStyle: "italic", fontWeight: 600, fontSize: 82, marginTop: 10 }}>{chapter.title}</div></Rise>
        </div>
      </AbsoluteFill>
    );
  }
  if (look === "journal") {
    return (
      <AbsoluteFill style={{ pointerEvents: "none" }}>
        <div style={{ position: "absolute", left: 130, top: 44, opacity: a, transform: `rotate(-5deg) scale(${interpolate(frame, [0, 6], [1.3, 1], CLAMP)})`, border: `4px solid ${STAMP}`,
          color: STAMP, fontFamily: ELITE, fontSize: 30, padding: "8px 16px 4px", letterSpacing: "0.08em", background: "rgba(253,251,246,0.85)" }}>{up(chapter.sub || "")}</div>
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 14, opacity: a, textAlign: "center", fontFamily: CAVEAT, fontWeight: 600, color: INK, fontSize: 58 }}>
          {chapter.place ? `${chapter.place}: ` : ""}{chapter.title}
        </div>
      </AbsoluteFill>
    );
  }
  if (look === "retro") {
    const x = (1920 - RETRO_W) / 2 + 64;
    return (
      <AbsoluteFill style={{ pointerEvents: "none" }}>
        <div style={{ position: "absolute", left: x, top: 44, opacity: a, color: "#fff", fontFamily: VT, textShadow: "2px 2px 0 rgba(0,0,0,0.7)" }}>
          <div style={{ fontSize: 84, lineHeight: 1 }}>{up(day)}</div>
          {chapter.place ? <div style={{ fontSize: 48, lineHeight: 1.05 }}>{up(chapter.place)}</div> : null}
        </div>
        <div style={{ position: "absolute", left: x, bottom: 130, opacity: a, color: "#fff", fontFamily: ELITE, fontSize: 38, background: "rgba(0,0,0,0.55)", padding: "10px 16px 4px" }}>
          {typed(chapter.title, frame)}</div>
      </AbsoluteFill>
    );
  }
  if (look === "fieldguide") {
    const [no, ...rest] = (chapter.sub || "").split(" · ");
    return (
      <AbsoluteFill style={{ pointerEvents: "none" }}>
        <div style={{ position: "absolute", left: 96, bottom: 96, opacity: a, transform: `translateY(${interpolate(a, [0, 1], [26, 0])}px)`, background: CREAM, color: INK, padding: "24px 44px 28px",
          boxShadow: "0 10px 30px rgba(0,0,0,0.35)", minWidth: 440 }}>
          <div style={{ fontFamily: PLEX, fontWeight: 500, fontSize: 26, ...tracked(0.2), color: STAMP }}>{up(no)}</div>
          <div style={{ fontFamily: PLAYFAIR, fontWeight: 800, fontSize: 104, lineHeight: 1.02, marginTop: 4 }}>{chapter.title}</div>
          <Rule delay={6} w={360} h={2} color={INK} style={{ margin: "16px 0 12px", opacity: 0.7 }} />
          {rest.length ? <div style={{ fontFamily: PLAYFAIR, fontStyle: "italic", fontWeight: 500, fontSize: 44 }}>{rest.join(" · ")}
            <span style={{ fontFamily: PLEX, fontStyle: "normal", fontSize: 20, letterSpacing: "0.2em", opacity: 0.65, marginLeft: 16 }}>SWAHILI</span></div> : null}
        </div>
      </AbsoluteFill>
    );
  }
  if (look === "monochrome") {
    return (
      <AbsoluteFill style={{ pointerEvents: "none", alignItems: "center", color: "#fff" }}>
        <div style={{ position: "absolute", top: 22, opacity: a, fontFamily: BODONI, fontWeight: 500, fontSize: 40, letterSpacing: "0.02em" }}>{chapter.title}</div>
        <div style={{ position: "absolute", bottom: 30, opacity: a, fontFamily: DM, fontWeight: 400, fontSize: 22, ...tracked(0.36) }}>{up(chapter.place ? `${chapter.sub} · ${chapter.place}` : chapter.sub || "")}</div>
      </AbsoluteFill>
    );
  }
  if (look === "slow") {
    return (
      <AbsoluteFill style={{ pointerEvents: "none" }}>
        <AbsoluteFill style={{ background: CORNER, opacity: a * 0.8 }} />
        <div style={{ position: "absolute", left: SX, bottom: SY, opacity: a, color: "#fff", textShadow: QUIET }}>
          <Rise><div style={{ fontFamily: JOST, fontWeight: 500, fontSize: 22, ...tracked(0.28) }}>{up(chapter.place ? `${day} · ${chapter.place}` : chapter.sub || "")}</div></Rise>
          <Rise delay={6}><div style={{ fontFamily: JOST, fontWeight: 300, fontSize: 54, marginTop: 8 }}>{chapter.title}</div></Rise>
        </div>
      </AbsoluteFill>
    );
  }
  if (look === "roadmovie") {
    const in_ = interpolate(frame, [0, 9], [-500, 0], OUT);
    return (
      <AbsoluteFill style={{ pointerEvents: "none" }}>
        <AbsoluteFill style={{ background: CORNER, opacity: a }} />
        <div style={{ position: "absolute", left: SX, bottom: SY, opacity: a, transform: `translateX(${in_}px)`, color: "#fff", textShadow: SHADOW }}>
          <div style={{ display: "inline-block", background: AMBER, color: "#111", fontFamily: BEBAS, fontSize: 64, lineHeight: 1, padding: "8px 20px 2px", textShadow: "none" }}>{up(day)}</div>
          {chapter.place ? <div style={{ fontFamily: BEBAS, fontSize: 92, lineHeight: 0.98, marginTop: 12 }}>{up(chapter.place)}</div> : null}
          <div style={{ fontFamily: BARLOW, fontWeight: 600, fontSize: 42, letterSpacing: "0.03em", marginTop: 4 }}>{chapter.title}</div>
        </div>
      </AbsoluteFill>
    );
  }
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <AbsoluteFill style={{ background: CORNER, opacity: a }} />
      <div style={{ position: "absolute", left: SX, bottom: SY, opacity: a, display: "flex", gap: 30, color: PAPER, textShadow: SHADOW }}>
        <Rule w={3} h={170} color={GOLD} tall style={{ alignSelf: "stretch", height: "auto" }} />
        <div>
          {chapter.sub ? <Rise><div style={{ fontFamily: DM, fontWeight: 600, fontSize: 24, ...tracked(0.22), color: GOLD }}>{up(chapter.sub)}</div></Rise> : null}
          <Rise delay={5}><div style={{ fontFamily: FRAUNCES, fontWeight: 500, fontSize: 76, lineHeight: 1.06, letterSpacing: "-0.01em", margin: "10px 0 8px", fontVariationSettings: "'opsz' 100, 'SOFT' 50" }}>{chapter.title}</div></Rise>
          {chapter.place ? <Rise delay={10}><div style={{ fontFamily: DM, fontWeight: 500, fontSize: 32 }}>{chapter.place}</div></Rise> : null}
        </div>
      </div>
    </AbsoluteFill>
  );
};

/** An animal's name the first time it is clearly in shot. */
const SubjectTag: React.FC<{ o: VlogOverlay; frames: number; look: VlogLook }> = ({ o, frames, look }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const a = useInOut(frames, fps * 0.4, fps * 0.6);
  if (look === "energetic") {
    const slide = interpolate(frame, [0, 7], [-500, 0], { ...CLAMP, easing: Easing.out(Easing.back(1.4)) });
    return (
      <div style={{ position: "absolute", left: SX, bottom: SY, opacity: a, transform: `translateX(${slide}px)` }}>
        <div style={{ display: "inline-block", background: YELLOW, color: "#111", fontFamily: ANTON, fontSize: 92, lineHeight: 1, padding: "10px 30px 4px", transform: "skewX(-6deg)" }}>{up(o.title)}</div>
        {o.sub ? <div><span style={{ display: "inline-block", background: "#111", color: "#fff", fontFamily: DM, fontWeight: 800, fontSize: 24, ...tracked(0.14), padding: "8px 18px", marginTop: 8 }}>{up(o.sub)}</span></div> : null}
      </div>
    );
  }
  if (look === "cinematic") {
    return (
      <div style={{ position: "absolute", right: SX + 10, bottom: BAR + 48, opacity: a, textAlign: "right", color: PAPER, textShadow: SHADOW }}>
        <Rise><div style={{ fontFamily: CINZEL, fontWeight: 500, fontSize: 46, letterSpacing: "0.3em", marginRight: "-0.3em" }}>{up(o.title)}</div></Rise>
        {o.sub ? <Rise delay={5}><div style={{ fontFamily: CORMORANT, fontStyle: "italic", fontWeight: 600, fontSize: 38, marginTop: 4 }}>{o.sub}</div></Rise> : null}
      </div>
    );
  }
  if (look === "journal") {
    return (
      <div style={{ position: "absolute", right: 160, bottom: 10, opacity: a, transform: "rotate(-3deg)", fontFamily: CAVEAT, color: INK, textAlign: "right" }}>
        <div style={{ fontSize: 68, fontWeight: 700, lineHeight: 1 }}>↖ {o.title}</div>
        {o.sub ? <div style={{ fontSize: 40 }}>({o.sub})</div> : null}
      </div>
    );
  }
  if (look === "retro") {
    return (
      <div style={{ position: "absolute", left: (1920 - RETRO_W) / 2 + 64, bottom: 130, opacity: a, color: "#fff", fontFamily: ELITE, fontSize: 38, background: "rgba(0,0,0,0.55)", padding: "10px 16px 4px" }}>
        {typed(`▸ ${up(o.title)}${o.sub ? ` / ${o.sub}` : ""}`, frame)}</div>
    );
  }
  if (look === "monochrome") {
    return (
      <AbsoluteFill style={{ pointerEvents: "none", alignItems: "center", color: "#fff" }}>
        <div style={{ position: "absolute", bottom: 30, opacity: a, fontFamily: DM, fontWeight: 400, fontSize: 24, ...tracked(0.34) }}>{up(o.title)}{o.sub ? ` · ${up(o.sub)}` : ""}</div>
      </AbsoluteFill>
    );
  }
  if (look === "slow") {
    return (
      <AbsoluteFill style={{ pointerEvents: "none" }}>
        <AbsoluteFill style={{ background: CORNER, opacity: a * 0.7 }} />
        <div style={{ position: "absolute", left: SX, bottom: SY, opacity: a, color: "#fff", textShadow: QUIET }}>
          <div style={{ fontFamily: JOST, fontWeight: 300, fontSize: 54 }}>{o.title}</div>
          {o.sub ? <div style={{ fontFamily: JOST, fontWeight: 500, fontSize: 22, ...tracked(0.26), marginTop: 6 }}>{up(o.sub)}</div> : null}
        </div>
      </AbsoluteFill>
    );
  }
  if (look === "roadmovie") {
    return (
      <div style={{ position: "absolute", left: SX, bottom: SY, opacity: a }}>
        <div style={{ display: "inline-block", background: "#111", color: "#fff", fontFamily: BEBAS, fontSize: 72, lineHeight: 1, padding: "10px 24px 4px", borderLeft: `12px solid ${AMBER}` }}>{up(o.title)}</div>
        {o.sub ? <div style={{ fontFamily: BARLOW, fontWeight: 600, fontSize: 34, color: "#fff", textShadow: SHADOW, marginTop: 6 }}>{o.sub}</div> : null}
      </div>
    );
  }
  const guide = look === "fieldguide";
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <AbsoluteFill style={{ background: CORNER, opacity: a * 0.9 }} />
      <div style={{ position: "absolute", left: SX, bottom: SY, opacity: a, display: "flex", gap: 26, color: PAPER, textShadow: SHADOW }}>
        <Rule w={3} h={110} color={guide ? CREAM : GOLD} tall style={{ alignSelf: "stretch", height: "auto" }} />
        <div>
          <Rise><div style={{ fontFamily: guide ? PLAYFAIR : FRAUNCES, fontStyle: "italic", fontWeight: 500, fontSize: 84, lineHeight: 1.0, fontVariationSettings: "'opsz' 144, 'SOFT' 100" }}>{o.title}</div></Rise>
          {o.sub ? <Rise delay={6}><div style={{ fontFamily: guide ? PLEX : DM, fontWeight: 600, fontSize: 22, ...tracked(0.22), color: guide ? CREAM : GOLD, marginTop: 12 }}>{up(o.sub)}</div></Rise> : null}
        </div>
      </div>
    </AbsoluteFill>
  );
};

/** How each look sets one plain sentence (a chapter's caption, the opening hook). */
function lineStyle(look: VlogLook, big: boolean): { style: React.CSSProperties; foot?: boolean; upper?: boolean } {
  const k = big ? 1.25 : 1;
  switch (look) {
    case "cinematic": return { foot: true, style: { bottom: BAR + 44, maxWidth: 1300, color: PAPER, textShadow: SHADOW, fontFamily: CORMORANT, fontStyle: "italic", fontWeight: 600, fontSize: 54 * k, lineHeight: 1.2 } };
    case "energetic": return { upper: true, style: { bottom: SY - 10, maxWidth: 1500, color: "#fff", background: "#111", padding: "12px 28px", fontFamily: DM, fontWeight: 800, fontSize: 34 * k, lineHeight: 1.25, letterSpacing: "0.06em" } };
    case "journal": return { style: { bottom: 92, maxWidth: 1500, color: INK, fontFamily: CAVEAT, fontWeight: 600, fontSize: 54 * k, lineHeight: 1.1, background: "rgba(253,251,246,0.92)", padding: "4px 26px", transform: "rotate(-0.6deg)" } };
    case "retro": return { style: { bottom: 64, maxWidth: RETRO_W - 200, color: "#fff", fontFamily: ELITE, fontSize: 36 * k, lineHeight: 1.3, background: "rgba(0,0,0,0.6)", padding: "12px 20px 6px" } };
    case "fieldguide": return { style: { bottom: 76, maxWidth: 1300, color: INK, background: CREAM, padding: "12px 34px", fontFamily: PLAYFAIR, fontStyle: "italic", fontWeight: 500, fontSize: 42 * k, lineHeight: 1.25, boxShadow: "0 6px 20px rgba(0,0,0,0.3)" } };
    case "monochrome": return { style: { bottom: 24, maxWidth: 1560, color: "#fff", fontFamily: BODONI, fontWeight: 400, fontSize: 32 * (big ? 1.1 : 1), lineHeight: 1.15, letterSpacing: "0.02em" } };
    case "slow": return { foot: true, style: { bottom: SY - 20, maxWidth: 1300, color: "#fff", textShadow: QUIET, fontFamily: JOST, fontWeight: 300, fontSize: 40 * k, lineHeight: 1.3 } };
    case "roadmovie": return { style: { bottom: SY - 20, maxWidth: 1400, color: "#fff", background: "rgba(17,17,17,0.84)", borderLeft: `10px solid ${AMBER}`, padding: "10px 26px", fontFamily: BARLOW, fontWeight: 600, fontSize: 44 * k, lineHeight: 1.2, letterSpacing: "0.02em" } };
    default: return { foot: true, style: { bottom: SY - 14, maxWidth: 1240, color: PAPER, textShadow: SHADOW, fontFamily: DM, fontWeight: 500, fontSize: 40 * k, lineHeight: 1.3 } };
  }
}

/** One plain sentence about what is on screen (readable with the sound off); `big`: the hook over the cold open. */
const Note: React.FC<{ text: string; frames: number; look: VlogLook; big?: boolean }> = ({ text, frames, look, big = false }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const a = useInOut(frames, fps * 0.4, fps * 0.4, false);
  const { style, foot, upper } = lineStyle(look, big);
  const shown = look === "retro" ? typed(text, frame, 1.4) : upper ? up(text) : text;
  return (
    <AbsoluteFill style={{ pointerEvents: "none", alignItems: "center" }}>
      {foot ? <AbsoluteFill style={{ background: FOOT, opacity: a * 0.9 }} /> : null}
      <div style={{ position: "absolute", opacity: a, textAlign: "center", transform: `translateY(${interpolate(a, [0, 1], [14, 0])}px)`, ...style }}>{shown}</div>
    </AbsoluteFill>
  );
};

/** The last seconds: the picture darkens a little and one quiet line sits high, clear of YouTube's end-screen tiles. */
const Outro: React.FC<{ text: string; look: VlogLook }> = ({ text, look }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const a = interpolate(frame, [0, fps * 1.2], [0, 1], CLAMP);
  const face: React.CSSProperties = look === "energetic" ? { fontFamily: ANTON, fontSize: 84, textTransform: "uppercase" }
    : look === "cinematic" ? { fontFamily: CINZEL, fontWeight: 400, fontSize: 46, letterSpacing: "0.42em", textTransform: "uppercase" }
    : look === "journal" ? { fontFamily: CAVEAT, fontWeight: 700, fontSize: 92, color: INK, textShadow: "none" }
    : look === "retro" ? { fontFamily: VT, fontSize: 92, textTransform: "uppercase" }
    : look === "fieldguide" ? { fontFamily: PLAYFAIR, fontStyle: "italic", fontWeight: 500, fontSize: 68 }
    : look === "monochrome" ? { fontFamily: BODONI, fontWeight: 500, fontSize: 52, letterSpacing: "0.22em", textTransform: "uppercase" }
    : look === "slow" ? { fontFamily: JOST, fontWeight: 300, fontSize: 56 }
    : look === "roadmovie" ? { fontFamily: BEBAS, fontSize: 96, letterSpacing: "0.03em" }
    : { fontFamily: FRAUNCES, fontStyle: "italic", fontWeight: 400, fontSize: 68, fontVariationSettings: "'opsz' 144, 'SOFT' 100" };
  return (
    <AbsoluteFill style={{ background: look === "journal" ? `rgba(236,227,207,${0.55 * a})` : `rgba(0,0,0,${0.45 * a})`, pointerEvents: "none" }}>
      <div style={{ position: "absolute", top: look === "cinematic" ? BAR + 44 : 130, width: "100%", textAlign: "center", opacity: a, color: PAPER, textShadow: SHADOW, ...face }}>{text}</div>
    </AbsoluteFill>
  );
};

/* ---------- the film ---------- */

export const Vlog: React.FC<VlogProps> = ({ shots, chapters, title, subtitle, titleAtSec = 0, hook, outro = "Thanks for watching", overlays = [], look = "documentary", fade,
  series, route = [], leg = [], titleSec, recap, next }) => {
  const { fps } = useVideoConfig();
  const f = fadeOf({ fade });
  const total = vlogFrames({ shots, chapters, title, fade: f }, fps);
  let from = 0;
  const marks: Array<[number, string]> = [];
  const layers = shots.map((shot, i) => {
    const frames = Math.round(shot.durationSec * fps);
    const start = i === 0 ? 0 : from - f;
    from = start + frames;
    marks.push([start, shot.date || ""]);
    return (
      <Sequence key={i} from={start} durationInFrames={frames} premountFor={fps}>
        <Shot shot={shot} frames={frames} first={i === 0} fade={f} look={look} index={i} />
      </Sequence>
    );
  });
  // Sound bridges: each clip's own sound starts before its picture and fades out after it, so a cut is heard coming
  // (a J cut) and the last place lingers under the next one (an L cut), instead of the sound switching with the picture.
  let at = 0;
  const bridges = shots.map((shot, i) => {
    const frames = Math.round(shot.durationSec * fps);
    const start = i === 0 ? 0 : at - f;
    at = start + frames;
    if (!shot.audio || !shot.volume) return null;
    const lead = Math.round((shot.audioLead ?? 0) * fps), tail = Math.round((shot.audioTail ?? 0) * fps);
    const from = Math.max(0, start - lead), skip = lead - (start - from), len = frames + (start - from) + tail;
    const v = shot.volume;
    return (
      <Sequence key={`a${i}`} from={from} durationInFrames={len} layout="none">
        <Audio src={staticFile(shot.audio)} startFrom={skip} volume={(t) => v * Math.min(interpolate(t, [0, Math.max(1, start - from + Math.max(3, f))], [0, 1], CLAMP),
          interpolate(t, [len - Math.max(3, tail + f), len], [1, 0], CLAMP))} />
      </Sequence>
    );
  });
  const titleFrames = Math.round(fps * (series ? titleSec ?? 6 : 4.5));
  const nextAt = series && next ? Math.round(next.atSec * fps) : null;  // a series ends on the next-part card
  const outroFrames = nextAt != null && nextAt < total ? total - nextAt : Math.min(Math.round(fps * 15), Math.floor(total / 4));
  const t0 = Math.round(titleAtSec * fps);
  const hookFrames = t0 - Math.round(fps * 1.4);
  const paper = "radial-gradient(ellipse at 30% 20%, #f3ecdb 0%, #e9dfc8 60%, #dfd3b8 100%)";
  return (
    <AbsoluteFill style={{ background: look === "journal" ? paper : look === "retro" ? "#050505" : look === "monochrome" ? "#0b0b0b" : "#0d0f0b" }}>
      {layers}
      {bridges}
      <LookLayer look={look} />
      {look === "retro" ? <DateStamp marks={marks} /> : null}
      {look === "roadmovie" ? <RouteBar chapters={chapters} /> : null}
      {hook && hookFrames > fps * 3 ? (
        <Sequence from={Math.round(fps * 0.9)} durationInFrames={hookFrames}>
          <Note text={hook} frames={hookFrames} look={look} big />
        </Sequence>
      ) : null}
      {series && recap && recap.sec > 1 ? (
        <Sequence from={Math.round(recap.atSec * fps)} durationInFrames={Math.round(recap.sec * fps)}>
          <Recap route={route} recap={recap} frames={Math.round(recap.sec * fps)} />
        </Sequence>
      ) : null}
      <Sequence from={t0} durationInFrames={titleFrames}>
        {series ? <SeriesTitle series={series} route={route} leg={leg} frames={titleFrames} /> : <TitleCard title={title} subtitle={subtitle} frames={titleFrames} look={look} />}
      </Sequence>
      {chapters.map((c, i) => {
        const at = Math.round(c.atSec * fps);
        const frames = Math.round(fps * (series ? 4.5 : 4.6));
        // A chapter that opens under the title card shows its label once the title has gone (never two at once).
        let from = at + Math.round(fps * (look === "energetic" ? 0 : 0.6));
        if (from < t0 + titleFrames && from + frames > t0) from = t0 + titleFrames;
        return at > 0 && from + frames < total - outroFrames ? (
          <Sequence key={i} from={from} durationInFrames={frames}>
            {series ? <PlaceTag sub={c.sub} place={c.place} country={c.country} border={c.border} day={c.day} route={route} frames={frames} />
              : <ChapterLabel chapter={c} frames={frames} look={look} />}
          </Sequence>
        ) : null;
      })}
      {overlays.map((o, i) => {
        const at = Math.round(o.atSec * fps), frames = Math.max(fps, Math.round(o.sec * fps));
        return at + frames < total - outroFrames ? (
          <Sequence key={`o${i}`} from={at} durationInFrames={frames}>
            {o.kind === "note" ? <Note text={o.title} frames={frames} look={look} /> : <AbsoluteFill style={{ pointerEvents: "none" }}><SubjectTag o={o} frames={frames} look={look} /></AbsoluteFill>}
          </Sequence>
        ) : null;
      })}
      <Sequence from={total - outroFrames} durationInFrames={outroFrames}>
        {series && next ? <NextCard next={next} route={route} frames={outroFrames} /> : <Outro text={outro} look={look} />}
      </Sequence>
    </AbsoluteFill>
  );
};

/* ---------- the thumbnail (1280x720) ---------- */

/** The title in at most `most` lines of about equal length, and the size that fits `width` (em: the face's average letter width). */
function fit(title: string, width: number, em: number, max: number, most = 2): { lines: string[]; size: number } {
  const words = title.split(/\s+/).filter(Boolean);
  let best: string[] = [title];
  if (words.length > 1 && most > 1 && title.length > 13) {  // a short title stays on one line
    const want = Math.min(most, words.length > 4 ? most : 2);
    const per = title.length / want;
    const lines: string[] = [];
    let cur = "";
    for (const w of words) {
      if (cur && lines.length < want - 1 && (cur + " " + w).length > per + 2) { lines.push(cur); cur = w; } else cur = cur ? `${cur} ${w}` : w;
    }
    lines.push(cur);
    best = lines;
  }
  const longest = Math.max(...best.map((l) => l.length), 1);
  return { lines: best, size: Math.floor(Math.min(max, width / (longest * em))) };
}

export const VlogThumb: React.FC<ThumbProps> = ({ src, title, kicker = "", look = "documentary" }) => {
  const img = (style: React.CSSProperties = {}) => (src ? <Img src={staticFile(src)} style={{ width: "100%", height: "100%", objectFit: "cover", ...style }} /> : null);
  const shade = (g: string) => <AbsoluteFill style={{ background: g }} />;
  const foot = "linear-gradient(180deg, rgba(0,0,0,0) 30%, rgba(0,0,0,0.5) 62%, rgba(0,0,0,0.86) 100%)";
  const lines = (f: { lines: string[]; size: number }, style: React.CSSProperties, wrap?: (l: string, i: number) => React.ReactNode) =>
    f.lines.map((l, i) => <div key={i} style={{ fontSize: f.size, ...style }}>{wrap ? wrap(l, i) : l}</div>);
  if (look === "energetic") {
    const f = fit(up(title), 1100, 0.52, 150, 3);
    return (
      <AbsoluteFill style={{ background: "#111" }}>{img()}{shade("linear-gradient(90deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0) 70%)")}
        <div style={{ position: "absolute", left: 56, bottom: 50, transform: "rotate(-2deg)", transformOrigin: "left bottom" }}>
          {kicker ? <div style={{ display: "inline-block", background: "#111", color: "#fff", fontFamily: DM, fontWeight: 800, fontSize: 26, letterSpacing: "0.16em", padding: "8px 16px", marginBottom: 12 }}>{up(kicker)}</div> : null}
          {lines(f, { fontFamily: ANTON, lineHeight: 1.06 }, (l, i) => <span style={{ display: "inline-block", background: i % 2 ? "#111" : YELLOW, color: i % 2 ? YELLOW : "#111", padding: "2px 22px 0", marginTop: 6 }}>{l}</span>)}
        </div>
      </AbsoluteFill>
    );
  }
  if (look === "cinematic") {
    const f = fit(up(title), 1060, 0.86, 96);
    return (
      <AbsoluteFill style={{ background: "#000" }}>{img()}{shade(foot)}
        <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 84, background: "#000" }} /><div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 84, background: "#000" }} />
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 112, textAlign: "center", color: "#fff", textShadow: SHADOW }}>
          {kicker ? <div style={{ fontFamily: CINZEL, fontWeight: 600, fontSize: 24, ...tracked(0.4), color: GOLD, marginBottom: 14 }}>{up(kicker)}</div> : null}
          {lines(f, { fontFamily: CINZEL, fontWeight: 700, lineHeight: 1.12, ...tracked(0.1) })}
        </div>
      </AbsoluteFill>
    );
  }
  if (look === "journal") {
    const f = fit(title, 560, 0.4, 150, 3);
    return (
      <AbsoluteFill style={{ background: "radial-gradient(ellipse at 30% 20%, #f3ecdb 0%, #e9dfc8 60%, #dfd3b8 100%)" }}>
        <div style={{ position: "absolute", left: 44, top: 70, width: 700, height: 500, padding: 18, background: "#fdfbf6", boxShadow: "0 18px 40px rgba(40,30,10,0.4)", transform: "rotate(-3deg)", boxSizing: "content-box" }}>
          <div style={{ width: "100%", height: "100%", overflow: "hidden" }}>{img()}</div></div>
        <div style={{ position: "absolute", right: 40, top: 150, width: 470, color: INK, transform: "rotate(-2deg)" }}>
          {lines(f, { fontFamily: CAVEAT, fontWeight: 700, lineHeight: 0.95 })}
          <svg width="420" height="34" viewBox="0 0 420 34"><path d="M8 22 C 110 4, 220 32, 412 12" stroke={STAMP} strokeWidth="7" fill="none" strokeLinecap="round" /></svg>
          {kicker ? <div style={{ display: "inline-block", border: `4px solid ${STAMP}`, color: STAMP, fontFamily: ELITE, fontSize: 26, padding: "8px 14px 2px", marginTop: 22, transform: "rotate(-4deg)" }}>{up(kicker)}</div> : null}
        </div>
      </AbsoluteFill>
    );
  }
  if (look === "retro") {
    const f = fit(up(title), 840, 0.42, 170, 3);
    return (
      <AbsoluteFill style={{ background: "#050505", alignItems: "center" }}>
        <div style={{ width: 960, height: "100%", overflow: "hidden", borderRadius: 26, position: "relative" }}>{img()}{shade(foot)}
          <div style={{ position: "absolute", left: 36, top: 26, fontFamily: VT, fontSize: 54, color: "#fff", textShadow: "2px 2px 0 rgba(0,0,0,0.7)" }}>▶ PLAY</div>
          {kicker ? <div style={{ position: "absolute", right: 36, top: 26, fontFamily: VT, fontSize: 54, color: AMBER, textShadow: "2px 2px 0 rgba(0,0,0,0.7)" }}>{up(kicker)}</div> : null}
          <div style={{ position: "absolute", left: 40, bottom: 34, color: "#f4efe2", textShadow: "4px 0 0 rgba(255,40,60,0.75), -4px 0 0 rgba(40,220,255,0.75)" }}>{lines(f, { fontFamily: VT, lineHeight: 0.9 })}</div>
        </div>
      </AbsoluteFill>
    );
  }
  if (look === "fieldguide") {
    const f = fit(title, 620, 0.5, 110, 3);
    return (
      <AbsoluteFill style={{ background: CREAM }}>{img()}
        <AbsoluteFill style={{ boxShadow: `inset 0 0 0 14px ${CREAM}` }} />
        <div style={{ position: "absolute", left: 56, bottom: 56, background: CREAM, color: INK, padding: "24px 38px 28px", boxShadow: "0 10px 30px rgba(0,0,0,0.4)", maxWidth: 720 }}>
          {kicker ? <div style={{ fontFamily: PLEX, fontSize: 24, ...tracked(0.22), color: STAMP, marginBottom: 6 }}>{up(kicker)}</div> : null}
          {lines(f, { fontFamily: PLAYFAIR, fontWeight: 800, lineHeight: 1.04 })}
        </div>
      </AbsoluteFill>
    );
  }
  if (look === "monochrome") {
    const f = fit(up(title), 1040, 0.74, 104);
    return (
      <AbsoluteFill style={{ background: "#0b0b0b" }}>{img({ filter: "grayscale(1) contrast(1.12)" })}{shade(foot)}
        <AbsoluteFill style={{ boxShadow: "inset 0 0 0 26px #0b0b0b, inset 0 0 0 28px rgba(255,255,255,0.8)" }} />
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 72, textAlign: "center", color: "#fff", textShadow: SHADOW }}>
          {lines(f, { fontFamily: BODONI, fontWeight: 600, lineHeight: 1.1, ...tracked(0.08) })}
          {kicker ? <div style={{ fontFamily: DM, fontWeight: 500, fontSize: 22, ...tracked(0.4), marginTop: 16 }}>{up(kicker)}</div> : null}
        </div>
      </AbsoluteFill>
    );
  }
  if (look === "slow") {
    const f = fit(title, 1000, 0.5, 108);
    return (
      <AbsoluteFill style={{ background: "#0d0f0b" }}>{img()}{shade("radial-gradient(ellipse at 0% 100%, rgba(0,0,0,0.78) 0%, rgba(0,0,0,0.35) 45%, rgba(0,0,0,0) 75%)")}
        <div style={{ position: "absolute", left: 64, bottom: 60, color: "#fff", textShadow: QUIET }}>
          {kicker ? <div style={{ fontFamily: JOST, fontWeight: 500, fontSize: 24, ...tracked(0.3), marginBottom: 12 }}>{up(kicker)}</div> : null}
          <div style={{ width: 80, height: 2, background: "#fff", marginBottom: 16 }} />
          {lines(f, { fontFamily: JOST, fontWeight: 400, lineHeight: 1.08 })}
        </div>
      </AbsoluteFill>
    );
  }
  if (look === "roadmovie") {
    const f = fit(up(title), 1120, 0.4, 210);
    return (
      <AbsoluteFill style={{ background: "#111" }}>{img()}{shade(foot)}
        <div style={{ position: "absolute", left: 60, bottom: 50, color: "#fff", textShadow: SHADOW }}>
          {kicker ? <div style={{ display: "inline-block", background: AMBER, color: "#111", fontFamily: BARLOW, fontWeight: 600, fontSize: 34, letterSpacing: "0.08em", padding: "4px 16px", textShadow: "none", marginBottom: 10 }}>{up(kicker)}</div> : null}
          {lines(f, { fontFamily: BEBAS, lineHeight: 0.92 })}
          <div style={{ width: 520, height: 12, background: AMBER, marginTop: 12 }} />
        </div>
      </AbsoluteFill>
    );
  }
  const f = fit(title, 1100, 0.5, 136);
  return (
    <AbsoluteFill style={{ background: "#0d0f0b" }}>{img()}{shade(foot)}
      <div style={{ position: "absolute", left: 64, bottom: 56, display: "flex", gap: 26, color: "#fff", textShadow: SHADOW }}>
        <div style={{ width: 6, background: GOLD }} />
        <div>
          {kicker ? <div style={{ fontFamily: DM, fontWeight: 700, fontSize: 26, ...tracked(0.24), color: GOLD, marginBottom: 8 }}>{up(kicker)}</div> : null}
          {lines(f, { fontFamily: FRAUNCES, fontWeight: 700, lineHeight: 1.0, letterSpacing: "-0.015em", fontVariationSettings: "'opsz' 144, 'SOFT' 50" })}
        </div>
      </div>
    </AbsoluteFill>
  );
};
