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
        mod: z.string().describe("Mod identifier: alias/name, numeric id, or ModDB URL/path (e.g. 'carrycapacity', '5894', '/show/mod/54807')"),
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
            status_note: info.note,
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
        mod: z.string().describe("Mod identifier: alias/name, numeric id, or ModDB URL/path (e.g. 'carrycapacity', '5894', '/show/mod/54807')"),
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

        if (params.tags !== undefined) {
          fields["tagids[]"] = resolveFormTagIds(page.text, params.tags);
          changes.push("tags (replaced)");
        } else if (params.add_tags?.length || params.remove_tags?.length) {
          const current = new Set(selectedValues(fields["tagids[]"]));
          for (const id of resolveFormTagIds(page.text, params.add_tags ?? [])) current.add(id);
          for (const id of resolveFormTagIds(page.text, params.remove_tags ?? [])) current.delete(id);
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
    "list_tags",
    {
      title: "List ModDB tags",
      description:
        "List the site-wide tag vocabulary every mod can carry (id, name, color). Check this before add_mod_tags: only these names exist on ModDB, and anything else has to be created deliberately.",
      annotations: { readOnlyHint: true },
      inputSchema: {},
    },
    async () => {
      try {
        const data = await client.apiV1("/tags");
        const tags = (Array.isArray(data?.tags) ? data.tags : [])
          .map((tag: any) => ({ id: String(tag?.tagid ?? ""), name: String(tag?.name ?? ""), color: tag?.color }))
          .filter((tag: { id: string; name: string }) => tag.id && tag.name);
        return textResult(pretty({ count: tags.length, tags }));
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
        "Add tags to a mod. Existing tags are applied through the mod edit form (the path the site's own UI uses), and only names from list_tags are accepted unless create_missing: true is passed. Tags are site-wide: brand-new ones can only be created through ModDB's user-tags API, which the site currently disables (HTTP 503).",
      annotations: { readOnlyHint: false },
      inputSchema: {
        mod: z.string().describe("Mod identifier: alias/name, numeric id, or ModDB URL/path (e.g. 'carrycapacity', '5894', '/show/mod/54807')"),
        tags: z.array(z.string()).min(1).describe("Tag names to add"),
        create_missing: z
          .boolean()
          .default(false)
          .describe("Also try to create tags that do not exist on ModDB yet (site-wide, visible to every user)"),
      },
    },
    async ({ mod, tags, create_missing }) => {
      try {
        const info = await resolveMod(mod);

        const wanted = normalizeTagNames(tags);
        if (!wanted.length) throw new ModdbError("No tag names given.");

        const known = await knownTagNames();
        const missing = wanted.filter((name) => !known.has(name.toLowerCase()));
        if (missing.length && !create_missing) {
          throw new ModdbError(
            `Tag(s) do not exist on ModDB: ${missing.map((name) => `"${name}"`).join(", ")}. ` +
              "Tags are site-wide, so new ones would appear for every user. Run list_tags to pick existing names, " +
              "or pass create_missing: true to attempt creating these.",
          );
        }

        // Creating tags is a v2 API feature and the site has it switched off (503), so run it
        // first: if it is refused, nothing has been changed yet.
        if (missing.length) {
          const res = await client.apiV2("POST", `/api/v2/mods/${info.modid}/tags`, { form: { "tags[]": missing } });
          if (res.status !== 200) {
            throw new ModdbError(
              `Creating new tag(s) failed (HTTP ${res.status}): ${errorFromResponse(res)}` +
                (res.status === 503
                  ? " — ModDB has user-defined tags disabled site-wide right now, so only existing tags can be added."
                  : ""),
              res.status,
            );
          }
        }

        const existing = wanted.filter((name) => !missing.includes(name));
        if (existing.length) {
          const page = await client.getLoggedIn(`/edit/mod/?assetid=${info.assetid}`);
          const fields = serializeForm(page.text, "form[name='form1']");
          const current = new Set(selectedValues(fields["tagids[]"]));
          for (const id of resolveFormTagIds(page.text, existing)) current.add(id);
          fields["tagids[]"] = [...current];
          const res = await client.postForm(`/edit/mod/?assetid=${info.assetid}`, fields);
          assertFormSaveSucceeded(res, `Adding tags to "${info.name}"`);
        }

        return textResult(
          pretty({
            ok: true,
            mod: info.name,
            added: existing,
            created: missing,
            url: `${client.baseUrl}${info.urlalias ? `/${info.urlalias}` : `/show/mod/${info.assetid}`}`,
          }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

/** Trim, drop empties and dedupe tag names case-insensitively, preserving order. */
function normalizeTagNames(names: string[]): string[] {
  const wanted: string[] = [];
  for (const name of names) {
    const clean = name.trim();
    if (clean && !wanted.some((existing) => existing.toLowerCase() === clean.toLowerCase())) wanted.push(clean);
  }
  return wanted;
}

/** Selected option values from a serializeForm() result (single value or list). */
function selectedValues(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

/** Map of lowercased tag label -> option value from the mod edit form's tag select. */
function tagIdsByName(html: string, fieldName: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const option of selectOptionsFromHtml(html, fieldName)) {
    const cleanLabel = option.label.replace(/\s*\(\d+\)\s*$/, "").trim().toLowerCase();
    if (cleanLabel && !map.has(cleanLabel)) map.set(cleanLabel, option.value);
  }
  return map;
}

/** Resolve tag names against the mod edit form, throwing for names it does not offer. */
function resolveFormTagIds(html: string, names: string[]): string[] {
  const map = tagIdsByName(html, "tagids[]");
  const unknown: string[] = [];
  const ids: string[] = [];
  for (const name of names) {
    const id = map.get(name.trim().toLowerCase());
    if (id === undefined) unknown.push(name);
    else if (!ids.includes(id)) ids.push(id);
  }
  if (unknown.length) {
    throw new ModdbError(
      `Unknown tag(s): ${unknown.join(", ")}. ModDB's mod edit form does not offer ${
        unknown.length > 1 ? "these names" : "this name"
      } — run list_tags to see the accepted ones.`,
    );
  }
  return ids;
}

/** Site-wide tag vocabulary, lowercased for comparison. */
async function knownTagNames(): Promise<Set<string>> {
  const data = await client.apiV1("/tags");
  const names = new Set<string>();
  for (const tag of Array.isArray(data?.tags) ? data.tags : []) {
    if (typeof tag?.name === "string" && tag.name.trim()) names.add(tag.name.trim().toLowerCase());
  }
  return names;
}
