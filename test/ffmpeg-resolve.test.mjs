/**
 * FILE: test/ffmpeg-resolve.test.mjs
 * PURPOSE: The one ffmpeg rule (server/health.mjs resolveTool, same as py/studio/config.py): STUDIO_FFMPEG, then the
 *          tools folder, then PATH only when new enough; versions read from every kind of build; fixes that fit the system.
 * USAGE: npm test. No real ffmpeg: the file system, PATH and `ffmpeg -version` are injected.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ffmpegFix, judgeSystem, MIN_FFMPEG, parseFfmpegVersion, resolveTool, versionTooOld, whichSync } from "../server/health.mjs";

const OUT = {
  gyan9: "ffmpeg version 9.0.2-essentials_build-www.gyan.dev Copyright (c) 2000-2026 the FFmpeg developers\nlibavcodec     63.  4.100 / 63.  4.100",
  brew: "ffmpeg version 7.1.1 Copyright (c) 2000-2025 the FFmpeg developers\nbuilt with Apple clang",
  ubuntu2204: "ffmpeg version 4.4.2-0ubuntu0.22.04.1 Copyright (c) 2000-2021 the FFmpeg developers\nlibavcodec     58.134.100 / 58.134.100",
  debian12: "ffmpeg version 5.1.6-0+deb12u1 Copyright (c) 2000-2024 the FFmpeg developers",
  btbn: "ffmpeg version n7.1-2-g1234abcd Copyright (c) 2000-2024 the FFmpeg developers",
  // The 2021 build on this PC's PATH: a date, not a number, so only libavcodec says how old it is.
  git2021: "ffmpeg version 2021-06-23-git-947122f111-full_build-www.gyan.dev Copyright (c) 2000-2021 the FFmpeg developers\n"
    + "libavutil      57.  0.100 / 57.  0.100\nlibavcodec     59.  0.100 / 59.  0.100\nlibavfilter     8.  0.102 /  8.  0.102",
  gitNew: "ffmpeg version N-128532-g5d85b7bfb2-20261106 Copyright (c) 2000-2026 the FFmpeg developers\nlibavcodec     63.  9.100 / 63.  9.100",
  git51: "ffmpeg version N-108000-gabc Copyright (c) 2000-2022 the FFmpeg developers\nlibavcodec     59. 37.100 / 59. 37.100",
  probe: "ffprobe version 6.1.1-3ubuntu5 Copyright (c) 2007-2023 the FFmpeg developers",
};

test("versions are read from release builds and from git builds (by their libavcodec)", () => {
  const v = (k) => parseFfmpegVersion(OUT[k]);
  assert.deepEqual([v("gyan9").major, v("gyan9").minor, v("gyan9").text], [9, 0, "9.0.2"]);
  assert.equal(v("brew").text, "7.1.1");
  assert.equal(v("ubuntu2204").text, "4.4.2");
  assert.equal(v("debian12").text, "5.1.6");
  assert.equal(v("btbn").text, "7.1");
  assert.equal(v("probe").text, "6.1.1");
  assert.deepEqual([v("git2021").major, v("git2021").minor, v("git2021").approx], [4, 4, true]);
  assert.deepEqual([v("git51").major, v("git51").minor], [5, 1]);
  assert.equal(v("gitNew").major, 9);
  assert.equal(parseFfmpegVersion("not ffmpeg at all"), null);
  assert.equal(parseFfmpegVersion(""), null);
});

test("too old means older than MIN_FFMPEG (5.1), and an unreadable version is never trusted", () => {
  assert.deepEqual(MIN_FFMPEG, { major: 5, minor: 1 });
  for (const k of ["ubuntu2204", "git2021"]) assert.equal(versionTooOld(parseFfmpegVersion(OUT[k])), true, k);
  for (const k of ["gyan9", "brew", "debian12", "btbn", "gitNew", "git51"]) assert.equal(versionTooOld(parseFfmpegVersion(OUT[k])), false, k);
  assert.equal(versionTooOld({ major: 5, minor: 0 }), true);
  assert.equal(versionTooOld(null), true);
});

// A fake machine: which files exist, what PATH holds, what each ffmpeg prints.
function machine({ files = [], path = {}, versions = {} } = {}) {
  const ran = [];
  return {
    ran,
    exists: (p) => files.includes(p),
    which: (exe) => path[exe] || "",
    run: (p) => { ran.push(p); return versions[p] || ""; },
  };
}

test("order: STUDIO_FFMPEG first, then the tools folder, then PATH", () => {
  const m = machine({ files: ["/env/ffmpeg", "/tools/ffmpeg"], path: { ffmpeg: "/usr/bin/ffmpeg" }, versions: { "/usr/bin/ffmpeg": OUT.brew } });
  const base = { toolsDir: "/tools", platform: "darwin", exists: m.exists, which: m.which, run: m.run };
  let r = resolveTool("ffmpeg", { ...base, env: { STUDIO_FFMPEG: "/env/ffmpeg" } });
  assert.deepEqual([r.source, r.path, r.usable], ["env", "/env/ffmpeg", true]);
  r = resolveTool("ffmpeg", { ...base, env: {} });
  assert.deepEqual([r.source, r.path, r.usable], ["tools", "/tools/ffmpeg", true]);
  r = resolveTool("ffmpeg", { ...base, env: {}, toolsDir: "/empty" });
  assert.deepEqual([r.source, r.path, r.version, r.usable], ["path", "/usr/bin/ffmpeg", "7.1.1", true]);
  assert.deepEqual(m.ran, ["/usr/bin/ffmpeg"], "only a PATH ffmpeg is run to read its version");
  r = resolveTool("ffprobe", { ...base, env: { STUDIO_FFMPEG: "/env/ffmpeg" }, toolsDir: "/empty" });
  assert.equal(r.found, false, "ffprobe has its own STUDIO_FFPROBE; STUDIO_FFMPEG does not choose it");
});

test("the tools folder is ffmpeg.exe on Windows and ffmpeg elsewhere (a Mac or Linux tools folder was never found)", () => {
  const win = machine({ files: ["D:\\data\\bin\\ffmpeg.exe"] });
  assert.equal(resolveTool("ffmpeg", { env: {}, toolsDir: "D:\\data\\bin", platform: "win32", ...win }).path, "D:\\data\\bin\\ffmpeg.exe");
  const mac = machine({ files: ["/Users/a/data/bin/ffmpeg"] });
  assert.equal(resolveTool("ffmpeg", { env: {}, toolsDir: "/Users/a/data/bin", platform: "darwin", ...mac }).source, "tools");
  assert.equal(resolveTool("ffmpeg", { env: {}, toolsDir: "/Users/a/data/bin", platform: "linux", ...machine({ files: ["/Users/a/data/bin/ffmpeg.exe"] }) }).found, false);
});

test("an old ffmpeg on PATH is found but flagged too old, never usable; a missing one is plainly missing", () => {
  const m = machine({ path: { "ffmpeg.exe": "C:\\ffmpeg\\bin\\ffmpeg.exe" }, versions: { "C:\\ffmpeg\\bin\\ffmpeg.exe": OUT.git2021 } });
  const r = resolveTool("ffmpeg", { env: {}, toolsDir: "D:\\data\\bin", platform: "win32", ...m });
  assert.deepEqual([r.found, r.tooOld, r.usable, r.source], [true, true, false, "path"]);
  const silent = machine({ path: { ffmpeg: "/usr/bin/ffmpeg" } });  // it does not even run
  assert.equal(resolveTool("ffmpeg", { env: {}, platform: "linux", ...silent }).usable, false);
  const none = resolveTool("ffmpeg", { env: {}, toolsDir: "/t", platform: "linux", ...machine() });
  assert.deepEqual([none.found, none.path, none.tooOld], [false, null, false]);
});

test("whichSync walks PATH with the system's separator", () => {
  const exists = (p) => p === "C:\\tools\\ffmpeg.exe" || p === "/opt/bin/ffmpeg";
  assert.equal(whichSync("ffmpeg.exe", { path: "C:\\nope;C:\\tools", platform: "win32", exists }), "C:\\tools\\ffmpeg.exe");
  assert.equal(whichSync("ffmpeg", { path: "/usr/bin:/opt/bin", platform: "linux", exists }), "/opt/bin/ffmpeg");
  assert.equal(whichSync("ffmpeg", { path: "", platform: "linux", exists }), "");
});

test("each system gets its own fix: Windows reruns setup, macOS brew, Linux the distro or a static build", () => {
  const old = { name: "ffmpeg", path: "/usr/bin/ffmpeg", version: "4.4.2", tooOld: true };
  const win = ffmpegFix("win32", "D:\\data\\bin");
  assert.match(win, /Run the setup again/); assert.match(win, /tools folder \(D:\\data\\bin\)/);
  const mac = ffmpegFix("darwin", "/x/bin", old);
  assert.match(mac, /brew install ffmpeg/); assert.match(mac, /4\.4\.2/); assert.match(mac, /older than 5\.1/);
  const linux = ffmpegFix("linux", "/x/bin");
  assert.match(linux, /sudo apt install ffmpeg/); assert.match(linux, /static build/);
  for (const t of [mac, linux]) assert.doesNotMatch(t, /\.exe|\\bin|STUDIO_DATA\\/, "no Windows paths on a Mac or Linux");
});

const strong = {
  threads: 32, cpuModel: "x", ramGb: 32, freeRamGb: 20, diskFreeGb: 400, reelGb: 0.5, dataDir: "/data",
  python: true, ffmpeg: true, dataWritable: true, mediaReachable: true, helper: "down", hardware: [],
};

test("the System page blocks a too-old PATH ffmpeg and says why, in the system's own words", () => {
  const r = judgeSystem({ ...strong, os: "darwin", toolsDir: "/data/bin",
    ffmpegInfo: { path: "/usr/local/bin/ffmpeg", source: "path", version: "4.4.2", tooOld: true } });
  const c = r.checks.find((x) => x.id === "ffmpeg");
  assert.equal(r.verdict, "blocked");
  assert.match(c.found, /4\.4\.2 on PATH · older than 5\.1/);
  assert.match(c.fix, /brew install ffmpeg/);
  const ok = judgeSystem({ ...strong, os: "linux", ffmpegInfo: { path: "/usr/bin/ffmpeg", source: "path", version: "6.1.1", tooOld: false } });
  assert.equal(ok.checks.find((x) => x.id === "ffmpeg").level, "ok");
  assert.equal(ok.checks.find((x) => x.id === "ffmpeg").found, "6.1.1 on PATH");
});

test("no fix on the System page names Windows paths on a Mac or Linux", () => {
  for (const os of ["darwin", "linux"]) {
    const r = judgeSystem({ ...strong, os, python: false, ffmpeg: false, dataWritable: false, toolsDir: "/data/bin" });
    const text = r.checks.map((c) => c.fix).join(" ");
    assert.doesNotMatch(text, /ffmpeg\.exe|STUDIO_DATA\\bin|Scripts\\python/, os);
    assert.match(r.checks.find((c) => c.id === "python").fix, os === "linux" ? /npm run setup/ : /Start Lazycow/);
  }
  const win = judgeSystem({ ...strong, os: "win32", ffmpeg: false, toolsDir: "E:\\studio\\bin" });
  assert.match(win.checks.find((c) => c.id === "ffmpeg").fix, /Start Lazycow.*E:\\studio\\bin/);
});
