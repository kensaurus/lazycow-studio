/**
 * FILE: shared/guard.mjs
 * PURPOSE: Fact guard for captions and post text.
 * OVERVIEW: The ranch workspace's rules, the same ones py/studio/guard.py applies there: its banned phrases, no prices,
 *           and its bare word only inside its registered name, read from its overlay (shared/ranch/brand.json, never
 *           exported). Without the overlay (a public clone) only the price rule applies (spec.json pricePattern).
 * DEPENDENCIES: shared/spec.json, shared/ranch/brand.json (optional), node:fs
 * USAGE: copyProblems(text)
 */
import { readFileSync } from "node:fs";
import spec from "./spec.json" with { type: "json" };

const RANCH = (() => {
  try { return JSON.parse(readFileSync(new URL("./ranch/brand.json", import.meta.url), "utf8")); }
  catch { return {}; }
})();
const BANNED = RANCH.bannedSubstrings || spec.bannedSubstrings || [];
const REGISTERED = RANCH.registered || "";
const BARE = RANCH.bareWord || "";
const PRICE = new RegExp(spec.pricePattern);

/** Is a banned phrase in the (lower-cased) text? A phrase in Latin letters counts only as whole words ("cow" is not in
    "coworking"); any other script (Japanese has no spaces) anywhere. Same rule as py/studio/guard.py hit. */
export function bannedHit(phrase, lower) {
  const p = String(phrase || "").toLowerCase().trim();
  if (!p) return false;
  if (/^[a-z0-9 '-]+$/.test(p)) return new RegExp(`(?<![a-z0-9])${p.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}(?![a-z0-9])`).test(lower);
  return lower.includes(p);
}

export function copyProblems(text) {
  const problems = [];
  const lower = text.toLowerCase();
  for (const phrase of BANNED) {
    if (bannedHit(phrase, lower)) problems.push(`banned:${phrase}`);
  }
  if (PRICE.test(text)) problems.push("price");
  if (REGISTERED && BARE && text.replaceAll(REGISTERED, "").includes(BARE)) problems.push("bare-bokujo");
  return problems;
}

export function assertCopy(text) {
  const problems = copyProblems(text);
  if (problems.length) throw new Error(`fact guard: ${problems.join(", ")}`);
  return text;
}
