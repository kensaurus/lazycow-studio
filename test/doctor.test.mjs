/**
 * FILE: test/doctor.test.mjs
 * PURPOSE: `npx lazycow doctor` (packages/lazycow/lib/doctor.mjs) says READY / SLOW / BLOCKED for the right reasons, maps
 *          its processor test to seconds per reel, exits 0 / 1 / 2, and its two no-Node twins (scripts/bootstrap/
 *          doctor.ps1, doctor.sh) use the same numbers and hosts.
 * USAGE: npm test. Facts are injected: no network, no benchmark, except one --offline run of the real command.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LIMITS } from "../server/health.mjs";
import { checkDisk, estimateReelSeconds, exitCodeFor, formatReport, HOSTS, INSTALL, judgeDoctor, minutesText, probeHosts, REFERENCE,
  SLOW_REEL_SECONDS } from "../packages/lazycow/lib/doctor.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const allUp = (platform) => HOSTS.filter((h) => !h.platforms || h.platforms.includes(platform)).map((h) => ({ host: h.host, ok: true, status: 200 }));

// The reference desktop, as gatherFacts would describe it.
const pc = {
  platform: "win32", arch: "x64", osName: "Windows 11", winBuild: 26300, threads: 32, cpuModel: "AMD Ryzen 9 5950X 16-Core Processor",
  ramGb: 64, diskFreeGb: 210, diskWhere: "D:", node: "26.13.1", python: null, gpus: ["NVIDIA GeForce RTX 4070"], encoders: [],
  ffmpeg: { found: false, usable: false, tooOld: false }, hosts: allUp("win32"), bench: { single: REFERENCE.single, multi: REFERENCE.multi },
};

test("the reference desktop is READY at the measured 357 s a reel, and the report reads like the example", () => {
  const r = judgeDoctor(pc);
  assert.equal(r.verdict, "READY");
  assert.equal(r.exitCode, 0);
  assert.equal(r.seconds, 357);
  const text = formatReport(r);
  assert.match(text, /^Lazycow check · Windows 11 x64 · 32 threads · 64 GB RAM/);
  assert.match(text, /✓ Free space on D: 210 GB \(needs 6 GB to install, 20 GB for renders\)/);
  assert.match(text, /! Graphics: NVIDIA found\. Lazycow renders on the processor today\./);
  assert.match(text, /Estimated time per reel: about 6 minutes/);
  assert.match(text, /Verdict: READY\. Install downloads about 1\.3 GB and takes 10–30 minutes\./);
  assert.ok(text.split("\n").length <= 20, "one screen");
});

test("benchmark to seconds: the reference is 357 s, half as fast is twice as long, more cores help only the parallel part", () => {
  const ref = { single: REFERENCE.single, multi: REFERENCE.multi };
  assert.equal(estimateReelSeconds(ref), REFERENCE.seconds);
  assert.equal(estimateReelSeconds({ single: ref.single / 2, multi: ref.multi / 2 }), 714);
  // Same cores, a quarter of them (an 8-thread laptop of the same generation): between 1x and 4x.
  const quarter = estimateReelSeconds({ single: ref.single, multi: ref.multi / 4 });
  assert.ok(quarter > 357 * 2 && quarter < 357 * 4, String(quarter));
  assert.ok(estimateReelSeconds({ single: ref.single * 1.3, multi: ref.multi * 1.3 }) < 357);
  assert.equal(estimateReelSeconds(null), null);
  assert.equal(estimateReelSeconds({ single: 0, multi: 5 }), null);
  assert.equal(minutesText(357), "about 6 minutes");
  assert.equal(minutesText(40), "about 1 minute");
  assert.equal(minutesText(3 * 3600), "about 3.0 hours");
});

test("without a benchmark it falls back to the thread-count guess", () => {
  const r = judgeDoctor({ ...pc, bench: null });
  assert.equal(r.secondsSource, "threads");
  assert.ok(r.seconds > 0);
});

test("an Intel Mac is BLOCKED and told why (PyTorch has no macOS x86 builds since 2.2); Apple silicon under Rosetta is not", () => {
  const mac = { ...pc, platform: "darwin", arch: "x64", osName: "macOS 14.6", macMajor: 14, rosetta: false, hosts: allUp("darwin"), gpus: [] };
  const r = judgeDoctor(mac);
  assert.equal(r.verdict, "BLOCKED");
  assert.equal(r.exitCode, 2);
  const sys = r.checks.find((c) => c.id === "system");
  assert.match(sys.found, /Intel processor/);
  assert.match(sys.fix, /PyTorch.*Intel Macs.*2\.2/);
  assert.match(sys.fix, /Apple silicon \(M1 or newer\)/);
  assert.match(formatReport(r), /Verdict: BLOCKED\. System: .*Intel processor.*What to do: .*PyTorch/);
  assert.equal(judgeDoctor({ ...mac, rosetta: true }).verdict, "READY");
  assert.equal(judgeDoctor({ ...mac, arch: "arm64" }).verdict, "READY");
  assert.equal(judgeDoctor({ ...mac, arch: "arm64", macMajor: 13 }).verdict, "BLOCKED", "macOS 13: the locked packages need 14");
});

test("free disk: under 6 GB is BLOCKED, under 26 GB is SLOW (it installs, little room for renders), else fine", () => {
  assert.deepEqual([INSTALL.diskGb, INSTALL.rendersGb], [6, LIMITS.diskGb.slow]);
  assert.equal(checkDisk(4.2, "C:").level, "blocked");
  assert.match(checkDisk(4.2, "C:").fix, /--dir/);
  assert.equal(checkDisk(15, "C:").level, "slow");
  assert.equal(checkDisk(40, "C:").level, "ok");
  assert.equal(checkDisk(null).level, "note");
  const r = judgeDoctor({ ...pc, diskFreeGb: 3 });
  assert.equal(r.verdict, "BLOCKED");
  assert.match(r.reason, /Free space on D: 3 GB/);
});

test("weak processor or little memory: the studio's own limits decide (4/8 threads, 6/12 GB)", () => {
  assert.equal(judgeDoctor({ ...pc, threads: 2 }).verdict, "BLOCKED");
  assert.equal(judgeDoctor({ ...pc, threads: 6, bench: null }).verdict, "SLOW");
  assert.equal(judgeDoctor({ ...pc, ramGb: 4 }).verdict, "BLOCKED");
  const slow = judgeDoctor({ ...pc, ramGb: 8 });
  assert.equal(slow.verdict, "SLOW");
  assert.equal(slow.exitCode, 1);
  assert.match(formatReport(slow), /Verdict: SLOW\. Memory: 8 GB\. Lazycow will run/);
});

test("a processor test far below the reference makes it SLOW: over half an hour a reel", () => {
  const r = judgeDoctor({ ...pc, bench: { single: REFERENCE.single / 4, multi: REFERENCE.multi / 12 } });
  assert.ok(r.seconds > SLOW_REEL_SECONDS);
  assert.equal(r.verdict, "SLOW");
});

test("download hosts: an install host down BLOCKS, a later one only slows; offline is not judged", () => {
  const down = (host) => pc.hosts.map((h) => (h.host === host ? { host, ok: false, error: "ETIMEDOUT" } : h));
  const gh = judgeDoctor({ ...pc, hosts: down("github.com") });
  assert.equal(gh.verdict, "BLOCKED");
  assert.match(gh.reason, /no answer from github\.com/);
  assert.equal(judgeDoctor({ ...pc, hosts: down("huggingface.co") }).verdict, "SLOW");
  assert.equal(judgeDoctor({ ...pc, hosts: null }).verdict, "READY");
});

test("graphics and an old PATH ffmpeg are information, never the verdict", () => {
  const r = judgeDoctor({ ...pc, ffmpeg: { found: true, usable: false, tooOld: true, version: "4.4 (git build)", source: "path" } });
  assert.equal(r.verdict, "READY");
  assert.match(formatReport(r), /! ffmpeg: 4\.4 \(git build\) on PATH is older than 5\.1/);
  assert.equal(judgeDoctor({ ...pc, gpus: [] }).checks.find((c) => c.id === "gpu").level, "note");
});

test("exit codes: 0 ready, 1 slow, 2 blocked", () => {
  assert.deepEqual(["READY", "SLOW", "BLOCKED"].map(exitCodeFor), [0, 1, 2]);
  assert.equal(exitCodeFor("nonsense"), 2);
});

test("probeHosts asks each host once with HEAD and counts any HTTP answer as reachable", async () => {
  const asked = [];
  const fake = async (url, opts) => {
    asked.push([url, opts.method]);
    if (url.includes("pypi")) throw Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } });
    return { status: url.includes("github") ? 404 : 200 };
  };
  const r = await probeHosts(HOSTS.slice(0, 4), { fetchImpl: fake });
  assert.ok(asked.every(([, m]) => m === "HEAD"));
  assert.deepEqual(r.map((x) => x.ok), [true, true, true, false]);
  assert.equal(r[3].error, "ENOTFOUND");
});

test("every host the setup downloads from is checked, by the doctor and by both no-Node scripts", () => {
  const V = JSON.parse(read("scripts/bootstrap/versions.json"));
  const urls = JSON.stringify(V).match(/https:\/\/[^"]+/g).filter((u) => !/ffmpeg\.org\/download/.test(u));
  const hosts = new Set(HOSTS.map((h) => h.host));
  for (const u of urls) assert.ok(hosts.has(new URL(u).host), `${new URL(u).host} (versions.json) is not in doctor.mjs HOSTS`);
  for (const h of ["pypi.org", "files.pythonhosted.org", "download.pytorch.org", "huggingface.co", "registry.npmjs.org"]) assert.ok(hosts.has(h), h);
  const ps = read("scripts/bootstrap/doctor.ps1"), sh = read("scripts/bootstrap/doctor.sh");
  for (const h of HOSTS) {
    if (!h.platforms || h.platforms.includes("win32")) assert.ok(ps.includes(`"${h.url}"`), `doctor.ps1 misses ${h.url}`);
    if (!h.platforms || h.platforms.some((p) => p !== "win32")) assert.ok(sh.includes(` ${h.url} ${h.need === "install" ? 1 : 0} `), `doctor.sh misses ${h.url}`);
  }
});

test("the no-Node scripts use the same limits as the studio and the doctor", () => {
  const ps = read("scripts/bootstrap/doctor.ps1"), sh = read("scripts/bootstrap/doctor.sh");
  const num = (text, re) => Number(re.exec(text)?.[1]);
  assert.equal(num(ps, /\$ThreadsMin = (\d+)/), LIMITS.threads.min); assert.equal(num(ps, /\$ThreadsSlow = (\d+)/), LIMITS.threads.slow);
  assert.equal(num(ps, /\$RamMin = (\d+)/), LIMITS.ramGb.min); assert.equal(num(ps, /\$RamSlow = (\d+)/), LIMITS.ramGb.slow);
  assert.equal(num(ps, /\$InstallGb = (\d+)/), INSTALL.diskGb); assert.equal(num(ps, /\$RendersGb = (\d+)/), INSTALL.rendersGb);
  assert.equal(num(ps, /\$DownloadGb = ([\d.]+)/), INSTALL.downloadGb);
  assert.equal(num(sh, /THREADS_MIN=(\d+)/), LIMITS.threads.min); assert.equal(num(sh, /THREADS_SLOW=(\d+)/), LIMITS.threads.slow);
  assert.equal(num(sh, /RAM_MIN=(\d+)/), LIMITS.ramGb.min); assert.equal(num(sh, /RAM_SLOW=(\d+)/), LIMITS.ramGb.slow);
  assert.equal(num(sh, /INSTALL_GB=(\d+)/), INSTALL.diskGb); assert.equal(num(sh, /RENDERS_GB=(\d+)/), INSTALL.rendersGb);
  assert.equal(num(sh, /DOWNLOAD_GB=([\d.]+)/), INSTALL.downloadGb);
  assert.match(sh, /PyTorch, which has had no builds for Intel Macs/);
  // Pasted through `irm | iex`, it must never close the person's window, and it stays plain ASCII like windows.ps1.
  assert.match(ps, /if \(\$MyInvocation\.MyCommand\.Path\) \{ exit \$top \} else \{ \$global:LASTEXITCODE = \$top \}/);
  assert.doesNotMatch(ps, /^param\(/m, "a param() block breaks the one-line form");
  for (const [name, text] of [["doctor.ps1", ps], ["doctor.sh", sh]]) assert.doesNotMatch(text, /[^\x00-\x7f]/, `${name} is ASCII`);
});

test("the bootstrap scripts run the check as step 1 and stop before downloading when BLOCKED, unless forced", () => {
  const win = read("scripts/bootstrap/windows.ps1");
  const step1 = win.slice(win.indexOf('Step 1 "'), win.indexOf('Step 2 "'));
  assert.match(step1, /doctor\.ps1/); assert.match(step1, /\$verdict -eq 2 -and -not \(\$Force -or \$env:LAZYCOW_FORCE -eq "1"\)/);
  assert.ok(win.indexOf("doctor.ps1") < win.indexOf("Fetch $V.node"), "checked before the first download");
  for (const f of ["scripts/bootstrap/mac.sh", "scripts/bootstrap/linux.sh"]) {
    const sh = read(f);
    const s1 = sh.slice(sh.indexOf('step 1 "'), sh.indexOf('step 2 "'));
    assert.match(s1, /sh "\$ROOT\/scripts\/bootstrap\/doctor\.sh"/, f);
    assert.match(s1, /\$\{PIPESTATUS\[0\]\}" = 2 \] && \[ "\$FORCE" != 1 \] && fail/, f);
  }
});

test("lazycow doctor runs on this computer and exits with its verdict's code (--offline: no network)", () => {
  const bin = join(ROOT, "packages", "lazycow", "bin", "lazycow.mjs");
  const r = spawnSync(process.execPath, [bin, "doctor", "--json", "--offline"], { encoding: "utf8", timeout: 60000 });
  const out = JSON.parse(r.stdout);
  assert.ok(["READY", "SLOW", "BLOCKED"].includes(out.verdict));
  assert.equal(r.status, exitCodeFor(out.verdict));
  assert.equal(out.facts.hosts, null);
  assert.ok(out.facts.bench.single > 0 && out.facts.bench.multi > 0);
  assert.match(execHelp(bin), /npx lazycow doctor/);
});

function execHelp(bin) { return spawnSync(process.execPath, [bin, "help"], { encoding: "utf8" }).stdout; }
