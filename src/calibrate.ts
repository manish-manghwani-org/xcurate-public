import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { searchFull, readTweetFull } from "./bird.js";
import { authCheck } from "./auth.js";
import { loadSettings } from "./config.js";
import { getDb } from "./db.js";
import { MyRepliesFile, type MyReply, type MyRepliesFile as MyRepliesFileT } from "./types.js";
import type { BirdFullTweet } from "./types.js";

export const MY_REPLIES_PATH = path.resolve(process.cwd(), "data", "my-replies.json");

const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const PER_BUCKET_LIMIT = 50; // first page per bucket; deeper history is flaky for free (§12.1)
const MAX_EXEMPLAR_PARENTS = 12;

// --- rate limiting: this is the heaviest read in the system — pace it hardest (§12.6)

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class AuthFailure extends Error {}
function isAuthError(m: string): boolean {
  return /\b(401|403|unauthorized|forbidden|authentication|auth[_ ]?token|not\s+logged\s+in)\b/i.test(m);
}
function isRetryable(m: string): boolean {
  return /\b(429|rate.?limit|timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|socket|network|5\d\d)\b/i.test(m);
}

interface Pace {
  jitterMinSeconds: number;
  jitterMaxSeconds: number;
  backoffBaseSeconds: number;
  maxRetries: number;
}

function jitterMs(p: Pace): number {
  return (p.jitterMinSeconds + Math.random() * Math.max(0, p.jitterMaxSeconds - p.jitterMinSeconds)) * 1000;
}

async function withBackoff<T>(fn: () => Promise<T>, p: Pace): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      if (isAuthError(m)) throw new AuthFailure(m);
      attempt += 1;
      if (!isRetryable(m) || attempt > p.maxRetries) throw err;
      await sleep(p.backoffBaseSeconds * 2 ** (attempt - 1) * 1000 + Math.random() * 1000);
    }
  }
}

// --- normalization

function legacyOf(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && "legacy" in raw) {
    const l = (raw as { legacy?: unknown }).legacy;
    if (l && typeof l === "object") return l as Record<string, unknown>;
  }
  return {};
}
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function toMyReply(t: BirdFullTweet, bucket: "A" | "B" | "C", now: number): MyReply | null {
  if (/^RT @\w+:/.test(t.text)) return null; // exclude reposts (§12.3)
  const legacy = legacyOf(t._raw);
  const statusId = t.inReplyToStatusId ?? str(legacy["in_reply_to_status_id_str"]);
  if (!statusId) return null; // must be an authored reply, not a top-level tweet
  const createdMs = Date.parse(t.createdAt);
  const created = Number.isNaN(createdMs) ? t.createdAt : new Date(createdMs).toISOString();
  const likes = t.likeCount;
  const replies = t.replyCount;
  const reposts = t.retweetCount;
  const quotes = t.quoteCount ?? (typeof legacy["quote_count"] === "number" ? (legacy["quote_count"] as number) : 0);
  return {
    id: t.id,
    url: `https://x.com/${t.author.username}/status/${t.id}`,
    text: t.text,
    created_at: created,
    bucket,
    age_days: Math.round(((now - createdMs) / MS_PER_DAY) * 10) / 10,
    engagement: { likes, replies, reposts, quotes },
    signal: likes + 2 * replies + quotes,
    in_reply_to: { handle: str(legacy["in_reply_to_screen_name"]), status_id: statusId, text: null },
  };
}

// --- bucket windows (relative to now)

interface BucketWindow {
  label: "A" | "B" | "C";
  since: string; // YYYY-MM-DD
  until: string;
}
const fmt = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

function bucketWindows(now: number, b: { calibrateWeeks: number; validateWeeks: number; testWeeks: number }): BucketWindow[] {
  return [
    { label: "A", since: fmt(now - b.calibrateWeeks * MS_PER_WEEK), until: fmt(now + MS_PER_DAY) },
    { label: "B", since: fmt(now - b.validateWeeks * MS_PER_WEEK), until: fmt(now - b.calibrateWeeks * MS_PER_WEEK) },
    { label: "C", since: fmt(now - b.testWeeks * MS_PER_WEEK), until: fmt(now - b.validateWeeks * MS_PER_WEEK) },
  ];
}

export interface CalibrateFetchOptions {
  /** Override the hard jitter floor (seconds) — for local test runs only. */
  jitterMinSeconds?: number;
  jitterMaxSeconds?: number;
}

export interface CalibrateFetchResult {
  path: string;
  file: MyRepliesFileT;
}

/**
 * Fetch my own authored replies as deep as the reader reliably allows, bucketed
 * by age. Heaviest read in the system: jitter hard, back off on 429s, cap total
 * requests, and checkpoint to disk after each bucket so a stop can resume (§12).
 */
export async function runCalibrateFetch(
  opts: CalibrateFetchOptions = {},
): Promise<CalibrateFetchResult> {
  const settings = loadSettings();
  const db = getDb();

  const status = await authCheck();
  if (!status.ok || !status.handle) {
    throw new Error(`auth check failed — cannot calibrate. ${status.detail}`);
  }
  const me = status.handle;

  const pace: Pace = {
    // Pace hardest of all reads: at least the ingest jitter, floor 20s.
    // Overrides exist for local test runs only; production keeps the floor.
    jitterMinSeconds: opts.jitterMinSeconds ?? Math.max(20, settings.ingest.jitterMinSeconds),
    jitterMaxSeconds: opts.jitterMaxSeconds ?? Math.max(90, settings.ingest.jitterMaxSeconds),
    backoffBaseSeconds: Math.max(30, settings.ingest.backoffBaseSeconds),
    maxRetries: 4,
  };

  const startedAt = new Date().toISOString();
  const runId = db
    .prepare("INSERT INTO runs (kind, started_at) VALUES ('calibrate', ?)")
    .run(startedAt).lastInsertRowid;

  const now = Date.now();
  const windows = bucketWindows(now, settings.calibrate.buckets);
  const byId = new Map<string, MyReply>();
  const notes: string[] = [];
  let budget = settings.calibrate.maxRequests;
  let requestsUsed = 0;
  let partial = false;
  let first = true;

  const build = (): MyRepliesFileT => {
    const replies = [...byId.values()].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    const times = replies.map((r) => Date.parse(r.created_at)).filter((n) => !Number.isNaN(n));
    const counts = { A: 0, B: 0, C: 0, total: replies.length };
    for (const r of replies) counts[r.bucket] += 1;
    return MyRepliesFile.parse({
      generated_at: new Date().toISOString(),
      me,
      buckets: settings.calibrate.buckets,
      range_fetched: {
        earliest: times.length ? new Date(Math.min(...times)).toISOString() : null,
        latest: times.length ? new Date(Math.max(...times)).toISOString() : null,
      },
      counts,
      requests_used: requestsUsed,
      partial,
      notes,
      replies,
    });
  };

  const checkpoint = (): void => {
    mkdirSync(path.dirname(MY_REPLIES_PATH), { recursive: true });
    writeFileSync(MY_REPLIES_PATH, JSON.stringify(build(), null, 2) + "\n", "utf8");
  };

  try {
    // 1) Fetch each bucket's replies (checkpoint after each).
    for (const win of windows) {
      if (budget <= 0) {
        notes.push(`request budget exhausted before bucket ${win.label}`);
        partial = true;
        break;
      }
      if (!first) await sleep(jitterMs(pace));
      first = false;
      const query = `from:${me} filter:replies since:${win.since} until:${win.until}`;
      try {
        const found = await withBackoff(() => searchFull(query, PER_BUCKET_LIMIT), pace);
        requestsUsed += 1;
        budget -= 1;
        let kept = 0;
        for (const t of found) {
          const r = toMyReply(t, win.label, now);
          if (r && !byId.has(r.id)) {
            byId.set(r.id, r);
            kept += 1;
          }
        }
        if (found.length >= PER_BUCKET_LIMIT) {
          partial = true;
          notes.push(`bucket ${win.label} hit the ${PER_BUCKET_LIMIT}-reply page cap — more may exist`);
        }
        notes.push(`bucket ${win.label} (${win.since}..${win.until}): ${kept} replies`);
      } catch (err) {
        if (err instanceof AuthFailure) throw err;
        partial = true;
        notes.push(`bucket ${win.label} fetch failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 160)}`);
      }
      checkpoint();
    }

    // 2) Fetch parent-tweet text for the highest-signal exemplars, within budget.
    const exemplars = [...byId.values()].sort((a, b) => b.signal - a.signal);
    const parentText = new Map<string, string>();
    for (const r of exemplars) {
      if (budget <= 0 || parentText.size >= MAX_EXEMPLAR_PARENTS) break;
      const pid = r.in_reply_to.status_id;
      if (!pid || parentText.has(pid)) continue;
      await sleep(jitterMs(pace));
      try {
        const parent = await withBackoff(() => readTweetFull(pid), pace);
        requestsUsed += 1;
        budget -= 1;
        if (parent) parentText.set(pid, parent.text);
      } catch (err) {
        if (err instanceof AuthFailure) throw err;
        notes.push(`parent ${pid} unreadable: ${(err instanceof Error ? err.message : String(err)).slice(0, 100)}`);
      }
    }
    for (const r of byId.values()) {
      const pid = r.in_reply_to.status_id;
      if (pid && parentText.has(pid)) r.in_reply_to.text = parentText.get(pid) ?? null;
    }
  } catch (err) {
    if (err instanceof AuthFailure) {
      partial = true;
      notes.push("aborted: auth failure — cookie likely expired; re-extract auth_token/ct0 and retry.");
    } else {
      partial = true;
      notes.push(`aborted: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`);
    }
  }

  const file = build();
  checkpoint();
  db.prepare("UPDATE runs SET finished_at = ?, stats_json = ? WHERE id = ?").run(
    new Date().toISOString(),
    JSON.stringify({
      counts: file.counts,
      range_fetched: file.range_fetched,
      requests_used: file.requests_used,
      partial: file.partial,
    }),
    runId,
  );

  return { path: MY_REPLIES_PATH, file };
}
