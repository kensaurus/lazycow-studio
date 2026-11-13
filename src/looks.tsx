/**
 * FILE: src/looks.tsx
 * PURPOSE: The picture looks (film, punch, split, ember, and the cut looks whip, zoom, ridge, slats, iris, jump, mono, pulse, mix) and word recipes (countdown, timeline, pov,
 *          altitude) that Story layers on a reel, so a stockpile of reels does not all look alike.
 * OVERVIEW: Looks change the picture: grain and light leaks, punch-in cuts with a speed ramp, paired
 *           split screens, firelight and sparks. Recipes change how the approved words are staged:
 *           a giant countdown number per line, a 朝 昼 夕 夜 rail, a typed POV headline, a counter
 *           that climbs to the altitude line. Every word still comes from the project's beats (the
 *           website SSOT); the only extra text is the theme's guard-checked kicker and the time and
 *           season marks read from each clip's own capture data.
 * DEPENDENCIES: remotion, shared/story-layout.mjs (positions), shared/looks.json (the list)
 * USAGE: imported by src/Story.tsx; a project picks them with `look`, `recipe`, `kicker`, `loop`
 * NOTES: Motion is transform and opacity only (the cut looks add filter and clip-path); textures are drawn once and moved. Fonts and colours
 *        are the house ones (Shippori Mincho, Cormorant, paper #faf8f1, moss #4d6b52).
 *        Research: docs/research/2026-11-08-reel-effects.md, docs/research/2026-11-09-reel-cuts.md.
 */
import React from "react";
import { AbsoluteFill, Audio, Easing, Freeze, OffthreadVideo, Sequence, interpolate, random, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { CameraMotionBlur } from "@remotion/motion-blur";
import { chipBoxes, kickerBox, meterBox, numeralBox, railBox, storyLayout } from "../shared/story-layout.mjs";
import { parseMeter, splitGroups } from "../shared/looks.mjs";

export { parseMeter, splitGroups };

export type Look = "film" | "punch" | "split" | "ember" | "whip" | "zoom" | "ridge" | "slats" | "iris" | "jump" | "mono" | "pulse" | "mix" | "spin" | "cube" | "glitch" | "burn" | "bars" | "window" | "print" | "steps" | "hold" | "mirror" | "impact" | "letters";
export type Recipe = "countdown" | "timeline" | "pov" | "altitude";
export type Kicker = { ja: string; en: string };

const PAPER = "#faf8f1";
const MOSS = "#4d6b52";
const SHADOW = "0 2px 22px rgba(0,0,0,0.55), 0 1px 3px rgba(0,0,0,0.5)";
const CLAMP = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const OUT = Easing.out(Easing.cubic);

type Shot = { src: string; durationSec: number; push?: number; label?: string; labelEn?: string; portrait?: boolean };
type Beat = { kind: "hook" | "line" | "end"; ja: string; en: string; startSec: number; endSec: number; side?: "left" | "right"; n?: number };
type Style = "column" | "centre" | "lower" | "split";

/** A soft dark pool behind words so they hold on snow and sky (Story's Scrim): it fades to nothing, never a box. */
const Pool: React.FC<{ x: number; y: number; w: number; h: number; alpha: number; strength?: number }> = ({ x, y, w, h, alpha, strength = 0.5 }) => (
  <div
    style={{
      position: "absolute",
      left: x - w * 0.25,
      top: y - h * 0.35,
      width: w * 1.5,
      height: h * 1.7,
      background: `radial-gradient(ellipse at 50% 50%, rgba(10,12,8,${strength}) 0%, rgba(10,12,8,${strength * 0.6}) 38%, rgba(10,12,8,0) 70%)`,
      opacity: alpha,
      pointerEvents: "none",
    }}
  />
);

/** Frame each shot's cut lands on (Story lays shots end to end). */
export function cutFrames(shots: Shot[], fps: number): number[] {
  const out: number[] = [];
  let t = 0;
  for (const s of shots) {
    out.push(t);
    t += Math.round(s.durationSec * fps);
  }
  return out;
}

function beatAlpha(t: number, beat: Beat) {
  const inT = interpolate(t, [beat.startSec, beat.startSec + 0.4], [0, 1], CLAMP);
  const outT = interpolate(t, [beat.endSec - 0.3, beat.endSec], [1, 0], CLAMP);
  return { alpha: Math.min(inT, outT), live: t >= beat.startSec && t < beat.endSec };
}

/* ---------------------------------------------------------------- looks: picture */

/** A video still is a photo (push 0.09) or a 360 move (push 0): those never ramp. */
const ramps = (shot: Shot, frames: number) => (shot.push ?? 0.04) > 0 && (shot.push ?? 0.04) < 0.08 && frames >= 45;

/**
 * Punch: a hard cut that lands 14% in and settles, sliding from alternating sides, and on video a
 * speed ramp: the first 35% plays at 2x, the rest slows to hold the moment (same source frames in total).
 */
export const PunchShot: React.FC<{ shot: Shot; frames: number; index: number }> = ({ shot, frames, index }) => {
  const frame = useCurrentFrame();
  const e = interpolate(frame, [0, 7], [0, 1], { ...CLAMP, easing: OUT });
  const push = shot.push ?? 0.04;
  const scale = (1.14 - 0.14 * e) * (1 + push * Math.min(1, frame / frames));
  const dx = (index % 2 ? -1 : 1) * 70 * (1 - e);
  const style: React.CSSProperties = { width: "100%", height: "100%", objectFit: "cover" };
  const src = staticFile(shot.src);
  let body: React.ReactNode = <OffthreadVideo src={src} muted style={style} />;
  if (ramps(shot, frames)) {
    const fast = Math.round(frames * 0.35);
    const r1 = 2;
    const r2 = (frames - fast * r1) / (frames - fast);
    body = (
      <>
        <Sequence durationInFrames={fast} layout="none">
          <OffthreadVideo src={src} muted playbackRate={r1} style={style} />
        </Sequence>
        <Sequence from={fast} layout="none">
          <OffthreadVideo src={src} muted trimBefore={fast * r1} playbackRate={r2} style={style} />
        </Sequence>
      </>
    );
  }
  return (
    <AbsoluteFill style={{ transform: `translateX(${dx}px) scale(${scale})` }}>
      {body}
    </AbsoluteFill>
  );
};

/* ---------------------------------------------------------------- looks: how one shot becomes the next
   Each look changes the KIND of cut, not how often it cuts: the reels already cut every 1.9 s, at the fast end of
   what holds viewers (docs/research/2026-11-09-reel-cuts.md). Only transform, opacity, filter and clip-path. */

type Move = "whip" | "zoom" | "ridge" | "slats" | "iris" | "hard" | "spin" | "cube" | "glitch" | "burn" | "bars" | "window";
/** Frames two shots overlap. A look not listed cross-fades (Story's FADE); punch, jump and pulse cut hard. */
export const OVERLAP: Partial<Record<Look, number>> = { punch: 0, jump: 0, pulse: 0, steps: 0, hold: 0, impact: 0, whip: 9, zoom: 10, ridge: 13, slats: 12, iris: 12, mix: 11, spin: 10, cube: 12, glitch: 8, burn: 13, bars: 12, window: 12, print: 12, letters: 11 };
const MOVES = new Set<Look>(["whip", "zoom", "ridge", "slats", "iris", "mix", "spin", "cube", "glitch", "burn", "bars", "window", "letters"]);
export const isMoveLook = (l?: Look | null) => !!l && MOVES.has(l);
/** Mix: a different cut each time, and every fourth one hard, so the rhythm itself changes. */
const MIX: Move[] = ["whip", "ridge", "hard", "spin", "slats", "burn", "hard", "cube", "zoom", "glitch", "bars", "hard", "iris", "window"];
/** Letters: the headline opens the reel; after that the cuts stay simple so the words get the attention. */
const LETTERS: Move[] = ["zoom", "hard", "burn", "hard", "whip", "hard"];
const moveOf = (look: Look, i: number): Move => (look === "mix" ? MIX[i % MIX.length] : look === "letters" ? LETTERS[i % LETTERS.length] : (look as Move));
const INOUT = Easing.inOut(Easing.cubic);

/** A mountain line rising from the bottom of the frame, a different ridge each cut (the view is what is for sale). */
function ridgeClip(p: number, seed: number): string {
  const n = 12, pts: string[] = ["0% 100%"];
  for (let i = 0; i <= n; i++) {
    const a = Math.sin(i * 1.7 + seed * 2.1) * 6 + Math.sin(i * 0.63 + seed) * 9 + Math.sin(i * 3.1 + seed * 0.7) * 2.5;
    pts.push(`${((i / n) * 100).toFixed(1)}% ${(100 - p * 142 + a + 22).toFixed(1)}%`);
  }
  pts.push("100% 100%");
  return `polygon(${pts.join(",")})`;
}
/** Bars that open one after another, joined along the top edge so one polygon draws them all. */
function slatClip(p: number, flip: boolean): string {
  const n = 7, pts: string[] = [];
  for (let i = 0; i < n; i++) {
    const k = flip ? n - 1 - i : i;
    const local = Math.min(1, Math.max(0, p * 1.75 - (k / n) * 0.75));
    const x0 = (i / n) * 100, x1 = ((i + 1) / n) * 100 + 0.05, y = local * 100;
    pts.push(`${x0.toFixed(2)}% 0%`, `${x0.toFixed(2)}% ${y.toFixed(1)}%`, `${x1.toFixed(2)}% ${y.toFixed(1)}%`, `${x1.toFixed(2)}% 0%`);
  }
  return `polygon(${pts.join(",")})`;
}
function moveStyle(kind: Move, p: number, side: "in" | "out", index: number, real = false): React.CSSProperties {
  // p runs 0 to 1 across the overlap. The incoming shot is on top. `real`: a camera motion blur is drawn (MoveShot),
  // so the flat CSS blur that stood in for it is kept light (it still softens the frame at the cut's fastest point).
  const mid = Math.sin(p * Math.PI);
  const soft = real ? 0.3 : 1;
  if (kind === "whip") {
    const v = index % 2 === 0, sign = index % 4 < 2 ? 1 : -1;
    const at = (side === "in" ? 1 - p : -p) * sign * 100;
    return { transform: v ? `translateX(${at}%) scaleX(${1 + mid * 0.22})` : `translateY(${at}%) scaleY(${1 + mid * 0.22})`, filter: `blur(${(mid * 26 * soft).toFixed(1)}px)` };
  }
  if (kind === "zoom") {
    if (side === "out") return { transform: `scale(${1 + p * 1.15})`, filter: `blur(${(p * 20 * soft).toFixed(1)}px)` };
    return { transform: `scale(${0.62 + p * 0.38})`, opacity: Math.min(1, p * 1.7), filter: `blur(${((1 - p) * 16 * soft).toFixed(1)}px)` };
  }
  if (kind === "spin") {
    const sign = index % 2 ? 1 : -1;
    if (side === "out") return { transform: `rotate(${(p * 80 * sign).toFixed(1)}deg) scale(${1 + p * 0.7})`, filter: `blur(${(mid * 20).toFixed(1)}px)` };
    return { transform: `rotate(${((p - 1) * 80 * sign).toFixed(1)}deg) scale(${1.7 - p * 0.7})`, opacity: Math.min(1, p * 2.4), filter: `blur(${(mid * 20).toFixed(1)}px)` };
  }
  if (kind === "cube") {
    if (side === "out") return { transform: `perspective(1900px) translateX(${(-p * 100).toFixed(1)}%) rotateY(${(-p * 90).toFixed(1)}deg)`, transformOrigin: "100% 50%" };
    return { transform: `perspective(1900px) translateX(${((1 - p) * 100).toFixed(1)}%) rotateY(${((1 - p) * 90).toFixed(1)}deg)`, transformOrigin: "0% 50%" };
  }
  if (side === "out") return {};
  if (kind === "glitch" || kind === "bars") return { opacity: p > 0.5 ? 1 : 0 };
  if (kind === "burn") return { opacity: Math.min(1, Math.max(0, (p - 0.3) / 0.4)) };
  if (kind === "window") { const a = (1 - p) * 40, b = (1 - p) * 30; return { clipPath: `inset(${a.toFixed(1)}% ${b.toFixed(1)}% round ${((1 - p) * 34).toFixed(0)}px)` }; }
  if (kind === "ridge") return { clipPath: ridgeClip(p, index) };
  if (kind === "slats") return { clipPath: slatClip(p, index % 2 === 1) };
  if (kind === "iris") return { clipPath: `circle(${(p * 118).toFixed(1)}% at 50% 44%)` };
  return { opacity: p > 0.92 ? 1 : 0 }; // hard: the cut lands on the last frame of the overlap
}

/* Whip and zoom get a real camera motion blur on their cuts (@remotion/motion-blur): each transition frame is drawn
   BLUR_SAMPLES times a fraction of a frame apart and averaged, so a whip streaks along its move and a zoom streaks out
   from the centre. Only the cut's own frames are blurred (about 10 per cut), which keeps the render cost small. The
   blurred copies are frozen frames, and frozen media is silent, so the shot's sound plays from its own <Audio>. */
const BLUR_LOOKS = new Set<Look>(["whip", "zoom"]);
export const BLUR_SAMPLES = 6;
type MoveProps = { shot: Shot; len: number; index: number; look: Look; first: boolean; last: boolean };

/** One shot with its way in and way out. */
export const MoveShot: React.FC<MoveProps> = (props) => {
  const frame = useCurrentFrame();
  if (!BLUR_LOOKS.has(props.look)) return <MoveBody {...props} />;
  const T = OVERLAP[props.look] ?? 10;
  const moving = (!props.first && frame < T) || (!props.last && frame >= props.len - T);
  const body = <MoveBody {...props} real />;
  return (
    <>
      {moving ? <CameraMotionBlur shutterAngle={220} samples={BLUR_SAMPLES}>{body}</CameraMotionBlur> : <AbsoluteFill>{body}</AbsoluteFill>}
      <Audio src={staticFile(props.shot.src)} volume={0.7} />
    </>
  );
};

const MoveBody: React.FC<MoveProps & { real?: boolean }> = ({ shot, len, index, look, first, last, real = false }) => {
  const frame = useCurrentFrame();
  const T = OVERLAP[look] ?? 10;
  const inP = first ? 1 : interpolate(frame, [0, T], [0, 1], { ...CLAMP, easing: INOUT });
  const outP = last ? 0 : interpolate(frame, [len - T, len], [0, 1], { ...CLAMP, easing: INOUT });
  const push = shot.push ?? 0.05;
  const scale = interpolate(frame, [0, len], [1, 1 + push], CLAMP);
  const entering = !first && inP < 1, leaving = !last && outP > 0;
  const style = leaving ? moveStyle(moveOf(look, index + 1), outP, "out", index + 1, real) : entering ? moveStyle(moveOf(look, index), inP, "in", index, real) : {};
  const kind = entering ? moveOf(look, index) : null;
  const mid = Math.sin(inP * Math.PI);
  // With a real blur the sound comes from MoveShot's <Audio>; the picture copies stay silent.
  const video = <OffthreadVideo src={staticFile(shot.src)} {...(real ? { muted: true } : { volume: 0.7 })} style={{ width: "100%", height: "100%", objectFit: "cover", transform: `scale(${scale})` }} />;
  // Real channel separation: red, green and blue copies pushed apart, added back together.
  const split = (kind === "glitch" && inP > 0.5) || (leaving && moveOf(look, index + 1) === "glitch" && outP < 0.5);
  const off = 26 * (entering ? 1 - inP : outP) + 8;
  const channel = (id: string, dx: number) => (
    <AbsoluteFill style={{ mixBlendMode: "screen", filter: `url(#${id})`, transform: `translateX(${dx.toFixed(1)}px)` }}>
      <OffthreadVideo src={staticFile(shot.src)} muted style={{ width: "100%", height: "100%", objectFit: "cover", transform: `scale(${scale})` }} />
    </AbsoluteFill>
  );
  return (
    <>
      {split ? (
        <AbsoluteFill style={{ ...style, background: "#000", isolation: "isolate" }}>
          <svg width="0" height="0" style={{ position: "absolute" }}>
            <filter id="rgbR"><feColorMatrix values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" /></filter>
            <filter id="rgbG"><feColorMatrix values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" /></filter>
            <filter id="rgbB"><feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" /></filter>
          </svg>
          {channel("rgbR", -off)}{channel("rgbG", 0)}{channel("rgbB", off)}
        </AbsoluteFill>
      ) : <AbsoluteFill style={style}>{video}</AbsoluteFill>}
      {kind === "burn" ? <AbsoluteFill style={{ mixBlendMode: "screen", opacity: mid, background: `radial-gradient(circle at ${index % 2 ? 22 : 78}% ${30 + (index % 3) * 18}%, #fff4d6 0%, #ffb347 26%, #d9480f 52%, transparent 78%)` }} /> : null}
      {kind === "bars" ? (
        <>
          <AbsoluteFill style={{ background: "#0e100c", clipPath: `inset(0 0 ${(100 - mid * 50).toFixed(1)}% 0)` }} />
          <AbsoluteFill style={{ background: "#0e100c", clipPath: `inset(${(100 - mid * 50).toFixed(1)}% 0 0 0)` }} />
        </>
      ) : null}
    </>
  );
};

const COVER: React.CSSProperties = { width: "100%", height: "100%", objectFit: "cover" };

/** Print (the photo dump): each shot lands as a tilted print on the pile, the last one still under it. */
export const PrintShot: React.FC<{ shot: Shot; len: number; index: number; first: boolean }> = ({ shot, len, index, first }) => {
  const frame = useCurrentFrame();
  const e = first ? 1 : interpolate(frame, [0, 10], [0, 1], { ...CLAMP, easing: OUT });
  const tilt = [-3.4, 2.6, -1.8, 3.6, -2.8, 1.6][index % 6];
  const push = interpolate(frame, [0, len], [1, 1.06], CLAMP);
  return (
    <AbsoluteFill style={{ background: index === 0 ? "#1d211a" : "transparent", justifyContent: "center", alignItems: "center" }}>
      <div style={{ width: "86%", height: "76%", background: PAPER, padding: 20, boxSizing: "border-box", overflow: "hidden", boxShadow: "0 30px 70px rgba(0,0,0,0.55)", opacity: Math.min(1, e * 3), transform: `rotate(${(tilt + (1 - e) * 9 * (index % 2 ? 1 : -1)).toFixed(2)}deg) scale(${(1 + (1 - e) * 0.42).toFixed(3)})` }}>
        <div style={{ width: "100%", height: "100%", overflow: "hidden" }}>
          <OffthreadVideo src={staticFile(shot.src)} muted style={{ ...COVER, transform: `scale(${push})` }} />
        </div>
      </div>
    </AbsoluteFill>
  );
};

/** Steps: stop-motion, the picture changes only every fourth frame. */
export const StepShot: React.FC<{ shot: Shot; frames: number }> = ({ shot, frames }) => {
  const frame = useCurrentFrame();
  const held = Math.floor(frame / 4) * 4;
  const scale = 1 + (shot.push ?? 0.05) * Math.min(1, held / frames);
  return (
    <AbsoluteFill style={{ transform: `scale(${scale.toFixed(4)})` }}>
      <Freeze frame={held}><OffthreadVideo src={staticFile(shot.src)} muted style={COVER} /></Freeze>
    </AbsoluteFill>
  );
};

/** Hold: each shot stops on a freeze-frame that drains and leans in, then a hard cut breaks it. */
export const HoldShot: React.FC<{ shot: Shot; frames: number }> = ({ shot, frames }) => {
  const frame = useCurrentFrame();
  const at = Math.max(8, frames - 18);
  const k = interpolate(frame, [at, frames], [0, 1], CLAMP);
  const scale = (1 + (shot.push ?? 0.04) * Math.min(1, frame / at)) * (1 + k * 0.1);
  return (
    <AbsoluteFill style={{ transform: `scale(${scale.toFixed(4)})`, filter: `saturate(${(1 - k * 0.75).toFixed(3)}) brightness(${(1 + (frame === at ? 0.5 : 0)).toFixed(2)})` }}>
      <Freeze frame={at} active={(f) => f >= at}><OffthreadVideo src={staticFile(shot.src)} muted style={COVER} /></Freeze>
    </AbsoluteFill>
  );
};

/** Mirror: the frame folds onto itself, left against right, then top against bottom on the next shot. */
export const MirrorShot: React.FC<{ shot: Shot; frames: number; index: number; first: boolean; fade: number }> = ({ shot, frames, index, first, fade }) => {
  const frame = useCurrentFrame();
  const opacity = first ? 1 : interpolate(frame, [0, fade], [0, 1], CLAMP);
  const side = index % 2 === 0;
  const scale = interpolate(frame, [0, frames], [1, 1 + (shot.push ?? 0.05)], CLAMP);
  const v = (flip: boolean) => <OffthreadVideo src={staticFile(shot.src)} muted style={{ ...COVER, transform: `${flip ? (side ? "scaleX(-1) " : "scaleY(-1) ") : ""}scale(${scale})` }} />;
  return (
    <AbsoluteFill style={{ opacity }}>
      <AbsoluteFill style={{ clipPath: side ? "inset(0 50% 0 0)" : "inset(0 0 50% 0)" }}>{v(false)}</AbsoluteFill>
      <AbsoluteFill style={{ clipPath: side ? "inset(0 0 0 50%)" : "inset(50% 0 0 0)" }}>{v(true)}</AbsoluteFill>
    </AbsoluteFill>
  );
};

/** Impact: a hard cut that lands too close and shakes itself into place. */
export const ImpactShot: React.FC<{ shot: Shot; frames: number; index: number }> = ({ shot, frames, index }) => {
  const frame = useCurrentFrame();
  const e = interpolate(frame, [0, 8], [1, 0], { ...CLAMP, easing: OUT });
  const dx = Math.sin(frame * 2.3 + index) * 26 * e, dy = Math.cos(frame * 1.9 + index) * 20 * e;
  const scale = (1 + 0.26 * e) * (1 + (shot.push ?? 0.04) * Math.min(1, frame / frames));
  return (
    <AbsoluteFill style={{ transform: `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) rotate(${(Math.sin(frame + index) * 1.4 * e).toFixed(2)}deg) scale(${scale.toFixed(4)})` }}>
      <OffthreadVideo src={staticFile(shot.src)} muted style={COVER} />
    </AbsoluteFill>
  );
};

/** Letters: the reel opens inside the words of its own headline, then the camera flies through a letter into the picture. */
export const LettersOpen: React.FC<{ text: string }> = ({ text }) => {
  const frame = useCurrentFrame();
  if (frame > 62) return null;
  const grow = interpolate(frame, [26, 54], [1, 1], CLAMP) * Math.pow(26, interpolate(frame, [26, 54], [0, 1], { ...CLAMP, easing: Easing.in(Easing.cubic) }));
  const fade = interpolate(frame, [46, 60], [1, 0], CLAMP);
  const rows = text.replace(/[。、]$/g, "").split("\n").filter(Boolean);
  const longest = Math.max(...rows.map((r) => r.length));
  const size = Math.min(250, 900 / Math.max(1, longest));
  // These are the reel's first frames and the picture behind them is often dark: a veil of white keeps the words readable.
  const veil = fade * interpolate(frame, [26, 40], [0.42, 0], CLAMP);
  const centred: React.CSSProperties = { justifyContent: "center", alignItems: "center" };
  const words = (
    <div style={{ transform: `scale(${grow.toFixed(3)})`, color: "#fff", fontFamily: "Shippori Mincho", fontWeight: 700, fontSize: size, lineHeight: 1.16, textAlign: "center", whiteSpace: "nowrap" }}>
      {rows.map((r) => <div key={r}>{r}</div>)}
    </div>
  );
  return (
    <>
      <AbsoluteFill style={{ background: "#000", mixBlendMode: "multiply", opacity: fade, ...centred }}>{words}</AbsoluteFill>
      <AbsoluteFill style={{ opacity: veil, ...centred }}>{words}</AbsoluteFill>
    </>
  );
};

/**
 * Jump: hard cuts between shots, and inside each video shot an overlapping jump cut (it steps back a few frames and
 * punches in). In the one controlled study, overlapping cuts held viewers better at low and medium pace.
 */
export const JumpShot: React.FC<{ shot: Shot; frames: number; index: number }> = ({ shot, frames, index }) => {
  const frame = useCurrentFrame();
  const at = Math.round(frames * 0.52), after = frame >= at;
  const kick = after ? interpolate(frame, [at, at + 5], [0.05, 0], { ...CLAMP, easing: OUT }) : 0;
  const push = shot.push ?? 0.04;
  const scale = (after ? 1.16 : 1) * (1 + kick) * (1 + push * Math.min(1, frame / frames));
  const origin = index % 2 ? "38% 40%" : "62% 46%";
  const style: React.CSSProperties = { width: "100%", height: "100%", objectFit: "cover" };
  const src = staticFile(shot.src);
  const body = ramps(shot, frames) ? (
    <>
      <Sequence durationInFrames={at} layout="none"><OffthreadVideo src={src} muted style={style} /></Sequence>
      <Sequence from={at} layout="none"><OffthreadVideo src={src} muted trimBefore={Math.max(0, at - 7)} style={style} /></Sequence>
    </>
  ) : <OffthreadVideo src={src} muted style={style} />;
  return <AbsoluteFill style={{ transform: `scale(${scale})`, transformOrigin: origin }}>{body}</AbsoluteFill>;
};

/** Mono: every shot opens in black and white and the colour floods in, so the eye is pulled to the colour of the place. */
export const MonoShot: React.FC<{ shot: Shot; frames: number; first: boolean; fade: number }> = ({ shot, frames, first, fade }) => {
  const frame = useCurrentFrame();
  const opacity = first ? 1 : interpolate(frame, [0, fade], [0, 1], CLAMP);
  const g = interpolate(frame, [fade + 2, fade + 20], [1, 0], { ...CLAMP, easing: INOUT });
  const scale = interpolate(frame, [0, frames], [1, 1 + (shot.push ?? 0.05)], CLAMP);
  return (
    <AbsoluteFill style={{ opacity, filter: `grayscale(${g.toFixed(3)}) contrast(${(1 + g * 0.14).toFixed(3)})` }}>
      <OffthreadVideo src={staticFile(shot.src)} volume={0.7} style={{ width: "100%", height: "100%", objectFit: "cover", transform: `scale(${scale})` }} />
    </AbsoluteFill>
  );
};

/** Pulse: hard cuts, and the picture leans in on every half second, the grid the cuts already sit on. */
export const PulseShot: React.FC<{ shot: Shot; frames: number; start: number }> = ({ shot, frames, start }) => {
  const frame = useCurrentFrame();
  const beat = (frame + start) % 15;
  const down = Math.floor((frame + start) / 15) % 2 === 0;
  const bump = (down ? 0.06 : 0.03) * Math.pow(1 - beat / 15, 3);
  const scale = (1 + (shot.push ?? 0.04) * Math.min(1, frame / frames)) * (1 + bump);
  return (
    <AbsoluteFill style={{ transform: `scale(${scale.toFixed(4)})`, filter: `brightness(${(1 + bump * 1.6).toFixed(3)})` }}>
      <OffthreadVideo src={staticFile(shot.src)} muted style={{ width: "100%", height: "100%", objectFit: "cover" }} />
    </AbsoluteFill>
  );
};

/** Punch: a paper flash on each caption's cut, so the new line lands with the picture. */
export const PunchFlash: React.FC<{ beats: Beat[] }> = ({ beats }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const peaks = beats.filter((b) => b.kind !== "hook").map((b) => Math.round((b.startSec - 0.1) * fps));
  const a = Math.max(0, ...peaks.map((p) => interpolate(frame - p, [-1, 1, 7], [0, 0.3, 0], CLAMP)));
  return <AbsoluteFill style={{ background: PAPER, opacity: a, pointerEvents: "none" }} />;
};

/** One grain tile, drawn once; each frame only moves it. */
const GRAIN =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix type='saturate' values='0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>`,
  );

/** Film: a slight gate weave on the picture underneath. */
export const Weave: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const frame = useCurrentFrame();
  const dx = (random(`wx${frame}`) - 0.5) * 2.6;
  const dy = (random(`wy${frame}`) - 0.5) * 1.8;
  return <AbsoluteFill style={{ transform: `translate(${dx}px, ${dy}px) scale(1.012)` }}>{children}</AbsoluteFill>;
};

/** Film: moving grain, a warm leak that blooms on every cut (alternating corners), a soft vignette. */
export const FilmOverlay: React.FC<{ cuts: number[] }> = ({ cuts }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const gx = Math.round((random(`gx${frame}`) - 0.5) * 240);
  const gy = Math.round((random(`gy${frame}`) - 0.5) * 240);
  let leak = 0;
  let side = 0;
  cuts.forEach((c, i) => {
    const v = interpolate(frame - c, [-2, 3, 26], [0, 1, 0], CLAMP);
    if (v > leak) {
      leak = v;
      side = i % 2;
    }
  });
  const drift = interpolate(leak, [0, 1], [width * 0.18, 0]);
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <AbsoluteFill style={{ background: "rgba(255,176,96,0.05)", mixBlendMode: "screen" }} />
      <div
        style={{
          position: "absolute",
          left: side ? -width * 0.35 : width * 0.35,
          top: -height * 0.12,
          width: width,
          height: height * 0.7,
          background: "radial-gradient(ellipse at 50% 40%, rgba(255,140,50,1) 0%, rgba(255,105,45,0.6) 38%, rgba(255,90,60,0) 72%)",
          mixBlendMode: "screen",
          opacity: leak * 0.9,
          transform: `translateX(${side ? drift : -drift}px)`,
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: -240,
          backgroundImage: `url("${GRAIN}")`,
          backgroundSize: "240px 240px",
          opacity: 0.2,
          mixBlendMode: "overlay",
          transform: `translate(${gx}px, ${gy}px)`,
        }}
      />
      <AbsoluteFill style={{ background: "radial-gradient(ellipse at 50% 48%, rgba(0,0,0,0) 58%, rgba(10,8,4,0.42) 100%)" }} />
    </AbsoluteFill>
  );
};

/** Ember: firelight that flickers up from below, sparks drifting up, a deep vignette. */
export const EmberOverlay: React.FC = () => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const flicker = 0.55 + 0.22 * Math.sin(frame * 0.37) + 0.14 * Math.sin(frame * 0.91 + 1.3) + 0.09 * Math.sin(frame * 2.3 + 0.4);
  const sparks = Array.from({ length: 30 }, (_, i) => {
    const period = 80 + Math.floor(random(`p${i}`) * 110);
    const phase = Math.floor(random(`f${i}`) * period);
    const p = ((frame + phase) % period) / period;
    const x = random(`x${i}`) * width + Math.sin((frame + phase) * 0.06 + i) * 26;
    const y = height * (1.02 - p * (0.55 + random(`h${i}`) * 0.3));
    const size = 5 + random(`s${i}`) * 7;
    return (
      <div
        key={i}
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: size,
          height: size,
          borderRadius: "50%",
          background: "radial-gradient(circle, rgba(255,226,170,1) 0%, rgba(255,150,70,0.9) 45%, rgba(255,120,50,0) 100%)",
          boxShadow: "0 0 10px 3px rgba(255,140,60,0.55)",
          opacity: Math.sin(Math.PI * p) * 0.9,
          transform: `translate(${x}px, ${y}px)`,
        }}
      />
    );
  });
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <AbsoluteFill
        style={{
          background: "radial-gradient(ellipse at 50% 108%, rgba(255,140,60,0.5) 0%, rgba(255,110,40,0.22) 38%, rgba(255,90,30,0) 72%)",
          mixBlendMode: "screen",
          opacity: Math.max(0.2, Math.min(1, flicker)),
        }}
      />
      {sparks}
      <AbsoluteFill style={{ background: "radial-gradient(ellipse at 50% 55%, rgba(0,0,0,0) 46%, rgba(6,4,2,0.6) 100%)" }} />
    </AbsoluteFill>
  );
};

const Chip: React.FC<{ box: { x: number; y: number; w: number; h: number }; ja?: string; en?: string; alpha: number }> = ({ box, ja, en, alpha }) =>
  ja ? (
    <>
    <Pool x={box.x} y={box.y} w={box.w} h={box.h} alpha={alpha} strength={0.45} />
    <div style={{ position: "absolute", left: box.x, top: box.y, width: box.w, height: box.h, textAlign: "right", color: PAPER, textShadow: SHADOW, opacity: alpha }}>
      <div style={{ fontFamily: "Shippori Mincho", fontWeight: 700, fontSize: 64, lineHeight: 1.05 }}>{ja}</div>
      {en ? <div style={{ fontFamily: "Cormorant", fontStyle: "italic", fontWeight: 500, fontSize: 30, lineHeight: 1.1 }}>{en}</div> : null}
    </div>
    </>
  ) : null;

/**
 * Split: each pair plays at once, top and bottom (left and right on wide), slowed so both clips fill the
 * pair's time. The halves wipe in from opposite sides and a paper rule draws between them.
 */
export const SplitShots: React.FC<{ shots: Shot[]; other: Shot[]; fade: number }> = ({ shots, other, fade }) => {
  const { fps, width, height } = useVideoConfig();
  const tall = height > width;
  const L = storyLayout(width, height);
  const chips = chipBoxes(L, width, height);
  const frames = shots.map((s) => Math.round(s.durationSec * fps));
  let from = 0;
  return (
    <>
      {splitGroups(shots.length).map((g, k) => {
        const total = g.reduce((a, i) => a + frames[i], 0);
        const start = k === 0 ? 0 : from - fade;
        const len = total + (k === 0 ? 0 : fade);
        from = start + len;
        return (
          <Sequence key={k} from={start} durationInFrames={len}>
            <SplitGroup idx={g} shots={shots} other={other} len={len} first={k === 0} fade={fade} tall={tall} chips={chips} />
          </Sequence>
        );
      })}
    </>
  );
};

const SplitGroup: React.FC<{ idx: number[]; shots: Shot[]; other: Shot[]; len: number; first: boolean; fade: number; tall: boolean; chips: { x: number; y: number; w: number; h: number }[] }> = ({ idx, shots, other, len, first, fade, tall, chips }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const opacity = first ? 1 : interpolate(frame, [0, fade], [0, 1], CLAMP);
  const cover: React.CSSProperties = { width: "100%", height: "100%", objectFit: "cover" };
  if (idx.length === 1) {
    const shot = shots[idx[0]];
    const scale = interpolate(frame, [0, len], [1, 1 + (shot.push ?? 0.04)], CLAMP);
    return (
      <AbsoluteFill style={{ opacity }}>
        <OffthreadVideo src={staticFile(shot.src)} muted style={{ ...cover, transform: `scale(${scale})` }} />
      </AbsoluteFill>
    );
  }
  // Each half is closer in shape to the other canvas: a tall frame's halves take the wide grade, and back,
  // except an upright source on a tall frame, whose wide grade is filled out with blur: it keeps its own.
  const half = (i: number, k: number) => {
    const shot = (tall && shots[i].portrait) || !other[i] ? shots[i] : other[i];
    const own = Math.round(shots[i].durationSec * fps);
    const wipe = interpolate(frame, [k * 5, k * 5 + 13], [0, 1], { ...CLAMP, easing: OUT });
    const off = (k === 0 ? -1 : 1) * 100 * (1 - wipe);
    const pos: React.CSSProperties = tall
      ? { left: 0, width: "100%", top: k === 0 ? 0 : "50%", height: "50%" }
      : { top: 0, height: "100%", left: k === 0 ? 0 : "50%", width: "50%" };
    const scale = interpolate(frame, [0, len], [1.0, 1.06], CLAMP);
    return (
      <div key={k} style={{ position: "absolute", overflow: "hidden", ...pos }}>
        <div style={{ position: "absolute", inset: 0, transform: tall ? `translateX(${off}%)` : `translateY(${off}%)` }}>
          <OffthreadVideo src={staticFile(shot.src)} muted playbackRate={Math.max(0.2, own / len)} style={{ ...cover, transform: `scale(${scale})` }} />
        </div>
      </div>
    );
  };
  const rule = interpolate(frame, [6, 20], [0, 1], { ...CLAMP, easing: OUT });
  const chipA = interpolate(frame, [16, 26], [0, 1], CLAMP) * interpolate(frame, [len - 8, len], [1, 0], CLAMP);
  const [a, b] = idx;
  return (
    <AbsoluteFill style={{ opacity, background: "#14160f" }}>
      {half(a, 0)}
      {half(b, 1)}
      <div
        style={{
          position: "absolute",
          background: PAPER,
          boxShadow: "0 0 12px rgba(0,0,0,0.45)",
          ...(tall
            ? { left: 0, right: 0, top: "50%", height: 4, marginTop: -2, transform: `scaleX(${rule})` }
            : { top: 0, bottom: 0, left: "50%", width: 4, marginLeft: -2, transform: `scaleY(${rule})` }),
        }}
      />
      <Chip box={chips[0]} ja={shots[a].label} en={shots[a].labelEn} alpha={chipA} />
      <Chip box={chips[1]} ja={shots[b].label} en={shots[b].labelEn} alpha={chipA} />
    </AbsoluteFill>
  );
};

/** Loop ending: the opening frame dissolves in under the last moments, so a replay has no seam. */
export const LoopTail: React.FC<{ first: Shot; total: number }> = ({ first, total }) => {
  const n = 12;
  return (
    <Sequence from={Math.max(0, total - n)} durationInFrames={n}>
      <LoopFade src={first.src} n={n} />
    </Sequence>
  );
};

const LoopFade: React.FC<{ src: string; n: number }> = ({ src, n }) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ opacity: interpolate(frame, [0, n - 1], [0, 1], CLAMP) }}>
      <OffthreadVideo src={staticFile(src)} muted style={{ width: "100%", height: "100%", objectFit: "cover" }} />
    </AbsoluteFill>
  );
};

/* ---------------------------------------------------------------- recipes: words */

/** The kicker over the headline ("ここで働く、3つの理由。"), sliding in with a short moss rule. */
export const KickerLine: React.FC<{ kicker: Kicker; beat: Beat; style: Style }> = ({ kicker, beat, style }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const { alpha, live } = beatAlpha(frame / fps, beat);
  if (!live) return null;
  const L = storyLayout(width, height, beat.ja.split("\n"), style);
  const K = kickerBox(L);
  const e = interpolate(frame, [beat.startSec * fps, beat.startSec * fps + 12], [0, 1], { ...CLAMP, easing: OUT });
  return (
    <>
    <Pool x={K.x} y={K.y} w={K.w * 0.8} h={K.h} alpha={alpha} strength={0.45} />
    <div style={{ position: "absolute", left: K.x, top: K.y, width: K.w, height: K.h, color: PAPER, textShadow: SHADOW, opacity: alpha, transform: `translateX(${(1 - e) * -28}px)` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <div style={{ width: 44 * e, height: 4, background: MOSS, boxShadow: "0 0 0 1px rgba(250,248,241,0.7)" }} />
        <div style={{ fontFamily: "Shippori Mincho", fontWeight: 700, fontSize: K.font, letterSpacing: "0.12em", lineHeight: 1.35 }}>{kicker.ja}</div>
      </div>
      <div style={{ fontFamily: "Cormorant", fontStyle: "italic", fontWeight: 500, fontSize: K.enFont, lineHeight: 1.3, marginLeft: 60 }}>{kicker.en}</div>
    </div>
    </>
  );
};

/** Countdown: a giant outlined number beside each proof line, landing big and settling. */
export const Numeral: React.FC<{ beat: Beat; style: Style; of: number }> = ({ beat, style, of }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const { alpha, live } = beatAlpha(frame / fps, beat);
  if (!live || !beat.n) return null;
  const L = storyLayout(width, height, undefined, style);
  const N = numeralBox(L, beat.side);
  const e = interpolate(frame, [beat.startSec * fps - 3, beat.startSec * fps + 9], [0, 1], { ...CLAMP, easing: OUT });
  const justify = N.align === "right" ? "flex-end" : N.align === "center" ? "center" : "flex-start";
  return (
    <>
    <Pool x={N.x + N.w * 0.15} y={N.y + N.h * 0.15} w={N.w * 0.7} h={N.h * 0.7} alpha={alpha * e} strength={0.38} />
    <div style={{ position: "absolute", left: N.x, top: N.y, width: N.w, height: N.h, display: "flex", alignItems: "flex-end", justifyContent: justify, opacity: alpha }}>
      <div
        style={{
          fontFamily: "Cormorant",
          fontStyle: "italic",
          fontWeight: 600,
          fontSize: N.font,
          lineHeight: 0.9,
          fontVariantNumeric: "lining-nums",
          fontFeatureSettings: '"lnum" 1',
          color: `rgba(250,248,241,${0.16 * e})`,
          WebkitTextStroke: `4px ${PAPER}`,
          textShadow: "0 4px 30px rgba(0,0,0,0.45)",
          transform: `scale(${1.4 - 0.4 * e})`,
          transformOrigin: "50% 80%",
        }}
      >
        {beat.n}
      </div>
      <div style={{ fontFamily: "Cormorant", fontStyle: "italic", fontWeight: 500, fontSize: Math.round(N.font * 0.2), color: PAPER, textShadow: SHADOW, marginLeft: 10, marginBottom: N.font * 0.12, opacity: e }}>
        / {of}
      </div>
    </div>
    </>
  );
};

const DAY = ["朝", "昼", "夕", "夜"];
const DAY_EN = ["morning", "midday", "dusk", "night"];

/** Timeline: a 朝 昼 夕 夜 rail; the dot travels to each shot's own time of day after the headline. */
export const Rail: React.FC<{ shots: Shot[]; beats: Beat[]; style: Style }> = ({ shots, beats, style }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  if (!shots.some((s) => s.label && DAY.includes(s.label))) return null;
  const hook = beats.find((b) => b.kind === "hook");
  const end = beats.find((b) => b.kind === "end");
  const from = (hook ? hook.endSec : 0.5) * fps;
  const to = (end ? end.startSec : 99) * fps;
  const alpha = interpolate(frame, [from - 4, from + 8], [0, 1], CLAMP) * interpolate(frame, [to - 8, to + 4], [1, 0], CLAMP);
  if (alpha <= 0) return null;
  const cuts = cutFrames(shots, fps);
  const stopOf = (i: number) => {
    let k = DAY.indexOf(shots[i]?.label ?? "");
    for (let j = i; k < 0 && j >= 0; j--) k = DAY.indexOf(shots[j].label ?? "");
    return Math.max(0, k);
  };
  const cur = Math.max(0, cuts.filter((c) => c <= frame).length - 1);
  const prev = cur > 0 ? stopOf(cur - 1) : stopOf(cur);
  const pos = interpolate(frame, [cuts[cur], cuts[cur] + 12], [prev, stopOf(cur)], { ...CLAMP, easing: Easing.inOut(Easing.cubic) });
  const L = storyLayout(width, height, undefined, style);
  const R = railBox(L);
  const step = R.w / (DAY.length - 1);
  const active = Math.round(pos);
  return (
    <>
    <Pool x={R.x} y={R.y} w={R.w} h={R.h} alpha={alpha} strength={0.4} />
    <div style={{ position: "absolute", left: R.x, top: R.y, width: R.w, height: R.h, opacity: alpha, color: PAPER }}>
      <div style={{ position: "absolute", left: 0, right: 0, top: 22, height: 3, background: "rgba(250,248,241,0.45)", boxShadow: "0 1px 6px rgba(0,0,0,0.5)" }} />
      <div style={{ position: "absolute", left: 0, width: R.w, top: 21, height: 4, background: PAPER, transformOrigin: "0 50%", transform: `scaleX(${pos / (DAY.length - 1)})` }} />
      {DAY.map((d, k) => (
        <div key={d} style={{ position: "absolute", left: k * step - 60, width: 120, top: 0, textAlign: "center" }}>
          <div style={{ width: 12, height: 12, borderRadius: 6, margin: "17px auto 0", background: k <= pos + 0.01 ? PAPER : "rgba(250,248,241,0.5)", boxShadow: "0 0 6px rgba(0,0,0,0.5)" }} />
          <div style={{ fontFamily: "Shippori Mincho", fontWeight: 700, fontSize: R.font, marginTop: 8, textShadow: SHADOW, opacity: k === active ? 1 : 0.5 }}>{d}</div>
          <div style={{ fontFamily: "Cormorant", fontStyle: "italic", fontWeight: 500, fontSize: R.enFont, textShadow: SHADOW, opacity: k === active ? 1 : 0 }}>{DAY_EN[k]}</div>
        </div>
      ))}
      <div
        style={{
          position: "absolute",
          left: -13,
          top: 10,
          width: 26,
          height: 26,
          borderRadius: 13,
          background: MOSS,
          border: `3px solid ${PAPER}`,
          boxShadow: "0 0 12px rgba(0,0,0,0.5)",
          transform: `translateX(${pos * step}px)`,
        }}
      />
    </div>
    </>
  );
};

/** POV: the kicker, then the headline, typed out with a blinking caret. */
export const TypedHook: React.FC<{ beat: Beat; kicker?: Kicker | null; style: Style }> = ({ beat, kicker, style }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const { alpha, live } = beatAlpha(frame / fps, beat);
  if (!live) return null;
  const columns = beat.ja.split("\n");
  const L = storyLayout(width, height, columns, style);
  const K = kickerBox(L);
  const start = beat.startSec * fps + 2;
  const kChars = kicker ? [...kicker.ja] : [];
  const kTyped = Math.floor(interpolate(frame, [start, start + kChars.length * 1.6], [0, kChars.length], CLAMP));
  const hStart = start + kChars.length * 1.6 + 4;
  const total = columns.reduce((a, c) => a + [...c].length, 0);
  const typed = Math.floor(interpolate(frame, [hStart, hStart + total * 2.4], [0, total], CLAMP));
  const blink = Math.floor(frame / 15) % 2 === 0 ? 1 : 0;
  // The caret takes no room in the line, so a full line never wraps it onto the next one.
  const caret = (on: boolean) => (
    <span style={{ display: "inline-block", position: "relative", width: 0, height: L.vertical ? 0 : "0.95em", verticalAlign: L.vertical ? undefined : "-0.08em" }}>
      <span
        style={{
          position: "absolute",
          left: L.vertical ? "-0.45em" : 6,
          top: L.vertical ? 6 : 0,
          width: L.vertical ? "0.9em" : 6,
          height: L.vertical ? 6 : "100%",
          background: PAPER,
          opacity: on ? blink : 0,
          boxShadow: SHADOW,
        }}
      />
    </span>
  );
  let n = 0;
  const done = typed >= total;
  const textAlign = L.vertical ? undefined : (L.hookAlign as "left" | "right" | "center");
  return (
    <>
      <Pool x={L.hook.x} y={L.hook.y} w={L.hook.w} h={L.hook.h} alpha={alpha} strength={0.42} />
      <Pool x={L.hookEn.x} y={L.hookEn.y} w={L.hookEn.w} h={L.hookEn.h * 0.7} alpha={alpha} strength={0.5} />
      {kicker ? <Pool x={K.x} y={K.y} w={K.w * 0.8} h={K.h} alpha={alpha} strength={0.45} /> : null}
      {kicker ? (
        <div style={{ position: "absolute", left: K.x, top: K.y, width: K.w, color: PAPER, textShadow: SHADOW, opacity: alpha }}>
          <div style={{ fontFamily: "Shippori Mincho", fontWeight: 700, fontSize: K.font, letterSpacing: "0.08em", lineHeight: 1.35 }}>
            {kChars.map((ch, i) => (
              <span key={i} style={{ opacity: i < kTyped ? 1 : 0 }}>{ch}</span>
            ))}
            {kTyped < kChars.length ? caret(true) : null}
          </div>
          <div style={{ fontFamily: "Cormorant", fontStyle: "italic", fontWeight: 500, fontSize: K.enFont, opacity: interpolate(frame, [hStart, hStart + 10], [0, 1], CLAMP) }}>{kicker.en}</div>
        </div>
      ) : null}
      <div
        style={{
          position: "absolute",
          left: L.hook.x,
          top: L.hook.y,
          width: L.hook.w,
          height: L.hook.h,
          writingMode: L.vertical ? "vertical-rl" : "horizontal-tb",
          fontFamily: "Shippori Mincho",
          fontWeight: 700,
          fontSize: L.hook.font,
          lineHeight: L.vertical ? 1.32 : 1.3,
          letterSpacing: L.vertical ? "0.08em" : "0.04em",
          textAlign,
          color: PAPER,
          textShadow: SHADOW,
          opacity: alpha,
        }}
      >
        {columns.map((col, c) => (
          <div key={c}>
            {[...col].map((ch) => {
              const i = n++;
              return (
                <React.Fragment key={i}>
                  <span style={{ opacity: i < typed ? 1 : 0 }}>{ch}</span>
                  {i === typed - 1 && !done ? caret(true) : null}
                </React.Fragment>
              );
            })}
            {c === columns.length - 1 && done ? caret(true) : null}
          </div>
        ))}
      </div>
      <div
        style={{
          position: "absolute",
          left: L.hookEn.x,
          top: L.hookEn.y,
          width: L.hookEn.w,
          fontFamily: "Cormorant",
          fontStyle: "italic",
          fontWeight: 500,
          fontSize: L.hookEn.font,
          lineHeight: 1.15,
          textAlign: L.vertical ? (L.hookEn.x > L.safe.x + 40 ? "right" : "left") : textAlign,
          color: PAPER,
          textShadow: SHADOW,
          opacity: interpolate(frame, [hStart + total * 2.4, hStart + total * 2.4 + 12], [0, 1], CLAMP) * alpha,
        }}
      >
        {beat.en}
      </div>
    </>
  );
};

/** Altitude: the headline is a counter that climbs to the approved number, over a ruler that scrolls. */
export const Meter: React.FC<{ beat: Beat }> = ({ beat }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const { alpha, live } = beatAlpha(frame / fps, beat);
  const m = parseMeter(beat.ja);
  if (!live || !m) return null;
  const L = storyLayout(width, height);
  const B = meterBox(L);
  const t0 = (beat.startSec + 0.15) * fps;
  const t1 = (beat.startSec + Math.min(2.2, (beat.endSec - beat.startSec) * 0.7)) * fps;
  const p = interpolate(frame, [t0, t1], [0, 1], { ...CLAMP, easing: OUT });
  const shown = Math.round(m.value * p).toLocaleString("en-US");
  const settle = interpolate(frame, [t1, t1 + 8], [1.06, 1], CLAMP);
  return (
    <>
    <Pool x={B.x + B.w * 0.15} y={B.y} w={B.w * 0.7} h={B.h} alpha={alpha} strength={0.55} />
    <div style={{ position: "absolute", left: B.x, top: B.y, width: B.w, height: B.h, textAlign: "center", color: PAPER, textShadow: SHADOW, opacity: alpha }}>
      <div style={{ fontFamily: "Shippori Mincho", fontWeight: 700, fontSize: B.label, letterSpacing: "0.3em", lineHeight: 1.3, marginRight: "-0.3em" }}>{m.label}</div>
      <div style={{ fontFamily: "Cormorant", fontStyle: "italic", fontWeight: 600, fontSize: B.num, lineHeight: 1.02, fontVariantNumeric: "tabular-nums lining-nums", transform: `scale(${p >= 1 ? settle : 1})` }}>
        {shown}
        <span style={{ fontSize: B.num * 0.42, marginLeft: 12 }}>{m.unit}</span>
      </div>
      <div style={{ position: "relative", height: 20, margin: "4px auto 0", width: "70%", overflow: "hidden", opacity: 0.85 }}>
        <div
          style={{
            position: "absolute",
            left: -60,
            right: -60,
            top: 0,
            height: 20,
            backgroundImage: `repeating-linear-gradient(90deg, ${PAPER} 0 3px, transparent 3px 30px)`,
            transform: `translateX(${-((p * m.value * 0.6) % 30)}px)`,
          }}
        />
      </div>
      <div style={{ fontFamily: "Cormorant", fontStyle: "italic", fontWeight: 500, fontSize: B.en, lineHeight: 1.3, opacity: interpolate(frame, [t1 - 6, t1 + 8], [0, 1], CLAMP) }}>{beat.en}</div>
    </div>
    </>
  );
};
