# vsmoddb-mcp

[![CI](https://github.com/LovelessCodes/vsmoddb-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/LovelessCodes/vsmoddb-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/vsmoddb-mcp)](https://www.npmjs.com/package/vsmoddb-mcp)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

An MCP server for managing your mods on the [Vintage Story ModDB](https://mods.vintagestory.at):
upload and update releases, edit mod descriptions/metadata and tags, and read or
answer comments — from any MCP client (Claude Code/Desktop, OpenCode, Cursor, …).

## Install & login

```bash
npm install -g vsmoddb-mcp
npm install -g playwright && npx playwright install chromium   # browser for the login helper, once
vsmoddb-mcp-login                                              # one manual browser login (reCAPTCHA)
```

Both commands are bins of this one package (`vsmoddb-mcp` runs the server,
`vsmoddb-mcp-login` runs the login helper) — there is no separate login package.
The helper also runs straight from the registry, without a global install:

```bash
npx playwright install chromium          # browser for the login helper, once
npx -p vsmoddb-mcp vsmoddb-mcp-login     # one manual browser login (reCAPTCHA)
```

The login must be repeated roughly every two weeks; sessions cannot be renewed
without a human because of the reCAPTCHA. Playwright is an optional dependency:
without it, `vsmoddb-mcp-login` prints the exact commands to set it up and an
alternative (cookie copy) that needs no browser automation.

**From source** (for development or vendoring):

```bash
git clone https://github.com/LovelessCodes/vsmoddb-mcp.git
cd vsmoddb-mcp
npm install
npm run build
npm run login
```

Then point your MCP client at `dist/index.js` (see [Client setup](#client-setup)).

## What it can do

| Tool | Purpose |
| --- | --- |
| `moddb_status` | Validate the session, report the logged-in account |
| `list_my_mods` | List the mods your account contributes to |
| `get_mod` | Public mod metadata, links, stats and releases |
| `update_mod` | Description (Markdown/HTML), summary, name, URL alias, links, side, tags |
| `list_tags` | The site-wide tag vocabulary (id, name, color) |
| `add_mod_tags` | Add existing tags through the edit form; new ones need `create_missing: true` |
| `upload_release` | Publish a new release (`confirm: true` required) |
| `update_release` | Change a release's changelog / game versions / version |
| `retract_release` | Retract a release with a public reason (`confirm: true` required) |
| `list_comments` | Comments on a mod page, with ids |
| `reply_to_comment` | Reply to a comment (Markdown → HTML) |
| `edit_comment` / `delete_comment` | Edit or delete your comments |
| `list_notifications` | New comments, mentions, followed-mod releases |
| `mark_notifications_read` | Clear specific notifications or all of them |

Read tools return JSON. Write tools return a small confirmation object (or an
error message that the model can act on, e.g. "Unknown game version(s): 9.9.9").

## Login

ModDB's login is protected by reCAPTCHA, so it cannot be automated end-to-end.
Log in once; the server then uses the stored session cookie plus the site's
action token for every request, refreshing the token automatically.

```
npm install playwright          # only needed for the login helper
npx playwright install chromium # one-time browser download
npm run login                   # from a checkout; global install: vsmoddb-mcp-login
```

Without a global install, run the helper through npx:
`npx -p vsmoddb-mcp vsmoddb-mcp-login`.

This writes `~/.config/vsmoddb-mcp/session.json` (mode 0600) containing the
`vs_websessionkey` cookie. Sessions last roughly two weeks; when they expire,
every tool returns "Your ModDB session has expired" with the same instructions,
so you just run `npm run login` again. A server that is already running picks up
the new session file on the next tool call — no client restart needed.

No browser at all? Log in at mods.vintagestory.at in your own browser, copy the
`vs_websessionkey` cookie value from devtools, and create the file manually:

```json
{ "cookie": "vs_websessionkey=<value>" }
```

**Treat that file like a password**: the cookie is a full session for your
Vintage Story account. Delete it and log out of the site to revoke access.

## Client setup

No install needed — run it straight from npm:

```json
{
  "mcpServers": {
    "vsmoddb": {
      "command": "npx",
      "args": ["-y", "vsmoddb-mcp"]
    }
  }
}
```

Or after `npm install -g vsmoddb-mcp`, use `"command": "vsmoddb-mcp"` with no
args. From a source checkout, point at the built file with an absolute path:

```json
{
  "mcpServers": {
    "vsmoddb": {
      "command": "node",
      "args": ["/absolute/path/to/vsmoddb-mcp/dist/index.js"]
    }
  }
}
```

Note: the login helper needs the Playwright package and a Chromium build; the
browser binaries are not bundled. Run the helper once from a global install
(`vsmoddb-mcp-login`), from the registry without installing anything
(`npx -p vsmoddb-mcp vsmoddb-mcp-login`), or from a source checkout
(`npm run login`). All of them write the same session file, and an MCP server
that is already running picks it up on the next tool call.

Claude Code / CLI:

```
claude mcp add vsmoddb -- npx -y vsmoddb-mcp
```

### Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `VSMODDB_SESSION_FILE` | `~/.config/vsmoddb-mcp/session.json` | Session file location |
| `VSMODDB_BASE_URL` | `https://mods.vintagestory.at` | Override for testing against a mock |
| `VSMODDB_MAX_UPLOAD_MB` | `40` | Upload size guard (ModDB's default limit) |

## How it works

ModDB is a hybrid site, and so is this server:

- **v2 API** for comments (create/edit/delete), release retraction, and
  notifications. Requests carry the `at` action token scraped from the site;
  when ModDB rejects it as stale the server re-reads it and retries once.
- **Classic PHP forms** for release uploads, mod/release edits and tag changes,
  because the public API stubs those out (and because ModDB disables its
  user-tags API with the shipped `DISABLE_USER_TAGS` default). The server
  renders the real edit page, serializes the form exactly like a browser,
  applies only your changes, and POSTs it back. A `303` redirect means success;
  a `200` re-render is parsed for the site's error messages and surfaced as a
  tool error.

Release uploads are `multipart/form-data` with a single file field. Game mod
identifiers/versions come from the zip's `modinfo.json`, so uploads require
`game_versions: ["1.22.7", …]` and ignore any `version` you pass.

## Notes and limits

- **Release files are immutable.** `upload_release` publishes immediately and
  the zip can never be replaced; retraction is the only way back. Both
  `upload_release` and `retract_release` require `confirm: true` for this reason.
- One file per release (`.zip`, or a bare `.dll`/`.cs` for non-game categories),
  40 MB by default.
- `update_mod`'s `description` **replaces** the entire description — ask the
  model to fetch the current one first (`get_mod` with `include_description`).
- Every `mod` parameter takes an alias (`carrycapacity`), a numeric id, or a
  ModDB URL/path copied from the browser (`/show/mod/54807`). The public API
  only knows published mods, so aliases, asset ids and unpublished drafts are
  resolved through the mod page; drafts work with the editing tools, but have no
  description/release/stats data until they are published.
- Comment replies are plain Markdown converted to HTML server-side by this MCP
  server. There is deliberately no bulk-reply tool: the ModDB rules forbid
  spamming or bot-like behaviour, so keep replies human-approved and on-topic.
- Tags are site-wide, not per-mod: `list_tags` returns the vocabulary, and
  `add_mod_tags` (like the site's own edit page) refuses names that do not exist
  yet unless you pass `create_missing: true` — otherwise a typo would silently
  invent a new public tag. Creating tags goes through ModDB's user-tags API,
  which the site currently disables (HTTP 503), so today only existing tags can
  actually be applied.
- Non-game-mod versions must match `n.n.n` (optionally `-rc.n`/`-pre.n`/`-dev.n`).
- You need to be a team member with edit rights for anything you modify; other
  users' mods return a clear "no edit permission" error.

## Development

```
npm run build      # tsc
npm run typecheck  # tsc --noEmit
npm run smoke      # offline end-to-end test (no credentials, no network)
```

`npm run smoke` starts a mock ModDB (all routes the tools touch), points the
real MCP server at it via `VSMODDB_BASE_URL`, drives all 14 tools over stdio
with the MCP SDK client, and asserts the wire format — exact `Content-Type:
text/html` for comment bodies, multipart fields for uploads, action-token
refresh on `403 Invalid action token`, and session-expiry handling (102 checks).

### Releasing

`npm publish` runs `prepublishOnly`, which builds and runs the smoke test, so a
broken commit cannot be published by accident.

```bash
npm version patch            # or minor / major: bumps package.json and tags the commit
npm publish
git push --follow-tags
```
