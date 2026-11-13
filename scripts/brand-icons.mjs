/*
FILE: scripts/brand-icons.mjs
PURPOSE: Render the Lazycow mark (server/brand/lazycow-mark.svg) into the PNG app icons and favicon.ico.
USAGE: node scripts/brand-icons.mjs   (needs playwright-core and an installed Chrome or Edge)
NOTES: The maskable icon puts the mark inside the 80% safe circle on a full yellow square.
*/
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "server", "brand");
const svg = readFileSync(join(dir, "lazycow-mark.svg"), "utf8");
const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch({ channel: "msedge" }));
const page = await browser.newPage();

async function png(size, { maskable = false } = {}) {
  await page.setViewportSize({ width: size, height: size });
  const inner = maskable ? Math.round(size * 0.72) : size;
  await page.setContent(`<html><body style="margin:0;width:${size}px;height:${size}px;display:grid;place-items:center;background:${maskable ? "#FFD23F" : "transparent"}">
    <img src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}" width="${inner}" height="${inner}"></body></html>`);
  await page.waitForTimeout(50);
  return page.screenshot({ omitBackground: !maskable, type: "png" });
}

const sizes = [16, 32, 48, 180, 192, 512];
const out = {};
for (const s of sizes) { out[s] = await png(s); writeFileSync(join(dir, `icon-${s}.png`), out[s]); }
writeFileSync(join(dir, "icon-maskable-512.png"), await png(512, { maskable: true }));
await browser.close();

// favicon.ico: PNG-compressed entries for 16, 32 and 48 (supported by every current browser).
const ico = [16, 32, 48];
const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(ico.length, 4);
let offset = 6 + 16 * ico.length;
const entries = [], blobs = [];
for (const s of ico) {
  const b = out[s], e = Buffer.alloc(16);
  e.writeUInt8(s, 0); e.writeUInt8(s, 1); e.writeUInt8(0, 2); e.writeUInt8(0, 3);
  e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(b.length, 8); e.writeUInt32LE(offset, 12);
  offset += b.length; entries.push(e); blobs.push(b);
}
writeFileSync(join(dir, "favicon.ico"), Buffer.concat([header, ...entries, ...blobs]));
console.log("icons written:", sizes.map((s) => `icon-${s}.png`).join(", "), "+ icon-maskable-512.png, favicon.ico");
