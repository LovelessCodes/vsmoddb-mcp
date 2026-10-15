#!/usr/bin/env node
/**
 * One-time (well, once every ~14 days) login helper.
 *
 * The Vintage Story account login is protected by reCAPTCHA, so it cannot be
 * automated. This helper opens a real browser, lets you log in, then stores the
 * resulting `vs_websessionkey` cookie (and the current action token) in the
 * session file used by the MCP server.
 */
import { loadSession, saveSession, sessionFilePath } from "./session.js";

const base = (process.env.VSMODDB_BASE_URL ?? "https://mods.vintagestory.at").replace(/\/+$/, "");

interface Cookie {
  name: string;
  value: string;
}

interface LoginPage {
  goto(url: string): Promise<unknown>;
  waitForFunction(fn: () => boolean, arg: undefined, opts: { timeout: number }): Promise<unknown>;
  evaluate<T>(fn: () => T): Promise<T>;
}

interface BrowserContext {
  newPage(): Promise<LoginPage>;
  cookies(): Promise<Cookie[]>;
}

interface Browser {
  newContext(): Promise<BrowserContext>;
  close(): Promise<void>;
}

interface Chromium {
  launch(opts: { headless: boolean }): Promise<Browser>;
}

/**
 * Playwright is an optional dependency, so it is loaded through an indirect
 * specifier: that keeps `tsc` from requiring its type declarations.
 */
async function loadChromium(): Promise<Chromium | null> {
  const specifier = "playwright";
  try {
    const mod = (await import(specifier)) as { chromium?: Chromium };
    return mod.chromium ?? null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const chromium = await loadChromium();
  if (!chromium) {
    console.error(
      [
        "Playwright is not installed, so the automated login helper is unavailable.",
        "",
        "Option A: install it and retry:",
        "  npm install playwright",
        "  npx playwright install chromium",
        "  npm run login",
        "",
        "Option B: log in to mods.vintagestory.at in your own browser and create the session file manually:",
        `  ${sessionFilePath()}`,
        '  { "cookie": "vs_websessionkey=<value copied from browser devtools > Application > Cookies>" }',
      ].join("\n"),
    );
    process.exitCode = 1;
    return;
  }

  let browser: Browser;
  try {
    browser = await chromium.launch({ headless: false });
  } catch (err) {
    console.error(
      [
        "Could not start the login browser.",
        err instanceof Error ? err.message : String(err),
        "",
        "If the browser is simply not downloaded yet, run:",
        "  npx playwright install chromium",
        "  vsmoddb-mcp-login   (or: npm run login)",
      ].join("\n"),
    );
    process.exitCode = 1;
    return;
  }

  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${base}/login`);
    console.error("Log in with your Vintage Story game account in the opened window (reCAPTCHA included).");

    await page.waitForFunction(
      () => Boolean((globalThis as any).user?.hash),
      undefined,
      { timeout: 10 * 60 * 1000 },
    );

    const user = await page.evaluate(() => (globalThis as any).user as { hash: string; at: string });
    const cookies = await context.cookies();
    const sessionCookie = cookies.filter((c: Cookie) => c.name === "vs_websessionkey");
    if (!sessionCookie.length) {
      console.error("Login succeeded, but no vs_websessionkey cookie was found; aborting.");
      process.exitCode = 1;
      return;
    }
    const cookie = sessionCookie.map((c: Cookie) => `${c.name}=${c.value}`).join("; ");
    const existing = loadSession();
    saveSession({
      ...existing,
      cookie,
      hash: user.hash,
      at: user.at,
      updatedAt: new Date().toISOString(),
    });
    console.error(`Saved ModDB session for user ${user.hash} to ${sessionFilePath()}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
