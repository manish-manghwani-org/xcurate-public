import { z } from "zod";

/**
 * Shape of a single tweet as emitted by `bird <cmd> --json` (verified against
 * real `bird home --following --json` output, v0.8.0). This is bird's already
 * simplified projection — richer fields (quotes, media, reply/repost flags)
 * come from `--json-full` and are wired in later phases as needed.
 *
 * Lenient on purpose: counts default to 0, optional fields tolerate absence, so
 * a single odd tweet never fails the whole fetch.
 */
export const BirdAuthor = z.object({
  username: z.string(),
  name: z.string(),
});
export type BirdAuthor = z.infer<typeof BirdAuthor>;

export const BirdTweet = z.object({
  id: z.string(),
  text: z.string(),
  createdAt: z.string(),
  replyCount: z.number().default(0),
  retweetCount: z.number().default(0),
  likeCount: z.number().default(0),
  quoteCount: z.number().optional(),
  conversationId: z.string().optional(),
  author: BirdAuthor,
  authorId: z.string().optional(),
});
export type BirdTweet = z.infer<typeof BirdTweet>;

export const BirdTweetArray = z.array(BirdTweet);

/**
 * Shape of `bird <cmd> --json-full`: the simple projection plus `media` and
 * `_raw` (the full GraphQL tweet object). `_raw` is kept as unknown — we read
 * its `legacy.*` signals defensively during normalization and store the whole
 * element as raw_json for thread context. Verified against v0.8.0.
 */
export const BirdFullTweet = BirdTweet.extend({
  inReplyToStatusId: z.string().nullable().optional(), // present on search results
  media: z.array(z.unknown()).optional(),
  _raw: z.unknown().optional(),
});
export type BirdFullTweet = z.infer<typeof BirdFullTweet>;

export const BirdFullTweetArray = z.array(BirdFullTweet);

// ---------------------------------------------------------------------------
// candidates.json (§7) — validated before writing
// ---------------------------------------------------------------------------

export const ThreadContextItem = z.object({
  handle: z.string(),
  text: z.string(),
});

export const Candidate = z.object({
  tweet_id: z.string(),
  url: z.string(),
  author: z.object({
    handle: z.string(),
    display_name: z.string().nullable(),
    weight: z.number(),
    // Rolling bucket distribution from account_buckets (top shares, desc).
    // Empty until the author has enough labeled tweets.
    buckets: z.array(z.object({ bucket: z.string(), share: z.number() })),
  }),
  text: z.string(),
  created_at: z.string(),
  age_hours: z.number(),
  engagement: z.object({
    likes: z.number(),
    replies: z.number(),
    reposts: z.number(),
    quotes: z.number(),
  }),
  score: z.number(),
  // Effective bucket used at rank time: the tweet's own label, else the
  // author's dominant profile bucket, else null (unclassified).
  bucket: z.string().nullable(),
  bucket_source: z.enum(["label", "profile"]).nullable(),
  thread_context: z.array(ThreadContextItem),
  reason: z.string(),
});
export type Candidate = z.infer<typeof Candidate>;

export const CandidatesFile = z.object({
  generated_at: z.string(),
  window_hours: z.number(),
  candidates: z.array(Candidate),
});
export type CandidatesFile = z.infer<typeof CandidatesFile>;

// ---------------------------------------------------------------------------
// data/my-replies.json (§12) — my own authored replies, bucketed by age
// ---------------------------------------------------------------------------

export const MyReply = z.object({
  id: z.string(),
  url: z.string(),
  text: z.string(),
  created_at: z.string(),
  bucket: z.enum(["A", "B", "C"]), // A=calibrate(0-4wk) B=validate(4-12) C=test(12-26)
  age_days: z.number(),
  engagement: z.object({
    likes: z.number(),
    replies: z.number(),
    reposts: z.number(),
    quotes: z.number(),
  }),
  signal: z.number(), // likes + 2*replies + quotes, for engagement-weighting exemplars
  in_reply_to: z.object({
    handle: z.string().nullable(),
    status_id: z.string().nullable(),
    text: z.string().nullable(), // parent tweet text, fetched for exemplars only
  }),
});
export type MyReply = z.infer<typeof MyReply>;

export const MyRepliesFile = z.object({
  generated_at: z.string(),
  me: z.string(),
  buckets: z.object({
    calibrateWeeks: z.number(),
    validateWeeks: z.number(),
    testWeeks: z.number(),
  }),
  range_fetched: z.object({
    earliest: z.string().nullable(),
    latest: z.string().nullable(),
  }),
  counts: z.object({ A: z.number(), B: z.number(), C: z.number(), total: z.number() }),
  requests_used: z.number(),
  partial: z.boolean(),
  notes: z.array(z.string()),
  replies: z.array(MyReply),
});
export type MyRepliesFile = z.infer<typeof MyRepliesFile>;

// ---------------------------------------------------------------------------
// Bucketing (PLANNING.md §2) — taxonomy config + classification handoff files
// ---------------------------------------------------------------------------

export const MAX_BUCKETS = 20;

export const BucketDef = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "bucket names are kebab-case slugs"),
  definition: z.string().min(1),
  replyStance: z.string().min(1),
  rankMultiplier: z.number().positive().max(3),
});
export type BucketDef = z.infer<typeof BucketDef>;

export const BucketsConfig = z
  .object({
    version: z.number().int().positive(),
    buckets: z.array(BucketDef).min(2).max(MAX_BUCKETS),
  })
  .refine((c) => new Set(c.buckets.map((b) => b.name)).size === c.buckets.length, {
    error: "bucket names must be unique",
  })
  .refine((c) => c.buckets.some((b) => b.name === "other"), {
    error: 'taxonomy must include the "other" fallback bucket',
  });
export type BucketsConfig = z.infer<typeof BucketsConfig>;

/** data/unclassified.json — pipeline → agent: tweets awaiting a bucket label. */
export const UnclassifiedFile = z.object({
  generated_at: z.string(),
  bucket_names: z.array(z.string()),
  remaining: z.number(), // unlabeled tweets still in the DB beyond this batch
  tweets: z.array(
    z.object({
      id: z.string(),
      author_handle: z.string(),
      text: z.string(),
    }),
  ),
});
export type UnclassifiedFile = z.infer<typeof UnclassifiedFile>;

/** data/classifications.json — agent → pipeline: labels to apply to the DB. */
export const ClassificationsFile = z.object({
  classified_at: z.string(),
  classifications: z.array(
    z.object({
      id: z.string(),
      bucket: z.string(),
    }),
  ),
});
export type ClassificationsFile = z.infer<typeof ClassificationsFile>;

/** A normalized tweet row ready to store in the `tweets` table (§7). */
export interface TweetRow {
  id: string;
  author_handle: string;
  text: string;
  created_at: string;
  url: string;
  like_count: number;
  reply_count: number;
  repost_count: number;
  quote_count: number;
  is_reply: 0 | 1;
  is_repost: 0 | 1;
  conversation_id: string | null;
  raw_json: string;
  fetched_at: string;
}
