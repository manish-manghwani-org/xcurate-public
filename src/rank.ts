import { getAccountProfiles, multiplierMap } from "./buckets.js";
import type { Settings } from "./config.js";
import type { DB } from "./db.js";
import type { BucketsConfig } from "./types.js";

/** A tweet row joined with its author's tracked weight (null if untracked). */
export interface DbTweet {
  id: string;
  author_handle: string;
  text: string;
  created_at: string;
  url: string;
  like_count: number;
  reply_count: number;
  repost_count: number;
  quote_count: number;
  is_reply: number;
  is_repost: number;
  conversation_id: string | null;
  raw_json: string;
  status: string;
  bucket: string | null;
  account_weight: number | null;
  account_display: string | null;
}

export interface RankedTweet {
  tweet: DbTweet;
  ageHours: number;
  score: number;
  /** Tweet's own label, else the author's dominant profile bucket, else null. */
  effectiveBucket: string | null;
  bucketSource: "label" | "profile" | null;
  factors: {
    recency: number;
    normalizedWeight: number;
    engagement: number;
    penalty: number;
    bucketMultiplier: number;
  };
  reason: string;
}

const DEFAULT_WEIGHT = 1.0;

/** Raw engagement signal: replies weighted double (they signal conversation). */
function rawEngagement(t: DbTweet): number {
  return t.like_count + 2 * t.reply_count + t.quote_count;
}

function recencyFactor(ageHours: number, windowHours: number, decay: Settings["decay"]): number {
  if (decay === "exp") return Math.exp(-ageHours / (windowHours / 3)); // ~0.05 at window
  return Math.max(0, 1 - ageHours / windowHours); // linear: 1 fresh → 0 at window
}

/** Penalty in [0,1] for low-signal shapes: walls of text, emoji-only, hashtag spam. */
function penaltyFor(text: string): number {
  let p = 0;
  if (text.length > 600) p += 0.5;
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  const emoji = (text.match(/\p{Extended_Pictographic}/gu) ?? []).length;
  if (letters < 5 && emoji >= 1) p += 0.6; // basically just emoji
  const hashtags = (text.match(/#\w+/g) ?? []).length;
  if (hashtags >= 3) p += 0.4;
  return Math.min(p, 1);
}

/** Coarse drop heuristic: a tweet that is essentially just a link, or an ad. */
function isLinkOrAd(text: string): boolean {
  const stripped = text.replace(/https?:\/\/\S+/g, "").replace(/\bt\.co\/\S+/g, "").trim();
  const hasLink = /https?:\/\/|\bt\.co\//.test(text);
  if (hasLink && stripped.length < 12) return true;
  return /\b(giveaway|airdrop|promo\s?code|use\s+code|discount\s+code|buy\s+now|limited\s+offer|sign\s+up\s+now|link\s+in\s+bio)\b/i.test(
    text,
  );
}

function buildReason(
  t: DbTweet,
  ageHours: number,
  f: RankedTweet["factors"],
  effectiveBucket: string | null,
  bucketSource: "label" | "profile" | null,
): string {
  const parts: string[] = [];
  const weight = t.account_weight ?? DEFAULT_WEIGHT;
  if (t.account_weight != null && weight > DEFAULT_WEIGHT) {
    parts.push(`tracked account (weight ${weight})`);
  } else if (t.account_weight != null) {
    parts.push("tracked account");
  }
  if (effectiveBucket) {
    const via = bucketSource === "profile" ? " (via author profile)" : "";
    const mult = f.bucketMultiplier !== 1 ? ` ×${f.bucketMultiplier}` : "";
    parts.push(`bucket ${effectiveBucket}${via}${mult}`);
  }
  if (f.recency > 0.75) parts.push("fresh");
  else if (f.recency > 0.4) parts.push(`${ageHours.toFixed(0)}h old`);
  if (f.engagement > 0.5) parts.push("above-baseline engagement");
  if (/\?\s*$|\?["')\]]?\s/.test(t.text) || t.text.includes("?")) parts.push("question detected");
  if (t.is_reply) parts.push("in a thread");
  if (f.penalty > 0) parts.push("penalized (low-signal shape)");
  return parts.length > 0 ? parts.join("; ") : "recent tweet in window";
}

/**
 * §7 coarse filter + score. Drops reposts, out-of-window, already
 * posted/skipped, muted authors, and pure link/ad tweets. The bucket
 * multiplier scales the tweet's positive appeal (recency/author/engagement)
 * but not the penalty, so a down-weighted bucket can't soften a penalty.
 * Fine judgement (is-this-worth-replying-to) is the agent's job downstream.
 */
export function rankTweets(db: DB, settings: Settings, buckets: BucketsConfig): RankedTweet[] {
  const rows = db
    .prepare(
      `SELECT t.id, t.author_handle, t.text, t.created_at, t.url,
              t.like_count, t.reply_count, t.repost_count, t.quote_count,
              t.is_reply, t.is_repost, t.conversation_id, t.raw_json, t.status,
              t.bucket,
              a.weight AS account_weight, a.display_name AS account_display
       FROM tweets t
       LEFT JOIN accounts a ON a.handle = LOWER(t.author_handle)
       WHERE t.is_repost = 0 AND t.status NOT IN ('posted', 'skipped')`,
    )
    .all() as DbTweet[];

  const multipliers = multiplierMap(buckets);
  const profiles = getAccountProfiles(db); // handle → entries sorted by share desc

  const muted = new Set(settings.mutedHandles.map((h) => h.replace(/^@/, "").toLowerCase()));
  const now = Date.now();

  // Author baselines for engagement normalization: use the author's own mean
  // when we have enough of their tweets, else fall back to the pool mean.
  const perAuthor = new Map<string, { sum: number; n: number }>();
  for (const r of rows) {
    const key = r.author_handle.toLowerCase();
    const cur = perAuthor.get(key) ?? { sum: 0, n: 0 };
    cur.sum += rawEngagement(r);
    cur.n += 1;
    perAuthor.set(key, cur);
  }
  const poolMean =
    rows.length > 0 ? rows.reduce((s, r) => s + rawEngagement(r), 0) / rows.length : 1;
  const baselineFor = (handle: string): number => {
    const a = perAuthor.get(handle.toLowerCase());
    const base = a && a.n >= 3 ? a.sum / a.n : poolMean;
    return Math.max(base, 1);
  };

  const w = settings.weights;
  const maxWeight = Math.max(
    DEFAULT_WEIGHT,
    ...rows.map((r) => r.account_weight ?? DEFAULT_WEIGHT),
  );

  const ranked: RankedTweet[] = [];
  for (const t of rows) {
    if (muted.has(t.author_handle.toLowerCase())) continue;
    if (isLinkOrAd(t.text)) continue;

    const ageHours = (now - Date.parse(t.created_at)) / 3_600_000;
    if (!Number.isFinite(ageHours) || ageHours > settings.windowHours || ageHours < 0) continue;

    const recency = recencyFactor(ageHours, settings.windowHours, settings.decay);
    const normalizedWeight = (t.account_weight ?? DEFAULT_WEIGHT) / maxWeight;
    const engagement = Math.min(rawEngagement(t) / baselineFor(t.author_handle), 3) / 3;
    const penalty = penaltyFor(t.text);

    // Effective bucket: own label wins; else predict from the author's profile.
    let effectiveBucket: string | null = t.bucket;
    let bucketSource: "label" | "profile" | null = t.bucket ? "label" : null;
    if (!effectiveBucket) {
      const dominant = profiles.get(t.author_handle.toLowerCase())?.[0];
      if (dominant) {
        effectiveBucket = dominant.bucket;
        bucketSource = "profile";
      }
    }
    const bucketMultiplier = effectiveBucket ? (multipliers.get(effectiveBucket) ?? 1.0) : 1.0;

    const score =
      bucketMultiplier *
        (w.wRecency * recency + w.wAuthor * normalizedWeight + w.wEngagement * engagement) -
      w.wPenalty * penalty;

    const factors = { recency, normalizedWeight, engagement, penalty, bucketMultiplier };
    ranked.push({
      tweet: t,
      ageHours,
      score,
      effectiveBucket,
      bucketSource,
      factors,
      reason: buildReason(t, ageHours, factors, effectiveBucket, bucketSource),
    });
  }

  // Return the full ranked pool; the caller slices to candidateLimit so it can
  // also report how many were considered.
  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}
