/**
 * FILE: shared/looks.mjs
 * PURPOSE: The look and recipe names (shared/looks.json) and the pure helpers src/looks.tsx uses,
 *          so node tests can check them without a renderer.
 * OVERVIEW: parseMeter splits the altitude line into label, number and unit; splitGroups pairs shots
 *           for the split look.
 * DEPENDENCIES: shared/looks.json
 * USAGE: import { LOOKS, RECIPES, parseMeter, splitGroups } from "../shared/looks.mjs"
 * NOTES: py/studio/staging.py reads the same JSON.
 */
import spec from "./looks.json" with { type: "json" };

export const LOOKS = Object.keys(spec.looks);
export const RECIPES = Object.keys(spec.recipes);

/** "標高1,444m。" → { label: "標高", value: 1444, unit: "m" }; null when the line has no number. */
export function parseMeter(ja) {
  const m = String(ja).replace(/\n/g, "").match(/^(.*?)(\d{1,3}(?:,\d{3})+|\d+)\s*(m|ｍ|km)/);
  if (!m) return null;
  return { label: m[1].replace(/[、。\s]+$/, ""), value: Number(m[2].replace(/,/g, "")), unit: m[3] === "ｍ" ? "m" : m[3] };
}

/** Pairs for the split look: (0,1), (2,3)… and the last shot alone under the end card. */
export function splitGroups(n) {
  const groups = [];
  let i = 0;
  while (i < n - 1) {
    if (i + 1 < n - 1) {
      groups.push([i, i + 1]);
      i += 2;
    } else {
      groups.push([i]);
      i += 1;
    }
  }
  if (n > 0) groups.push([n - 1]);
  return groups;
}
