import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { client, errorResult, pretty, textResult } from "./common.js";
import { scrapeMyMods } from "../html.js";

export function registerSessionTools(server: McpServer): void {
  server.registerTool(
    "moddb_status",
    {
      title: "ModDB session status",
      description:
        "Validate the configured Vintage Story ModDB session, refresh the action token, and report the logged-in account. Run this first when other tools complain about an invalid session.",
      annotations: { readOnlyHint: true },
      inputSchema: {},
    },
    async () => {
      try {
        const { hash } = await client.ensureSession(true);
        let player: string | undefined;
        try {
          const page = await client.get(`/show/user/${hash}`);
          player = /<meta property="og:title" content="([^"]+)"/.exec(page.text)?.[1];
        } catch {
          // Name is a nice-to-have only.
        }
        return textResult(
          pretty({
            status: "ok",
            player,
            user_hash: hash,
            base_url: client.baseUrl,
            session_file: client.sessionFile,
          }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "list_my_mods",
    {
      title: "List my ModDB mods",
      description:
        "List the mods the logged-in account contributes to (the 'Your mod contributions' section of mods.vintagestory.at/home). Use the returned names/paths with get_mod, upload_release, update_mod, etc.",
      annotations: { readOnlyHint: true },
      inputSchema: {},
    },
    async () => {
      try {
        const res = await client.getLoggedIn("/home");
        const mods = scrapeMyMods(res.text);
        return textResult(
          pretty({
            count: mods.length,
            mods: mods.map((m) => ({ name: m.name, path: m.path, url: m.url, summary: m.summary })),
          }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
