import { ModdbClient, ModdbError, type DecodedResponse } from "../client.js";
import * as cheerio from "cheerio";

export const client = new ModdbClient();

export function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

export function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Extracts the human-readable error from an API response body. */
export function errorFromResponse(res: DecodedResponse): string {
  const trimmed = res.text.trim();
  if (trimmed) {
    try {
      const json = JSON.parse(trimmed) as Record<string, unknown>;
      for (const key of ["error", "errormessage", "message"]) {
        const value = json[key];
        if (typeof value === "string" && value) return value;
      }
    } catch {
      return trimmed.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 400);
    }
  }
  return `HTTP ${res.status}`;
}

export function htmlToText(html: string): string {
  if (!html) return "";
  const $ = cheerio.load(html);
  return $.root().text().replace(/[ \t]+\n/g, "\n").trim();
}

export interface ModBasic {
  modid: number;
  assetid: number;
  name: string;
  urlalias: string | null;
}

export interface ReleaseInfo {
  release_id: number;
  version: string;
  game_versions: string[];
  filename?: string;
  downloads: number;
  created?: string;
  changelog_html?: string;
}

export interface ModFull extends ModBasic {
  side?: string;
  type?: string;
  tags: string[];
  homepage_url?: string;
  source_code_url?: string;
  issue_tracker_url?: string;
  wiki_url?: string;
  trailer_video_url?: string;
  downloads: number;
  follows: number;
  description_html: string;
  releases: ReleaseInfo[];
}

/** Resolves a mod id, numeric id, or URL alias and returns normalized info via the public v1 API. */
export async function resolveMod(modRef: string): Promise<ModFull> {
  const data = await client.apiV1(`/mod/${encodeURIComponent(modRef)}`);
  const m = data?.mod ?? data;
  const modid = Number(m?.modid);
  const assetid = Number(m?.assetid);
  if (!Number.isFinite(modid) || !Number.isFinite(assetid)) {
    throw new ModdbError(`Could not resolve mod "${modRef}" on the ModDB.`);
  }
  return {
    modid,
    assetid,
    name: String(m.name ?? modRef),
    urlalias: m.urlalias ?? null,
    side: m.side,
    type: m.type,
    tags: Array.isArray(m.tags) ? m.tags : [],
    homepage_url: m.homepageurl || undefined,
    source_code_url: m.sourcecodeurl || undefined,
    issue_tracker_url: m.issuetrackerurl || undefined,
    wiki_url: m.wikiurl || undefined,
    trailer_video_url: m.trailervideourl || undefined,
    downloads: Number(m.downloads ?? 0),
    follows: Number(m.follows ?? 0),
    description_html: String(m.text ?? ""),
    releases: (Array.isArray(m.releases) ? m.releases : []).map((r: any) => ({
      release_id: Number(r.releaseid),
      version: String(r.modversion),
      game_versions: Array.isArray(r.tags) ? r.tags : [],
      filename: r.filename,
      downloads: Number(r.downloads ?? 0),
      created: r.created,
      changelog_html: r.changelog,
    })),
  };
}

/** Path of the mod's public page (uses the URL alias when set). */
export function modPagePath(mod: Pick<ModBasic, "assetid" | "urlalias">): string {
  return mod.urlalias ? `/${mod.urlalias}` : `/show/mod/${mod.assetid}`;
}

export function unixToIso(unix?: number): string | undefined {
  return unix !== undefined && Number.isFinite(unix) ? new Date(unix * 1000).toISOString() : undefined;
}
