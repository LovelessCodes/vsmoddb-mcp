import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ModdbError } from "../client.js";
import { markdownToHtml } from "../markdown.js";
import { scrapeComments } from "../html.js";
import { client, errorFromResponse, errorResult, modPagePath, pretty, resolveMod, textResult, unixToIso } from "./common.js";

export function registerCommentTools(server: McpServer): void {
  server.registerTool(
    "list_comments",
    {
      title: "List ModDB comments",
      description:
        "List comments on a mod's ModDB page, newest first. Accepts a mod name, numeric id, or URL alias. Returns comment ids for reply_to_comment, edit_comment and delete_comment.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        mod: z.string().describe("Mod identifier: numeric id, or URL alias / mod id string (e.g. 'carrycapacity')"),
        limit: z.number().int().min(1).max(200).default(25).describe("Maximum number of comments to return (newest first)"),
        include_deleted: z.boolean().default(false).describe("Include comments that were hidden/deleted"),
      },
    },
    async ({ mod, limit, include_deleted }) => {
      try {
        const info = await resolveMod(mod);
        const page = await client.get(modPagePath(info));
        let comments = scrapeComments(page.text);
        if (!include_deleted) comments = comments.filter((c) => !c.deleted);
        comments.sort((a, b) => (b.createdUnix ?? 0) - (a.createdUnix ?? 0));
        const shown = comments.slice(0, limit);
        return textResult(
          pretty({
            mod: info.name,
            mod_page: `${client.baseUrl}${modPagePath(info)}`,
            total_visible: comments.length,
            showing: shown.length,
            comments: shown.map((c) => ({
              id: c.id,
              user: c.user,
              date: unixToIso(c.createdUnix),
              reply_to: c.parentId && c.parentId !== c.id ? c.parentId : undefined,
              text: c.text,
            })),
          }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "reply_to_comment",
    {
      title: "Reply to a ModDB comment",
      description:
        "Post a reply to a comment on a mod's ModDB page. The text is Markdown (converted to HTML). Use only user-approved wording; the ModDB rules prohibit bot-like/spammy commenting.",
      annotations: { readOnlyHint: false },
      inputSchema: {
        mod: z.string().describe("Mod identifier: numeric id, URL alias, or mod id string"),
        comment_id: z.number().int().describe("Id of the comment to reply to (from list_comments)"),
        text: z.string().min(1).describe("Reply content in Markdown"),
      },
    },
    async ({ mod, comment_id, text }) => {
      try {
        const info = await resolveMod(mod);
        const html = markdownToHtml(text);
        const res = await client.apiV2("PUT", `/api/v2/mods/${info.modid}/comments`, {
          query: { "response-to": comment_id },
          contentType: "text/html",
          body: html,
        });
        if (res.status !== 201) {
          throw new ModdbError(`Posting the reply failed (HTTP ${res.status}): ${errorFromResponse(res)}`, res.status);
        }
        const location = res.headers.get("location") ?? "";
        const created = /#cmt-(\d+)/.exec(location)?.[1];
        return textResult(
          pretty({
            ok: true,
            comment_id: created ? Number(created) : undefined,
            url: `${client.baseUrl}${modPagePath(info)}#cmt-${created ?? ""}`,
            posted_html: res.text,
          }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "edit_comment",
    {
      title: "Edit a ModDB comment",
      description:
        "Edit one of your own comments (or any comment if you are a moderator). The text is Markdown and replaces the current content entirely.",
      annotations: { readOnlyHint: false },
      inputSchema: {
        comment_id: z.number().int().describe("Id of the comment to edit"),
        text: z.string().min(1).describe("New comment content in Markdown (replaces the old content)"),
      },
    },
    async ({ comment_id, text }) => {
      try {
        const res = await client.apiV2("POST", `/api/v2/comments/${comment_id}`, {
          contentType: "text/html",
          body: markdownToHtml(text),
        });
        if (res.status !== 200) {
          throw new ModdbError(`Editing the comment failed (HTTP ${res.status}): ${errorFromResponse(res)}`, res.status);
        }
        return textResult(pretty({ ok: true, comment_id, updated_html: res.text }));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "delete_comment",
    {
      title: "Delete a ModDB comment",
      description: "Delete one of your own comments (irreversible; requires confirm: true).",
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        comment_id: z.number().int().describe("Id of the comment to delete"),
        confirm: z.boolean().describe("Must be true to delete; a guard against accidental deletions"),
      },
    },
    async ({ comment_id, confirm }) => {
      try {
        if (!confirm) throw new ModdbError("Refusing to delete without confirm: true.");
        const res = await client.apiV2("DELETE", `/api/v2/comments/${comment_id}`, { form: {} });
        if (res.status !== 200) {
          throw new ModdbError(`Deleting the comment failed (HTTP ${res.status}): ${errorFromResponse(res)}`, res.status);
        }
        return textResult(pretty({ ok: true, comment_id, deleted: true }));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
