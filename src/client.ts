import fs from "node:fs";
import { basename } from "node:path";
import { loginInstructions, loadSession, saveSession, sessionFilePath, type Session } from "./session.js";
import { extractMessages, isLoginPage, scrapeUser } from "./html.js";

const DEFAULT_BASE = "https://mods.vintagestory.at";
const USER_AGENT = "vsmoddb-mcp/0.1.0 (+https://mods.vintagestory.at)";

export class SessionExpiredError extends Error {}

export class ModdbError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export interface DecodedResponse {
  status: number;
  url: string;
  headers: Headers;
  text: string;
}

export type FormValue = string | string[] | number | boolean | undefined;

/** Body types accepted by `fetch` in Node. */
export type RequestBody = string | Uint8Array | FormData;

export function encodeForm(fields: Record<string, FormValue>): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) sp.append(key, String(item));
    } else {
      sp.append(key, String(value));
    }
  }
  return sp.toString();
}

function parseErrorPayload(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const json = JSON.parse(trimmed) as Record<string, unknown>;
    for (const key of ["error", "errormessage", "message"]) {
      const value = json[key];
      if (typeof value === "string" && value) return value;
    }
    return null;
  } catch {
    // Not JSON: return a short plain-text excerpt for HTML error pages.
    const plain = trimmed.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return plain.slice(0, 400) || null;
  }
}

export class ModdbClient {
  private base: string;
  private session: Session;
  private at?: string;
  private hash?: string;

  constructor() {
    this.base = (process.env.VSMODDB_BASE_URL ?? DEFAULT_BASE).replace(/\/+$/, "");
    this.session = loadSession() ?? { cookie: "" };
    this.at = this.session.at;
    this.hash = this.session.hash;
  }

  get baseUrl(): string {
    return this.base;
  }

  get sessionFile(): string {
    return sessionFilePath();
  }

  get userHash(): string | undefined {
    return this.hash;
  }

  private get origin(): string {
    return new URL(this.base).origin;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { "user-agent": USER_AGENT };
    if (this.session.cookie) headers["cookie"] = this.session.cookie;
    return { ...headers, ...extra };
  }

  private async fetchOnce(
    pathOrUrl: string,
    opts: {
      method?: string;
      headers?: Record<string, string>;
      body?: RequestBody;
      timeoutMs?: number;
      withoutCredentials?: boolean;
    } = {},
  ): Promise<Response> {
    const url = new URL(pathOrUrl, this.base + "/");
    const headers = opts.withoutCredentials
      ? { "user-agent": USER_AGENT }
      : this.headers(opts.headers);
    return fetch(url, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body,
      redirect: "manual",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
    });
  }

  /**
   * GET with manual redirect handling: same-origin redirects are followed with
   * credentials, cross-origin ones (the account login) without, so a logged-out
   * state never leaks the session cookie anywhere.
   */
  async get(pathOrUrl: string, opts: { timeoutMs?: number } = {}): Promise<DecodedResponse> {
    let url = new URL(pathOrUrl, this.base + "/");
    for (let i = 0; i < 8; i++) {
      const res = await this.fetchOnce(url.toString(), { timeoutMs: opts.timeoutMs });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get("location");
        if (location) {
          await res.body?.cancel().catch(() => {});
          const next = new URL(location, url);
          if (next.origin === this.origin) {
            url = next;
            continue;
          }
          const cross = await fetch(next.toString(), {
            headers: { "user-agent": USER_AGENT },
            redirect: "follow",
            signal: AbortSignal.timeout(60_000),
          });
          return { status: cross.status, url: cross.url, headers: cross.headers, text: await cross.text() };
        }
      }
      return { status: res.status, url: url.toString(), headers: res.headers, text: await res.text() };
    }
    throw new ModdbError(`Too many redirects while fetching ${pathOrUrl}`);
  }

  private assertLoggedIn(res: DecodedResponse): void {
    if (new URL(res.url).origin !== this.origin || isLoginPage(res.text)) {
      throw new SessionExpiredError(`Your ModDB session has expired.\n\n${loginInstructions()}`);
    }
    const user = scrapeUser(res.text);
    if (user && user.hash === null) {
      throw new SessionExpiredError(`Your ModDB session has expired.\n\n${loginInstructions()}`);
    }
  }

  /** Validates the session cookie and returns the current action token, caching it. */
  async ensureSession(force = false): Promise<{ hash: string; at: string }> {
    if (!this.session.cookie) throw new SessionExpiredError(loginInstructions());
    if (!force && this.at && this.hash) return { hash: this.hash, at: this.at };

    const res = await this.get("/home");
    this.assertLoggedIn(res);
    const user = scrapeUser(res.text);
    if (!user?.hash || !user.at) {
      throw new SessionExpiredError(`Your ModDB session has expired.\n\n${loginInstructions()}`);
    }
    this.at = user.at;
    this.hash = user.hash;
    this.session.at = user.at;
    this.session.hash = user.hash;
    this.session.updatedAt = new Date().toISOString();
    saveSession(this.session);
    return { hash: user.hash, at: user.at };
  }

  /** GET of a page that requires the user to be logged in. */
  async getLoggedIn(path: string): Promise<DecodedResponse> {
    await this.ensureSession();
    const res = await this.get(path);
    this.assertLoggedIn(res);
    return res;
  }

  /** Public ModDB JSON API (v1), e.g. path `/mod/carrycapacity`. */
  async apiV1(path: string): Promise<any> {
    const res = await this.get(`/api/${path.replace(/^\//, "")}`);
    let json: any;
    try {
      json = JSON.parse(res.text);
    } catch {
      throw new ModdbError(
        `ModDB returned non-JSON (HTTP ${res.status}) for /api/${path}: ${res.text.slice(0, 200)}`,
        res.status,
      );
    }
    const status = Number(json?.statuscode ?? res.status);
    if (res.status >= 400 || status >= 400) {
      throw new ModdbError(
        String(json?.errormessage ?? json?.error ?? `API error (HTTP ${status})`),
        status,
      );
    }
    return json;
  }

  /**
   * Authenticated v2 API request. Adds the action token, retries once after
   * refreshing it when the server reports it as stale.
   */
  async apiV2(
    method: string,
    path: string,
    opts: { query?: Record<string, string | number | undefined>; form?: Record<string, FormValue>; body?: string; contentType?: string } = {},
  ): Promise<DecodedResponse> {
    const run = async (at: string): Promise<Response> => {
      const url = new URL(this.base + path);
      for (const [key, value] of Object.entries(opts.query ?? {})) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
      url.searchParams.set("at", at);
      const headers: Record<string, string> = {};
      let body: RequestBody | undefined;
      if (opts.form) {
        headers["content-type"] = "application/x-www-form-urlencoded";
        body = encodeForm(opts.form);
      } else if (opts.contentType) {
        headers["content-type"] = opts.contentType;
        body = opts.body ?? "";
      }
      return this.fetchOnce(url.toString(), { method, headers, body });
    };

    let { at } = await this.ensureSession();
    let res = await run(at);
    if (res.status === 403) {
      const text = await res.text();
      if (/action token/i.test(text)) {
        ({ at } = await this.ensureSession(true));
        res = await run(at);
      } else {
        throw new ModdbError(`ModDB refused the request (HTTP 403): ${parseErrorPayload(text) ?? text.slice(0, 300)}`, 403);
      }
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      await res.body?.cancel().catch(() => {});
      throw new SessionExpiredError(`Your ModDB session has expired.\n\n${loginInstructions()}`);
    }
    return { status: res.status, url: res.url, headers: res.headers, text: await res.text() };
  }

  /** POST an `application/x-www-form-urlencoded` body (classic ModDB forms). */
  async postForm(path: string, fields: Record<string, FormValue>): Promise<DecodedResponse> {
    await this.ensureSession();
    const body = encodeForm({ ...fields, at: this.at });
    const res = await this.fetchOnce(path, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    return { status: res.status, url: this.base + path, headers: res.headers, text: await res.text() };
  }

  /** POST a multipart body with one attached file (release uploads). */
  async postMultipart(
    path: string,
    fields: Record<string, FormValue>,
    file: { field: string; path: string; filename?: string; contentType?: string },
  ): Promise<DecodedResponse> {
    await this.ensureSession();
    const form = new FormData();
    for (const [key, value] of Object.entries({ ...fields, at: this.at as string })) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value) form.append(key, String(item));
      } else {
        form.append(key, String(value));
      }
    }
    const data = await fs.promises.readFile(file.path);
    form.append(
      file.field,
      new Blob([data], { type: file.contentType ?? "application/zip" }),
      file.filename ?? basename(file.path),
    );
    const res = await this.fetchOnce(path, {
      method: "POST",
      body: form,
      timeoutMs: 15 * 60 * 1000,
    });
    return { status: res.status, url: this.base + path, headers: res.headers, text: await res.text() };
  }
}

/**
 * Interprets the response of a classic form POST.
 * A 303 redirect means the save succeeded; a 200 re-render carries error messages.
 */
export function assertFormSaveSucceeded(res: DecodedResponse, action: string): string | null {
  if (res.status === 303) {
    return res.headers.get("location");
  }
  if (res.status === 200) {
    const messages = extractMessages(res.text);
    const detail = messages.length
      ? messages.map((m) => `- ${m}`).join("\n")
      : "The site re-rendered the form without a specific error message.";
    throw new ModdbError(`${action} failed:\n${detail}`);
  }
  const payload = parseErrorPayload(res.text);
  throw new ModdbError(`${action} failed (HTTP ${res.status})${payload ? `: ${payload}` : ""}`, res.status);
}
