import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ModdbError } from "../client.js";
import { scrapeNotifications } from "../html.js";
import { client, errorFromResponse, errorResult, pretty, textResult } from "./common.js";

export function registerNotificationTools(server: McpServer): void {
  server.registerTool(
    "list_notifications",
    {
      title: "List ModDB notifications",
      description:
        "List the logged-in account's ModDB notifications (new comments, mentions, releases of followed mods, ...). Comment notifications are the quickest way to find comments awaiting a reply on your mods.",
      annotations: { readOnlyHint: true },
      inputSchema: {},
    },
    async () => {
      try {
        const res = await client.getLoggedIn("/notifications");
        const notes = scrapeNotifications(res.text);
        return textResult(
          pretty({
            count: notes.length,
            notifications: notes.map((n) => ({
              id: n.id,
              text: n.text,
              when: n.date,
              link: n.link ? new URL(n.link, client.baseUrl).toString() : undefined,
            })),
          }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "mark_notifications_read",
    {
      title: "Mark ModDB notifications as read",
      description: "Mark specific notifications (ids) or all notifications (all: true) as read.",
      annotations: { readOnlyHint: false },
      inputSchema: {
        ids: z.array(z.number().int()).optional().describe("Notification ids from list_notifications"),
        all: z.boolean().default(false).describe("Mark every unread notification as read"),
      },
    },
    async ({ ids, all }) => {
      try {
        let list = ids ?? [];
        if (all) {
          const res = await client.getLoggedIn("/notifications");
          list = scrapeNotifications(res.text).map((n) => n.id);
        }
        if (!list.length) {
          return textResult(pretty({ ok: true, cleared: 0, note: "Nothing to do: pass ids or all: true." }));
        }
        const res = await client.apiV2("POST", "/api/v2/notifications/clear", {
          form: { ids: list.join(",") },
        });
        if (res.status !== 200) {
          throw new ModdbError(`Clearing notifications failed (HTTP ${res.status}): ${errorFromResponse(res)}`, res.status);
        }
        return textResult(pretty({ ok: true, cleared: list.length, ids: list }));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
