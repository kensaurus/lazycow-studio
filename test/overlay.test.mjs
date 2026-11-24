/**
 * FILE: test/overlay.test.mjs
 * PURPOSE: The ranch overlay (BL-117) on the server side: the helper's Pinterest boards are the ranch's own, read from
 *          shared/ranch/copy.json only in the ranch workspace; any other project (and a public clone) has none.
 * DEPENDENCIES: server/helper.mjs, shared/ranch/*.json (optional: absent in a public clone)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BRAND = new URL("../shared/ranch/brand.json", import.meta.url);
const COPY = new URL("../shared/ranch/copy.json", import.meta.url);
const markers = existsSync(BRAND) ? JSON.parse(readFileSync(BRAND, "utf8")).markers || [] : [];

test("helper defaults: a project that is not the ranch has no Pinterest boards and no ranch words", () => {
  const code = 'import("./server/helper.mjs").then((m) => console.log(JSON.stringify({ boards: m.PINTEREST_BOARDS, '
    + 'pick: [m.pinterestBoard("fire-1108-3"), m.pinterestBoard("cafe-kumo_office-1109_1080x1920.mp4"), m.pinterestBoard("lunch-1124")] })))';
  const out = execFileSync(process.execPath, ["-e", code], { cwd: ROOT, env: { ...process.env, STUDIO_RANCH: "0" }, encoding: "utf8" });
  assert.deepEqual(JSON.parse(out.trim().split("\n").pop()), { boards: {}, pick: ["", "", ""] });
  for (const w of markers) assert.ok(!out.includes(w), w);
});

test("the ranch workspace keeps its own boards, from its overlay", { skip: !existsSync(COPY) && "needs the ranch overlay (not in a public clone)" }, () => {
  const code = 'import("./server/helper.mjs").then((m) => console.log(JSON.stringify(m.PINTEREST_BOARDS)))';
  const env = { ...process.env };
  for (const k of ["STUDIO_RANCH", "STUDIO_PROJECTS", "STUDIO_DATA"]) delete env[k];
  const out = execFileSync(process.execPath, ["-e", code], { cwd: ROOT, env, encoding: "utf8" });
  assert.deepEqual(JSON.parse(out.trim().split("\n").pop()), JSON.parse(readFileSync(COPY, "utf8")).helper.pinterestBoards);
});
