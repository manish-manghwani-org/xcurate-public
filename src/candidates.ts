import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getAccountProfiles, loadBuckets, type ProfileEntry } from "./buckets.js";
import { loadSettings, type Settings } from "./config.js";
import { getDb, type DB } from "./db.js";
import { rankTweets, type DbTweet, type RankedTweet } from "./rank.js";
import { Candidate, CandidatesFile, type Candidate as CandidateT } from "./types.js";

export const CANDIDATES_PATH = path.resolve(process.cwd(), "data", "candidates.json");

/** Best-effort thread context: the parent tweet, if we ingested it too. */
function threadContext(db: DB, ranked: RankedTweet): Array<{ handle: string; text: string }> {
  if (ranked.tweet.is_reply !== 1) return [];
  let parentId: string | undefined;
  try {
    const raw = JSON.parse(ranked.tweet.raw_json) as { _raw?: { legacy?: Record<string, unknown> } };
    const legacy = raw._raw?.legacy;
    const v = legacy?.["in_reply_to_status_id_str"];
    if (typeof v === "string") parentId = v;
  } catch {
    /* raw_json malformed — no context */
  }
  if (!parentId) return [];
  const parent = db
    .prepare("SELECT author_handle, text FROM tweets WHERE id = ?")
    .get(parentId) as { author_handle: string; text: string } | undefined;
  return parent ? [{ handle: parent.author_handle, text: parent.text }] : [];
}

/** Prefer the tracked account's display name; fall back to the tweet author's. */
function displayName(t: DbTweet): string | null {
  if (t.account_display) return t.account_display;
  try {
    const raw = JSON.parse(t.raw_json) as { author?: { name?: string } };
    return raw.author?.name ?? null;
  } catch {
    return null;
  }
}

function toCandidate(
  db: DB,
  r: RankedTweet,
  profiles: Map<string, ProfileEntry[]>,
): CandidateT {
  const t: DbTweet = r.tweet;
  return {
    tweet_id: t.id,
    url: t.url,
    author: {
      handle: t.author_handle,
      display_name: displayName(t),
      weight: t.account_weight ?? 1.0,
      buckets: (profiles.get(t.author_handle.toLowerCase()) ?? []).slice(0, 3),
    },
    text: t.text,
    created_at: t.created_at,
    age_hours: Math.round(r.ageHours * 10) / 10,
    engagement: {
      likes: t.like_count,
      replies: t.reply_count,
      reposts: t.repost_count,
      quotes: t.quote_count,
    },
    score: Math.round(r.score * 1000) / 1000,
    bucket: r.effectiveBucket,
    bucket_source: r.bucketSource,
    thread_context: threadContext(db, r),
    reason: r.reason,
  };
}

/**
 * Diversity cap (PLANNING.md §2.3): walk the ranked pool in score order taking
 * at most `maxPerBucket` per known bucket, so one viral topic can't monopolize
 * the digest. Tweets with no bucket signal at all bypass the cap — early on,
 * before labels accumulate, everything still flows.
 */
function applyDiversityCap(ranked: RankedTweet[], settings: Settings): RankedTweet[] {
  const { candidateLimit } = settings;
  const { maxPerBucket } = settings.buckets;
  const perBucket = new Map<string, number>();
  const picked: RankedTweet[] = [];
  for (const r of ranked) {
    if (picked.length >= candidateLimit) break;
    if (r.effectiveBucket) {
      const n = perBucket.get(r.effectiveBucket) ?? 0;
      if (n >= maxPerBucket) continue;
      perBucket.set(r.effectiveBucket, n + 1);
    }
    picked.push(r);
  }
  return picked;
}

export interface CandidatesResult {
  path: string;
  count: number;
}

/** Rank, export data/candidates.json (zod-validated), and mark rows candidate. */
export function writeCandidates(): CandidatesResult {
  const settings = loadSettings();
  const buckets = loadBuckets();
  const db = getDb();

  const startedAt = new Date().toISOString();
  const runId = db
    .prepare("INSERT INTO runs (kind, started_at) VALUES ('candidates', ?)")
    .run(startedAt).lastInsertRowid;

  const ranked = rankTweets(db, settings, buckets);
  const top = applyDiversityCap(ranked, settings);
  const profiles = getAccountProfiles(db);
  const candidates = top.map((r) => Candidate.parse(toCandidate(db, r, profiles)));

  const file = CandidatesFile.parse({
    generated_at: new Date().toISOString(),
    window_hours: settings.windowHours,
    candidates,
  });

  mkdirSync(path.dirname(CANDIDATES_PATH), { recursive: true });
  writeFileSync(CANDIDATES_PATH, JSON.stringify(file, null, 2) + "\n", "utf8");

  // Promote emitted tweets seen -> candidate (don't disturb drafted/etc.).
  const promote = db.prepare(
    "UPDATE tweets SET status = 'candidate' WHERE id = ? AND status = 'seen'",
  );
  const promoteAll = db.transaction((ids: string[]) => {
    for (const id of ids) promote.run(id);
  });
  promoteAll(candidates.map((c) => c.tweet_id));

  db.prepare("UPDATE runs SET finished_at = ?, stats_json = ? WHERE id = ?").run(
    new Date().toISOString(),
    JSON.stringify({ emitted: candidates.length, considered: ranked.length }),
    runId,
  );

  return { path: CANDIDATES_PATH, count: candidates.length };
}
