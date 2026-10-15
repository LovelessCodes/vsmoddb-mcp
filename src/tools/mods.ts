import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ModdbError } from "../client.js";
import { selectOptionsFromHtml, serializeForm } from "../html.js";
import { markdownToHtml } from "../markdown.js";
import { assertFormSaveSucceeded } from "../client.js";
import { client, errorFromResponse, errorResult, htmlToText, pretty, resolveMod, textResult } from "./common.js";

export function registerModTools(server: McpServer): void {
  server.registerTool(
    "get_mod",
    {
      title: "Get ModDB mod info",
      description:
        "Fetch a mod's public ModDB metadata: ids, tags, links, stats and the release list (with release ids and compatible game versions). Accepts mod name, numeric id, or URL alias.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        mod: z.string().describe("Mod identifier: numeric id, URL alias, or mod id string (e.g. 'carrycapacity')"),
        include_description: z.boolean().default(false).describe("Include the full description as plain text"),
        include_changelogs: z.boolean().default(false).describe("Include each release's changelog as plain text"),
        release_limit: z.number().int().min(1).max(100).default(20).describe("How many (newest) releases to list"),
      },
    },
    async ({ mod, include_description, include_changelogs, release_limit }) => {
      try {
        const info = await resolveMod(mod);
        const releases = info.releases.slice(0, release_limit).map((r) => ({
          release_id: r.release_id,
          version: r.version,
          game_versions: r.game_versions,
          filename: r.filename,
          downloads: r.downloads,
          created: r.created,
          changelog: include_changelogs ? htmlToText(r.changelog_html ?? "") : undefined,
        }));
        return textResult(
          pretty({
            modid: info.modid,
            assetid: info.assetid,
            name: info.name,
            urlalias: info.urlalias,
            url: `${client.baseUrl}${info.urlalias ? `/${info.urlalias}` : `/show/mod/${info.assetid}`}`,
            type: info.type,
            side: info.side,
            tags: info.tags,
            links: {
              homepage: info.homepage_url,
              source_code: info.source_code_url,
              issue_tracker: info.issue_tracker_url,
              wiki: info.wiki_url,
              trailer_video: info.trailer_video_url,
            },
            downloads: info.downloads,
            follows: info.follows,
            release_count: info.releases.length,
            releases,
            description: include_description ? htmlToText(info.description_html) : undefined,
          }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "update_mod",
    {
      title: "Update ModDB mod description/metadata",
      description:
        "Update a mod's ModDB page: description, summary, name, URL alias, links, side, and tags. Only the provided fields are changed; everything else (including team members, images, status) is preserved. 'description' REPLACES the whole description, so provide the full new text in Markdown. 'tags' replaces the full tag list; use add_tags/remove_tags for incremental changes.",
      annotations: { readOnlyHint: false },
      inputSchema: {
        mod: z.string().describe("Mod identifier: numeric id, URL alias, or mod id string"),
        description: z.string().optional().describe("Full new description in Markdown (replaces the current description)"),
        description_html: z.string().optional().describe("Full new description as raw HTML (takes precedence over 'description')"),
        summary: z.string().max(100).optional().describe("New short summary (max 100 chars)"),
        name: z.string().optional().describe("New mod name"),
        url_alias: z.string().optional().describe("New URL alias (letters only)"),
        homepage_url: z.string().optional().describe("Homepage/forum post URL"),
        source_code_url: z.string().optional().describe("Source code URL"),
        issue_tracker_url: z.string().optional().describe("Issue tracker URL"),
        wiki_url: z.string().optional().describe("Wiki URL"),
        donate_url: z.string().optional().describe("Donation URL"),
        trailer_video_url: z.string().optional().describe("Trailer video URL"),
        side: z.string().optional().describe("Mod side: 'client', 'server' or 'both'"),
        tags: z.array(z.string()).optional().describe("Full replacement list of tag names"),
        add_tags: z.array(z.string()).optional().describe("Tag names to add (applied before remove_tags)"),
        remove_tags: z.array(z.string()).optional().describe("Tag names to remove"),
      },
    },
    async (params) => {
      try {
        const changes: string[] = [];
        const info = await resolveMod(params.mod);
        const page = await client.getLoggedIn(`/edit/mod/?assetid=${info.assetid}`);
        if (page.status === 403) {
          throw new ModdbError(`You do not have edit permission for "${info.name}".`);
        }
        const fields = serializeForm(page.text, "form[name='form1']");
        if (!fields["save"]) {
          throw new ModdbError(
            `Could not load the edit form for "${info.name}" (are you a team member with edit permissions?).`,
          );
        }

        if (params.description_html !== undefined) {
          fields["text"] = params.description_html;
          changes.push("description (html)");
        } else if (params.description !== undefined) {
          fields["text"] = markdownToHtml(params.description);
          changes.push("description");
        }
        if (params.summary !== undefined) {
          fields["summary"] = params.summary;
          changes.push("summary");
        }
        if (params.name !== undefined) {
          fields["name"] = params.name;
          changes.push("name");
        }
        if (params.url_alias !== undefined) {
          fields["urlAlias"] = params.url_alias;
          changes.push("url_alias");
        }
        const urlOverrides: Array<[string | undefined, string, string]> = [
          [params.homepage_url, "homepageUrl", "homepage_url"],
          [params.source_code_url, "sourceCodeUrl", "source_code_url"],
          [params.issue_tracker_url, "issueTrackerUrl", "issue_tracker_url"],
          [params.wiki_url, "wikiUrl", "wiki_url"],
          [params.donate_url, "donateUrl", "donate_url"],
          [params.trailer_video_url, "trailerVideoUrl", "trailer_video_url"],
        ];
        for (const [value, formKey, label] of urlOverrides) {
          if (value !== undefined) {
            fields[formKey] = value;
            changes.push(label);
          }
        }
        if (params.side !== undefined) {
          const options = selectOptionsFromHtml(page.text, "side");
          const wanted = params.side.trim().toLowerCase();
          const match =
            options.find((o) => o.value.toLowerCase() === wanted) ??
            options.find((o) => o.label.toLowerCase() === wanted) ??
            options.find((o) => o.label.toLowerCase().startsWith(wanted));
          if (!match) {
            throw new ModdbError(
              `Unknown side "${params.side}". Valid options: ${options.map((o) => `${o.label} (${o.value})`).join(", ")}`,
            );
          }
          fields["side"] = match.value;
          changes.push("side");
        }

        const tagOptions = selectOptionsFromHtml(page.text, "tagids[]");
        const tagIdByName = new Map<string, string>();
        for (const option of tagOptions) {
          const cleanLabel = option.label.replace(/\s*\(\d+\)\s*$/, "").trim().toLowerCase();
          if (cleanLabel && !tagIdByName.has(cleanLabel)) tagIdByName.set(cleanLabel, option.value);
        }
        const resolveTagIds = (names: string[]): string[] => {
          const unknown: string[] = [];
          const ids: string[] = [];
          for (const name of names) {
            const id = tagIdByName.get(name.trim().toLowerCase());
            if (id === undefined) unknown.push(name);
            else if (!ids.includes(id)) ids.push(id);
          }
          if (unknown.length) {
            throw new ModdbError(
              `Unknown tag(s): ${unknown.join(", ")}. Tags must already exist on the ModDB (see the tag list on the mod edit page); use add_mod_tags to create new user-defined tags.`,
            );
          }
          return ids;
        };

        if (params.tags !== undefined) {
          fields["tagids[]"] = resolveTagIds(params.tags);
          changes.push("tags (replaced)");
        } else if (params.add_tags?.length || params.remove_tags?.length) {
          const current = new Set(
            (Array.isArray(fields["tagids[]"]) ? fields["tagids[]"] : fields["tagids[]"] ? [fields["tagids[]"] as string] : []) as string[],
          );
          for (const id of resolveTagIds(params.add_tags ?? [])) current.add(id);
          for (const id of resolveTagIds(params.remove_tags ?? [])) current.delete(id);
          fields["tagids[]"] = [...current];
          changes.push("tags");
        }

        if (!changes.length) {
          throw new ModdbError("No changes requested: provide at least one field to update.");
        }

        const res = await client.postForm(`/edit/mod/?assetid=${info.assetid}`, fields);
        assertFormSaveSucceeded(res, `Updating "${info.name}"`);
        return textResult(
          pretty({
            ok: true,
            mod: info.name,
            changed: changes,
            url: `${client.baseUrl}${info.urlalias ? `/${info.urlalias}` : `/show/mod/${info.assetid}`}`,
          }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "add_mod_tags",
    {
      title: "Add tags to a mod",
      description:
        "Add tags to a mod via the ModDB v2 API. Unlike update_mod's tag list, names that do not exist yet are created as new user-defined tags.",
      annotations: { readOnlyHint: false },
      inputSchema: {
        mod: z.string().describe("Mod identifier: numeric id, URL alias, or mod id string"),
        tags: z.array(z.string()).min(1).describe("Tag names to add"),
      },
    },
    async ({ mod, tags }) => {
      try {
        const info = await resolveMod(mod);
        const res = await client.apiV2("POST", `/api/v2/mods/${info.modid}/tags`, {
          form: { "tags[]": tags },
        });
        if (res.status !== 200) {
          throw new ModdbError(`Adding tags failed (HTTP ${res.status}): ${errorFromResponse(res)}`, res.status);
        }
        let body: unknown = res.text;
        try {
          body = JSON.parse(res.text);
        } catch {
          // leave as text
        }
        return textResult(pretty({ ok: true, mod: info.name, added: tags, response: body }));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
