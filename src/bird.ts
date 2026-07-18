import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { z } from "zod";
import {
  BirdTweetArray,
  BirdFullTweetArray,
  BirdFullTweet,
  type BirdTweet,
} from "./types.js";

const execFileP = promisify(execFile);
const require = createRequire(import.meta.url);

// Run bird's own CLI entry with node directly — no reliance on PATH or the
// .bin shim, and no shell, so nothing can be injected via arguments.
const BIRD_CLI = path.join(
  path.dirname(require.resolve("@steipete/bird/package.json")),
  "dist",
  "cli.js",
);

/**
 * §2 (non-negotiable): xcurate is READ-ONLY against X. Only the subcommands in
 * this allowlist may ever run. bird's write commands (tweet, reply, unbookmark,
 * …) are deliberately absent AND explicitly denied below. This is the single
 * choke point through which every X request passes.
 */
const READ_ONLY_COMMANDS = new Set([
  "home",
  "read",
  "thread",
  "replies",
  "search",
  "mentions",
  "user-tweets",
  "list-timeline",
  "lists",
  "following",
  "followers",
  "about",
  "whoami",
  "check",
  "help",
  "query-ids",
]);

// Belt-and-suspenders denylist: any of these throws even if mistakenly allowed.
const FORBIDDEN_COMMANDS = new Set([
  "tweet",
  "reply",
  "unbookmark",
  "bookmark",
  "like",
  "unlike",
  "follow",
  "unfollow",
  "dm",
  "retweet",
]);

/** Strip anything that looks like a cookie/token before logging or throwing. */
export function redact(s: string): string {
  return s.replace(/[A-Fa-f0-9]{16,}/g, "<REDACTED>");
}

/**
 * Run a bird subcommand and return raw stdout. Auth (TWITTER_AUTH_TOKEN /
 * TWITTER_CT0) is passed only via the child's environment — never on argv, so
 * it can't leak into a process listing. Secrets are never logged.
 */
export async function runBird(args: string[]): Promise<string> {
  const sub = args[0];
  if (!sub) throw new Error("bird: no subcommand given");
  if (FORBIDDEN_COMMANDS.has(sub) || !READ_ONLY_COMMANDS.has(sub)) {
    throw new Error(
      `bird: refusing to run "${sub}" — xcurate is read-only against X (§2). ` +
        `Only read subcommands are permitted.`,
    );
  }
  try {
    const { stdout } = await execFileP(process.execPath, [BIRD_CLI, ...args], {
      env: process.env, // carries the cookie; never placed in argv
      maxBuffer: 32 * 1024 * 1024,
      timeout: 60_000,
    });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(`bird ${sub} failed: ${redact(e.stderr || e.message || String(err))}`);
  }
}

/** Run a read subcommand with `--json` appended and validate the result. */
export async function birdJson<T>(schema: z.ZodType<T>, args: string[]): Promise<T> {
  const out = await runBird([...args, "--json"]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    throw new Error(`bird ${args[0]}: expected JSON output, got: ${redact(out.slice(0, 200))}`);
  }
  return schema.parse(parsed);
}

/** Fetch the Following home feed (tweets from accounts you follow), simple JSON. */
export async function fetchFollowingFeed(limit: number): Promise<BirdTweet[]> {
  return birdJson(BirdTweetArray, ["home", "--following", "-n", String(limit)]);
}

/** Fetch the Following home feed with the full GraphQL payload (for ingest). */
export async function fetchFollowingFeedFull(limit: number): Promise<BirdFullTweet[]> {
  const out = await runBird(["home", "--following", "-n", String(limit), "--json-full"]);
  return parseFullTweets(out, "home");
}

/** Fetch a user's profile timeline with the full GraphQL payload (for ingest). */
export async function fetchUserTweetsFull(
  handle: string,
  limit: number,
): Promise<BirdFullTweet[]> {
  const h = handle.startsWith("@") ? handle : `@${handle}`;
  const out = await runBird(["user-tweets", h, "-n", String(limit), "--json-full"]);
  return parseFullTweets(out, "user-tweets");
}

/**
 * bird's `--json-full` output shape is not stable across commands / counts: it
 * may be a bare array, or a wrapper object like `{ tweets: [...], nextCursor }`
 * (observed on `user-tweets` at higher -n). Accept either.
 */
/** Search tweets with the full payload (used by calibration: `from:me filter:replies`). */
export async function searchFull(query: string, limit: number): Promise<BirdFullTweet[]> {
  const out = await runBird(["search", query, "-n", String(limit), "--json-full"]);
  return parseFullTweets(out, "search");
}

/** Fetch a single tweet (a reply's parent, for exemplar context). Null if unreadable. */
export async function readTweetFull(idOrUrl: string): Promise<BirdFullTweet | null> {
  const out = await runBird(["read", idOrUrl, "--json-full"]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    return null;
  }
  const obj = Array.isArray(parsed) ? parsed[0] : parsed;
  const result = BirdFullTweet.safeParse(obj);
  return result.success ? result.data : null;
}

function extractTweetArray(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    for (const key of ["tweets", "data", "timeline", "items"]) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
  }
  return [];
}

function parseFullTweets(out: string, label: string): BirdFullTweet[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    throw new Error(`bird ${label}: expected JSON output, got: ${redact(out.slice(0, 200))}`);
  }
  return BirdFullTweetArray.parse(extractTweetArray(parsed));
}
