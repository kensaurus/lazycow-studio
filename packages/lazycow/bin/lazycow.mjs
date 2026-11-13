#!/usr/bin/env node
/**
 * FILE: packages/lazycow/bin/lazycow.mjs
 * PURPOSE: The `lazycow` command: connect AI agents (mcp), install the studio, open it, check it, call its API.
 * Part of Lazycow Studio by kensaurus (https://kensaur.us). Apache-2.0.
 */
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

const PKG = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const [cmd = "help", ...rest] = process.argv.slice(2);

const HELP = `lazycow ${PKG.version}: Lazycow Studio from the command line. By kensaurus, https://kensaur.us

  npx lazycow install [--dir <folder>] [--yes]   Download, check (SHA-256) and set up the studio
  npx lazycow open                               Open the studio in your browser
  npx lazycow status                             Is the studio running, and is this computer ready
  npx -y lazycow mcp                             MCP server for Claude Code, Claude Desktop, Cursor
  npx lazycow api <GET|POST> <path> [json]       Call any studio API route (docs/openapi.yaml)

Connect Claude Code:   claude mcp add lazycow -- npx -y lazycow mcp
Finds the studio by STUDIO_PORT / STUDIO_API_TOKEN, else LAZYCOW_DIR's .env, else the folder the setup recorded.
Approving a reel stays a person's job in the studio. Agents and scripts cannot approve.

Code:     https://github.com/kensaurus/lazycow-studio  (Apache-2.0, keep the NOTICE)
Support:  https://github.com/kensaurus/lazycow-studio/blob/main/SUPPORTING.md`;

function flag(name) {
  const i = rest.indexOf(name);
  if (i < 0) return undefined;
  const v = rest[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

function fail(err) {
  process.stderr.write(`lazycow: ${err?.message || err}\n`);
  process.exit(1);
}

function openUrl(url) {
  const [c, a] = process.platform === "win32" ? ["cmd.exe", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  spawn(c, a, { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
}

try {
  switch (cmd) {
    case "mcp":
      await import("../lib/mcp.mjs");
      break;
    case "install": {
      const { install } = await import("../lib/install.mjs");
      const dir = flag("--dir"), zip = flag("--zip");
      await install({ dir: typeof dir === "string" ? dir : undefined, zip: typeof zip === "string" ? zip : undefined,
        yes: !!flag("--yes"), noStart: !!flag("--no-start") });
      break;
    }
    case "status": {
      const { createClient } = await import("../lib/client.mjs");
      const c = createClient();
      const h = await c.health();
      const ok = h && (h.ok ?? true);
      process.stdout.write(`Lazycow Studio ${h?.version || "?"} is running at ${c.base}${ok ? "" : " (it reports a problem)"}\n`);
      if (rest.includes("--json")) process.stdout.write(JSON.stringify(h, null, 2) + "\n");
      break;
    }
    case "open": {
      const { createClient } = await import("../lib/client.mjs");
      const c = createClient();
      await c.health();
      openUrl(c.base + "/");
      process.stdout.write(`Opened ${c.base}\n`);
      break;
    }
    case "api": {
      const [method, path, json] = rest;
      if (!method || !path) fail("usage: lazycow api <GET|POST> <path> [json]");
      const { createClient } = await import("../lib/client.mjs");
      let body;
      if (json !== undefined) { try { body = JSON.parse(json); } catch { fail("the body must be JSON"); } }
      const out = await createClient().request(method, path, body);
      process.stdout.write((typeof out === "string" ? out : JSON.stringify(out, null, 2)) + "\n");
      break;
    }
    case "-v": case "--version": case "version":
      process.stdout.write(PKG.version + "\n");
      break;
    case "-h": case "--help": case "help":
      process.stdout.write(HELP + "\n");
      break;
    default:
      fail(`unknown command "${cmd}". Try: npx lazycow help`);
  }
} catch (err) {
  fail(err);
}
