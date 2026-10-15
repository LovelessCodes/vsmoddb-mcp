#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerSessionTools } from "./tools/session.js";
import { registerModTools } from "./tools/mods.js";
import { registerReleaseTools } from "./tools/releases.js";
import { registerCommentTools } from "./tools/comments.js";
import { registerNotificationTools } from "./tools/notifications.js";

// Read the version from package.json (always shipped in the npm tarball) so it
// cannot drift from the published package, like a hardcoded string would.
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const server = new McpServer({
  name: "vsmoddb-mcp",
  version: pkg.version,
});

registerSessionTools(server);
registerModTools(server);
registerReleaseTools(server);
registerCommentTools(server);
registerNotificationTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
