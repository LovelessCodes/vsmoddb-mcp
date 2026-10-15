#!/usr/bin/env node
/**
 * Offline end-to-end smoke test.
 *
 * Starts a mock ModDB HTTP server, points the real MCP server at it through
 * VSMODDB_BASE_URL, and drives every tool over stdio using the MCP SDK client.
 * The mock records every request so the test can assert wire-level details
 * (exact Content-Type, multipart fields, action tokens, cookies).
 *
 * No credentials and no network access are required.
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vsmoddb-smoke-"));

let passed = 0;
const failures = [];
function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

/* ------------------------------------------------------------------ */
/* Mock ModDB                                                          */
/* ------------------------------------------------------------------ */

const state = {
  homeLevel: 1, // "a1"; after the forced token refresh it becomes "a2"
  rejectTokenOnce: true,
  loggedOut: false,
  failNextModPost: false,
  requests: [],
};

const at = () => (state.homeLevel === 1 ? "a1" : "a2");

const homePage = (level) =>
  `<!doctype html><html><head><title>ModDB</title></head><body>` +
  `<script>window.user={hash:"DEADBEEF",at:"${level === 1 ? "a1" : "a2"}"};</script>` +
  `<h3>Your mod contributions</h3>` +
  `<div class="mod"><a href="/testmod"><h4>Test Mod</h4><p>A smoke-test mod</p></a></div>` +
  `</body></html>`;

const loggedOutPage = `<!doctype html><html><head><title>Vintage Story Game Account</title></head><body>login</body></html>`;

const userScript = `<script>window.user={hash:"DEADBEEF",at:"${at()}"};</script>`;

const modJson = () => ({
  statuscode: 200,
  mod: {
    modid: 42,
    assetid: 7,
    name: "Test Mod",
    urlalias: "testmod",
    side: "Both",
    type: "code mod",
    tags: ["Utility"],
    homepageurl: "https://example.com/testmod",
    sourcecodeurl: "https://github.com/example/testmod",
    downloads: 123,
    follows: 4,
    text: "<p>Hello <strong>world</strong></p>",
    releases: [
      {
        releaseid: 501,
        modversion: "1.0.0",
        filename: "testmod_1.0.0.zip",
        downloads: 10,
        created: "2026-01-01 10:00:00",
        tags: ["1.22.7"],
        changelog: "<p>First release</p>",
      },
    ],
  },
});

const modPage = () =>
  `<!doctype html><html><body>${userScript}` +
  `<div class="release-table"><table><tbody>` +
  `<tr data-assetid="501"><td>1.0.0</td><td><a class="mod-dl" href="/dl/501">testmod_1.0.0.zip</a></td></tr>` +
  `</tbody></table></div>` +
  `<div class="comments">` +
  `<div id="cmt-9000" data-stamp="1767225600" data-d="0" class="comment">` +
  `<div class="title"><a href="/show/user/deadbeef">Smoke Tester</a><span>1 day ago</span></div>` +
  `<div class="body"><p>Can you add feature X?</p></div></div>` +
  `<div id="cmt-8999" data-stamp="1767139200" data-d="1" class="comment">` +
  `<div class="title"><a href="/show/user/other">Other User</a></div>` +
  `<a class="reference" href="#cmt-9000">reply</a>` +
  `<div class="body">Please!</div></div>` +
  `<div id="cmt-8998" data-stamp="1767052800" data-d="0" class="comment deleted">` +
  `<div class="title"><a href="/show/user/spammer">Spammer</a></div>` +
  `<div class="body">buy cheap gold</div></div>` +
  `</div></body></html>`;

const releaseCreatePage = () =>
  `<!doctype html><html><body>${userScript}` +
  `<form name="form1" method="post" enctype="multipart/form-data" action="/edit/release/?modid=42">` +
  `<input type="hidden" name="modid" value="42">` +
  `<input type="hidden" name="assetid" value="">` +
  `<input type="hidden" name="numsaved" value="0">` +
  `<input type="hidden" name="saveandback" value="0">` +
  `<input type="checkbox" name="cgvs[]" value="1.22.7" checked>` +
  `<input type="checkbox" name="cgvs[]" value="1.22.6">` +
  `<input type="checkbox" name="cgvs[]" value="1.22.5">` +
  `<textarea name="text"></textarea>` +
  `<input type="file" name="newfile">` +
  `<input type="submit" name="save" value="Save">` +
  `</form></body></html>`;

const releaseEditPage = () =>
  `<!doctype html><html><body>${userScript}` +
  `<form name="form1" method="post" action="/edit/release?assetid=501">` +
  `<input type="hidden" name="modid" value="42">` +
  `<input type="hidden" name="assetid" value="501">` +
  `<input type="hidden" name="numsaved" value="1">` +
  `<input type="hidden" name="save" value="1">` +
  `<input type="hidden" name="saveandback" value="0">` +
  `<input type="checkbox" name="cgvs[]" value="1.22.7" checked>` +
  `<input type="checkbox" name="cgvs[]" value="1.22.6">` +
  `<input type="checkbox" name="cgvs[]" value="1.22.5">` +
  `<input type="text" id="inp-modversion" name="modversion" value="1.0.0" disabled>` +
  `<textarea name="text"><p>First release</p></textarea>` +
  `</form></body></html>`;

const modEditPage = () =>
  `<!doctype html><html><body>${userScript}` +
  `<form name="form1" method="post" action="/edit/mod/?assetid=7">` +
  `<input type="hidden" name="save" value="1">` +
  `<input type="hidden" name="assetid" value="7">` +
  `<input type="text" name="name" value="Test Mod">` +
  `<input type="text" name="summary" value="A smoke-test mod">` +
  `<input type="text" name="urlAlias" value="testmod">` +
  `<input type="text" name="homepageUrl" value="">` +
  `<input type="text" name="sourceCodeUrl" value="https://github.com/example/testmod">` +
  `<input type="text" name="issueTrackerUrl" value="">` +
  `<input type="text" name="wikiUrl" value="">` +
  `<input type="text" name="donateUrl" value="">` +
  `<input type="text" name="trailerVideoUrl" value="">` +
  `<select name="side">` +
  `<option value="0">Client</option><option value="1" selected>Server</option><option value="2">Both</option>` +
  `</select>` +
  `<select name="tagids[]" multiple>` +
  `<option value="10" selected>Utility</option>` +
  `<option value="11">Library</option>` +
  `<option value="12">Cosmetic (3)</option>` +
  `</select>` +
  `<textarea name="text">&lt;p&gt;Hello&lt;/p&gt;</textarea>` +
  `</form></body></html>`;

const modPostFailurePage = () =>
  `<!doctype html><html><body>${userScript}<div id="message-container">` +
  `<div class="bg-error">Name contains illegal characters</div>` +
  `</div></body></html>`;

const notificationsPage = () =>
  `<!doctype html><html><body>${userScript}` +
  `<label class="list-entry" data-label="2 hours ago">` +
  `<input type="checkbox" name="nids[]" value="77">` +
  `<a href="/notification/77">New comment on</a> Test Mod</label>` +
  `<label class="list-entry" data-label="3 days ago">` +
  `<input type="checkbox" name="nids[]" value="76">` +
  `<a href="/notification/76">New follower</a> joined</label>` +
  `</body></html>`;

// Mod page served for an alias. The CSP lists the per-mod v2 endpoints, which is how the
// server relates a URL alias back to a mod id (the public v1 API only knows release identifiers).
const aliasModPage = () =>
  `<!doctype html><html><head><title>Test Mod - Vintage Story Mod DB</title></head><body>${userScript}` +
  `<a href="/edit/mod/?assetid=7">Edit this mod</a></body></html>`;

// Mod page of an unpublished draft: absent from the public API, only the page knows about it.
const draftModPage = () =>
  `<!doctype html><html><head><title>Draft Mod - Vintage Story Mod DB</title></head><body>${userScript}` +
  `<span>Draft</span><a href="/edit/mod/?assetid=77">Edit this mod</a></body></html>`;

const csp = (modid) => ({
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": `default-src 'self'; connect-src mods.vintagestory.at/api/v2/mods/${modid}/ mods.vintagestory.at/api/v2/comments/`,
});

function parseMultipart(bodyLatin1, boundary) {
  const parts = [];
  for (const chunk of bodyLatin1.split(`--${boundary}`)) {
    if (!chunk.startsWith("\r\n")) continue;
    const body = chunk.slice(2);
    const headerEnd = body.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;
    const headers = body.slice(0, headerEnd);
    let content = body.slice(headerEnd + 4);
    if (content.endsWith("\r\n")) content = content.slice(0, -2);
    const name = /name="([^"]*)"/.exec(headers)?.[1];
    if (name === undefined) continue;
    parts.push({ name, filename: /filename="([^"]*)"/.exec(headers)?.[1], content });
  }
  return parts;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks);
  const rec = {
    method: req.method,
    path: url.pathname,
    query: url.searchParams,
    headers: req.headers,
    bodyLatin1: raw.toString("latin1"),
    bodyUtf8: raw.toString("utf8"),
  };
  state.requests.push(rec);

  const send = (status, body, headers = {}) => {
    res.writeHead(status, headers);
    res.end(body);
  };
  const sendHtml = (html, status = 200) => send(status, html, { "content-type": "text/html; charset=utf-8" });
  const sendJson = (obj, status = 200) => send(status, JSON.stringify(obj), { "content-type": "application/json" });
  const fields = () => Object.fromEntries(new URLSearchParams(rec.bodyUtf8));

  const { pathname } = url;

  if (req.method === "GET" && pathname === "/home") {
    return sendHtml(state.loggedOut ? loggedOutPage : homePage(state.homeLevel));
  }
  if (req.method === "GET" && pathname.startsWith("/show/user/")) {
    return sendHtml(`<!doctype html><html><head><meta property="og:title" content="Smoke Tester"></head><body></body></html>`);
  }
  if (req.method === "GET" && pathname.startsWith("/api/mod/")) {
    const ref = decodeURIComponent(pathname.slice("/api/mod/".length));
    if (ref === "nonexistent" || ref === "testalias" || ref === "77") {
      return sendJson({ statuscode: 404, error: "Mod not found" }, 404);
    }
    return sendJson(modJson());
  }
  if (req.method === "GET" && pathname === "/testmod") return sendHtml(modPage());
  if (req.method === "GET" && pathname === "/testalias") return send(200, aliasModPage(), csp(42));
  if (req.method === "GET" && pathname === "/show/mod/77") return send(200, draftModPage(), csp(77));
  if (req.method === "GET" && pathname === "/edit/release/" && url.searchParams.get("modid") === "42") {
    return sendHtml(releaseCreatePage());
  }
  if (req.method === "GET" && pathname === "/edit/release" && url.searchParams.get("assetid") === "501") {
    return sendHtml(releaseEditPage());
  }
  if (req.method === "GET" && pathname === "/edit/mod/" && url.searchParams.get("assetid") === "7") {
    return sendHtml(modEditPage());
  }
  if (req.method === "GET" && pathname === "/notifications") return sendHtml(notificationsPage());

  if (req.method === "POST" && pathname === "/edit/release/" && url.searchParams.get("modid") === "42") {
    return send(303, "", { location: "/testmod" });
  }
  if (req.method === "POST" && pathname === "/edit/release" && url.searchParams.get("assetid") === "501") {
    return send(303, "", { location: "/testmod" });
  }
  if (req.method === "POST" && pathname === "/edit/mod/" && url.searchParams.get("assetid") === "7") {
    if (state.failNextModPost) {
      state.failNextModPost = false;
      return sendHtml(modPostFailurePage());
    }
    return send(303, "", { location: "/testmod" });
  }

  // ---- v2 API ----
  if (req.method === "PUT" && pathname === "/api/v2/mods/42/comments") {
    if (state.rejectTokenOnce && url.searchParams.get("at") === "a1") {
      state.rejectTokenOnce = false;
      state.homeLevel = 2;
      return sendJson({ error: "Invalid action token" }, 403);
    }
    return send(201, "<p>Posted</p>", { "content-type": "text/html", location: "/testmod#cmt-9001" });
  }
  if (req.method === "POST" && pathname === "/api/v2/comments/9001") {
    return send(200, "<p>Edited</p>", { "content-type": "text/html" });
  }
  if (req.method === "DELETE" && pathname === "/api/v2/comments/9001") {
    return sendJson({ statuscode: 200 });
  }
  if (req.method === "PUT" && pathname === "/api/v2/mods/42/releases/501/retraction") {
    if (!fields().reason) return sendJson({ error: "No reason given" }, 400);
    return sendJson({ statuscode: 200 });
  }
  if (req.method === "POST" && pathname === "/api/v2/mods/42/tags") {
    return sendJson({ statuscode: 200, added: url.searchParams.get("at") ? 2 : 0 });
  }
  if (req.method === "POST" && pathname === "/api/v2/notifications/clear") {
    return sendJson({ statuscode: 200 });
  }

  send(404, `mock has no route for ${req.method} ${pathname}`);
});

/* ------------------------------------------------------------------ */
/* Driver                                                              */
/* ------------------------------------------------------------------ */

const calls = [];
const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  const entry = { name, args, isError: Boolean(res.isError), text };
  calls.push(entry);
  return entry;
};
const ok = (label, r) => {
  check(label, !r.isError, r.isError ? r.text : `unexpectedly errored: ${r.text}`);
};
const json = (r) => JSON.parse(r.text);
const requests = (method, pathPrefix) =>
  state.requests.filter((r) => r.method === method && r.path.startsWith(pathPrefix));

const base = await new Promise((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
});

const sessionFile = path.join(tmp, "session.json");
fs.writeFileSync(sessionFile, JSON.stringify({ cookie: "vs_websessionkey=smoke-session" }) + "\n");
const sessionAt = () => JSON.parse(fs.readFileSync(sessionFile, "utf8")).at;

const zipPath = path.join(tmp, "testmod.zip");
fs.writeFileSync(zipPath, Buffer.concat([Buffer.from("PK\u0003\u0004"), Buffer.from("smoke")]));
const txtPath = path.join(tmp, "notes.txt");
fs.writeFileSync(txtPath, "not a release");

const client = new Client({ name: "vsmoddb-smoke", version: "0.0.1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "dist", "index.js")],
  env: { ...process.env, VSMODDB_BASE_URL: base, VSMODDB_SESSION_FILE: sessionFile },
});
await client.connect(transport);
console.log(`mock ModDB at ${base}\n`);

const pkgVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
check(
  "server reports the package version",
  client.getServerVersion()?.version === pkgVersion,
  `server=${client.getServerVersion()?.version} package=${pkgVersion}`,
);

try {
  /* -------- session hot reload: logging in while the server is already running -------- */
  const parkedSession = fs.readFileSync(sessionFile, "utf8");
  fs.rmSync(sessionFile);
  const noSession = await call("moddb_status");
  check(
    "moddb_status explains how to log in when no session file exists",
    noSession.isError &&
      /No valid ModDB session is configured/.test(noSession.text) &&
      /npm run login/.test(noSession.text),
    noSession.text,
  );
  fs.writeFileSync(sessionFile, parkedSession);
  const afterLogin = await call("moddb_status");
  check(
    "the running server picks up a session file that appears later",
    !afterLogin.isError && json(afterLogin).user_hash === "DEADBEEF",
    afterLogin.text,
  );

  /* -------- session tools -------- */
  const status = await call("moddb_status");
  ok("moddb_status succeeds", status);
  if (!status.isError) {
    const s = json(status);
    check("moddb_status reports the logged-in account", s.user_hash === "DEADBEEF", status.text);
    check("moddb_status resolves the player name", s.player === "Smoke Tester", status.text);
    check("moddb_status points at the mock", s.base_url === base, status.text);
    check("moddb_status does not echo the action token", s.at === undefined && !/action token/i.test(status.text));
    check(
      "moddb_status caches the action token in the session file",
      sessionAt() === "a1",
      `session file at=${sessionAt()}`,
    );
  }

  const mine = await call("list_my_mods");
  ok("list_my_mods succeeds", mine);
  if (!mine.isError) {
    const m = json(mine);
    check("list_my_mods finds the contributed mod", m.count === 1 && m.mods[0].name === "Test Mod", mine.text);
    check("list_my_mods returns the mod path", m.mods[0].path === "/testmod", mine.text);
  }

  /* -------- get_mod -------- */
  const mod = await call("get_mod", { mod: "testmod", include_changelogs: true });
  ok("get_mod succeeds", mod);
  if (!mod.isError) {
    const g = json(mod);
    check("get_mod maps ids", g.modid === 42 && g.assetid === 7, mod.text);
    check("get_mod lists releases", g.release_count === 1 && g.releases[0].release_id === 501, mod.text);
    check("get_mod maps game versions", g.releases[0].game_versions.join() === "1.22.7", mod.text);
    check("get_mod converts changelog html to text", g.releases[0].changelog === "First release", mod.text);
  }
  const missing = await call("get_mod", { mod: "nonexistent" });
  check("get_mod reports unresolvable mods", missing.isError && /Could not resolve mod/.test(missing.text), missing.text);
  check(
    "get_mod falls back to the mod page before giving up",
    requests("GET", "/nonexistent").length >= 1,
    `page lookups: ${requests("GET", "/nonexistent").length}`,
  );
  const aliasMod = await call("get_mod", { mod: "testalias" });
  check(
    "get_mod resolves URL aliases through the mod page",
    !aliasMod.isError && json(aliasMod).modid === 42 && json(aliasMod).name === "Test Mod",
    aliasMod.text,
  );
  const draftMod = await call("get_mod", { mod: "https://mods.vintagestory.at/show/mod/77" });
  check(
    "get_mod resolves unpublished drafts from the mod page",
    !draftMod.isError &&
      json(draftMod).modid === 77 &&
      json(draftMod).assetid === 77 &&
      /draft/i.test(json(draftMod).status_note ?? ""),
    draftMod.text,
  );

  /* -------- comments -------- */
  const comments = await call("list_comments", { mod: "42" });
  ok("list_comments succeeds", comments);
  if (!comments.isError) {
    const c = json(comments);
    check("list_comments skips deleted comments", c.total_visible === 2, comments.text);
    check("list_comments is newest first", c.comments[0].id === 9000 && c.comments[1].id === 8999, comments.text);
    check("list_comments resolves reply targets", c.comments[1].reply_to === 9000, comments.text);
    check("list_comments converts dates", c.comments[0].date === new Date(1767225600 * 1000).toISOString(), comments.text);
  }

  const reply = await call("reply_to_comment", {
    mod: "testmod",
    comment_id: 9000,
    text: "Thanks **a lot**!\n\n- Fixed",
  });
  ok("reply_to_comment succeeds", reply);
  if (!reply.isError) {
    check("reply_to_comment returns the new comment id", json(reply).comment_id === 9001, reply.text);
  }
  const commentPuts = requests("PUT", "/api/v2/mods/42/comments");
  check("reply_to_comment retried after the stale action token", commentPuts.length === 2, `${commentPuts.length} PUTs`);
  if (commentPuts.length === 2) {
    check("stale-token retry used the old token first", commentPuts[0].query.get("at") === "a1");
    check("stale-token retry refreshed the token", commentPuts[1].query.get("at") === "a2");
    check("reply uses response-to", commentPuts[1].query.get("response-to") === "9000");
    check(
      "reply Content-Type is exactly text/html",
      commentPuts[1].headers["content-type"] === "text/html",
      String(commentPuts[1].headers["content-type"]),
    );
    check(
      "reply body is the converted markdown",
      commentPuts[1].bodyUtf8 === "<p>Thanks <strong>a lot</strong>!</p>\n<ul>\n<li>Fixed</li>\n</ul>",
      commentPuts[1].bodyUtf8,
    );
    check("reply sends the session cookie", /vs_websessionkey=smoke-session/.test(commentPuts[1].headers.cookie ?? ""));
  }

  const edited = await call("edit_comment", { comment_id: 9001, text: "Updated" });
  ok("edit_comment succeeds", edited);
  const commentPosts = requests("POST", "/api/v2/comments/9001");
  check("edit_comment uses text/html", commentPosts[0]?.headers["content-type"] === "text/html");
  check("edit_comment sends converted markdown", commentPosts[0]?.bodyUtf8 === "<p>Updated</p>", commentPosts[0]?.bodyUtf8);

  const refusedDelete = await call("delete_comment", { comment_id: 9001, confirm: false });
  check("delete_comment requires confirm", refusedDelete.isError && /confirm/.test(refusedDelete.text), refusedDelete.text);
  const deleted = await call("delete_comment", { comment_id: 9001, confirm: true });
  ok("delete_comment succeeds", deleted);
  const commentDeletes = requests("DELETE", "/api/v2/comments/9001");
  check("delete_comment sends an empty form body", commentDeletes[0]?.bodyUtf8 === "", JSON.stringify(commentDeletes[0]?.bodyUtf8));
  check(
    "delete_comment uses a urlencoded form",
    commentDeletes[0]?.headers["content-type"] === "application/x-www-form-urlencoded",
  );

  /* -------- release upload -------- */
  const noConfirm = await call("upload_release", { mod: "testmod", file_path: zipPath });
  check("upload_release requires confirm", noConfirm.isError && /confirm/.test(noConfirm.text), noConfirm.text);

  const noVersions = await call("upload_release", { mod: "testmod", file_path: zipPath, confirm: true });
  check("upload_release asks for game versions", noVersions.isError && /game_versions/.test(noVersions.text), noVersions.text);

  const badVersion = await call("upload_release", {
    mod: "testmod",
    file_path: zipPath,
    game_versions: ["9.9.9"],
    confirm: true,
  });
  check("upload_release validates game versions", badVersion.isError && /9\.9\.9/.test(badVersion.text), badVersion.text);

  const badFile = await call("upload_release", {
    mod: "testmod",
    file_path: path.join(tmp, "missing.zip"),
    game_versions: ["1.22.7"],
    confirm: true,
  });
  check("upload_release checks the file exists", badFile.isError && /not found/i.test(badFile.text), badFile.text);

  const badExt = await call("upload_release", {
    mod: "testmod",
    file_path: txtPath,
    game_versions: ["1.22.7"],
    confirm: true,
  });
  check("upload_release rejects non-release files", badExt.isError && /\.zip/.test(badExt.text), badExt.text);

  const upload = await call("upload_release", {
    mod: "testmod",
    file_path: zipPath,
    changelog: "First *public* build",
    game_versions: ["1.22.7", "1.22.5"],
    version: "2.0.0",
    confirm: true,
  });
  ok("upload_release succeeds", upload);
  if (!upload.isError) {
    const u = json(upload);
    check("upload_release reports the ignored version", /ignored/.test(JSON.stringify(u.notes)), upload.text);
    check("upload_release reports the mod page url", u.url === `${base}/testmod`, upload.text);
  }
  const uploadPosts = requests("POST", "/edit/release/");
  check("upload_release posts multipart", uploadPosts.length === 1, `${uploadPosts.length} POSTs`);
  if (uploadPosts.length === 1) {
    const req = uploadPosts[0];
    check("upload uses multipart/form-data", /^multipart\/form-data; boundary=/.test(req.headers["content-type"] ?? ""));
    const boundary = /boundary=(.+)$/.exec(req.headers["content-type"])[1];
    const parts = parseMultipart(req.bodyLatin1, boundary);
    const byName = (n) => parts.filter((p) => p.name === n);
    const value = (n) => byName(n)[0]?.content;
    check("upload sends save=1", value("save") === "1", JSON.stringify(value("save")));
    check("upload sends assetid=", value("assetid") === "");
    check("upload targets the resolved modid", value("modid") === "42");
    check("upload sends numsaved=0", value("numsaved") === "0");
    check("upload sends saveandback=1", value("saveandback") === "1");
    check("upload sends the action token", value("at") === sessionAt(), `${value("at")} vs ${sessionAt()}`);
    check(
      "upload sends the converted changelog",
      value("text") === "<p>First <em>public</em> build</p>",
      value("text"),
    );
    check(
      "upload sends one cgvs[] per game version",
      byName("cgvs[]").map((p) => p.content).join() === "1.22.7,1.22.5",
      byName("cgvs[]").map((p) => p.content).join(),
    );
    const file = byName("newfile")[0];
    check("upload attaches the file as newfile", file?.filename === "testmod.zip", String(file?.filename));
    check("upload sends the file bytes", file?.content.startsWith("PK"), String(file?.content.slice(0, 8)));
  }

  /* -------- update_release -------- */
  const unknownRelease = await call("update_release", { mod: "testmod", release_id: 999, changelog: "x" });
  check("update_release validates the release id", unknownRelease.isError && /not found/.test(unknownRelease.text), unknownRelease.text);

  const versionOnGameMod = await call("update_release", { mod: "testmod", release_id: 501, version: "1.0.1" });
  check(
    "update_release refuses game-mod version edits",
    versionOnGameMod.isError && /zip/.test(versionOnGameMod.text),
    versionOnGameMod.text,
  );

  const noChanges = await call("update_release", { mod: "testmod", release_id: 501 });
  check("update_release requires a change", noChanges.isError && /No changes/.test(noChanges.text), noChanges.text);

  const updateRelease = await call("update_release", {
    mod: "testmod",
    release_id: 501,
    changelog: "Changelog *update*",
    game_versions: ["1.22.6", "1.22.7"],
  });
  ok("update_release succeeds", updateRelease);
  const releasePosts = state.requests.filter((r) => r.method === "POST" && r.path === "/edit/release");
  check("update_release posts the serialized edit form", releasePosts.length === 1, `${releasePosts.length} POSTs`);
  if (releasePosts.length === 1) {
    const body = new URLSearchParams(releasePosts[0].bodyUtf8);
    check("update_release keeps the form's save/modid/assetid", body.get("save") === "1" && body.get("modid") === "42" && body.get("assetid") === "501", releasePosts[0].bodyUtf8);
    check("update_release replaces the changelog", body.get("text") === "<p>Changelog <em>update</em></p>", String(body.get("text")));
    check("update_release replaces game versions", body.getAll("cgvs[]").join() === "1.22.6,1.22.7", body.getAll("cgvs[]").join());
    check("update_release forces saveandback", body.get("saveandback") === "1");
    check("update_release omits the disabled version input", body.get("modversion") === null, String(body.get("modversion")));
  }

  /* -------- retract_release -------- */
  const retractNoConfirm = await call("retract_release", { mod: "testmod", release_id: 501, reason: "Broken" });
  check("retract_release requires confirm", retractNoConfirm.isError && /confirm/.test(retractNoConfirm.text), retractNoConfirm.text);

  const retract = await call("retract_release", {
    mod: "testmod",
    release_id: 501,
    reason: "Broken **save**",
    confirm: true,
  });
  ok("retract_release succeeds", retract);
  const retractionPuts = requests("PUT", "/api/v2/mods/42/releases/501/retraction");
  check("retract_release calls the retraction endpoint", retractionPuts.length === 1);
  check(
    "retract_release sends the reason as html",
    new URLSearchParams(retractionPuts[0]?.bodyUtf8 ?? "").get("reason") === "<p>Broken <strong>save</strong></p>",
    retractionPuts[0]?.bodyUtf8,
  );

  /* -------- update_mod -------- */
  const modNoChanges = await call("update_mod", { mod: "testmod" });
  check("update_mod requires a change", modNoChanges.isError && /No changes/.test(modNoChanges.text), modNoChanges.text);

  const badSide = await call("update_mod", { mod: "testmod", side: "NoSuchSide" });
  check("update_mod validates side options", badSide.isError && /Valid options: Client \(0\), Server \(1\), Both \(2\)/.test(badSide.text), badSide.text);

  const badTag = await call("update_mod", { mod: "testmod", tags: ["Nonexistent"] });
  check("update_mod rejects unknown tags", badTag.isError && /Unknown tag\(s\): Nonexistent/.test(badTag.text), badTag.text);

  const modUpdate = await call("update_mod", {
    mod: "testmod",
    summary: "Better summary",
    side: "Both",
    add_tags: ["Library"],
    remove_tags: ["Utility"],
  });
  ok("update_mod succeeds", modUpdate);
  const modPosts = requests("POST", "/edit/mod/");
  check("update_mod posts the serialized edit form", modPosts.length === 1, `${modPosts.length} POSTs`);
  if (modPosts.length === 1) {
    const body = new URLSearchParams(modPosts[0].bodyUtf8);
    check("update_mod sets the summary", body.get("summary") === "Better summary", modPosts[0].bodyUtf8);
    check("update_mod maps the side label to its value", body.get("side") === "2", String(body.get("side")));
    check("update_mod applies tag additions/removals", body.getAll("tagids[]").join() === "11", body.getAll("tagids[]").join());
    check("update_mod preserves the description", body.get("text") === "<p>Hello</p>", String(body.get("text")));
    check("update_mod keeps unrelated fields", body.get("name") === "Test Mod" && body.get("sourceCodeUrl") === "https://github.com/example/testmod");
    check("update_mod sends the action token", body.get("at") === sessionAt(), String(body.get("at")));
  }

  const descUpdate = await call("update_mod", { mod: "testmod", description: "# Title\n\nHello" });
  ok("update_mod can replace the description", descUpdate);
  const descBody = new URLSearchParams(state.requests.filter((r) => r.method === "POST" && r.path === "/edit/mod/").at(-1).bodyUtf8);
  check("update_mod converts markdown descriptions", descBody.get("text") === "<h1>Title</h1>\n<p>Hello</p>", String(descBody.get("text")));

  state.failNextModPost = true;
  const failedSave = await call("update_mod", { mod: "testmod", name: "Test Mod 2" });
  check(
    "update_mod surfaces server-side form errors",
    failedSave.isError && /Name contains illegal characters/.test(failedSave.text),
    failedSave.text,
  );

  /* -------- tags via the v2 API -------- */
  const addTags = await call("add_mod_tags", { mod: "testmod", tags: ["Automation", "Utility"] });
  ok("add_mod_tags succeeds", addTags);
  const tagPosts = requests("POST", "/api/v2/mods/42/tags");
  check("add_mod_tags posts tags[] entries", tagPosts[0]?.bodyUtf8.startsWith("tags%5B%5D=Automation&tags%5B%5D=Utility"), tagPosts[0]?.bodyUtf8);
  check("add_mod_tags sends the action token", tagPosts[0]?.query.get("at") === sessionAt(), String(tagPosts[0]?.query.get("at")));

  /* -------- notifications -------- */
  const notes = await call("list_notifications");
  ok("list_notifications succeeds", notes);
  if (!notes.isError) {
    const n = json(notes);
    check("list_notifications reads ids", n.count === 2 && n.notifications.map((x) => x.id).join() === "77,76", notes.text);
    check("list_notifications resolves links", n.notifications[1].link === `${base}/notification/76`, notes.text);
    check("list_notifications reads dates", n.notifications[0].when === "2 hours ago", notes.text);
  }

  const clearOne = await call("mark_notifications_read", { ids: [77] });
  ok("mark_notifications_read clears one", clearOne);
  check(
    "mark_notifications_read sends comma-separated ids",
    new URLSearchParams(requests("POST", "/api/v2/notifications/clear")[0]?.bodyUtf8 ?? "").get("ids") === "77",
  );
  const clearAll = await call("mark_notifications_read", { all: true });
  ok("mark_notifications_read --all succeeds", clearAll);
  check(
    "mark_notifications_read --all expands to every id",
    new URLSearchParams(requests("POST", "/api/v2/notifications/clear")[1]?.bodyUtf8 ?? "").get("ids") === "77,76",
  );

  /* -------- session expiry -------- */
  state.loggedOut = true;
  const expired = await call("list_my_mods");
  check(
    "expired sessions produce login instructions",
    expired.isError && /session has expired/i.test(expired.text) && /npm run login/.test(expired.text),
    expired.text,
  );
  state.loggedOut = false;
} catch (err) {
  failures.push(`driver crashed: ${err?.stack ?? err}`);
  console.error(err);
} finally {
  await client.close().catch(() => {});
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} checks passed, ${failures.length} failed`);
if (failures.length) {
  console.error(failures.map((f) => `- ${f}`).join("\n"));
  process.exitCode = 1;
}
