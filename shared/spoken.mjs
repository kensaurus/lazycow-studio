/**
 * FILE: shared/spoken.mjs
 * PURPOSE: Word-by-word captions for a reel with a read-aloud voice: which word of an on-screen line is being said
 *          at a moment, so the line lights up as the voice reads it (src/Story.tsx Hook and Line).
 * OVERVIEW: The voice reads the reel's own approved line (py/studio/ai.py tool_voice), so the words are known; their
 *           timing comes from the voice clip's own span (from, to). Words are split by the browser's word segmenter
 *           (Intl.Segmenter, Japanese aware), and each word gets a share of the span by its spoken length (kana and
 *           kanji count 1, Latin letters 0.5, digits 0.8, punctuation a short pause). Plain and free: no extra AI call.
 * USAGE: spokenStates(text, {from, to}, seconds) -> ["done" | "now" | "next", ...] one per character (code point),
 *        or null when the line is not spoken.
 * NOTES: Shared with test/spoken.test.mjs; keep it free of Remotion imports.
 */
const PUNCT = /^[\s、。，．,.!?！？「」『』（）()…・ー〜~:：;；"'“”‘’-]+$/u;

function weightOf(word) {
  if (/^\s+$/u.test(word)) return 0;
  if (PUNCT.test(word)) return 0.35;
  let w = 0;
  for (const ch of word) w += /[A-Za-z]/.test(ch) ? 0.5 : /[0-9]/.test(ch) ? 0.8 : 1;
  return w;
}

/** The words of a line, in order, each with its characters' start index and spoken weight. */
export function spokenWords(text) {
  const chars = [...String(text || "")];
  const out = [];
  let parts;
  try {
    parts = [...new Intl.Segmenter("ja", { granularity: "word" }).segment(chars.join(""))].map((s) => s.segment);
  } catch {
    parts = chars;  // no segmenter: one character at a time
  }
  let i = 0;
  for (const part of parts) {
    const n = [...part].length;
    out.push({ text: part, start: i, end: i + n, weight: part.includes("\n") ? 0 : weightOf(part) });
    i += n;
  }
  return out;
}

/** Each character's state at `t` seconds: said ("done"), being said ("now") or still to come ("next"). */
export function spokenStates(text, spoken, t) {
  if (!spoken || !(spoken.to > spoken.from)) return null;
  const words = spokenWords(text);
  const total = words.reduce((a, w) => a + w.weight, 0) || 1;
  const states = new Array([...String(text || "")].length).fill("next");
  const progress = Math.max(0, Math.min(1, (t - spoken.from) / (spoken.to - spoken.from))) * total;
  let acc = 0;
  for (const w of words) {
    const s = acc, e = acc + w.weight;
    acc = e;
    const state = t >= spoken.to || (w.weight === 0 && progress >= s) || progress >= e ? "done" : progress >= s && t >= spoken.from ? "now" : "next";
    for (let k = w.start; k < w.end; k++) states[k] = state;
  }
  return states;
}
