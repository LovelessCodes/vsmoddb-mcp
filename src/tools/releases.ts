import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ModdbError, assertFormSaveSucceeded } from "../client.js";
import { scrapeReleaseEditForm, scrapeReleaseRows, serializeForm } from "../html.js";
import { markdownToHtml } from "../markdown.js";
import { client, errorFromResponse, errorResult, modPagePath, pretty, resolveMod, textResult } from "./common.js";

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-(?:rc|pre|dev)\.\d+)?$/;

function maxUploadBytes(): number {
  const mb = Number(process.env.VSMODDB_MAX_UPLOAD_MB ?? 40);
  return (Number.isFinite(mb) && mb > 0 ? mb : 40) * 1024 * 1024;
}

function checkReleaseFile(filePath: string): { size: number; warning?: string } {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new ModdbError(`Release file not found: ${filePath}`);
  }
  if (!stat.isFile()) throw new ModdbError(`Not a file: ${filePath}`);
  const ext = path.extname(filePath).toLowerCase();
  if (![".zip", ".dll", ".cs"].includes(ext)) {
    throw new ModdbError(`ModDB releases must be a .zip archive (game mods) or a single .dll/.cs file; got "${ext}".`);
  }
  const limit = maxUploadBytes();
  if (stat.size > limit) {
    throw new ModdbError(
      `File is ${(stat.size / 1048576).toFixed(1)} MB, which exceeds the configured limit of ${(limit / 1048576).toFixed(0)} MB ` +
        `(ModDB's default). If this mod has a raised upload limit, set VSMODDB_MAX_UPLOAD_MB accordingly.`,
    );
  }
  return {
    size: stat.size,
    warning:
      ext !== ".zip"
        ? "Note: game mods normally ship as a .zip archive; a bare .dll/.cs file may fail the server-side modinfo check."
        : undefined,
  };
}

function findReleaseAssetId(
  modPageHtml: string,
  filename: string | undefined,
  version: string,
): number | undefined {
  const rows = scrapeReleaseRows(modPageHtml);
  if (filename) {
    const byFile = rows.find((r) => r.filename === filename);
    if (byFile) return byFile.assetId;
  }
  const byVersion = rows.find((r) => r.version === version);
  return byVersion?.assetId;
}

export function registerReleaseTools(server: McpServer): void {
  server.registerTool(
    "upload_release",
    {
      title: "Upload a ModDB release",
      description:
        "Upload and publish a new release (zip in, one release out). For game mods the identifier/version are auto-detected from the zip's modinfo.json, and game_versions must be provided. The uploaded file cannot be replaced afterwards, so verify the build first. Requires confirm: true.",
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        mod: z.string().describe("Mod identifier: numeric id, URL alias, or mod id string"),
        file_path: z.string().describe("Absolute path to the .zip (or .dll/.cs) to upload, on the machine running this server"),
        changelog: z.string().default("").describe("Changelog text in Markdown (optional but recommended)"),
        game_versions: z
          .array(z.string())
          .optional()
          .describe('Compatible game versions, e.g. ["1.22.7", "1.22.6"] (required for game mods)'),
        version: z
          .string()
          .optional()
          .describe("Release version (e.g. 1.2.0). Required for non-game-mod categories; ignored for game mods (taken from the zip)"),
        confirm: z.boolean().default(false).describe("Must be true; guards against accidental publication"),
      },
    },
    async ({ mod, file_path, changelog, game_versions, version, confirm }) => {
      try {
        if (!confirm) {
          throw new ModdbError(
            "Refusing to upload without confirm: true. Publishing a release notifies followers and the file cannot be replaced afterwards.",
          );
        }
        const fileCheck = checkReleaseFile(file_path);
        const info = await resolveMod(mod);
        const page = await client.getLoggedIn(`/edit/release/?modid=${info.modid}`);
        if (page.status === 403) {
          throw new ModdbError(`You do not have edit permission for "${info.name}".`);
        }
        const form = scrapeReleaseEditForm(page.text);

        const fields: Record<string, string | string[]> = {
          save: "1",
          assetid: "",
          modid: String(info.modid),
          numsaved: "0",
          saveandback: "1",
          text: markdownToHtml(changelog),
        };
        const notes: string[] = [];

        if (form.gameMod) {
          if (!game_versions?.length) {
            throw new ModdbError(
              `"${info.name}" is a game mod: provide game_versions (valid values include ${form.validVersions.slice(0, 3).join(", ")}).`,
            );
          }
          const invalid = game_versions.filter((v) => !form.validVersions.includes(v));
          if (invalid.length) {
            throw new ModdbError(
              `Unknown game version(s): ${invalid.join(", ")}. Valid values include: ${form.validVersions.slice(0, 10).join(", ")} ...`,
            );
          }
          fields["cgvs[]"] = game_versions;
          if (version) notes.push("The 'version' parameter was ignored: game mod releases take their version from the zip.");
        } else {
          if (!version) {
            throw new ModdbError(`"${info.name}" is not a game mod: provide the release 'version' (semver, e.g. 1.2.0).`);
          }
          if (!SEMVER_RE.test(version)) {
            throw new ModdbError(
              `Malformed version "${version}". Expected n.n.n or n.n.n-rc.n / -pre.n / -dev.n.`,
            );
          }
          fields["modversion"] = version;
        }

        const res = await client.postMultipart(`/edit/release/?modid=${info.modid}`, fields, {
          field: "newfile",
          path: file_path,
        });
        const location = assertFormSaveSucceeded(res, `Uploading a release for "${info.name}"`);
        const url = location ? new URL(location, client.baseUrl).toString() : `${client.baseUrl}${modPagePath(info)}`;
        return textResult(
          pretty({
            ok: true,
            mod: info.name,
            version: version ?? "(detected from zip)",
            game_versions: game_versions ?? undefined,
            file: file_path,
            size_mb: Number((fileCheck.size / 1048576).toFixed(2)),
            warning: fileCheck.warning,
            notes: notes.length ? notes : undefined,
            url,
          }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "update_release",
    {
      title: "Update a ModDB release",
      description:
        "Update an existing release's changelog, compatible game versions, or (non-game mods only) version. The uploaded file itself can never be replaced. Provide at least one of changelog / game_versions / version.",
      annotations: { readOnlyHint: false },
      inputSchema: {
        mod: z.string().describe("Mod identifier: numeric id, URL alias, or mod id string"),
        release_id: z.number().int().describe("Release id (see get_mod)"),
        changelog: z.string().optional().describe("New changelog in Markdown (replaces the old changelog)"),
        game_versions: z
          .array(z.string())
          .optional()
          .describe("Full replacement list of compatible game versions (game mods only)"),
        version: z
          .string()
          .optional()
          .describe("New version (only allowed for non-game-mod categories; game mod versions come from the zip)"),
      },
    },
    async ({ mod, release_id, changelog, game_versions, version }) => {
      try {
        const info = await resolveMod(mod);
        const target = info.releases.find((r) => r.release_id === release_id);
        if (!target) {
          throw new ModdbError(`Release ${release_id} was not found for "${info.name}". Use get_mod to list releases.`);
        }
        const page = await client.getLoggedIn(modPagePath(info));
        const assetId = findReleaseAssetId(page.text, target.filename, target.version);
        if (!assetId) {
          throw new ModdbError(
            `Could not find the edit link for release ${release_id} (v${target.version}) on the mod page. ` +
              `Are you logged in with edit permissions for "${info.name}"?`,
          );
        }
        const editPage = await client.getLoggedIn(`/edit/release?assetid=${assetId}`);
        if (editPage.status === 403) {
          throw new ModdbError(`You do not have edit permission for release ${release_id} of "${info.name}".`);
        }
        const form = scrapeReleaseEditForm(editPage.text);
        if (form.retracted) {
          throw new ModdbError(`Release ${release_id} (v${target.version}) is retracted and can no longer be edited.`);
        }
        const fields = serializeForm(editPage.text, "form[name='form1']");
        if (!fields["save"]) {
          throw new ModdbError("Could not load the release edit form for this release.");
        }

        const changes: string[] = [];
        if (changelog !== undefined) {
          fields["text"] = markdownToHtml(changelog);
          changes.push("changelog");
        }
        if (game_versions !== undefined) {
          if (!form.gameMod) throw new ModdbError("game_versions only applies to game mods.");
          const invalid = game_versions.filter((v) => !form.validVersions.includes(v));
          if (invalid.length) {
            throw new ModdbError(
              `Unknown game version(s): ${invalid.join(", ")}. Valid values include: ${form.validVersions.slice(0, 10).join(", ")} ...`,
            );
          }
          fields["cgvs[]"] = game_versions;
          changes.push("game_versions");
        }
        if (version !== undefined) {
          if (form.versionDisabled) {
            throw new ModdbError("The version of a game mod release is taken from its zip file and cannot be edited.");
          }
          if (!SEMVER_RE.test(version)) {
            throw new ModdbError(`Malformed version "${version}". Expected n.n.n or n.n.n-rc.n / -pre.n / -dev.n.`);
          }
          fields["modversion"] = version;
          changes.push("version");
        }
        if (!changes.length) {
          throw new ModdbError("No changes requested: provide changelog, game_versions and/or version.");
        }
        fields["saveandback"] = "1";

        const res = await client.postForm(`/edit/release?assetid=${assetId}`, fields);
        const location = assertFormSaveSucceeded(res, `Updating release ${release_id} of "${info.name}"`);
        return textResult(
          pretty({
            ok: true,
            mod: info.name,
            release_id,
            version: version ?? target.version,
            changed: changes,
            url: location ? new URL(location, client.baseUrl).toString() : undefined,
          }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "retract_release",
    {
      title: "Retract a ModDB release",
      description:
        "Retract (mark as broken/withdrawn) a release with a reason. The release stays visible with a retraction notice and can no longer be edited. Requires confirm: true.",
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        mod: z.string().describe("Mod identifier: numeric id, URL alias, or mod id string"),
        release_id: z.number().int().describe("Release id (see get_mod)"),
        reason: z.string().min(1).describe("Public reason for the retraction"),
        confirm: z.boolean().default(false).describe("Must be true; retraction cannot be undone by authors"),
      },
    },
    async ({ mod, release_id, reason, confirm }) => {
      try {
        if (!confirm) throw new ModdbError("Refusing to retract without confirm: true.");
        const info = await resolveMod(mod);
        const target = info.releases.find((r) => r.release_id === release_id);
        if (!target) {
          throw new ModdbError(`Release ${release_id} was not found for "${info.name}". Use get_mod to list releases.`);
        }
        const res = await client.apiV2("PUT", `/api/v2/mods/${info.modid}/releases/${release_id}/retraction`, {
          form: { reason: markdownToHtml(reason) },
        });
        if (res.status !== 200) {
          throw new ModdbError(`Retracting failed (HTTP ${res.status}): ${errorFromResponse(res)}`, res.status);
        }
        return textResult(
          pretty({ ok: true, mod: info.name, release_id, version: target.version, retracted: true, reason }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
