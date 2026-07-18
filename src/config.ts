import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

/** Validated shape of config/settings.json (§9). */
export const Settings = z.object({
  windowHours: z.number().positive(),
  candidateLimit: z.number().int().positive(),
  maxReplyChars: z.number().int().positive(),
  ingest: z.object({
    feedTypes: z.array(z.enum(["following", "for-you"])).min(1),
    maxPerFeed: z.number().int().positive(),
    jitterMinSeconds: z.number().nonnegative(),
    jitterMaxSeconds: z.number().nonnegative(),
    backoffBaseSeconds: z.number().nonnegative(),
  }),
  weights: z.object({
    wRecency: z.number(),
    wAuthor: z.number(),
    wEngagement: z.number(),
    wPenalty: z.number(),
  }),
  decay: z.enum(["linear", "exp"]),
  mutedHandles: z.array(z.string()),
  buckets: z.object({
    maxPerBucket: z.number().int().positive(), // diversity cap at candidate export
    profileWindowDays: z.number().positive(), // rolling window for account profiles
    profileMaxTweets: z.number().int().positive(), // per-author cap inside the window
    minProfileTweets: z.number().int().positive(), // labeled tweets needed before a profile exists
    suggestMinSamples: z.number().int().positive(), // posted+skipped needed before suggesting a multiplier
    exportLimit: z.number().int().positive(), // max tweets per buckets:export batch
  }),
  calibrate: z.object({
    buckets: z.object({
      calibrateWeeks: z.number().positive(),
      validateWeeks: z.number().positive(),
      testWeeks: z.number().positive(),
    }),
    maxRequests: z.number().int().positive(),
    engagementWeighting: z.boolean(),
  }),
  // Local classifier (PLANNING.md §2.7) — Ollama-backed topic bucketing. Fully
  // local: reads only tweet text from SQLite, never touches X or the cookie.
  classify: z.object({
    provider: z.literal("ollama"),
    endpoint: z.string().min(1), // Ollama base URL, e.g. http://127.0.0.1:11434
    model: z.string().min(1), // e.g. qwen2.5:7b-instruct (3b bridge until RAM lands)
    concurrency: z.number().int().positive(), // CPU-bound: 1 serializes to avoid thrashing
    timeoutMs: z.number().int().positive(), // per-tweet request timeout
    maxRetries: z.number().int().nonnegative(), // retries before a tweet falls to `other`
  }),
});
export type Settings = z.infer<typeof Settings>;

const SETTINGS_PATH = path.resolve(process.cwd(), "config", "settings.json");

export function loadSettings(file: string = SETTINGS_PATH): Settings {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`Could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const result = Settings.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid config/settings.json:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/** A tracked account as declared in config/accounts.seed.json (§9). */
export const SeedAccount = z.object({
  handle: z.string().min(1),
  weight: z.number().positive().default(1.0),
});
export const SeedAccounts = z.array(SeedAccount);
export type SeedAccount = z.infer<typeof SeedAccount>;

const SEED_PATH = path.resolve(process.cwd(), "config", "accounts.seed.json");

export function loadSeedAccounts(file: string = SEED_PATH): SeedAccount[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return []; // seed file is optional
  }
  const result = SeedAccounts.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid config/accounts.seed.json:\n${z.prettifyError(result.error)}`);
  }
  // Strip a leading "@" if present, normalize to lowercase for stable keys.
  return result.data.map((a) => ({ ...a, handle: a.handle.replace(/^@/, "").toLowerCase() }));
}
