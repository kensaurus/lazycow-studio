/**
 * FILE: packages/lazycow/lib/install.mjs
 * PURPOSE: `lazycow install`: download this version's release zip, check it against the SHA-256 baked into this
 *          package, unpack it, and start the double-click setup.
 * OVERVIEW: The zip and its hash come from the same release as this package (lib/release.json, written by
 *           scripts/build-packages.mjs), so a changed or swapped download is refused. Nothing runs before the hash
 *           matches. The setup itself (scripts/bootstrap in the zip) pins and checks its own downloads.
 * DEPENDENCIES: node:crypto, node:fs, node:os, node:path, node:child_process, global fetch
 * Part of Lazycow Studio by kensaurus (https://kensaur.us). Apache-2.0.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const RELEASE = JSON.parse(readFileSync(new URL("./release.json", import.meta.url), "utf8"));

export function release() { return RELEASE; }

export function defaultDir() {
  return join(homedir(), "Lazycow Studio");
}

export async function sha256File(file) {
  const h = createHash("sha256");
  await pipeline(createReadStream(file), h);
  return h.digest("hex");
}

function say(msg) { process.stderr.write(msg + "\n"); }

async function download(url, file) {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(15 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status} from ${url}`);
  const total = Number(res.headers.get("content-length")) || 0;
  let got = 0, shown = -1;
  const counted = Readable.fromWeb(res.body).on("data", (c) => {
    got += c.length;
    const pct = total ? Math.floor((got / total) * 10) : -1;
    if (pct !== shown && pct >= 0) { shown = pct; process.stderr.write(`\r  ${pct * 10}% of ${(total / 1e6).toFixed(0)} MB`); }
  });
  await pipeline(counted, createWriteStream(file));
  if (total) process.stderr.write("\n");
}

function unzip(zip, into) {
  mkdirSync(into, { recursive: true });
  // Windows: its own bsdtar by full path (a "tar" earlier on PATH, such as Git's GNU tar, reads "C:" as a host),
  // then PowerShell's Expand-Archive.
  const sys = join(process.env.SystemRoot || "C:\\Windows", "System32");
  const tries = process.platform === "win32" ? [[join(sys, "tar.exe"), ["-xf", zip, "-C", into]],
    [join(sys, "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-Command", "Expand-Archive", "-LiteralPath", zip, "-DestinationPath", into, "-Force"]]]
    : process.platform === "darwin" ? [["ditto", ["-x", "-k", zip, into]], ["unzip", ["-q", zip, "-d", into]]]
    : [["unzip", ["-q", zip, "-d", into]], ["bsdtar", ["-xf", zip, "-C", into]]];
  for (const [cmd, args] of tries) {
    const r = spawnSync(cmd, args, { stdio: "inherit" });
    if (r.status === 0) return;
  }
  throw new Error(`Could not unpack ${zip}. Unzip it yourself, then double-click "Start Lazycow".`);
}

/**
 * @param {{ dir?: string, zip?: string, yes?: boolean, noStart?: boolean, url?: string }} opts
 * @returns {Promise<{ dir: string, sha256: string, started: boolean }>}
 */
export async function install(opts = {}) {
  const dir = resolve(opts.dir || defaultDir());
  if (existsSync(join(dir, "package.json"))) {
    let name = "";
    try { name = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name; } catch { /* not ours */ }
    if (name === "lazycow-studio") throw new Error(`Lazycow Studio is already in ${dir}. Open it with: npx lazycow open (or double-click "Start Lazycow" there).`);
  }
  if (existsSync(dir) && statSync(dir).isDirectory() && readdirSync(dir).length) {
    throw new Error(`${dir} is not empty. Choose an empty or new folder: npx lazycow install --dir "<folder>"`);
  }

  const work = join(tmpdir(), `lazycow-${RELEASE.version}-${process.pid}`);
  mkdirSync(work, { recursive: true });
  try {
    let zip = opts.zip ? resolve(opts.zip) : join(work, RELEASE.zip);
    if (!opts.zip) {
      const url = opts.url || RELEASE.url;
      say(`Downloading Lazycow Studio ${RELEASE.version} from ${url}`);
      await download(url, zip);
    }
    const got = await sha256File(zip);
    if (got !== RELEASE.sha256) {
      throw new Error(`The download does not match this release (SHA-256 ${got}, expected ${RELEASE.sha256}). Nothing was installed.`);
    }
    say(`SHA-256 ok: ${got}`);

    const unpacked = join(work, "unpacked");
    unzip(zip, unpacked);
    const top = readdirSync(unpacked);
    const inner = top.length === 1 && statSync(join(unpacked, top[0])).isDirectory() ? join(unpacked, top[0]) : unpacked;
    if (!existsSync(join(inner, "README.TXT"))) throw new Error("The zip does not look like a Lazycow Studio release (no README.TXT).");
    mkdirSync(resolve(dir, ".."), { recursive: true });
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });  // empty, checked above
    renameSync(inner, dir);
    say(`Unpacked to ${dir}`);
    say(`Read README.TXT there first. It is 1997 in there.`);

    if (opts.noStart) return { dir, sha256: got, started: false };
    if (process.platform === "win32") {
      const ps = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(dir, "scripts", "bootstrap", "windows.ps1")];
      if (opts.yes) ps.push("-Yes");
      spawn("cmd.exe", ["/c", "start", "\"Lazycow Studio setup\"", "powershell", ...ps.map((a) => (/\s/.test(a) ? `"${a}"` : a))],
        { detached: true, stdio: "ignore", windowsVerbatimArguments: true }).unref();
      say("The setup opened in a new window. It installs Node, Python and ffmpeg for Lazycow only (about 10 minutes).");
      return { dir, sha256: got, started: true };
    }
    if (process.platform === "darwin") {
      spawn("open", [join(dir, "Start Lazycow.command")], { detached: true, stdio: "ignore" }).unref();
      say("The setup opened in Terminal. It installs Node, Python and ffmpeg for Lazycow only.");
      return { dir, sha256: got, started: true };
    }
    say(`On Linux, run it from that folder: npm ci && npm run setup && npm run review (see README.md).`);
    return { dir, sha256: got, started: false };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
