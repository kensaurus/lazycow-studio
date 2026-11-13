// The drop box (server/dropbox.mjs): only people on the local network, only with the current link, only photos and
// videos, never outside its folder; a sent file lands in <inbox>/<date>_<name>/ and the studio is told once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.STUDIO_DROP_PORT = "4391";  // never the studio's own drop box port
const { isPrivate, safeName, openDrop, closeDrop, dropState, lanAddress, saveUpload, dropPage } = await import("../server/dropbox.mjs");
const { createServer } = await import("node:http");

test("only private-network addresses count as people on this Wi-Fi", () => {
  for (const a of ["192.168.1.20", "10.0.0.5", "172.16.3.4", "172.31.255.1", "::ffff:192.168.0.9", "127.0.0.1", "::1", "fe80::1", "fd12::3"]) assert.equal(isPrivate(a), true, a);
  for (const a of ["8.8.8.8", "172.32.0.1", "100.64.0.1", "203.0.113.5", "2001:db8::1", ""]) assert.equal(isPrivate(a), false, a);
});

test("file names stay inside the folder and safe on Windows", () => {
  assert.equal(safeName("../../evil.jpg"), "evil.jpg");
  assert.equal(safeName("..\\..\\win.mov"), "win.mov");
  assert.equal(safeName("a:b?c.mov"), "a_b_c.mov");
  assert.equal(safeName(".hidden.jpg"), "hidden.jpg");
  assert.equal(safeName(""), "file");
  assert.equal(safeName("夕焼け 2026.HEIC"), "夕焼け 2026.HEIC");
});

test("a phone sends a photo; a wrong link, a wrong type and a short upload are refused", { skip: !lanAddress() && "this machine has no local network" }, async () => {
  const inbox = mkdtempSync(join(tmpdir(), "drop-"));
  let told = 0;
  const st = openDrop({ hours: 1, inbox, onFiles: () => { told += 1; } });
  try {
    assert.equal(st.open, true);
    const base = `http://127.0.0.1:4391/d/${st.url.split("/d/")[1]}`;
    const page = await fetch(base + "/");
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy"), /script-src 'self'/);
    assert.equal((await fetch("http://127.0.0.1:4391/d/not-the-token/")).status, 404);
    assert.equal((await fetch(base + "/up?name=setup.exe", { method: "POST", body: "MZ" })).status, 415);
    const ok = await fetch(`${base}/up?name=${encodeURIComponent("IMG_0001.JPG")}&who=${encodeURIComponent("Aki Tanaka")}`, { method: "POST", body: Buffer.from("not really a jpeg") });
    assert.equal(ok.status, 200);
    const again = await fetch(`${base}/up?name=IMG_0001.JPG&who=${encodeURIComponent("Aki Tanaka")}`, { method: "POST", body: Buffer.from("second") });
    assert.equal(again.status, 200);
    const [day] = readdirSync(inbox);
    assert.match(day, /^\d{4}-\d\d-\d\d_Aki-Tanaka$/);
    assert.deepEqual(readdirSync(join(inbox, day)).sort(), ["IMG_0001-1.JPG", "IMG_0001.JPG"]);
    assert.equal(readFileSync(join(inbox, day, "IMG_0001.JPG"), "utf8"), "not really a jpeg");
    assert.equal(dropState().received, 2);
  } finally {
    closeDrop();
  }
  assert.equal(told, 1, "the studio is told once when the drop box closes with new files");
  assert.equal(dropState().open, false);
});

test("files dropped on the studio page: saved without overwriting, wrong types refused, told once each", async () => {
  const inbox = mkdtempSync(join(tmpdir(), "drop-page-"));
  const saved = [];
  const srv = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    saveUpload(req, res, { inbox, name: u.searchParams.get("name"), folder: "2026-11-10_dropped", reply: (code, msg) => { res.writeHead(code); res.end(msg); }, onSaved: (x) => saved.push(x) });
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${srv.address().port}/?name=`;
  try {
    const put = (name, body) => fetch(base + encodeURIComponent(name), { method: "POST", body });
    assert.equal((await put("clip.mov", "AAAA")).status, 200);
    const again = await put("clip.mov", "BBBB");
    assert.equal(again.status, 200);
    assert.equal((await again.json()).name, "clip-1.mov");  // a second file with the same name keeps both
    assert.equal((await put("notes.txt", "x")).status, 415);
    assert.equal((await put("../../escape.jpg", "CC")).status, 200);
    const files = readdirSync(join(inbox, "2026-11-10_dropped")).sort();
    assert.deepEqual(files, ["clip-1.mov", "clip.mov", "escape.jpg"]);
    assert.equal(readFileSync(join(inbox, "2026-11-10_dropped", "clip.mov"), "utf8"), "AAAA");
    assert.equal(saved.length, 3);
  } finally { srv.close(); }
});

test("two uploads with the same name at once keep both files whole, and the studio keeps running (review 13 Nov)", async () => {
  const inbox = mkdtempSync(join(tmpdir(), "drop-same-"));
  const srv = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    saveUpload(req, res, { inbox, name: u.searchParams.get("name"), folder: "same", reply: (code, msg) => { res.writeHead(code); res.end(msg); } });
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  try {
    const put = (body) => fetch(`http://127.0.0.1:${srv.address().port}/?name=IMG_0001.JPG`, { method: "POST", body });
    const [a, b] = await Promise.all([put("A".repeat(200000)), put("B".repeat(200000))]);
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    const files = readdirSync(join(inbox, "same")).sort();
    assert.deepEqual(files, ["IMG_0001-1.JPG", "IMG_0001.JPG"], "two files, no .part left behind");
    const bodies = files.map((f) => readFileSync(join(inbox, "same", f), "utf8")).sort();
    assert.deepEqual(bodies, ["A".repeat(200000), "B".repeat(200000)], "neither was mixed with the other");
  } finally { srv.close(); }
});

test("the drop box page names the open project, escaped, and never the ranch by default", () => {
  const plain = dropPage("");
  assert.doesNotMatch(plain, /牧場|ranch/i);
  assert.match(plain, /このパソコン/);
  assert.match(plain, /this computer/);
  assert.doesNotMatch(plain + dropPage("Kawa Inn"), /\{PLACE|\{USE/);
  assert.match(dropPage("Kawa Inn"), /Kawa Inn's computer/);
  assert.match(dropPage("<img src=x>"), /&lt;img src=x&gt;/);
  assert.doesNotMatch(dropPage("<img src=x>"), /<img src=x>/);
});
