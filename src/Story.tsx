/**
 * FILE: src/Story.tsx
 * PURPOSE: The house reel: graded shots, a reversal hook, proof lines, an end card.
 * OVERVIEW: Shots cross-dissolve over 8 frames and push in a little. Words come
 *           from the website's SSOT lines (reversal-lines.ts, place-line.ts).
 *           Japanese hook is vertical Shippori Mincho on tall canvases, with the
 *           English in Cormorant italic. No boxes behind text, a soft shadow and
 *           a low gradient carry legibility.
 * DEPENDENCIES: remotion, shared/story-layout.mjs, public/fonts
 * USAGE: compositions Story-9x16, Story-4x5, Story-16x9; props from py/studio/reels.py
 * NOTES: Positions come from storyLayout so test/story.test.mjs can check the safe zone.
 *        `look` (film, punch, split, ember) and `recipe` (countdown, timeline, pov, altitude) come from
 *        src/looks.tsx; without them this is the house reel, unchanged.
 *        `typeKit`, `palette` and `motion` (src/typekit.ts, shared/type-kits.json) dress the words: type pairing,
 *        colours, how they arrive. Missing: Shippori Mincho and Cormorant on paper, typed in, as before.
 */
import React from "react";
import {
  AbsoluteFill,
  Audio,
  Easing,
  OffthreadVideo,
  Sequence,
  continueRender,
  delayRender,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { lineBox, storyLayout } from "../shared/story-layout.mjs";
import { enFont, kitOf, motionOf, paletteOf, useKitFonts, type Kit, type Motion, type Palette } from "./typekit";
import { spokenStates } from "../shared/spoken.mjs";
import {
  EmberOverlay, FilmOverlay, HoldShot, ImpactShot, JumpShot, KickerLine, LettersOpen, LoopTail, Meter, MirrorShot, MonoShot, MoveShot, Numeral, OVERLAP, PrintShot, PulseShot, StepShot, PunchFlash, PunchShot, Rail, SplitShots, TypedHook, Weave,
  cutFrames, isMoveLook, parseMeter, type Kicker, type Look, type Recipe,
} from "./looks";

const PAPER = "#faf8f1";
/* Word-by-word captions: the word being said is warm amber, words still to come are dimmed, said words are paper. */
const SAYING = "#f4c66b";
const sayStyle = (state: string | undefined, accent = SAYING): React.CSSProperties =>
  state === "now" ? { color: accent } : state === "next" ? { opacity: 0.58 } : {};
/* A reel's type pairing, colours and word motion (src/typekit.ts, shared/type-kits.json); the house ones by default. */
type Dress = { k: Kit; p: Palette; m: Motion };
const DressCtx = React.createContext<Dress>({ k: kitOf(), p: paletteOf(), m: motionOf() });
const useDress = () => React.useContext(DressCtx);
/** A line's text with each character styled by whether the voice has said it (plain text when not spoken). */
const SpokenText: React.FC<{ text: string; spoken?: { from: number; to: number } }> = ({ text, spoken }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { p } = useDress();
  const states = spokenStates(text, spoken, frame / fps);
  if (!states) return <>{text}</>;
  return <>{[...text].map((ch, k) => (ch === "\n" ? "\n" : <span key={k} style={sayStyle(states[k], p.accent)}>{ch}</span>))}</>;
};
const MOSS = "#4d6b52";
const SHADOW = "0 2px 22px rgba(0,0,0,0.55), 0 1px 3px rgba(0,0,0,0.5)";
const FADE = 8;

const fontHandle = delayRender("fonts");
Promise.all([
  new FontFace("Shippori Mincho", `url(${staticFile("fonts/ShipporiMincho-Bold.ttf")})`, { weight: "700" }).load(),
  new FontFace("Shippori Mincho", `url(${staticFile("fonts/ShipporiMincho-Medium.ttf")})`, { weight: "500" }).load(),
  new FontFace("Cormorant", `url(${staticFile("fonts/CormorantGaramond-Italic.ttf")})`, { style: "italic", weight: "300 700" }).load(),
])
  .then((faces) => {
    // FontFaceSet.add is in every browser Remotion renders with; the "dom" types in use here leave it out.
    faces.forEach((f) => (document.fonts as unknown as { add(face: FontFace): void }).add(f));
    continueRender(fontHandle);
  })
  .catch(() => continueRender(fontHandle));

export type StoryShot = {
  src: string;
  durationSec: number;
  push?: number;
  /** A time-of-day or season mark read from the clip's capture data (朝 昼 夕 夜 / 春 夏 秋 冬). */
  label?: string;
  labelEn?: string;
  /** The source was shot upright (split look picks the grade that is not blur-filled). */
  portrait?: boolean;
  /** Opening shot only: a transparent cut-out of its subject, drawn over the headline (Behind). */
  fg?: string;
};
/** A second picture track (V2, py/studio/layers.py): a B-roll cutaway over a running shot, or a paper-print inset. */
export type StoryLayer = {
  src: string;
  atSec: number;
  durationSec: number;
  kind: "cutaway" | "inset";
  /** Inset only: where it sits, as fractions of the frame, and its tilt in degrees. */
  rect?: { x: number; y: number; w: number; h: number };
  tilt?: number;
};
export type StoryBeat = {
  kind: "hook" | "line" | "end";
  ja: string;
  en: string;
  startSec: number;
  endSec: number;
  /** Which side a line sits on: the build picks the side of the shot where the picture is quiet. */
  side?: "left" | "right";
  /** Countdown recipe: this line's number (3, 2, 1). */
  n?: number;
  /** Read aloud by the reel's voice from..to (seconds): the words light up as they are said (shared/spoken.mjs). */
  spoken?: { from: number; to: number };
};
export type TextStyle = "column" | "centre" | "lower" | "split";
export type StoryProps = {
  shots9x16: StoryShot[];
  shots16x9: StoryShot[];
  /** V2 layers per size (empty or missing: one picture track, as before). */
  layers9x16?: StoryLayer[];
  layers16x9?: StoryLayer[];
  beats: StoryBeat[];
  handle: string;
  /** Where the headline and lines live (shared/story-layout.mjs). */
  style?: TextStyle;
  /** Real ambience from a ranch clip, under every shot so the cuts do not drop the sound. */
  bed?: { src: string; volume: number } | null;
  /** Picture look and word recipe (src/looks.tsx, shared/looks.json). */
  look?: Look | null;
  recipe?: Recipe | null;
  /** A short framing label shown with the headline; guard-checked by the assembler. */
  kicker?: Kicker | null;
  /** End on the opening frame so a replay has no seam. */
  loop?: boolean;
  /** Type pairing, colours and how the words arrive (shared/type-kits.json); missing = the house ones. */
  typeKit?: string | null;
  palette?: string | null;
  motion?: string | null;
};

const ShotLayer: React.FC<{ shot: StoryShot; frames: number; first: boolean; look?: Look | null; index: number; len: number; last: boolean; start: number }> = ({ shot, frames, first, look, index, len, last, start }) => {
  const frame = useCurrentFrame();
  if (look === "punch") return <PunchShot shot={shot} frames={frames} index={index} />;
  if (look && isMoveLook(look)) return <MoveShot shot={shot} len={len} index={index} look={look} first={first} last={last} />;
  if (look === "jump") return <JumpShot shot={shot} frames={frames} index={index} />;
  if (look === "pulse") return <PulseShot shot={shot} frames={frames} start={start} />;
  if (look === "mono") return <MonoShot shot={shot} frames={frames} first={first} fade={FADE} />;
  if (look === "print") return <PrintShot shot={shot} len={len} index={index} first={first} />;
  if (look === "steps") return <StepShot shot={shot} frames={frames} />;
  if (look === "hold") return <HoldShot shot={shot} frames={frames} />;
  if (look === "mirror") return <MirrorShot shot={shot} frames={frames} index={index} first={first} fade={FADE} />;
  if (look === "impact") return <ImpactShot shot={shot} frames={frames} index={index} />;
  const opacity = first ? 1 : interpolate(frame, [0, FADE], [0, 1], { extrapolateRight: "clamp" });
  const push = shot.push ?? 0.05;
  const scale = interpolate(frame, [0, frames], [1, 1 + push], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ opacity }}>
      <OffthreadVideo
        src={staticFile(shot.src)}
        volume={0.7}
        style={{ width: "100%", height: "100%", objectFit: "cover", transform: `scale(${scale})` }}
      />
    </AbsoluteFill>
  );
};

/* V2. A cutaway comes in almost as a hard cut (3 frames) and leaves the same way; it is silent, so the base shot's
   own sound runs under it and the cut back reads as an L-cut. An inset is a tilted paper print that settles in. */
const LayerClip: React.FC<{ layer: StoryLayer; frames: number }> = ({ layer, frames }) => {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  if (layer.kind === "cutaway") {
    const a = Math.min(interpolate(frame, [0, 3], [0, 1], CLAMP_BOTH), interpolate(frame, [frames - 3, frames], [1, 0], CLAMP_BOTH));
    const scale = interpolate(frame, [0, frames], [1.06, 1.0], CLAMP_BOTH);
    return (
      <AbsoluteFill style={{ opacity: a }}>
        <OffthreadVideo src={staticFile(layer.src)} muted style={{ width: "100%", height: "100%", objectFit: "cover", transform: `scale(${scale})` }} />
      </AbsoluteFill>
    );
  }
  const r = layer.rect ?? { x: 0.06, y: 0.13, w: 0.46, h: 0.3 };
  const pad = Math.round(Math.min(width, height) * 0.014);
  const settle = spring({ frame, fps, config: { damping: 14, stiffness: 140 } });
  const out = interpolate(frame, [frames - 6, frames], [1, 0], CLAMP_BOTH);
  const tilt = (layer.tilt ?? 0) + interpolate(settle, [0, 1], [(layer.tilt ?? 0) >= 0 ? 6 : -6, 0]);
  const w = r.w * width, h = Math.min(r.h * height, w * 1.25);
  return (
    <div
      style={{
        position: "absolute", left: r.x * width, top: r.y * height, width: w, height: h + pad * 3,
        background: "#f7f4ec", padding: pad, paddingBottom: pad * 4, boxSizing: "border-box",
        boxShadow: "0 18px 40px rgba(0,0,0,0.45), 0 2px 6px rgba(0,0,0,0.35)",
        transform: `rotate(${tilt.toFixed(2)}deg) scale(${interpolate(settle, [0, 1], [0.86, 1]).toFixed(3)})`,
        opacity: Math.min(interpolate(frame, [0, 5], [0, 1], CLAMP_BOTH), out),
      }}
    >
      <OffthreadVideo src={staticFile(layer.src)} muted style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
    </div>
  );
};
const CLAMP_BOTH = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const LayerTrack: React.FC<{ layers: StoryLayer[] }> = ({ layers }) => {
  const { fps } = useVideoConfig();
  return (
    <>
      {layers.map((l, i) => {
        const frames = Math.max(1, Math.round(l.durationSec * fps));
        return (
          <Sequence key={i} from={Math.round(l.atSec * fps)} durationInFrames={frames}>
            <LayerClip layer={l} frames={frames} />
          </Sequence>
        );
      })}
    </>
  );
};

/** A soft dark pool behind words, so they hold on snow and sky. Not a box: it fades to nothing. */
const Scrim: React.FC<{ x: number; y: number; w: number; h: number; alpha: number; strength?: number }> = ({ x, y, w, h, alpha, strength = 0.5 }) => (
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

function useBeatProgress(beat: StoryBeat) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const inT = interpolate(t, [beat.startSec, beat.startSec + 0.5], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const outT = interpolate(t, [beat.endSec - 0.35, beat.endSec], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return { t, alpha: Math.min(inT, outT), live: t >= beat.startSec && t < beat.endSec };
}

/* How one letter of the headline arrives (motion): typed (the house: one after another, rising a little), lines that
   rise together, letters that pop, letters that come into focus, or a wipe across each line (wipeClip). */
const CLAMP = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
function letterIn(m: Motion, frame: number, start: number, index: number, line: number): { opacity: number; transform?: string; filter?: string } {
  if (m === "wipe") return { opacity: 1 };
  if (m === "rise") {
    const a = interpolate(frame, [start + line * 7, start + line * 7 + 14], [0, 1], { ...CLAMP, easing: Easing.out(Easing.cubic) });
    return { opacity: a, transform: `translateY(${(1 - a) * 48}px)` };
  }
  if (m === "pop") {
    const a = interpolate(frame, [start + index * 1.6, start + index * 1.6 + 9], [0, 1], CLAMP);
    return { opacity: Math.min(1, a * 2), transform: `scale(${interpolate(a, [0, 0.7, 1], [0.3, 1.12, 1])})` };
  }
  if (m === "blur") {
    const a = interpolate(frame, [start + index * 1.2, start + index * 1.2 + 14], [0, 1], CLAMP);
    return { opacity: a, filter: a < 1 ? `blur(${(1 - a) * 14}px)` : undefined };
  }
  const a = interpolate(frame, [start + index * 2.2, start + index * 2.2 + 10], [0, 1], CLAMP);
  return { opacity: a, transform: `translateY(${interpolate(a, [0, 1], [14, 0])}px)` };
}
const wipeClip = (frame: number, from: number, vertical: boolean) => {
  const w = interpolate(frame, [from, from + 16], [0, 100], { ...CLAMP, easing: Easing.inOut(Easing.cubic) });
  return vertical ? `inset(0 -20% ${100 - w}% -20%)` : `inset(-20% ${100 - w}% -20% 0)`;
};

const Hook: React.FC<{ beat: StoryBeat; style: TextStyle }> = ({ beat, style }) => {
  const { width, height, fps } = useVideoConfig();
  const frame = useCurrentFrame();
  const { alpha, live } = useBeatProgress(beat);
  const { k, p, m } = useDress();
  if (!live) return null;
  const columns = beat.ja.split("\n");
  const L = storyLayout(width, height, columns, style);
  const textAlign = L.vertical ? undefined : (L.hookAlign as "left" | "right" | "center");
  const enAlign = L.vertical ? (L.hookEn.x > L.safe.x + 40 ? "right" : "left") : textAlign;
  const startFrame = beat.startSec * fps;
  const said = spokenStates(beat.ja, beat.spoken, frame / fps);
  let index = 0;
  let at = 0;  // code point index in beat.ja (line breaks count), for the spoken state
  return (
    <>
      <Scrim x={L.hook.x} y={L.hook.y} w={L.hook.w} h={L.hook.h} alpha={alpha} strength={0.42} />
      <Scrim x={L.hookEn.x} y={L.hookEn.y} w={L.hookEn.w} h={L.hookEn.h * 0.7} alpha={alpha} strength={0.5} />
      <div
        style={{
          position: "absolute",
          left: L.hook.x,
          top: L.hook.y,
          width: L.hook.w,
          height: L.hook.h,
          writingMode: L.vertical ? "vertical-rl" : "horizontal-tb",
          fontFamily: k.jaFamily,
          fontWeight: k.hookWeight,
          fontSize: L.hook.font,
          lineHeight: L.vertical ? 1.32 : 1.3,
          letterSpacing: L.vertical ? "0.08em" : "0.04em",
          textAlign,
          color: p.text,
          textShadow: SHADOW,
          opacity: interpolate(alpha, [0, 1], [0, 1]),
        }}
      >
        {columns.map((col, c) => (
          <div key={c} style={m === "wipe" ? { clipPath: wipeClip(frame, startFrame + 4 + c * 7, L.vertical) } : undefined}>
            {[...col].map((ch, j) => {
              const state = said?.[at + j];
              if (j === [...col].length - 1) at += [...col].length + 1;
              const { opacity, transform, filter } = letterIn(m, frame, startFrame + 4, index++, c);
              return (
                <span
                  key={index}
                  style={{
                    display: "inline-block",
                    opacity: opacity * (state === "next" ? 0.58 : 1),
                    color: state === "now" ? p.accent : undefined,
                    transform,
                    filter,
                  }}
                >
                  {ch}
                </span>
              );
            })}
          </div>
        ))}
      </div>
      <div
        style={{
          position: "absolute",
          left: L.hookEn.x,
          top: L.hookEn.y,
          width: L.hookEn.w,
          ...enFont(k),
          fontSize: L.hookEn.font * k.enScale,
          lineHeight: 1.15,
          textAlign: enAlign,
          color: p.enColor,
          textShadow: SHADOW,
          opacity: interpolate(frame, [startFrame + 14, startFrame + 28], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) * alpha,
        }}
      >
        {beat.en}
      </div>
    </>
  );
};

/* A proof line arrives the reel's way: rising (the house), popping a little, coming into focus, or wiped on. */
function lineIn(m: Motion, alpha: number, rise: number, align: string): React.CSSProperties {
  if (m === "pop") return { transform: `scale(${interpolate(alpha, [0, 1], [0.9, 1])})`, transformOrigin: align === "right" ? "right bottom" : align === "center" ? "center" : "left bottom" };
  if (m === "blur") return { filter: alpha < 1 ? `blur(${(1 - alpha) * 10}px)` : undefined };
  if (m === "wipe") return { clipPath: align === "right" ? `inset(-10% -10% -10% ${(1 - alpha) * 100}%)` : `inset(-10% ${(1 - alpha) * 100}% -10% -10%)` };
  return { transform: `translateY(${rise}px)` };
}

const Line: React.FC<{ beat: StoryBeat; style: TextStyle }> = ({ beat, style }) => {
  const { width, height } = useVideoConfig();
  const { alpha, live } = useBeatProgress(beat);
  const { k, p, m } = useDress();
  if (!live) return null;
  const L = storyLayout(width, height, undefined, style);
  const B = lineBox(L, beat.side);
  const top = B.y < L.safe.y + (L.safe.bottom - L.safe.y) / 3;
  const rise = interpolate(alpha, [0, 1], [top ? -18 : 18, 0]);
  const items = B.align === "right" ? "flex-end" : B.align === "center" ? "center" : "flex-start";
  return (
    <>
    <Scrim x={B.x + (B.align === "right" ? B.w * 0.2 : 0)} y={B.y + (top ? 0 : B.h * 0.25)} w={B.w * 0.8} h={B.h * 0.75} alpha={alpha} strength={0.55} />
    <div
      style={{
        position: "absolute",
        left: B.x,
        top: B.y,
        width: B.w,
        height: B.h,
        display: "flex",
        flexDirection: "column",
        justifyContent: top ? "flex-start" : "flex-end",
        alignItems: items,
        textAlign: B.align as "left" | "right" | "center",
        opacity: alpha,
        ...lineIn(m, alpha, rise, B.align),
      }}
    >
      <div style={{ width: 56, height: 3, background: p.bar, opacity: 0.85, marginBottom: 18, boxShadow: SHADOW }} />
      <div
        style={{
          fontFamily: k.jaFamily,
          fontWeight: k.lineWeight,
          fontSize: L.line.font,
          lineHeight: 1.4,
          color: p.text,
          textShadow: SHADOW,
          letterSpacing: "0.04em",
          whiteSpace: "pre-line",
        }}
      >
        <SpokenText text={beat.ja} spoken={beat.spoken} />
      </div>
      <div
        style={{
          ...enFont(k),
          fontSize: L.line.enFont * k.enScale,
          lineHeight: 1.35,
          color: p.enColor,
          opacity: 0.92,
          textShadow: SHADOW,
          marginTop: 4,
        }}
      >
        {beat.en}
      </div>
    </div>
    </>
  );
};

const End: React.FC<{ beat: StoryBeat; handle: string }> = ({ beat, handle }) => {
  const { width, height } = useVideoConfig();
  const { alpha, live } = useBeatProgress(beat);
  const { k, p } = useDress();
  if (!live) return null;
  const L = storyLayout(width, height);
  const big = (L.vertical ? 132 : 112) * k.enScale;
  const [kanji, latin] = beat.ja.includes("Work&Camp") ? [beat.ja.replace("Work&Camp", ""), "Work & Camp"] : [beat.ja, beat.en];
  return (
    <>
      <AbsoluteFill style={{ background: "rgba(20,22,18,0.38)", opacity: alpha }} />
      <div
        style={{
          position: "absolute",
          left: L.end.x,
          top: L.end.y,
          width: L.end.w,
          height: L.end.h,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          color: p.text,
          textShadow: SHADOW,
          opacity: alpha,
        }}
      >
        <div style={{ fontFamily: k.jaFamily, fontWeight: k.lineWeight, fontSize: 40, letterSpacing: "0.5em", marginRight: "-0.5em" }}>
          {kanji}
        </div>
        <div style={{ ...enFont(k), fontSize: big, lineHeight: 1.05, marginTop: 6 }}>
          {latin}
        </div>
        {handle ? (
          <>
            <div style={{ width: 64, height: 2, background: p.rule, margin: "22px 0 18px", boxShadow: "0 0 0 1px rgba(250,248,241,0.6)" }} />
            <div style={{ ...enFont(k), textTransform: undefined, fontSize: 38 * Math.min(1, k.enScale), letterSpacing: "0.06em" }}>{handle}</div>
          </>
        ) : null}
      </div>
    </>
  );
};

/* The headline behind the subject: the opening shot's own subject (a transparent cut-out, py/studio/ai.py behind) is
   drawn again over the words, moving exactly as ShotLayer moves that shot (same push), so the words sit behind it. */
const Behind: React.FC<{ shot: StoryShot; frames: number }> = ({ shot, frames }) => {
  const frame = useCurrentFrame();
  const push = shot.push ?? 0.05;
  const scale = interpolate(frame, [0, frames], [1, 1 + push], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <OffthreadVideo src={staticFile(shot.fg!)} muted transparent style={{ width: "100%", height: "100%", objectFit: "cover", transform: `scale(${scale})` }} />
    </AbsoluteFill>
  );
};

export const Story: React.FC<StoryProps> = ({ shots9x16, shots16x9, layers9x16 = [], layers16x9 = [], beats, handle, bed, style = "column", look = null, recipe = null, kicker = null, loop = false, typeKit = null, palette = null, motion = null }) => {
  const { fps, width, height } = useVideoConfig();
  const dress = React.useMemo(() => ({ k: kitOf(typeKit), p: paletteOf(palette), m: motionOf(motion) }), [typeKit, palette, motion]);
  useKitFonts(dress.k);
  const shots = width > height ? shots16x9 : shots9x16;
  const other = width > height ? shots9x16 : shots16x9;
  const fade = (look ? OVERLAP[look] : undefined) ?? FADE; // punch, jump and pulse cut hard; the others overlap by their own length
  let from = 0;
  const layers =
    look === "split" ? (
      <SplitShots shots={shots} other={other} fade={fade} />
    ) : (
      shots.map((shot, i) => {
        const frames = Math.round(shot.durationSec * fps);
        const start = i === 0 ? 0 : from - fade;
        const node = (
          <Sequence key={i} from={start} durationInFrames={frames + (i === 0 ? 0 : fade)}>
            <ShotLayer shot={shot} frames={frames + fade} first={i === 0} look={look} index={i} len={frames + (i === 0 ? 0 : fade)} last={i === shots.length - 1} start={start} />
          </Sequence>
        );
        from = start + frames + (i === 0 ? 0 : fade);
        return node;
      })
    );
  const total = shots.reduce((a, s) => a + Math.round(s.durationSec * fps), 0);
  const counted = beats.filter((b) => b.kind === "line" && b.n).length;
  return (
    <DressCtx.Provider value={dress}>
    <AbsoluteFill style={{ background: "#14160f" }}>
      {bed ? <Audio src={staticFile(bed.src)} volume={bed.volume} /> : null}
      {look === "film" ? <Weave>{layers}</Weave> : layers}
      {(width > height ? layers16x9 : layers9x16).length ? <LayerTrack layers={width > height ? layers16x9 : layers9x16} /> : null}
      {loop && look !== "split" && shots.length > 1 ? <LoopTail first={shots[0]} total={total} /> : null}
      {look === "film" ? <FilmOverlay cuts={cutFrames(shots, fps)} /> : null}
      {look === "ember" ? <EmberOverlay /> : null}
      {look === "punch" ? <PunchFlash beats={beats} /> : null}
      <AbsoluteFill
        style={{
          background:
            "linear-gradient(180deg, rgba(0,0,0,0.22) 0%, rgba(0,0,0,0) 24%, rgba(0,0,0,0) 44%, rgba(0,0,0,0.5) 72%, rgba(0,0,0,0.55) 100%)",
        }}
      />
      {recipe === "timeline" ? <Rail shots={shots} beats={beats} style={style} /> : null}
      {beats.map((beat, i) => {
        if (beat.kind === "hook") {
          if (recipe === "pov") return <TypedHook key={i} beat={beat} kicker={kicker} style={style} />;
          if (recipe === "altitude" && parseMeter(beat.ja)) return <Meter key={i} beat={beat} />;
          return (
            <React.Fragment key={i}>
              {kicker ? <KickerLine kicker={kicker} beat={beat} style={style} /> : null}
              <Hook beat={beat} style={style} />
            </React.Fragment>
          );
        }
        if (beat.kind === "line") {
          return (
            <React.Fragment key={i}>
              {recipe === "countdown" && beat.n ? <Numeral beat={beat} style={style} of={counted} /> : null}
              <Line beat={beat} style={style} />
            </React.Fragment>
          );
        }
        return <End key={i} beat={beat} handle={handle} />;
      })}
      {shots[0]?.fg && width <= height && (look === null || look === "ember") ? (
        <Sequence from={0} durationInFrames={Math.round(shots[0].durationSec * fps)}>
          <Behind shot={shots[0]} frames={Math.round(shots[0].durationSec * fps) + fade} />
        </Sequence>
      ) : null}
      {look === "letters" && beats.find((b) => b.kind === "hook") ? <LettersOpen text={beats.find((b) => b.kind === "hook")!.ja} /> : null}
    </AbsoluteFill>
    </DressCtx.Provider>
  );
};

export function storyFrames(props: StoryProps, fps: number, landscape: boolean): number {
  const shots = landscape ? props.shots16x9 : props.shots9x16;
  const total = shots.reduce((sum, s) => sum + Math.round(s.durationSec * fps), 0);
  return Math.max(fps, total);
}
