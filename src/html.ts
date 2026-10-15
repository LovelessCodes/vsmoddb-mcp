import * as cheerio from "cheerio";

/** Values a serialized form can hold: repeated keys become arrays. */
export type FormFields = Record<string, string | string[]>;

export interface ScrapedUser {
  hash: string | null;
  at: string | null;
}

/**
 * Reads `window.user={hash:"...",at:"..."}` that ModDB embeds into every page
 * for logged-in users. Returns nulls when the visitor is logged out.
 */
export function scrapeUser(html: string): ScrapedUser | null {
  const m = /window\.user=\{hash:(?:"([0-9a-fA-F]+)"|null),at:(?:"([0-9a-fA-F]+)"|null)/.exec(html);
  if (!m) return null;
  return { hash: m[1] ?? null, at: m[2] ?? null };
}

/** Extracts server-generated messages (errors/warnings) from a rendered page. */
export function extractMessages(html: string): string[] {
  const $ = cheerio.load(html);
  const messages: string[] = [];
  $("#message-container > div").each((_, el) => {
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (text) messages.push(text);
  });
  if (!messages.length) {
    $(".bg-error").each((_, el) => {
      const text = $(el).text().replace(/\s+/g, " ").trim();
      if (text) messages.push(text);
    });
  }
  return messages;
}

/** True when the returned page is the account login page rather than ModDB content. */
export function isLoginPage(html: string): boolean {
  return /<title>Vintage Story Game Account<\/title>/i.test(html);
}

export interface MyModEntry {
  name: string;
  path: string;
  url: string;
  summary?: string;
}

/** Parses the "Your mod contributions" section of the logged-in /home page. */
export function scrapeMyMods(html: string): MyModEntry[] {
  const $ = cheerio.load(html);
  const header = $("h3")
    .filter((_, el) => $(el).text().trim().toLowerCase().startsWith("your mod contributions"))
    .first();
  if (!header.length) return [];

  const entries: MyModEntry[] = [];
  header
    .nextUntil("h3")
    .filter(".mod")
    .each((_, el) => {
      const $el = $(el);
      const link = $el
        .find("a")
        .filter((_, a) => $(a).find("h4").length > 0)
        .first();
      const href = link.attr("href") ?? $el.find("a[href]").first().attr("href");
      const name = $el.find("h4").first().text().trim();
      const summary = link.find("p").first().text().trim();
      if (href && name) entries.push({ name, path: href, url: absolutize(href), summary: summary || undefined });
    });
  return entries;
}

export interface ReleaseRow {
  assetId: number;
  version: string;
  filename?: string;
  retracted: boolean;
}

/** Parses the release table of a mod page (public, no auth needed). */
export function scrapeReleaseRows(html: string): ReleaseRow[] {
  const $ = cheerio.load(html);
  const rows: ReleaseRow[] = [];
  $(".release-table tbody tr[data-assetid]").each((_, el) => {
    const $el = $(el);
    const assetId = Number($el.attr("data-assetid"));
    if (!Number.isFinite(assetId)) return;
    const version = $el.find("td").eq(0).text().trim();
    const filename = $el.find("a.mod-dl").first().text().trim() || undefined;
    rows.push({ assetId, version, filename, retracted: $el.hasClass("retracted") });
  });
  return rows;
}

export interface CommentInfo {
  id: number;
  user?: string;
  createdUnix?: number;
  parentId?: number;
  depth: number;
  deleted: boolean;
  text: string;
  textHtml: string;
}

/** Parses the comments section of a mod page (public, no auth needed). */
export function scrapeComments(html: string): CommentInfo[] {
  const $ = cheerio.load(html);
  const comments: CommentInfo[] = [];
  $(".comments div[id^='cmt-']").each((_, el) => {
    const $el = $(el);
    const id = Number(($el.attr("id") ?? "").slice(4));
    if (!Number.isFinite(id)) return;
    const title = $el.children(".title").first();
    const user = title.find("a[href^='/show/user/']").first().text().trim() || undefined;
    const stamp = Number($el.attr("data-stamp"));
    const depth = Number($el.attr("data-d") ?? "0");
    const refHref = $el.children("a.reference").first().attr("href");
    const parentId =
      refHref && refHref.startsWith("#cmt-") ? Number(refHref.slice(5)) : undefined;
    const body = $el.children(".body").first();
    comments.push({
      id,
      user,
      createdUnix: Number.isFinite(stamp) && stamp > 0 ? stamp : undefined,
      parentId: Number.isFinite(parentId as number) ? (parentId as number) : undefined,
      depth: Number.isFinite(depth) ? depth : 0,
      deleted: $el.hasClass("deleted"),
      text: body.text().replace(/\s+\n/g, "\n").trim(),
      textHtml: body.html()?.trim() ?? "",
    });
  });
  return comments;
}

export interface SelectOption {
  value: string;
  label: string;
  selected: boolean;
}

export function scrapeSelectOptions($: cheerio.CheerioAPI, selectName: string): SelectOption[] {
  const select = $(`select[name="${selectName}"]`).first();
  if (!select.length) return [];
  return select
    .find("option")
    .map((_, el) => {
      const $el = $(el);
      return {
        value: $el.attr("value") ?? "",
        label: $el.text().trim(),
        selected: $el.attr("selected") !== undefined,
      };
    })
    .get();
}

export function selectOptionsFromHtml(html: string, selectName: string): SelectOption[] {
  return scrapeSelectOptions(cheerio.load(html), selectName);
}

/**
 * Serializes a server-rendered form into the exact field set a browser would submit.
 * Disabled inputs/selects and unchecked checkboxes/radios are skipped. Multiple
 * selects and checkbox groups produce arrays.
 */
export function serializeForm(html: string, formSelector: string): FormFields {
  const $ = cheerio.load(html);
  const form = $(formSelector).first();
  const fields: FormFields = {};
  const add = (name: string, value: string): void => {
    const existing = fields[name];
    if (existing === undefined) fields[name] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else fields[name] = [existing, value];
  };

  form.find("input").each((_, el) => {
    const $el = $(el);
    if ($el.attr("disabled") !== undefined) return;
    const name = $el.attr("name");
    if (!name) return;
    const type = ($el.attr("type") ?? "text").toLowerCase();
    if (["submit", "button", "reset", "file", "image"].includes(type)) return;
    if (type === "checkbox" || type === "radio") {
      if ($el.attr("checked") !== undefined) add(name, $el.attr("value") ?? "on");
      return;
    }
    add(name, $el.attr("value") ?? "");
  });

  form.find("textarea").each((_, el) => {
    const $el = $(el);
    if ($el.attr("disabled") !== undefined) return;
    const name = $el.attr("name");
    if (!name) return;
    add(name, $el.text() ?? "");
  });

  form.find("select").each((_, el) => {
    const $el = $(el);
    if ($el.attr("disabled") !== undefined) return;
    const name = $el.attr("name");
    if (!name) return;
    const selected = $el
      .find("option")
      .filter((_, o) => $(o).attr("selected") !== undefined)
      .map((_, o) => $(o).attr("value") ?? "")
      .get();
    if ($el.attr("multiple") !== undefined) {
      for (const v of selected) add(name, v);
    } else {
      add(name, selected[0] ?? $el.find("option").first().attr("value") ?? "");
    }
  });

  return fields;
}

export interface EditReleaseForm {
  gameMod: boolean;
  retracted: boolean;
  numsaved: string;
  modid: string;
  assetid: string;
  versionDisabled: boolean;
  currentVersion: string;
  currentChangelog: string;
  checkedVersions: string[];
  validVersions: string[];
}

/** Parses the release edit/create form (`/edit/release/?modid=|?assetid=`). */
export function scrapeReleaseEditForm(html: string): EditReleaseForm {
  const $ = cheerio.load(html);
  const form = $("form[name='form1']").first();
  const cgvInputs = form.find("input[name='cgvs[]']");
  const validVersions = cgvInputs
    .map((_, el) => $(el).attr("value") ?? "")
    .get()
    .filter(Boolean);
  const checkedVersions = cgvInputs
    .filter((_, el) => $(el).attr("checked") !== undefined)
    .map((_, el) => $(el).attr("value") ?? "")
    .get()
    .filter(Boolean);
  const versionInput = form.find("#inp-modversion");
  return {
    gameMod: cgvInputs.length > 0,
    retracted: /This release has been retracted/i.test(html),
    numsaved: form.find("input[name='numsaved']").attr("value") ?? "0",
    modid: form.find("input[name='modid']").attr("value") ?? "",
    assetid: form.find("input[name='assetid']").attr("value") ?? "",
    versionDisabled: versionInput.attr("disabled") !== undefined,
    currentVersion: versionInput.attr("value") ?? "",
    currentChangelog: form.find("textarea[name='text']").text() ?? "",
    checkedVersions,
    validVersions,
  };
}

export interface NotificationEntry {
  id: number;
  text: string;
  date?: string;
  link?: string;
}

/** Parses the /notifications page. */
export function scrapeNotifications(html: string): NotificationEntry[] {
  const $ = cheerio.load(html);
  const out: NotificationEntry[] = [];
  $("label.list-entry").each((_, el) => {
    const $el = $(el);
    const id = Number($el.find("input[name='nids[]']").attr("value"));
    if (!Number.isFinite(id)) return;
    const anchor = $el.find("a[href^='/notification/']").first();
    const text = $el
      .clone()
      .children("input, a")
      .remove()
      .end()
      .text()
      .replace(/\s+/g, " ")
      .trim();
    out.push({
      id,
      text,
      date: $el.attr("data-label"),
      link: anchor.attr("href"),
    });
  });
  return out;
}

function absolutize(pathOrUrl: string): string {
  const base = process.env.VSMODDB_BASE_URL ?? "https://mods.vintagestory.at";
  try {
    return new URL(pathOrUrl, base + "/").toString();
  } catch {
    return pathOrUrl;
  }
}
