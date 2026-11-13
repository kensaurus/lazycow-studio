/**
 * FILE: shared/guard.mjs
 * PURPOSE: Fact guard for captions and post text.
 * OVERVIEW: Same banned list as py/studio/guard.py, both reading spec.json.
 * DEPENDENCIES: shared/spec.json
 * USAGE: copyProblems(text)
 * NOTES: 牧場 is allowed only inside 嬬恋牧場Work&Camp.
 */
import spec from "./spec.json" with { type: "json" };

const REGISTERED = "嬬恋牧場Work&Camp";
const PRICE = new RegExp(spec.pricePattern);

export function copyProblems(text) {
  const problems = [];
  const lower = text.toLowerCase();
  for (const phrase of spec.bannedSubstrings) {
    if (lower.includes(phrase.toLowerCase())) problems.push(`banned:${phrase}`);
  }
  if (PRICE.test(text)) problems.push("price");
  if (text.replaceAll(REGISTERED, "").includes("牧場")) problems.push("bare-bokujo");
  return problems;
}

export function assertCopy(text) {
  const problems = copyProblems(text);
  if (problems.length) throw new Error(`fact guard: ${problems.join(", ")}`);
  return text;
}
