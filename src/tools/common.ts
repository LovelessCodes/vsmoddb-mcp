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
  /** Set when a mod is an unpublished draft, where only page-derived data is available. */
  note?: string;
}

/** Normalizes any mod reference (full URL, page path, "/show/mod/<id>", alias, or id) to its last path segment. */
export function normalizeModRef(modRef: string): string {
  let ref = modRef.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(ref)) {
    try {
      ref = new URL(ref).pathname;
    } catch {
      // keep as-is and let the segment logic below do its best
    }
  }
  ref = ref.split(/[?#]/)[0];
  const segments = ref
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
  return segments.length ? decodeURIComponent(segments[segments.length - 1]) : "";
}

/** Name of the mod described by a mod page, taken from its <title> ("Name - Vintage Story Mod DB"). */
function modNameFromPage(html: string, fallback: string): string {
  const m = /<title>([^<]*)<\/title>/i.exec(html);
  if (!m) return fallback;
  const name = m[1]
    .replace(/\s*-\s*Vintage Story Mod DB\s*$/i, "")
    .trim();
  return name || fallback;
}

/**
 * Reads the mod id ModDB embeds into every mod page. The page's CSP lists the per-mod
 * v2 endpoints (`connect-src ... /api/v2/mods/<modid>/ ...`), which is the only stable
 * way to relate an asset id or URL alias back to a mod id.
 */
function modIdFromPage(res: DecodedResponse): number | null {
  const haystack = `${res.headers.get("content-security-policy") ?? ""}\n${res.text}`;
  const m = /\/api\/v2\/mods\/(\d+)\//.exec(haystack);
  return m ? Number(m[1]) : null;
}

/** Fetches normalized mod info via the public v1 API (accepts a mod id or a release identifier). */
async function fetchModInfo(ref: string): Promise<ModFull> {
  const data = await client.apiV1(`/mod/${encodeURIComponent(ref)}`);
  const m = data?.mod ?? data;
  const modid = Number(m?.modid);
  const assetid = Number(m?.assetid);
  if (!Number.isFinite(modid) || !Number.isFinite(assetid)) {
    throw new ModdbError(`Could not resolve mod "${ref}" on the ModDB.`);
  }
  return {
    modid,
    assetid,
    name: String(m.name ?? ref),
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

/** Like fetchModInfo, but treats a 404 as "not resolvable this way" instead of an error. */
async function tryApiMod(ref: string): Promise<ModFull | null> {
  try {
    return await fetchModInfo(ref);
  } catch (err) {
    if (err instanceof ModdbError && err.status === 404) return null;
    throw err;
  }
}

/** Page-derived info for unpublished drafts, which are absent from the public API. */
function modInfoFromPage(
  res: DecodedResponse,
  opts: { ref: string; modid: number | null; isNumeric: boolean },
): ModFull | null {
  if (opts.modid === null) return null;
  const editLink = /\/edit\/mod\/?\?assetid=(\d+)/.exec(res.text);
  const assetid = opts.isNumeric ? Number(opts.ref) : editLink ? Number(editLink[1]) : 0;
  return {
    modid: opts.modid,
    assetid,
    name: modNameFromPage(res.text, opts.ref),
    urlalias: opts.isNumeric ? null : opts.ref,
    tags: [],
    downloads: 0,
    follows: 0,
    description_html: "",
    releases: [],
    note:
      "This mod is an unpublished draft, so it is absent from the public ModDB API. Ids were read from the mod page; " +
      "release lists, descriptions and stats are unavailable until the mod is published.",
  };
}

/**
 * Resolves a mod reference (name/alias, numeric id, "/show/mod/<id>" path, or full URL) to normalized info.
 * The public v1 API only knows published mods by id or release identifier, so aliases and asset ids are
 * resolved through the mod page, and unpublished drafts fall back to page-derived info.
 */
export async function resolveMod(modRef: string): Promise<ModFull> {
  const ref = normalizeModRef(modRef);
  if (!ref) throw new ModdbError(`Invalid mod reference "${modRef}".`);

  const direct = await tryApiMod(ref);
  if (direct) return direct;

  const isNumeric = /^\d+$/.test(ref);
  const page = await client.get(isNumeric ? `/show/mod/${ref}` : `/${ref}`);
  const modid = modIdFromPage(page);
  if (modid !== null) {
    const viaId = await tryApiMod(String(modid));
    if (viaId) return viaId;
  }

  const pageInfo = modInfoFromPage(page, { ref, modid, isNumeric });
  if (pageInfo) return pageInfo;

  throw new ModdbError(`Could not resolve mod "${modRef}" on the ModDB.`);
}

/** Path of the mod's public page (uses the URL alias when set). */
export function modPagePath(mod: Pick<ModBasic, "assetid" | "urlalias">): string {
  return mod.urlalias ? `/${mod.urlalias}` : `/show/mod/${mod.assetid}`;
}

export function unixToIso(unix?: number): string | undefined {
  return unix !== undefined && Number.isFinite(unix) ? new Date(unix * 1000).toISOString() : undefined;
}
