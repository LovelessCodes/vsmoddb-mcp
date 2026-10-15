import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Session {
  /** Raw value for the `Cookie` header, e.g. "vs_websessionkey=...". */
  cookie: string;
  /** Cached ModDB action token ("at"); refreshed automatically by the client. */
  at?: string;
  /** Cached user hash of the logged-in account. */
  hash?: string;
  updatedAt?: string;
}

export function sessionFilePath(): string {
  const override = process.env.VSMODDB_SESSION_FILE;
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".config", "vsmoddb-mcp", "session.json");
}

export function loadSession(): Session | null {
  try {
    const raw = fs.readFileSync(sessionFilePath(), "utf8");
    const parsed = JSON.parse(raw) as Session;
    if (typeof parsed.cookie !== "string" || !parsed.cookie) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveSession(session: Session): void {
  const file = sessionFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(session, null, 2) + "\n", { mode: 0o600 });
}

export function loginInstructions(): string {
  return [
    "No valid ModDB session is configured.",
    "",
    "Log in once with:",
    "  npm run login",
    "    (opens a browser window at the Vintage Story account login; the reCAPTCHA cannot be automated)",
    '    (first time only: run "npx playwright install chromium")',
    "",
    "or create the session file manually:",
    `  ${sessionFilePath()}`,
    '  { "cookie": "vs_websessionkey=<value copied from your browser devtools>" }',
  ].join("\n");
}
