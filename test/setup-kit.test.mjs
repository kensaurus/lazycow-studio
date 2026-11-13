// The double-click setup (README.TXT, Start Lazycow, scripts/bootstrap) and the 90s pop-up tour: what a person who has
// never opened a terminal relies on. A real install is tested by hand (scripts/bootstrap/README.md); these keep the
// pieces honest between releases.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const has = (p) => existsSync(new URL(`../${p}`, import.meta.url));
const V = JSON.parse(read("scripts/bootstrap/versions.json"));

test("every download is pinned to an official https URL and a SHA-256", () => {
  const items = [V.node["win-x64"], V.node["darwin-arm64"], V.uv["win-x64"], V.uv["darwin-arm64"], V.ffmpeg["win-x64"], V.ffmpeg["darwin-arm64"].ffmpeg, V.ffmpeg["darwin-arm64"].ffprobe];
  for (const it of items) {
    assert.match(it.url, /^https:\/\/(nodejs\.org\/dist\/|github\.com\/(astral-sh\/uv|GyanD\/codexffmpeg)\/releases\/download\/|ffmpeg\.martin-riedl\.de\/download\/)/, it.url);
    assert.match(it.sha256, /^[0-9a-f]{64}$/, it.url);
  }
  assert.ok(V.node["win-x64"].url.includes(`v${V.node.version}/`) && V.uv["win-x64"].url.includes(`/${V.uv.version}/`) && V.ffmpeg["win-x64"].url.includes(`/${V.ffmpeg.version}/`), "the version and the URL agree");
});

test("the Python packages are locked with hashes for Windows (CPU torch) and Mac", () => {
  for (const f of ["py/requirements-win.lock", "py/requirements-mac.lock"]) {
    const lock = read(f);
    assert.match(lock, /^torch==2\.\d+\.\d+/m, f);
    assert.match(lock, /^open-clip-torch==/m, f);
    assert.ok((lock.match(/--hash=sha256:[0-9a-f]{64}/g) || []).length > 50, `${f} carries hashes`);
  }
  assert.match(read("py/requirements-win.lock"), /^torch==[\d.]+\+cpu/m, "Windows gets the CPU build, not a 2 GB CUDA one");
});

test("README.TXT walks through the steps and the files it names exist", () => {
  const txt = read("README.TXT");
  for (const n of [1, 2, 3, 4, 5, 6, 7]) assert.match(txt, new RegExp(`STEP ${n}\\.`), `STEP ${n}`);
  assert.match(txt, /There is no step 7/);
  assert.match(txt, /No crack\. It is free\./);
  for (const f of ["Start Lazycow.cmd", "Start Lazycow.command", "scripts/bootstrap/windows.ps1", "scripts/bootstrap/mac.sh", "scripts/bootstrap/versions.json", "SUPPORTING.md", "AUTORUN.INF"]) assert.ok(has(f), f);
});

test("Start Lazycow runs the installer the first time and the app after that", () => {
  const cmd = read("Start Lazycow.cmd");
  assert.match(cmd, /-ExecutionPolicy Bypass -File "%~dp0scripts\\bootstrap\\windows\.ps1"/);
  assert.match(cmd, /%LOCALAPPDATA%\\Lazycow\\node\\node\.exe.*scripts\\app\.mjs/s);
  const mac = read("Start Lazycow.command");
  assert.match(mac, /bash scripts\/bootstrap\/mac\.sh/);
  const attrs = read(".gitattributes");
  assert.match(attrs, /\*\.cmd text eol=crlf/); assert.match(attrs, /\*\.ps1 text eol=crlf/); assert.match(attrs, /\*\.sh text eol=lf/); assert.match(attrs, /\*\.command text eol=lf/);
});

test("the Windows installer checks every download and never lets a native program's stderr stop it", () => {
  const ps = read("scripts/bootstrap/windows.ps1");
  assert.match(ps, /Get-FileHash \$out -Algorithm SHA256/);
  assert.match(ps, /Remove-Item \$out -Force/, "a file with the wrong hash is deleted");
  // Windows PowerShell 5.1 + "Stop" + `2>&1` on a native program = the first progress line on stderr ends setup (13 Nov).
  assert.doesNotMatch(ps, /&\s*\$\w+[^\n]*2>&1\s*\|\s*Tee-Object/, "native calls go through Run, which sets Continue");
  assert.match(ps, /function Run\(/);
  assert.doesNotMatch(ps, /\bAdd-MpPreference|Set-ExecutionPolicy|\[Environment\]::SetEnvironmentVariable\("PATH"/, "nothing system-wide");
});

test("the server started from a shortcut finds npx: launch puts its own Node first on PATH", () => {
  const launch = read("scripts/launch.mjs");
  assert.match(launch, /dirname\(process\.execPath\)/);
});

test("the 90s pop-up tour is opt-in, capped, and closes with Esc", () => {
  const html = read("server/editor.html");
  assert.match(html, /data-pop="1"/, "the DO NOT CLICK button");
  assert.match(html, /MAX_OPEN: (\d+), MAX_ALL: (\d+)/);
  const [, open, all] = /MAX_OPEN: (\d+), MAX_ALL: (\d+)/.exec(html).map(Number);
  assert.ok(open <= 12 && all <= 50, "capped, so it stays fun");
  assert.match(html, /e\.key === "Escape" && \(POP\.on/);
  assert.match(html, /just close the browser lol/);
  const tour = html.slice(html.indexOf("const POP = {"), html.indexOf("document.addEventListener(\"keydown\", (e) => { if (e.key === \"Escape\" && (POP.on"));
  assert.doesNotMatch(tour, /window\.open\(/, "never real tabs or windows");
});
