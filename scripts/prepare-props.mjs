/**
 * FILE: scripts/prepare-props.mjs
 * PURPOSE: Break Japanese caption lines with BudouX before Remotion paints them.
 * OVERVIEW: Rewrites pages[].text in a props JSON file. No new words.
 * DEPENDENCIES: budoux
 * USAGE: node scripts/prepare-props.mjs path/to/props.json
 * NOTES: A line of 12 characters or fewer is left as one line.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { loadDefaultJapaneseParser } from "budoux";

const parser = loadDefaultJapaneseParser();
const path = process.argv[2];
const props = JSON.parse(readFileSync(path, "utf8"));

function wrap(text) {
  const parts = parser.parse(text);
  if (parts.join("").length <= 12) return text;
  const mid = Math.ceil(parts.length / 2);
  return `${parts.slice(0, mid).join("")}\n${parts.slice(mid).join("")}`;
}

props.pages = (props.pages || []).map((page) => ({ ...page, text: wrap(page.text) }));
writeFileSync(path, JSON.stringify(props, null, 2));
