/**
 * FILE: test/instagram-reels.test.mjs
 * PURPOSE: Instagram reels through the Facebook connection (py/studio/connectors/instagram_reel.py): the daily plan
 *   books Instagram only while that connection can publish there, and otherwise leaves it as it was (a by-hand
 *   reminder, nothing waited on); the trial-reels switch on the Accounts card (default by follower count, saved per
 *   project); and the minute ticker leaving a post that waits for its retry alone (BL-156).
 * USAGE: npm test
 */
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { AUTO_NETS, fitsNetwork, OPTIONAL_NETS, planAhead, postSlots, readyMap, retryAfter } from "../server/autoplan.mjs";
import { assemblePage } from "../server/ui.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const html = assemblePage(ROOT).replace(/\r\n/g, "\n");
const script = html.slice(html.indexOf("<script>"), html.lastIndexOf("</script>"));
const body = (name) => { const at = script.indexOf(`function ${name}(`); assert.ok(at > 0, name); return script.slice(at, script.indexOf("\n}", at) + 2); };
const server = readFileSync(new URL("../server/review.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const channels = JSON.parse(readFileSync(new URL("../shared/channels.json", import.meta.url), "utf8"));
const NOW = Date.parse("2026-11-27T09:00:00+09:00");

test("Instagram is booked only while the Facebook connection can publish reels there", () => {
  assert.ok(AUTO_NETS.includes("instagram") && OPTIONAL_NETS.includes("instagram"));
  const off = readyMap({ conns: { facebook: { connected: true } }, ytConnected: true, chrome: false });
  assert.equal("instagram" in off, false, "not connected: not a network the plan books or waits on");
  assert.equal(off.facebook, true); assert.equal(off.x, false, "the other networks are always listed");
  const on = readyMap({ conns: { facebook: { connected: true }, instagram: { connected: true } } });
  assert.equal(on.instagram, true);
  // What autoPlan books: the chosen networks that are ready; waiting: listed and not ready (never Instagram unconnected).
  assert.match(server, /return readyMap\(\{ conns, ytConnected: !!yt\.connected, chrome: extensionConnected\(\) \}\);/);
  assert.match(server, /const waiting = chosen\.filter\(\(n\) => n in ready && !ready\[n\]\);/);
  assert.match(server, /networks: AUTO_NETS\.filter\(\(n\) => !OPTIONAL_NETS\.includes\(n\) \|\| ready\?\.\[n\]\)/);
});

test("an Instagram reel is planned like the other daily networks, short cuts only, at its listed hours", () => {
  const ig = channels.channels.find((c) => c.id === "instagram");
  assert.deepEqual(ig.postTimesJst, ["12:00", "19:00"]);
  const spec = { channels: [{ ...ig, off: undefined }] };
  assert.equal(fitsNetwork({ slug: "cafe-lunch" }, "instagram", spec), true);
  assert.equal(fitsNetwork({ slug: "cafe-lunch-long" }, "instagram", spec), false, "a long explainer is not a reel");
  assert.equal(fitsNetwork({ slug: "cafe-lunch" }, "instagram", { channels: [{ ...ig, off: true }] }), false, "switched off: never planned");
  const reels = [{ slug: "lunch-a", headline: "A", networks: ["instagram"] }, { slug: "night-b", headline: "B", networks: ["instagram"] }];
  const r = planAhead({ reels, networks: ["instagram"], now: NOW, aheadDays: 2, slots: postSlots(spec) });
  assert.deepEqual(r.plan.map((p) => [p.network, p.at.slice(11, 16)]), [["instagram", "19:00"], ["instagram", "19:00"]]);
});

test("a queued post waiting for its retry is left alone until its time", () => {
  assert.equal(retryAfter("retry 1/2 after 2026-11-27T19:05+09:00: could not reach Facebook"), Date.parse("2026-11-27T19:05+09:00"));
  assert.ok(Number.isNaN(retryAfter("")) && Number.isNaN(retryAfter("could not reach Facebook")));
  assert.match(server, /r\.status === "queued" && r\.at && Date\.parse\(r\.at\) <= now && !\(retryAfter\(r\.note\) > now\)\)\) startTask\("post-due"/);
});

test("the trial-reels switch: on under 1,000 followers until chosen, saved per project", () => {
  // eslint-disable-next-line no-new-func
  const igTrialOn = new Function(`${body("igTrialOn")}\nreturn igTrialOn;`)();
  assert.equal(igTrialOn({ followers: 120, trialUnder: 1000 }, {}), true);
  assert.equal(igTrialOn({ followers: 5400, trialUnder: 1000 }, {}), false);
  assert.equal(igTrialOn({ followers: null }, {}), true, "an unknown count: a new account");
  assert.equal(igTrialOn({ followers: 120 }, { trial: false }), false, "the choice wins");
  assert.equal(igTrialOn({ followers: 5400 }, { trial: true }), true);
  assert.match(body("igTrialHtml"), /data-igtrial="1"/);
  assert.ok(script.includes('tri ? { id: "instagram", trial: tri.checked }'), "the switch saves through /api/channels/set");
  assert.match(server, /if \(id === "instagram" && trial !== undefined\) \{ if \(typeof trial === "boolean"\) o\.igTrial = trial; else delete o\.igTrial; \}/);
  assert.match(server, /if \(c\.id === "instagram" && typeof o\.igTrial === "boolean"\) c\.trial = o\.igTrial;/);
  assert.match(server, /b\.trial !== undefined && \(b\.id !== "instagram"/, "trial only for Instagram, true / false / null");
  for (const lang of ["en", "ja"]) {
    // In the main blocks (test/i18n.test.mjs reads only those), one line right after `  en: {` / `  ja: {`.
    const at = script.indexOf(`\n  ${lang}: {\n    "igr.line"`);
    assert.ok(at > 0, lang);
    const block = script.slice(at, script.indexOf("\n", at + lang.length + 8));
    for (const k of ["igr.line", "igr.trial", "igr.trial.d", "igr.trial.auto", "igr.trial.auto0", "igr.via", "igr.hand"]) assert.ok(block.includes(`"${k}"`), `${lang} ${k}`);
  }
});

test("the page sends Instagram reels from the studio only while connected, else keeps the by-hand way", () => {
  const line = script.split("\n").find((l) => l.startsWith("const STUDIO_NETS = "));
  // eslint-disable-next-line no-new-func
  const make = new Function("connections", `${line}\nreturn STUDIO_NETS;`);
  assert.equal(make({}).includes("instagram"), false);
  assert.equal(make({ instagram: { connected: true } }).includes("instagram"), true);
  assert.equal(make({}).includes("facebook") && make({}).includes("bluesky"), true);
});
