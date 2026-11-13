/**
 * FILE: test/openapi-routes.test.mjs
 * PURPOSE: docs/openapi.yaml describes the API the server really has: every route server/review.mjs answers is in the
 *          spec, and every fixed path in the spec is a route the server answers (docs/ROADMAP.md #12).
 * USAGE: npm test
 * NOTES: Paths are read from the spec's top-level `paths:` keys, so no YAML library is needed.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const spec = readFileSync(new URL("../docs/openapi.yaml", import.meta.url), "utf8");
const code = readFileSync(new URL("../server/review.mjs", import.meta.url), "utf8");
const specPaths = new Set([...spec.matchAll(/^ {2}(\/[^\s:]*):\s*$/gm)].map((m) => m[1]));
// The old /api/collect* names are rewritten to /api/intake* before routing (kept for scripts written before 0.12).
const ALIASES = new Set(["/api/collect"]);
const codeRoutes = new Set([...code.matchAll(/url\.pathname === "(\/[^"]+)"/g)].map((m) => m[1]).filter((p) => !ALIASES.has(p)));
// Two route families are matched by pattern, not by literal: read their names from the code too, so they stay in step.
const research = /\/\^\\\/api\\\/research\\\/\(([a-z|-]+)\)\$\//.exec(code)?.[1];
const actions = /if \(!\[([^\]]+)\]\.includes\(act\)\)/.exec(code)?.[1];
for (const name of (research || "").split("|").filter(Boolean)) codeRoutes.add(`/api/research/${name}`);
for (const name of (actions || "").match(/[a-z]+/g) || []) codeRoutes.add(`/api/${name}`);

test("every route the server answers is described in docs/openapi.yaml", () => {
  assert.ok(specPaths.size > 100 && codeRoutes.size > 100, `read ${specPaths.size} spec paths, ${codeRoutes.size} routes`);
  assert.deepEqual([...codeRoutes].filter((p) => !specPaths.has(p)).sort(), []);
});

test("every fixed path in docs/openapi.yaml is a route the server answers", () => {
  // Paths with {params} are matched by patterns in review.mjs; a fixed path must appear as a literal somewhere in it.
  const fixed = [...specPaths].filter((p) => !p.includes("{"));
  assert.deepEqual(fixed.filter((p) => !codeRoutes.has(p) && !code.includes(`"${p}"`) && !code.includes(`'${p}'`) && !code.includes(`\`${p}`)).sort(), []);
});
