/**
 * FILE: src/ProductPreview.tsx
 * PURPOSE: A product video from an app's release kit (docs/product-kit.md): the app's screens in a drawn device (or full
 *          screen for App Store previews), slow pans and push-ins, a before -> after reveal where a screen has both,
 *          a recording playing inside the device, captions from the changelog, in the brand's colours and font,
 *          and an end card.
 * OVERVIEW: Every number comes from the timeline py/studio/product.py plans (props): scene frames, sizes, captions,
 *           colours. This file only draws. One continuous background (the brand's colour with two slow glows) sits
 *           under every scene, so a cut between scenes is a dissolve of the device, never a flash.
 * DEPENDENCIES: remotion (Img, OffthreadVideo, Freeze, staticFile, delayRender), public/fonts (OFL), the kit's files
 *               under product-kits/<name>/files (a link py/studio/product.py makes in the Remotion public folder)
 * USAGE: composition "ProductPreview" (src/Root.tsx); size, fps and length come from props.preset and
 *        props.durationInFrames, and py/studio/product.py checks the rendered file against shared/product-presets.json.
 * NOTES: Device frames are drawn here (no Apple or Google artwork). App Store presets (frame "none") show the app itself
 *        full screen with text over it, as App Review Guideline 2.3.4 asks. Nothing from a kit is run: its pictures and
 *        recordings are shown, its font file is loaded under the name "KitBrand", its colours were checked by Python.
 */
import React, { useEffect, useState } from "react";
import { AbsoluteFill, Easing, Freeze, Img, OffthreadVideo, Sequence, cancelRender, continueRender, delayRender, interpolate, staticFile, useCurrentFrame } from "remotion";

export type PvDevice = "phone" | "tablet" | "desktop";
export type PvScene = {
  kind: "compare" | "screen" | "recording"; id: string; surface: string; device: PvDevice; platform: string;
  src: string; before: string | null; w: number; h: number; vw?: number; vh?: number; focus: { x: number; y: number };
  caption: string; from: number; dur: number; clipFrames?: number;
};
export type PvFace = { family: string; src: string; weight: string; style: string };
export type ProductProps = {
  preset: { id: string; label: string; width: number; height: number; fps: number; frame: "none" | "device"; orientation: "portrait" | "landscape" | "square"; store: string };
  durationInFrames: number; seconds: number; overlap: number;
  app: { name: string; tagline: string; host: string; version: string; cta: string; stores: string[] };
  brand: { background: string; text: string; primary: string; accent: string; onAccent: string; family: string };
  fonts: PvFace[]; logo: string | null;
  labels: { before: string; after: string; news: string };
  title: { from: number; dur: number } | null;
  scenes: PvScene[];
  news: { from: number; dur: number; lines: string[] } | null;
  end: { from: number; dur: number; kind: "card" | "overlay" };
  warnings?: string[];
};

export const emptyProduct: ProductProps = {
  preset: { id: "social-9x16", label: "Social 9:16", width: 1080, height: 1920, fps: 30, frame: "device", orientation: "portrait", store: "social" },
  durationInFrames: 90, seconds: 3, overlap: 15,
  app: { name: "Your app", tagline: "", host: "", version: "", cta: "Get it", stores: [] },
  brand: { background: "#0d0f14", text: "#f5f6f8", primary: "#7c9cff", accent: "#7c9cff", onAccent: "#111111", family: "DM Sans" },
  fonts: [], logo: null, labels: { before: "Before", after: "Now", news: "What's new" },
  title: null, scenes: [], news: null, end: { from: 0, dur: 90, kind: "card" },
};

const CLAMP = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const EASE = Easing.bezier(0.22, 1, 0.36, 1);       // arrivals: fast in, long settle
const GLIDE = Easing.bezier(0.65, 0, 0.35, 1);      // the reveal's wipe: even in and out
const ease = (f: number, a: number, b: number, from = 0, to = 1, e = EASE) => interpolate(f, [a, b], [from, to], { ...CLAMP, easing: e });

/* ---------- colour helpers: everything is mixed from the kit's four colours ---------- */
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const mix = (a: string, b: string, t: number) => {
  const [x, y] = [rgb(a), rgb(b)];
  return `rgb(${x.map((v, i) => Math.round(v + (y[i] - v) * t)).join(",")})`;
};
const alpha = (hex: string, a: number) => `rgba(${rgb(hex).join(",")},${a})`;
const lum = (hex: string) => { const [r, g, b] = rgb(hex); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };

/* ---------- fonts: the kit's own (as "KitBrand") or a bundled face, with DM Sans and Zen Kaku Gothic New behind it ---------- */
const loaded = new Map<string, Promise<void>>();
const useFaces = (faces: PvFace[]) => {
  const [handle] = useState(() => delayRender("product fonts"));
  useEffect(() => {
    const load = (f: PvFace) => {
      const key = `${f.family}|${f.src}|${f.weight}`;
      if (!loaded.has(key)) {
        const face = new FontFace(f.family, `url(${staticFile(f.src)})`, { weight: f.weight, style: f.style });
        // A kit's font that will not load falls back to the bundled faces: the render goes on.
        loaded.set(key, face.load().then((x) => { (document.fonts as unknown as { add: (y: FontFace) => void }).add(x); }, (err) => { console.warn(`font ${f.family}: ${err}`); }));
      }
      return loaded.get(key)!;
    };
    Promise.all(faces.map(load)).then(() => continueRender(handle)).catch((err) => cancelRender(err));
  }, [handle, faces]);
};

/* ---------- where things go, per shape ---------- */
type Box = { x: number; y: number; w: number; h: number };
type Layout = { caption: Box & { align: "left" | "center"; size: number }; device: Box };
function layoutOf(p: ProductProps): Layout {
  const { width: W, height: H, frame, orientation } = p.preset;
  if (frame === "none") return { caption: { x: W * 0.07, y: H * 0.06, w: W * 0.86, h: H * 0.16, align: "center", size: W * 0.054 }, device: { x: 0, y: 0, w: W, h: H } };
  if (orientation === "landscape") return { caption: { x: W * 0.075, y: H * 0.2, w: W * 0.36, h: H * 0.6, align: "left", size: W * 0.034 }, device: { x: W * 0.47, y: H * 0.07, w: W * 0.48, h: H * 0.86 } };
  if (orientation === "square") return { caption: { x: W * 0.08, y: H * 0.065, w: W * 0.84, h: H * 0.17, align: "center", size: W * 0.048 }, device: { x: W * 0.08, y: H * 0.26, w: W * 0.84, h: H * 0.7 } };
  // Portrait social: the words inside the networks' safe zone (shared/spec.json 9x16: from y 269 of 1920), the device below.
  return { caption: { x: W * 0.08, y: H * 0.14, w: W * 0.84, h: H * 0.16, align: "center", size: W * 0.058 }, device: { x: W * 0.1, y: H * 0.33, w: W * 0.8, h: H * 0.62 } };
}

/* A device's outer size for a screen of aspect a (w / h), fitted into a box: the screen, the bezel, the browser bar. */
type Fit = { x: number; y: number; ow: number; oh: number; sw: number; sh: number; bezel: number; bar: number; radius: number; inner: number };
function fitDevice(device: PvDevice, a: number, box: Box): Fit {
  const bezelK = device === "phone" ? 0.034 : device === "tablet" ? 0.03 : 0;
  const barK = device === "desktop" ? 0.052 : 0;
  // In units of the screen's width: outer = (1 + 2b) x (1/a + 2b + bar).
  const uw = 1 + 2 * bezelK, uh = 1 / a + 2 * bezelK + barK;
  const s = Math.min(box.w / uw, box.h / uh);
  const sw = s, sh = s / a, bezel = s * bezelK, bar = s * barK, ow = uw * s, oh = uh * s;
  const radius = device === "phone" ? ow * 0.15 : device === "tablet" ? ow * 0.05 : ow * 0.014;
  return { x: box.x + (box.w - ow) / 2, y: box.y + (box.h - oh) / 2, ow, oh, sw, sh, bezel, bar, radius, inner: Math.max(2, radius - bezel) };
}

/* ---------- the screen's contents: a still that pans to its focus and pushes in, or a recording ---------- */
const Still: React.FC<{ src: string; w: number; h: number; sw: number; sh: number; focus: { x: number; y: number }; f: number; dur: number }> = ({ src, w, h, sw, sh, focus, f, dur }) => {
  // Cover the screen; a picture taller than the screen (a long page) scrolls from its top toward the focus.
  const k = Math.max(sw / w, sh / h);
  const cw = w * k, ch = h * k;
  const t = ease(f, 0, dur, 0, 1, Easing.inOut(Easing.cubic));
  const overY = Math.max(0, ch - sh), overX = Math.max(0, cw - sw);
  const tall = overY > sh * 0.25;
  const y = tall ? -overY * Math.min(1, focus.y * 1.1) * t : -overY * focus.y;
  const x = -overX * focus.x;
  const push = 1 + 0.045 * t;
  const ox = (focus.x * sw).toFixed(1), oy = (tall ? sh * 0.5 : focus.y * sh).toFixed(1);
  return (
    <div style={{ position: "absolute", inset: 0, transform: `scale(${push})`, transformOrigin: `${ox}px ${oy}px` }}>
      <Img src={staticFile(src)} style={{ position: "absolute", left: x, top: y, width: cw, height: ch, display: "block" }} />
    </div>
  );
};

const Clip: React.FC<{ src: string; clipFrames: number; f: number; dur: number }> = ({ src, clipFrames, f, dur }) => {
  const push = 1 + 0.025 * ease(f, 0, dur, 0, 1, Easing.inOut(Easing.cubic));
  const video = <OffthreadVideo src={staticFile(src)} muted style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />;
  return (
    <div style={{ position: "absolute", inset: 0, transform: `scale(${push})` }}>
      {f < clipFrames ? video : <Freeze frame={Math.max(0, clipFrames - 1)}>{video}</Freeze>}
    </div>
  );
};

/* The before -> after reveal: "after" wipes in from the left behind a soft line of light in the accent colour. */
const Reveal: React.FC<{ sc: PvScene; sw: number; sh: number; f: number; accent: string; labels: ProductProps["labels"]; family: string; scale: number }> = ({ sc, sw, sh, f, accent, labels, family, scale }) => {
  const a = Math.round(sc.dur * 0.36), b = Math.round(sc.dur * 0.62);
  const p = ease(f, a, b, 0, 1, GLIDE);
  const edge = p * sw;
  const chip = (text: string, on: number): React.ReactNode => (
    // At the foot of the screen, where an app rarely keeps its title: the label never covers the app's own heading.
    <div style={{ position: "absolute", bottom: sh * 0.045, left: "50%", marginLeft: -sw * 0.14, width: sw * 0.28, textAlign: "center", padding: `${8 * scale}px 0`, borderRadius: 999,
      background: "rgba(10,10,14,0.62)", color: "#fff", fontFamily: family, fontWeight: 650, fontSize: 22 * scale, letterSpacing: "0.04em",
      opacity: on, transform: `translateY(${(1 - on) * -8}px)`, boxShadow: "0 6px 18px rgba(0,0,0,0.25)" }}>{text}</div>
  );
  return (
    <>
      <Still src={sc.before!} w={sc.w} h={sc.h} sw={sw} sh={sh} focus={sc.focus} f={f} dur={sc.dur} />
      <div style={{ position: "absolute", inset: 0, clipPath: `inset(0 ${(100 - p * 100).toFixed(3)}% 0 0)` }}>
        <Still src={sc.src} w={sc.w} h={sc.h} sw={sw} sh={sh} focus={sc.focus} f={f} dur={sc.dur} />
      </div>
      {p > 0 && p < 1 ? (
        <div style={{ position: "absolute", top: 0, bottom: 0, left: edge - 1.5 * scale, width: 3 * scale, background: "#fff",
          boxShadow: `0 0 ${24 * scale}px ${6 * scale}px ${alpha(accent, 0.75)}, 0 0 ${60 * scale}px ${18 * scale}px ${alpha(accent, 0.35)}` }} />
      ) : null}
      {chip(labels.before, 1 - ease(f, a, a + 10))}
      {chip(labels.after, ease(f, b - 6, b + 8))}
    </>
  );
};

/* ---------- the drawn devices ---------- */
const Device: React.FC<{ fit: Fit; device: PvDevice; platform: string; host: string; brand: ProductProps["brand"]; children: React.ReactNode }> = ({ fit, device, platform, host, brand, children }) => {
  const { ow, oh, sw, sh, bezel, bar, radius, inner } = fit;
  const dark = lum(brand.background) < 0.5;
  const shell = device === "desktop" ? mix(brand.background, dark ? "#ffffff" : "#000000", 0.1) : "#0b0b0e";
  const ring = dark ? "rgba(255,255,255,0.16)" : "rgba(0,0,0,0.18)";
  return (
    <div style={{ position: "absolute", left: fit.x, top: fit.y, width: ow, height: oh, borderRadius: radius, background: shell,
      boxShadow: `0 0 0 ${Math.max(1, ow * 0.002)}px ${ring}, 0 ${oh * 0.04}px ${oh * 0.09}px rgba(0,0,0,0.38), 0 ${oh * 0.01}px ${oh * 0.02}px rgba(0,0,0,0.25)` }}>
      {device === "desktop" ? (
        <div style={{ position: "absolute", left: 0, top: 0, width: ow, height: bar, display: "flex", alignItems: "center", gap: bar * 0.22, paddingLeft: bar * 0.45 }}>
          {[0, 1, 2].map((i) => <span key={i} style={{ width: bar * 0.24, height: bar * 0.24, borderRadius: "50%", background: dark ? "rgba(255,255,255,0.28)" : "rgba(0,0,0,0.22)" }} />)}
          {host ? (
            <span style={{ marginLeft: bar * 0.6, padding: `0 ${bar * 0.5}px`, height: bar * 0.56, lineHeight: `${bar * 0.56}px`, borderRadius: bar * 0.28, minWidth: ow * 0.3,
              background: dark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)", color: dark ? "rgba(255,255,255,0.72)" : "rgba(0,0,0,0.6)",
              fontFamily: `"${brand.family}", "DM Sans", sans-serif`, fontSize: bar * 0.32, textAlign: "center" }}>{host}</span>
          ) : null}
        </div>
      ) : null}
      <div style={{ position: "absolute", left: bezel, top: bezel + bar, width: sw, height: sh, borderRadius: device === "desktop" ? `0 0 ${radius}px ${radius}px` : inner,
        overflow: "hidden", background: "#000", isolation: "isolate" }}>
        {children}
      </div>
      {device === "phone" && platform !== "web" ? (
        platform === "android"
          ? <span style={{ position: "absolute", left: ow / 2 - sw * 0.022, top: bezel + sw * 0.03, width: sw * 0.044, height: sw * 0.044, borderRadius: "50%", background: "#050507" }} />
          : <span style={{ position: "absolute", left: ow / 2 - sw * 0.16, top: bezel + sw * 0.028, width: sw * 0.32, height: sw * 0.092, borderRadius: sw * 0.05, background: "#050507" }} />
      ) : null}
      {device === "tablet" ? <span style={{ position: "absolute", left: ow / 2 - bezel * 0.18, top: bezel * 0.41, width: bezel * 0.36, height: bezel * 0.36, borderRadius: "50%", background: "#1b1b20" }} /> : null}
    </div>
  );
};

/* ---------- words: each word rises into place, a short beat after the one before ---------- */
const Words: React.FC<{ text: string; f: number; delay: number; size: number; color: string; family: string; weight?: number; align: "left" | "center"; lh?: number }> = ({ text, f, delay, size, color, family, weight = 720, align, lh = 1.12 }) => {
  const words = /\s/.test(text) ? text.split(/(\s+)/) : [...text];  // a line with no spaces (Japanese) arrives a character at a time
  let n = 0;
  return (
    <div style={{ fontFamily: `"${family}", "DM Sans", "Zen Kaku Gothic New", sans-serif`, fontSize: size, fontWeight: weight, lineHeight: lh, color,
      letterSpacing: "-0.02em", textAlign: align, textWrap: "balance" } as React.CSSProperties}>
      {words.map((w, i) => {
        if (/^\s+$/.test(w)) return <span key={i}>{w}</span>;
        const k = n++;
        const t = ease(f, delay + k * 2.2, delay + k * 2.2 + 16);
        return <span key={i} style={{ display: "inline-block", opacity: t, transform: `translateY(${(1 - t) * size * 0.42}px)`, filter: `blur(${(1 - t) * 6}px)` }}>{w}</span>;
      })}
    </div>
  );
};

const Caption: React.FC<{ sc: PvScene; p: ProductProps; lay: Layout; f: number; out: number }> = ({ sc, p, lay, f, out }) => {
  if (!sc.caption && !sc.surface) return null;
  const { caption: c } = lay;
  const full = p.preset.frame === "none";
  const s = c.size;
  const body = (
    <div style={{ display: "grid", gap: s * 0.32, justifyItems: c.align === "center" ? "center" : "start" }}>
      {sc.surface ? (
        <div style={{ fontFamily: `"${p.brand.family}", "DM Sans", sans-serif`, fontSize: s * 0.34, fontWeight: 700, letterSpacing: "0.16em", textTransform: "uppercase",
          color: full ? "#ffffff" : p.brand.accent, opacity: ease(f, 4, 16) * 0.92 }}>{sc.surface}</div>
      ) : null}
      {sc.caption ? <Words text={sc.caption} f={f} delay={8} size={s} color={full ? "#ffffff" : p.brand.text} family={p.brand.family} align={c.align} /> : null}
    </div>
  );
  const box: React.CSSProperties = { position: "absolute", left: c.x, top: c.y, width: c.w, display: "flex", flexDirection: "column", justifyContent: "center",
    alignItems: c.align === "center" ? "center" : "flex-start", minHeight: c.h, opacity: out };
  if (!full) return <div style={box}>{body}</div>;
  // Full screen (App Store): the words on a soft dark glass over the app's own top, so they read on any screen.
  return (
    <div style={{ ...box, minHeight: 0 }}>
      <div style={{ padding: `${s * 0.5}px ${s * 0.62}px`, borderRadius: s * 0.55, background: "rgba(8,9,12,0.8)", backdropFilter: "blur(18px) saturate(1.2)",
        boxShadow: "0 10px 40px rgba(0,0,0,0.28)", opacity: ease(f, 0, 10), maxWidth: c.w }}>{body}</div>
    </div>
  );
};

/* ---------- one scene: the device (or the full screen) with its words ---------- */
const Scene: React.FC<{ sc: PvScene; i: number; p: ProductProps; lay: Layout; scale: number }> = ({ sc, i, p, lay, scale }) => {
  const f = useCurrentFrame();
  const ov = p.overlap;
  const full = p.preset.frame === "none";
  const enter = ease(f, 0, ov + 6);
  const leave = full ? 1 : 1 - ease(f, sc.dur - ov, sc.dur, 0, 1, Easing.in(Easing.quad));
  // The device's screen has the viewport's shape (a long page capture scrolls inside it); a recording keeps its own.
  const aspect = sc.kind !== "recording" && sc.vw && sc.vh ? sc.vw / sc.vh : sc.w / sc.h;
  const fit = full ? null : fitDevice(sc.device, aspect, lay.device);
  const sw = fit ? fit.sw : p.preset.width, sh = fit ? fit.sh : p.preset.height;
  const screen = sc.kind === "compare" ? <Reveal sc={sc} sw={sw} sh={sh} f={f} accent={p.brand.accent} labels={p.labels} family={p.brand.family} scale={scale} />
    : sc.kind === "recording" ? <Clip src={sc.src} clipFrames={sc.clipFrames || sc.dur} f={f} dur={sc.dur} />
    : <Still src={sc.src} w={sc.w} h={sc.h} sw={sw} sh={sh} focus={sc.focus} f={f} dur={sc.dur} />;
  if (full) {
    return (
      <AbsoluteFill style={{ opacity: enter }}>
        {screen}
        <AbsoluteFill style={{ background: "linear-gradient(180deg, rgba(0,0,0,0.28) 0%, rgba(0,0,0,0) 26%)" }} />
        <Caption sc={sc} p={p} lay={lay} f={f} out={1 - ease(f, sc.dur - ov - 4, sc.dur - 2)} />
      </AbsoluteFill>
    );
  }
  // A slow turn in alternating directions: the device settles toward the viewer through the scene.
  const side = i % 2 === 0 ? 1 : -1;
  const turn = interpolate(f, [0, sc.dur], [5.5 * side, 1.5 * side], CLAMP);
  const tilt = interpolate(f, [0, sc.dur], [2.2, 0.6], CLAMP);
  const lift = (1 - enter) * p.preset.height * 0.05 - (1 - leave) * p.preset.height * 0.02;
  const grow = 0.94 + 0.06 * enter + 0.02 * (1 - leave);
  return (
    <AbsoluteFill style={{ opacity: Math.min(enter, leave) }}>
      <div style={{ position: "absolute", left: fit!.x + fit!.ow * 0.12, top: fit!.y + fit!.oh * 0.97, width: fit!.ow * 0.76, height: fit!.oh * 0.06, borderRadius: "50%",
        background: "rgba(0,0,0,0.45)", filter: `blur(${fit!.oh * 0.03}px)`, opacity: 0.55 * enter }} />
      <AbsoluteFill style={{ transform: `perspective(${p.preset.width * 2.6}px) translateY(${lift}px) rotateY(${turn}deg) rotateX(${tilt}deg) scale(${grow})`,
        transformOrigin: `${fit!.x + fit!.ow / 2}px ${fit!.y + fit!.oh / 2}px` }}>
        <Device fit={fit!} device={sc.device} platform={sc.platform} host={p.app.host} brand={p.brand}>{screen}</Device>
      </AbsoluteFill>
      <Caption sc={sc} p={p} lay={lay} f={f} out={leave} />
    </AbsoluteFill>
  );
};

/* ---------- the background: the brand colour with two slow glows, the same under every scene ---------- */
const Backdrop: React.FC<{ p: ProductProps }> = ({ p }) => {
  const f = useCurrentFrame();
  const { width: W, height: H } = p.preset;
  const t = f / Math.max(1, p.durationInFrames);
  const b = p.brand;
  const a = { x: 22 + 10 * Math.sin(t * Math.PI * 2), y: 12 + 6 * Math.cos(t * Math.PI * 2) };
  const c = { x: 80 - 8 * Math.sin(t * Math.PI * 2 + 1), y: 88 - 6 * Math.cos(t * Math.PI * 2 + 1) };
  const dark = lum(b.background) < 0.5;
  return (
    <AbsoluteFill style={{ background: b.background }}>
      <AbsoluteFill style={{ background: `radial-gradient(${Math.max(W, H) * 0.62}px circle at ${a.x}% ${a.y}%, ${alpha(b.accent, dark ? 0.34 : 0.22)} 0%, transparent 70%)` }} />
      <AbsoluteFill style={{ background: `radial-gradient(${Math.max(W, H) * 0.7}px circle at ${c.x}% ${c.y}%, ${alpha(b.primary, dark ? 0.24 : 0.16)} 0%, transparent 72%)` }} />
      <AbsoluteFill style={{ background: `radial-gradient(130% 90% at 50% 45%, transparent 55%, ${mix(b.background, "#000000", dark ? 0.55 : 0.12)} 100%)`, opacity: 0.7 }} />
    </AbsoluteFill>
  );
};

/* ---------- cards: the opening title, what's new, the end ---------- */
const Logo: React.FC<{ src: string | null; size: number; f: number; delay: number; accent: string }> = ({ src, size, f, delay, accent }) => {
  if (!src) return null;
  const t = ease(f, delay, delay + 20);
  return (
    <div style={{ width: size, height: size, borderRadius: size * 0.225, overflow: "hidden", transform: `scale(${0.82 + 0.18 * t})`, opacity: t,
      boxShadow: `0 ${size * 0.08}px ${size * 0.3}px ${alpha(accent, 0.35)}, 0 ${size * 0.04}px ${size * 0.1}px rgba(0,0,0,0.3)` }}>
      <Img src={staticFile(src)} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
    </div>
  );
};

const Title: React.FC<{ p: ProductProps; dur: number; unit: number }> = ({ p, dur, unit }) => {
  const f = useCurrentFrame();
  const out = 1 - ease(f, dur - p.overlap, dur, 0, 1, Easing.in(Easing.quad));
  const fam = p.brand.family;
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", opacity: out, transform: `translateY(${-(1 - out) * unit * 0.6}px)` }}>
      <div style={{ display: "grid", justifyItems: "center", gap: unit * 0.55, maxWidth: p.preset.width * 0.82, textAlign: "center" }}>
        <Logo src={p.logo} size={unit * 3.2} f={f} delay={0} accent={p.brand.accent} />
        <Words text={p.app.name} f={f} delay={6} size={unit * 1.9} color={p.brand.text} family={fam} weight={760} align="center" lh={1.04} />
        {p.app.tagline ? <div style={{ fontFamily: `"${fam}", "DM Sans", sans-serif`, fontSize: unit * 0.78, color: alpha(p.brand.text, 0.72), opacity: ease(f, 16, 32), fontWeight: 450 }}>{p.app.tagline}</div> : null}
        {p.app.version ? (
          <div style={{ marginTop: unit * 0.2, padding: `${unit * 0.22}px ${unit * 0.6}px`, borderRadius: 999, border: `${Math.max(1, unit * 0.05)}px solid ${alpha(p.brand.accent, 0.7)}`,
            color: p.brand.accent, fontFamily: `"${fam}", "DM Sans", sans-serif`, fontSize: unit * 0.56, fontWeight: 650, letterSpacing: "0.06em", opacity: ease(f, 22, 36) }}>
            {`${p.labels.news} · ${p.app.version}`}
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};

const News: React.FC<{ p: ProductProps; lines: string[]; dur: number; unit: number }> = ({ p, lines, dur, unit }) => {
  const f = useCurrentFrame();
  const enter = ease(f, 0, p.overlap + 6), out = 1 - ease(f, dur - p.overlap, dur, 0, 1, Easing.in(Easing.quad));
  const fam = p.brand.family;
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", opacity: Math.min(enter, out) }}>
      <div style={{ display: "grid", gap: unit * 0.7, width: "fit-content", maxWidth: Math.min(p.preset.width * 0.8, unit * 26) }}>
        <Words text={p.labels.news} f={f} delay={2} size={unit * 1.3} color={p.brand.text} family={fam} align="left" />
        {lines.map((ln, i) => {
          const t = ease(f, 10 + i * 6, 26 + i * 6);
          return (
            <div key={i} style={{ display: "flex", gap: unit * 0.5, alignItems: "flex-start", opacity: t, transform: `translateX(${(1 - t) * unit}px)` }}>
              <span style={{ flex: "none", width: unit * 0.9, height: unit * 0.9, marginTop: unit * 0.12, borderRadius: "50%", background: p.brand.accent, color: p.brand.onAccent,
                display: "flex", alignItems: "center", justifyContent: "center", fontSize: unit * 0.56, fontWeight: 800, fontFamily: "\"DM Sans\", sans-serif" }}>✓</span>
              <span style={{ fontFamily: `"${fam}", "DM Sans", "Zen Kaku Gothic New", sans-serif`, fontSize: unit * 0.82, lineHeight: 1.3, color: p.brand.text, fontWeight: 520 }}>{ln}</span>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

const EndCard: React.FC<{ p: ProductProps; dur: number; unit: number }> = ({ p, dur, unit }) => {
  const f = useCurrentFrame();
  const enter = ease(f, 0, p.overlap + 8);
  const fam = p.brand.family;
  const stores = p.app.stores.join("  ·  ");
  void dur;
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", opacity: enter }}>
      <div style={{ display: "grid", justifyItems: "center", gap: unit * 0.6, textAlign: "center", maxWidth: p.preset.width * 0.84 }}>
        <Logo src={p.logo} size={unit * 3.6} f={f} delay={2} accent={p.brand.accent} />
        <Words text={p.app.name} f={f} delay={8} size={unit * 1.8} color={p.brand.text} family={fam} weight={760} align="center" lh={1.04} />
        <div style={{ marginTop: unit * 0.3, padding: `${unit * 0.42}px ${unit * 1.1}px`, borderRadius: 999, background: p.brand.accent, color: p.brand.onAccent,
          fontFamily: `"${fam}", "DM Sans", sans-serif`, fontSize: unit * 0.74, fontWeight: 700, letterSpacing: "0.01em",
          opacity: ease(f, 16, 30), transform: `scale(${0.92 + 0.08 * ease(f, 16, 34)})`, boxShadow: `0 ${unit * 0.3}px ${unit}px ${alpha(p.brand.accent, 0.4)}` }}>{p.app.cta}</div>
        {stores || p.app.host ? (
          <div style={{ fontFamily: `"${fam}", "DM Sans", sans-serif`, fontSize: unit * 0.52, letterSpacing: "0.08em", color: p.brand.text, opacity: 0.62 * ease(f, 24, 40) }}>
            {stores || p.app.host}
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};

/* Full screen (App Store): the last screen stays, with the app's name and call to action over its lower part. */
const EndOverlay: React.FC<{ p: ProductProps; last: PvScene | undefined; lay: Layout; unit: number }> = ({ p, last, unit }) => {
  const f = useCurrentFrame();
  const t = ease(f, p.overlap, p.overlap + 18);
  const { width: W, height: H } = p.preset;
  const fam = p.brand.family;
  return (
    <AbsoluteFill>
      {last ? (last.kind === "recording"
        ? <Freeze frame={Math.max(0, Math.min(last.clipFrames || last.dur, last.dur) - 1)}><OffthreadVideo src={staticFile(last.src)} muted style={{ width: "100%", height: "100%", objectFit: "cover" }} /></Freeze>
        : <Still src={last.src} w={last.w} h={last.h} sw={W} sh={H} focus={last.focus} f={last.dur} dur={last.dur} />) : null}
      <AbsoluteFill style={{ background: `linear-gradient(180deg, rgba(0,0,0,0) 48%, rgba(0,0,0,${0.66 * t}) 100%)` }} />
      <div style={{ position: "absolute", left: W * 0.08, right: W * 0.08, bottom: H * 0.075, display: "grid", justifyItems: "center", gap: unit * 0.5, opacity: t,
        transform: `translateY(${(1 - t) * unit}px)` }}>
        <div style={{ fontFamily: `"${fam}", "DM Sans", sans-serif`, fontSize: unit * 1.5, fontWeight: 760, color: "#fff", letterSpacing: "-0.02em", textAlign: "center" }}>{p.app.name}</div>
        <div style={{ padding: `${unit * 0.36}px ${unit}px`, borderRadius: 999, background: p.brand.accent, color: p.brand.onAccent, fontFamily: `"${fam}", "DM Sans", sans-serif`,
          fontSize: unit * 0.66, fontWeight: 700 }}>{p.app.cta}</div>
      </div>
    </AbsoluteFill>
  );
};

export const ProductPreview: React.FC<ProductProps> = (props) => {
  const p = { ...emptyProduct, ...props };
  useFaces(p.fonts);
  const lay = layoutOf(p);
  const { width: W, height: H } = p.preset;
  const unit = Math.min(W, H) / 27;          // the cards' type and spacing unit
  const scale = Math.min(W, H) / 1080;       // the reveal's chip, line and label sizes
  const last = p.scenes[p.scenes.length - 1];
  return (
    <AbsoluteFill style={{ background: p.brand.background, overflow: "hidden" }}>
      <Backdrop p={p} />
      {p.title ? <Sequence from={p.title.from} durationInFrames={p.title.dur} name="Title"><Title p={p} dur={p.title.dur} unit={unit} /></Sequence> : null}
      {p.scenes.map((sc, i) => (
        <Sequence key={sc.id + i} from={sc.from} durationInFrames={sc.dur} name={`${sc.kind} ${sc.id}`}>
          <Scene sc={sc} i={i} p={p} lay={lay} scale={scale} />
        </Sequence>
      ))}
      {p.news ? <Sequence from={p.news.from} durationInFrames={p.news.dur} name="What's new"><News p={p} lines={p.news.lines} dur={p.news.dur} unit={unit} /></Sequence> : null}
      <Sequence from={p.end.from} durationInFrames={p.end.dur} name="End">
        {p.end.kind === "overlay" ? <EndOverlay p={p} last={last} lay={lay} unit={unit} /> : <EndCard p={p} dur={p.end.dur} unit={unit} />}
      </Sequence>
    </AbsoluteFill>
  );
};
