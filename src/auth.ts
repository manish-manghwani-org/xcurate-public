import { config } from "dotenv";
import { runBird, redact } from "./bird.js";

config({ quiet: true });

const AUTH_TOKEN = "TWITTER_AUTH_TOKEN";
const CT0 = "TWITTER_CT0";

/**
 * Ensure the cookie is present in the environment (loaded from .env). Throws a
 * clear, actionable error — never echoes the values.
 */
export function assertCredentialsPresent(): void {
  const missing: string[] = [];
  if (!process.env[AUTH_TOKEN]?.trim()) missing.push(AUTH_TOKEN);
  if (!process.env[CT0]?.trim()) missing.push(CT0);
  if (missing.length > 0) {
    throw new Error(
      `Missing ${missing.join(" and ")} in .env.\n` +
        `Copy .env.example to .env and paste your x.com cookies from\n` +
        `DevTools > Application > Cookies > https://x.com (auth_token, ct0).\n` +
        `These are secrets — never commit, log, or share them.`,
    );
  }
}

export interface AuthStatus {
  ok: boolean;
  handle?: string;
  detail: string;
}

/**
 * Verify the cookie is still *valid* (not just present) by hitting the API via
 * `bird whoami`. Reports validity and the authenticated handle without ever
 * printing token values. On failure, tells the human to re-extract the cookie.
 */
export async function authCheck(): Promise<AuthStatus> {
  assertCredentialsPresent();

  let out: string;
  try {
    // whoami performs a real authenticated read, so it detects an expired cookie.
    out = await runBird(["whoami"]);
  } catch (err) {
    return {
      ok: false,
      detail:
        `Cookie is present but authentication failed — it has most likely expired.\n` +
        `Re-extract auth_token and ct0 from a fresh x.com session and update .env.\n` +
        `(${redact(err instanceof Error ? err.message : String(err))})`,
    };
  }

  // Never print `out` — whoami echoes account internals. Only extract the handle.
  const match = out.match(/@([A-Za-z0-9_]{1,15})/);
  const handle = match?.[1];
  if (!handle) {
    return { ok: false, detail: "Could not confirm the account — the cookie may be invalid." };
  }
  return { ok: true, handle, detail: `Cookie valid — authenticated as @${handle}.` };
}
