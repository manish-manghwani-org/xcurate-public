import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Settings } from "./config.js";
import { getDb, type DB } from "./db.js";
import {
  BucketsConfig,
  ClassificationsFile,
  UnclassifiedFile,
  type BucketDef,
} from "./types.js";

export const BUCKETS_PATH = path.resolve(process.cwd(), "config", "buckets.json");
export const UNCLASSIFIED_PATH = path.resolve(process.cwd(), "data", "unclassified.json");
export const CLASSIFICATIONS_PATH = path.resolve(process.cwd(), "data", "classifications.json");

export function loadBuckets(file: string = BUCKETS_PATH): BucketsConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`Could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const result = BucketsConfig.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid config/buckets.json:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/** name → rankMultiplier, for the ranking pass. */
export function multiplierMap(config: BucketsConfig): Map<string, number> {
  return new Map(config.buckets.map((b) => [b.name, b.rankMultiplier]));
}

// ---------------------------------------------------------------------------
// Account profiles — rolling distribution over an author's labeled tweets
// ---------------------------------------------------------------------------

export interface ProfileEntry {
  bucket: string;
  share: number;
}

/** handle (lowercase) → profile entries sorted by share desc. */
export function getAccountProfiles(db: DB): Map<string, ProfileEntry[]> {
  const rows = db
    .prepare("SELECT handle, bucket, share FROM account_buckets ORDER BY handle, share DESC")
    .all() as Array<{ handle: string; bucket: string; share: number }>;
  const map = new Map<string, ProfileEntry[]>();
  for (const r of rows) {
    const list = map.get(r.handle) ?? [];
    list.push({ bucket: r.bucket, share: r.share });
    map.set(r.handle, list);
  }
  return map;
}

/**
 * Full deterministic recompute of account_buckets from labeled tweets: per
 * author, the most recent `profileMaxTweets` labeled tweets within
 * `profileWindowDays`; only authors with at least `minProfileTweets` labeled
 * tweets get a profile (tiny samples would give off-beat detection false
 * confidence).
 */
export function recomputeProfiles(db: DB, settings: Settings): { authors: number } {
  const { profileWindowDays, profileMaxTweets, minProfileTweets } = settings.buckets;
  const cutoff = new Date(Date.now() - profileWindowDays * 86_400_000).toISOString();
  const rows = db
    .prepare(
      `SELECT LOWER(author_handle) AS handle, bucket, created_at FROM tweets
       WHERE bucket IS NOT NULL AND created_at >= ?
       ORDER BY handle, created_at DESC`,
    )
    .all(cutoff) as Array<{ handle: string; bucket: string; created_at: string }>;

  const perAuthor = new Map<string, string[]>();
  for (const r of rows) {
    const list = perAuthor.get(r.handle) ?? [];
    if (list.length < profileMaxTweets) list.push(r.bucket); // rows come newest-first
    perAuthor.set(r.handle, list);
  }

  const now = new Date().toISOString();
  const insert = db.prepare(
    `INSERT INTO account_buckets (handle, bucket, share, tweet_count, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  let authors = 0;
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM account_buckets").run();
    for (const [handle, labels] of perAuthor) {
      if (labels.length < minProfileTweets) continue;
      authors += 1;
      const counts = new Map<string, number>();
      for (const b of labels) counts.set(b, (counts.get(b) ?? 0) + 1);
      for (const [bucket, n] of counts) {
        const share = Math.round((n / labels.length) * 1000) / 1000;
        insert.run(handle, bucket, share, n, now);
      }
    }
  });
  tx();
  return { authors };
}

// ---------------------------------------------------------------------------
// Export / apply — the agent-classification handoff (agent writes files,
// this CLI owns the DB — same pattern as mark-posted)
// ---------------------------------------------------------------------------

export interface ExportResult {
  path: string;
  exported: number;
  remaining: number;
}

/** Write data/unclassified.json: unlabeled tweets (newest first) for the agent to label. */
export function exportUnclassified(limit?: number): ExportResult {
  const db = getDb();
  const config = loadBuckets();
  const batch = db
    .prepare(
      `SELECT id, author_handle, text FROM tweets
       WHERE bucket IS NULL AND is_repost = 0
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit ?? 300) as Array<{ id: string; author_handle: string; text: string }>;
  const total = (
    db.prepare("SELECT COUNT(*) AS n FROM tweets WHERE bucket IS NULL AND is_repost = 0").get() as {
      n: number;
    }
  ).n;

  const file = UnclassifiedFile.parse({
    generated_at: new Date().toISOString(),
    bucket_names: config.buckets.map((b) => b.name),
    remaining: total - batch.length,
    tweets: batch,
  });
  mkdirSync(path.dirname(UNCLASSIFIED_PATH), { recursive: true });
  writeFileSync(UNCLASSIFIED_PATH, JSON.stringify(file, null, 2) + "\n", "utf8");
  return { path: UNCLASSIFIED_PATH, exported: batch.length, remaining: file.remaining };
}

export interface ApplyResult {
  applied: number;
  unknownIds: number;
  invalidBuckets: string[];
  profiledAuthors: number;
}

/**
 * Read data/classifications.json (written by the agent), validate every label
 * against config/buckets.json, apply to tweets.bucket, then recompute account
 * profiles. Logs a `runs` row for observability.
 */
export function applyClassifications(settings: Settings, file: string = CLASSIFICATIONS_PATH): ApplyResult {
  const db = getDb();
  const config = loadBuckets();
  const valid = new Set(config.buckets.map((b) => b.name));

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(
      `Could not read ${file} — run /classify-tweets (or /daily-digest) first: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const parsed = ClassificationsFile.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid data/classifications.json:\n${z.prettifyError(parsed.error)}`);
  }

  const startedAt = new Date().toISOString();
  const runId = db
    .prepare("INSERT INTO runs (kind, started_at) VALUES ('buckets-apply', ?)")
    .run(startedAt).lastInsertRowid;

  const update = db.prepare("UPDATE tweets SET bucket = ? WHERE id = ?");
  let applied = 0;
  let unknownIds = 0;
  const invalidBuckets = new Set<string>();
  const tx = db.transaction(() => {
    for (const c of parsed.data.classifications) {
      if (!valid.has(c.bucket)) {
        invalidBuckets.add(c.bucket);
        continue;
      }
      const r = update.run(c.bucket, c.id);
      if (r.changes > 0) applied += 1;
      else unknownIds += 1;
    }
  });
  tx();

  const { authors } = recomputeProfiles(db, settings);

  db.prepare("UPDATE runs SET finished_at = ?, stats_json = ? WHERE id = ?").run(
    new Date().toISOString(),
    JSON.stringify({ applied, unknownIds, invalidBuckets: [...invalidBuckets], profiledAuthors: authors }),
    runId,
  );

  return { applied, unknownIds, invalidBuckets: [...invalidBuckets], profiledAuthors: authors };
}

// ---------------------------------------------------------------------------
// Feedback (B4) — per-bucket posted/skipped rates → *suggested* multipliers.
// Report-only by design: config/buckets.json is edited by the human, never
// auto-adjusted (human-in-the-loop, like everything else here).
// ---------------------------------------------------------------------------

export interface BucketFeedback {
  bucket: string;
  posted: number;
  skipped: number;
  postRate: number;
  currentMultiplier: number;
  suggestedMultiplier: number | null; // null = not enough data or no meaningful change
}

const SUGGEST_MIN = 0.3;
const SUGGEST_MAX = 1.5;

export function bucketFeedbackStats(db: DB, settings: Settings, config: BucketsConfig): BucketFeedback[] {
  const rows = db
    .prepare(
      `SELECT bucket,
              SUM(CASE WHEN status = 'posted'  THEN 1 ELSE 0 END) AS posted,
              SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped
       FROM tweets
       WHERE status IN ('posted', 'skipped') AND bucket IS NOT NULL
       GROUP BY bucket`,
    )
    .all() as Array<{ bucket: string; posted: number; skipped: number }>;

  const totalPosted = rows.reduce((s, r) => s + r.posted, 0);
  const totalActed = rows.reduce((s, r) => s + r.posted + r.skipped, 0);
  const overallRate = totalActed > 0 ? totalPosted / totalActed : 0;

  const byName = new Map(config.buckets.map((b) => [b.name, b]));
  const out: BucketFeedback[] = [];
  for (const r of rows) {
    const def: BucketDef | undefined = byName.get(r.bucket);
    if (!def) continue; // labels from a since-removed bucket — shown nowhere, harmless
    const acted = r.posted + r.skipped;
    const postRate = r.posted / acted;
    let suggested: number | null = null;
    if (acted >= settings.buckets.suggestMinSamples && overallRate > 0) {
      const raw = def.rankMultiplier * (postRate / overallRate);
      const clamped = Math.min(SUGGEST_MAX, Math.max(SUGGEST_MIN, raw));
      const rounded = Math.round(clamped * 100) / 100;
      if (Math.abs(rounded - def.rankMultiplier) >= 0.05) suggested = rounded;
    }
    out.push({
      bucket: r.bucket,
      posted: r.posted,
      skipped: r.skipped,
      postRate: Math.round(postRate * 100) / 100,
      currentMultiplier: def.rankMultiplier,
      suggestedMultiplier: suggested,
    });
  }
  out.sort((a, b) => b.posted + b.skipped - (a.posted + a.skipped));
  return out;
}
