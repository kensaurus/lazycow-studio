# lazycow

**Lazycow Studio from the command line, from your AI agent and from your code.**

[Lazycow Studio](https://github.com/kensaurus/lazycow-studio) turns the photos and videos you never edited into short vertical reels and YouTube trip films. It runs on your own computer, and a person approves every post. This package connects to it in three ways:

| You want to… | Run |
|:--|:--|
| Install the studio (no terminal skills needed after this line) | `npx lazycow install` |
| Let Claude Code, Claude Desktop or Cursor drive it | `claude mcp add lazycow -- npx -y lazycow mcp` |
| Script it from Node | `import { createClient } from "lazycow"` |

Approving a reel stays a person's job in the studio. Agents and scripts can make, plan and post approved reels. They cannot approve.

## Install the studio

```
npx lazycow install
```

It downloads this version's release zip from GitHub, checks it against the SHA-256 built into the package, unpacks it to `~/Lazycow Studio`, and starts the double-click setup. The setup installs Node, Python and ffmpeg for Lazycow only, in about 10 minutes. Options: `--dir <empty folder>`, `--yes` (take every suggestion).

Prefer to click? Download the zip from [Releases](https://github.com/kensaurus/lazycow-studio/releases), unzip it, read `README.TXT`, and double-click **Start Lazycow**.

## Connect an AI agent (MCP)

Claude Code:

```
claude mcp add lazycow -- npx -y lazycow mcp
```

Claude Desktop or Cursor (`claude_desktop_config.json` / `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "lazycow": { "command": "npx", "args": ["-y", "lazycow", "mcp"] }
  }
}
```

The server finds the studio by itself: `STUDIO_PORT` and `STUDIO_API_TOKEN` when set, else the `.env` in `LAZYCOW_DIR`, else the folder the setup recorded. So your agent config never holds a copy of the token. Tools: studio status, list and make reels, remix, plan and publish approved reels, jobs, projects, research, priced AI assist, performance. Full list: [docs/mcp.md](https://github.com/kensaurus/lazycow-studio/blob/main/docs/mcp.md).

Each tool answers with a plain sentence and the data, and the same data as `structuredContent` for programs (a list
arrives as `{ "items": [...] }`). Account secrets never leave the studio.

Listed in the official MCP Registry as `io.github.kensaurus/lazycow`.

## Use the API from code

```js
import { createClient } from "lazycow";

const studio = createClient();            // or createClient({ port: 4318, token: "..." })
const health = await studio.health();
const { reels } = await studio.overview();
const anything = await studio.request("GET", "/api/posts");
```

Every route is in the studio's [OpenAPI document](https://github.com/kensaurus/lazycow-studio/blob/main/docs/openapi.yaml). Errors are `StudioError` with `status`, `path` and `body`. Types are included.

From a shell:

```
npx lazycow status
npx lazycow api GET /api/posts
npx lazycow open
```

## Requirements

Node 20 or newer. The studio itself runs on Windows 10/11 and macOS 14+ (Apple silicon); Linux works from source.

## Credits and licence

Made by **kensaurus** (Kenji Sakuramoto, [kensaur.us](https://kensaur.us)). Apache-2.0: if you redistribute it or build on it, keep the `NOTICE` file, and please keep the line "Based on Lazycow Studio by kensaurus". "Lazycow" and the sleepy-cow icon are trademarks of kensaurus LLC ([TRADEMARKS.md](https://github.com/kensaurus/lazycow-studio/blob/main/TRADEMARKS.md)).

Like it? [Support Lazycow](https://github.com/kensaurus/lazycow-studio/blob/main/SUPPORTING.md): supporters get their feature requests looked at first.
