import { fetchFollowingFeedFull, fetchUserTweetsFull } from "./bird.js";
import { loadSettings, loadSeedAccounts, type Settings } from "./config.js";
import { getDb, type DB } from "./db.js";
import type { BirdFullTweet, TweetRow } from "./types.js";

// ---------------------------------------------------------------------------
// Normalization: bird --json-full element -> TweetRow (§7)
// ---------------------------------------------------------------------------

/** Read the `legacy` object from bird's `_raw`, defensively (it's unknown). */
function legacyOf(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && "legacy" in raw) {
    const legacy = (raw as { legacy?: unknown }).legacy;
    if (legacy && typeof legacy === "object") return legacy as Record<string, unknown>;
  }
  return {};
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function isRepost(tweet: BirdFullTweet, legacy: Record<string, unknown>): boolean {
  if (typeof legacy["retweeted_status_id_str"] === "string") return true;
  if (
    tweet._raw &&
    typeof tweet._raw === "object" &&
    "retweeted_status_result" in tweet._raw &&
    (tweet._raw as { retweeted_status_result?: unknown }).retweeted_status_result
  ) {
    return true;
  }
  return /^RT @\w+:/.test(tweet.text);
}

/** Convert Twitter's "Sun Jul 05 08:00:01 +0000 2026" to ISO; fall back to raw. */
function toIso(twitterDate: string): string {
  const ms = Date.parse(twitterDate);
  return Number.isNaN(ms) ? twitterDate : new Date(ms).toISOString();
}

export function normalizeTweet(tweet: BirdFullTweet, fetchedAt: string): TweetRow {
  const legacy = legacyOf(tweet._raw);
  const handle = tweet.author.username;
  const conversationId =
    tweet.conversationId ??
    (typeof legacy["conversation_id_str"] === "string"
      ? (legacy["conversation_id_str"] as string)
      : null);

  return {
    id: tweet.id,
    author_handle: handle,
    text: tweet.text,
    created_at: toIso(tweet.createdAt),
    url: `https://x.com/${handle}/status/${tweet.id}`,
    like_count: numOr(tweet.likeCount, numOr(legacy["favorite_count"], 0)),
    reply_count: numOr(tweet.replyCount, numOr(legacy["reply_count"], 0)),
    repost_count: numOr(tweet.retweetCount, numOr(legacy["retweet_count"], 0)),
    quote_count: numOr(tweet.quoteCount, numOr(legacy["quote_count"], 0)),
    is_reply: typeof legacy["in_reply_to_status_id_str"] === "string" ? 1 : 0,
    is_repost: isRepost(tweet, legacy) ? 1 : 0,
    conversation_id: conversationId,
    raw_json: JSON.stringify(tweet), // full payload (public tweet data; no secrets)
    fetched_at: fetchedAt,
  };
}

// ---------------------------------------------------------------------------
// Storage: dedup on id; refresh engagement on conflict, preserve status (§14)
// ---------------------------------------------------------------------------

interface UpsertCounts {
  inserted: number;
  updated: number;
}

function upsertTweets(db: DB, rows: TweetRow[]): UpsertCounts {
  const insert = db.prepare(`
    INSERT INTO tweets (
      id, author_handle, text, created_at, url,
      like_count, reply_count, repost_count, quote_count,
      is_reply, is_repost, conversation_id, raw_json, fetched_at, status
    ) VALUES (
      @id, @author_handle, @text, @created_at, @url,
      @like_count, @reply_count, @repost_count, @quote_count,
      @is_reply, @is_repost, @conversation_id, @raw_json, @fetched_at, 'seen'
    )
    ON CONFLICT(id) DO UPDATE SET
      like_count   = excluded.like_count,
      reply_count  = excluded.reply_count,
      repost_count = excluded.repost_count,
      quote_count  = excluded.quote_count,
      raw_json     = excluded.raw_json,
      fetched_at   = excluded.fetched_at
    -- note: status, text, created_at are preserved on refresh
  `);

  // ON CONFLICT makes insert-vs-update invisible in `info.changes`, so we check
  // existence first (same transaction) to report accurate insert/update counts.
  const exists = db.prepare("SELECT 1 FROM tweets WHERE id = ?");
  const counts: UpsertCounts = { inserted: 0, updated: 0 };
  const tx = db.transaction((batch: TweetRow[]) => {
    for (const row of batch) {
      const already = exists.get(row.id) !== undefined;
      insert.run(row);
      if (already) counts.updated += 1;
      else counts.inserted += 1;
    }
  });
  tx(rows);
  return counts;
}

// ---------------------------------------------------------------------------
// Accounts: seed the tracked-accounts table from config (INSERT OR IGNORE)
// ---------------------------------------------------------------------------

function seedAccounts(db: DB): void {
  const seeds = loadSeedAccounts();
  if (seeds.length === 0) return;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO accounts (handle, weight, added_at)
    VALUES (?, ?, ?)
  `);
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    for (const a of seeds) insert.run(a.handle, a.weight, now);
  });
  tx();
}

function trackedHandles(db: DB): string[] {
  return db
    .prepare("SELECT handle FROM accounts ORDER BY weight DESC")
    .all()
    .map((r) => (r as { handle: string }).handle);
}

// ---------------------------------------------------------------------------
// Rate-limiting: jitter every request, exponential backoff, stop on auth fail
// ---------------------------------------------------------------------------

class AuthFailure extends Error {}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function isAuthError(msg: string): boolean {
  return /\b(401|403|unauthorized|forbidden|authentication|auth[_ ]?token|not\s+logged\s+in)\b/i.test(
    msg,
  );
}
function isRetryable(msg: string): boolean {
  return /\b(429|rate.?limit|timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|socket|network|5\d\d)\b/i.test(
    msg,
  );
}
function isNotFound(msg: string): boolean {
  return /\b(404|not\s+found|no\s+such\s+user|does\s+not\s+exist|suspended|protected)\b/i.test(msg);
}

interface RateConfig {
  jitterMinSeconds: number;
  jitterMaxSeconds: number;
  backoffBaseSeconds: number;
  maxRetries: number;
}

function jitterMs(cfg: RateConfig): number {
  const { jitterMinSeconds: lo, jitterMaxSeconds: hi } = cfg;
  return (lo + Math.random() * Math.max(0, hi - lo)) * 1000;
}

/**
 * Run a fetch with exponential backoff on retryable errors. Auth failures throw
 * AuthFailure immediately (caller stops the whole run rather than hammering).
 * Permanent errors (404/suspended) also throw without retry.
 */
async function withBackoff<T>(fn: () => Promise<T>, cfg: RateConfig): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isAuthError(msg)) throw new AuthFailure(msg);
      attempt += 1;
      if (isNotFound(msg) || !isRetryable(msg) || attempt > cfg.maxRetries) throw err;
      const waitSec = cfg.backoffBaseSeconds * 2 ** (attempt - 1);
      await sleep(waitSec * 1000 + Math.random() * 1000);
    }
  }
}

// ---------------------------------------------------------------------------
// Ingest run
// ---------------------------------------------------------------------------

export interface IngestOptions {
  /** Override config jitter (seconds) — used to keep local test runs quick. */
  jitterMinSeconds?: number;
  jitterMaxSeconds?: number;
  maxRetries?: number;
  /**
   * Fetch only the following feed (one request) and skip tracked-account
   * timelines. This is the hourly-schedule mode — it keeps the hourly cadence
   * to a single jittered read so we stay gentle on the source.
   */
  feedOnly?: boolean;
}

export interface IngestStats {
  runId: number | bigint;
  feedOnly: boolean;
  following: { fetched: number; inserted: number; updated: number };
  accounts: {
    attempted: number;
    ok: number;
    failed: number;
    fetched: number;
    inserted: number;
    updated: number;
    failures: Array<{ handle: string; error: string }>;
  };
  aborted?: string;
}

export async function runIngest(opts: IngestOptions = {}): Promise<IngestStats> {
  const settings: Settings = loadSettings();
  const db = getDb();
  seedAccounts(db);

  const rate: RateConfig = {
    jitterMinSeconds: opts.jitterMinSeconds ?? settings.ingest.jitterMinSeconds,
    jitterMaxSeconds: opts.jitterMaxSeconds ?? settings.ingest.jitterMaxSeconds,
    backoffBaseSeconds: settings.ingest.backoffBaseSeconds,
    maxRetries: opts.maxRetries ?? 3,
  };
  const limit = settings.ingest.maxPerFeed;

  const startedAt = new Date().toISOString();
  const runId = db
    .prepare("INSERT INTO runs (kind, started_at) VALUES ('ingest', ?)")
    .run(startedAt).lastInsertRowid;

  const stats: IngestStats = {
    runId,
    feedOnly: opts.feedOnly ?? false,
    following: { fetched: 0, inserted: 0, updated: 0 },
    accounts: {
      attempted: 0,
      ok: 0,
      failed: 0,
      fetched: 0,
      inserted: 0,
      updated: 0,
      failures: [],
    },
  };

  const finalize = (): IngestStats => {
    db.prepare("UPDATE runs SET finished_at = ?, stats_json = ? WHERE id = ?").run(
      new Date().toISOString(),
      JSON.stringify(stats),
      runId,
    );
    return stats;
  };

  try {
    // 1) Following feed (primary source). No pre-jitter on the very first read.
    if (settings.ingest.feedTypes.includes("following")) {
      const tweets = await withBackoff(() => fetchFollowingFeedFull(limit), rate);
      const now = new Date().toISOString();
      const rows = tweets.map((t) => normalizeTweet(t, now));
      const c = upsertTweets(db, rows);
      stats.following = { fetched: rows.length, inserted: c.inserted, updated: c.updated };
    }

    // 2) Tracked account timelines, jittered between each. Skipped in
    //    feed-only (hourly) mode — deep reads stay on the manual/daily path.
    for (const handle of opts.feedOnly ? [] : trackedHandles(db)) {
      stats.accounts.attempted += 1;
      await sleep(jitterMs(rate)); // gentle: pause before each account read
      try {
        const tweets = await withBackoff(() => fetchUserTweetsFull(handle, limit), rate);
        const now = new Date().toISOString();
        const rows = tweets.map((t) => normalizeTweet(t, now));
        const c = upsertTweets(db, rows);
        stats.accounts.ok += 1;
        stats.accounts.fetched += rows.length;
        stats.accounts.inserted += c.inserted;
        stats.accounts.updated += c.updated;
      } catch (err) {
        if (err instanceof AuthFailure) throw err; // bubble up: stop the run
        stats.accounts.failed += 1;
        stats.accounts.failures.push({
          handle,
          error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
        });
      }
    }
  } catch (err) {
    if (err instanceof AuthFailure) {
      stats.aborted = "auth failure — cookie likely expired; re-extract auth_token/ct0 and retry.";
      return finalize();
    }
    stats.aborted = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    return finalize();
  }

  return finalize();
}
