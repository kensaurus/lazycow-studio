/**
 * FILE: scripts/post-stills.mjs
 * PURPOSE: Draw photo posts (src/Post.tsx) as stills: bundle once, then one still per set.
 * OVERVIEW: Called by py/studio/stills.py with a jobs file: {"publicDir": "...", "jobs": [{"props": {...}, "out": "x.png"}]}.
 *           The public folder is a small one stills.py fills with the fonts and this run's photos: Remotion copies the
 *           whole public folder into the bundle on Windows, and the studio's own public/ holds 100+ GB of footage.
 *           Prints "PROGRESS i/n label" lines (the studio's job board reads them) and one "RESULT {json}" line.
 * USAGE: node scripts/post-stills.mjs <jobs.json>
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const spec = JSON.parse(readFileSync(process.argv[2], "utf8"));
const jobs = spec.jobs || [];
const done = [], failed = [];

console.log(`PROGRESS 0/${jobs.length} preparing the drawing (about half a minute)`);
const serveUrl = await bundle({ entryPoint: join(ROOT, "src", "index.ts"), publicDir: spec.publicDir, outDir: spec.bundleDir });
for (const [i, job] of jobs.entries()) {
  console.log(`PROGRESS ${i}/${jobs.length} drawing ${job.label || job.out}`);
  try {
    const composition = await selectComposition({ serveUrl, id: "Post", inputProps: job.props });
    await renderStill({ composition, serveUrl, output: job.out, inputProps: job.props, imageFormat: "png", timeoutInMilliseconds: 120_000, chromiumOptions: { gl: "angle" } });
    done.push(job.out);
  } catch (e) {
    failed.push({ out: job.out, error: String(e.message || e).split(/\r?\n/)[0] });
  }
}
console.log(`PROGRESS ${jobs.length}/${jobs.length} drawn`);
console.log("RESULT " + JSON.stringify({ done, failed }));
process.exit(failed.length && !done.length ? 1 : 0);
