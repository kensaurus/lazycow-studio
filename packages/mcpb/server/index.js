// FILE: packages/mcpb/server/index.js (server/index.js inside lazycow.mcpb)
// PURPOSE: The Claude Desktop extension's entry: start the same MCP server as `npx -y lazycow mcp` (lib/mcp.mjs).
// NOTES: Claude Desktop passes each extension setting as an environment variable. A setting left empty can arrive as
//        "" or as the unreplaced "${user_config.…}"; both are dropped here, so the server falls back to the studio's
//        .env, as `npx lazycow mcp` does. scripts/build-mcpb.mjs packs this file. Part of Lazycow Studio by kensaurus
//        (https://kensaur.us). Apache-2.0.
for (const key of ["STUDIO_PORT", "STUDIO_API_TOKEN", "LAZYCOW_DIR"]) {
  const value = process.env[key];
  if (value !== undefined && (!value.trim() || value.includes("${"))) delete process.env[key];
}
await import("./lib/mcp.mjs");
