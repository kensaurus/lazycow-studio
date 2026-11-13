# test

`npm test` runs the safe-zone and fact-guard checks (`story.test.mjs`) and the language check (`i18n.test.mjs`: every English label in the editor has a Japanese one, and every label the page asks for exists). Python tests live in `py/tests`. `mcp.test.mjs` drives the MCP server (`server/mcp.mjs`) against a fake studio on a random port: the handshake, the tool list, a read, the refusal to publish an unapproved reel, and the "studio not running" error.

| File | Checks |
|:--|:--|
| `story.test.mjs`, `layout.test.mjs` | Safe zones, text boxes and the fact guard |
| `looks.test.mjs`, `palette.test.mjs` | Cut styles and colours |
| `i18n.test.mjs` | Every English label has a Japanese one |
| `helper.test.mjs`, `chrome-bridge.test.mjs` | The Chrome helper and the Chrome link |
| `health.test.mjs` | The machine check and restart rules |
| `mcp.test.mjs`, `perf-mcp.test.mjs` | The MCP server's tools and the results tools |
| `profiles.test.mjs` | Profile kits |

Run `npm test` (Node) and `cd py && PYTHONPATH=. <venv python> -m pytest -q` (Python). `npx tsc --noEmit -p .` has two known errors (`document.fonts.add` in `src/Story.tsx` and `src/brand.ts`).
