// How people pay for Lazycow's development (shared/support.json): real Stripe links, the same ones everywhere they are
// shown, and no link to a GitHub Sponsors listing that does not exist (13 Nov: it redirected to the profile page).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const support = JSON.parse(read("shared/support.json"));
const links = [support.once.jpy, support.once.usd, ...support.monthly.map((p) => p.url)];

test("every support link is a live-mode Stripe checkout or portal address", () => {
  for (const u of links) assert.match(u, /^https:\/\/buy\.stripe\.com\/[A-Za-z0-9]+$/, u);
  assert.match(support.manage, /^https:\/\/billing\.stripe\.com\/p\/login\/[A-Za-z0-9]+$/);
  assert.equal(support.legal, "https://kensaur.us/tokushoho/");
  assert.deepEqual(support.monthly.map((p) => [p.id, p.jpy, p.usd]), [["supporter", 500, 4], ["backer", 1500, 10], ["sponsor", 5000, 35]]);
});

test("README, SUPPORTING.md and FUNDING.yml show the same links, and nothing points at GitHub Sponsors", () => {
  const readme = read("README.md"), page = read("SUPPORTING.md"), funding = read(".github/FUNDING.yml");
  for (const u of links) {
    assert.ok(readme.includes(u), `README: ${u}`);
    assert.ok(page.includes(u), `SUPPORTING.md: ${u}`);
  }
  for (const p of support.monthly) assert.ok(funding.includes(p.url), `FUNDING.yml: ${p.id}`);
  assert.ok(page.includes(support.manage), "how to cancel");
  // docs/ranch-workspace.md is the maintainer's own and stays out of the public copy (scripts/public-export.json).
  const own = ["docs/ranch-workspace.md"].filter((f) => existsSync(new URL(`../${f}`, import.meta.url)));
  for (const f of ["README.md", "SUPPORTING.md", "package.json", "server/editor.html", "server/review.mjs", "packages/lazycow/README.md", ...own]) {
    assert.doesNotMatch(read(f), /github\.com\/sponsors\//, f);
  }
  assert.doesNotMatch(page, /寄付します|donate now/i, "a payment for a service, never called a donation");
});
