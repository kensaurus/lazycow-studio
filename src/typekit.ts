/**
 * FILE: src/typekit.ts
 * PURPOSE: A reel's type pairing, colours and word motion (shared/type-kits.json), and loading only the fonts that
 *          pairing needs before a frame is drawn.
 * OVERVIEW: kitOf/paletteOf/motionOf fall back to the house entry (the first), so a reel without these props renders
 *           as before. useKitFonts holds the render (delayRender) until the kit's faces are loaded.
 * DEPENDENCIES: remotion, shared/type-kits.json, public/fonts
 */
import { useEffect, useState } from "react";
import { cancelRender, continueRender, delayRender, staticFile } from "remotion";
import table from "../shared/type-kits.json";

export type Kit = {
  id: string; jaFamily: string; jaFaces: string[][]; hookWeight: number; lineWeight: number;
  enFamily: string; enFaces: string[][]; enItalic: boolean; enWeight: number; enScale: number; enUpper?: boolean; enTrack?: string;
};
export type Palette = { id: string; text: string; accent: string; rule: string; bar: string; enColor: string };
export type Motion = "type" | "rise" | "pop" | "blur" | "wipe";

const KITS = table.kits as Kit[];
const PALETTES = table.palettes as Palette[];
const MOTIONS = table.motions.map((m) => m.id) as Motion[];

export const kitOf = (id?: string | null): Kit => KITS.find((k) => k.id === id) || KITS[0];
export const paletteOf = (id?: string | null): Palette => PALETTES.find((p) => p.id === id) || PALETTES[0];
export const motionOf = (id?: string | null): Motion => (MOTIONS.includes(id as Motion) ? (id as Motion) : MOTIONS[0]);

/** The English line's font props for a kit (family, italic, weight, case, tracking). */
export const enFont = (k: Kit) => ({
  fontFamily: k.enFamily,
  fontStyle: k.enItalic ? "italic" : "normal",
  fontWeight: k.enWeight,
  textTransform: k.enUpper ? ("uppercase" as const) : undefined,
  letterSpacing: k.enTrack,
});

const loading = new Map<string, Promise<unknown>>();
function load(family: string, file: string, weight: string, style?: string) {
  const key = `${family}|${file}`;
  if (!loading.has(key)) {
    const face = new FontFace(family, `url(${staticFile(`fonts/${file}`)})`, { weight, style: style || "normal" });
    loading.set(key, face.load().then((f) => (document.fonts as unknown as { add: (x: FontFace) => void }).add(f)));
  }
  return loading.get(key)!;
}

/** Holds the frame until the kit's Japanese and English faces are ready. */
export const useKitFonts = (k: Kit) => {
  const [handle] = useState(() => delayRender(`fonts ${k.id}`));
  useEffect(() => {
    Promise.all([...k.jaFaces.map(([f, w, s]) => load(k.jaFamily, f, w, s)), ...k.enFaces.map(([f, w, s]) => load(k.enFamily, f, w, s))])
      .then(() => continueRender(handle))
      .catch((err) => cancelRender(err));
  }, [handle, k]);
};
