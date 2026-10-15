#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerSessionTools } from "./tools/session.js";
import { registerModTools } from "./tools/mods.js";
import { registerReleaseTools } from "./tools/releases.js";
import { registerCommentTools } from "./tools/comments.js";
import { registerNotificationTools } from "./tools/notifications.js";

const server = new McpServer({
  name: "vsmoddb-mcp",
  version: "0.1.1",
});

registerSessionTools(server);
registerModTools(server);
registerReleaseTools(server);
registerCommentTools(server);
registerNotificationTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
