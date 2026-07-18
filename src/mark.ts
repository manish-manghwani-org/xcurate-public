import { getDb } from "./db.js";

/** How much each posted reply raises the author's interaction weight. */
export const WEIGHT_BUMP = 0.5;

export interface MarkResult {
  tweet_id: string;
  author_handle: string;
  action: "posted" | "skipped";
  new_weight?: number;
  alreadyDone: boolean;
}

interface TweetRow {
  author_handle: string;
  status: string;
}

function requireTweet(id: string): TweetRow {
  const row = getDb().prepare("SELECT author_handle, status FROM tweets WHERE id = ?").get(id) as
    | TweetRow
    | undefined;
  if (!row) {
    throw new Error(
      `Tweet ${id} isn't in the DB. Run \`npm run ingest\` first, or check the id from the digest.`,
    );
  }
  return row;
}

/**
 * Record that I posted a reply (manually, on X). Sets the tweet `posted`, logs
 * the action, records the chosen draft, and bumps the author's weight +
 * last_interacted_at (creating the account if it wasn't tracked). Never posts.
 */
export function markPosted(tweetId: string, replyText?: string): MarkResult {
  const db = getDb();
  const tweet = requireTweet(tweetId);
  const handle = tweet.author_handle;
  const key = handle.toLowerCase();

  if (tweet.status === "posted") {
    const w = db.prepare("SELECT weight FROM accounts WHERE handle = ?").get(key) as
      | { weight: number }
      | undefined;
    return {
      tweet_id: tweetId,
      author_handle: handle,
      action: "posted",
      ...(w ? { new_weight: w.weight } : {}),
      alreadyDone: true,
    };
  }

  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare("UPDATE tweets SET status = 'posted' WHERE id = ?").run(tweetId);
    db.prepare(
      "INSERT INTO actions (tweet_id, action, reply_text, acted_at) VALUES (?, 'posted', ?, ?)",
    ).run(tweetId, replyText ?? null, now);

    // Record what I posted as the chosen draft (the agent drafts to a file, so
    // the drafts table is otherwise empty — this closes that loop).
    if (replyText) {
      const max = db
        .prepare("SELECT MAX(draft_index) AS m FROM drafts WHERE tweet_id = ?")
        .get(tweetId) as { m: number | null };
      const idx = max.m == null ? 0 : max.m + 1;
      db.prepare(
        `INSERT INTO drafts (tweet_id, draft_index, reply_text, rationale, chosen, created_at)
         VALUES (?, ?, ?, 'posted via mark-posted', 1, ?)`,
      ).run(tweetId, idx, replyText, now);
      db.prepare("UPDATE drafts SET chosen = 0 WHERE tweet_id = ? AND draft_index != ?").run(
        tweetId,
        idx,
      );
    }

    // Bump author weight; start tracking the author if they weren't already.
    const acct = db.prepare("SELECT weight FROM accounts WHERE handle = ?").get(key);
    if (acct) {
      db.prepare(
        "UPDATE accounts SET weight = weight + ?, last_interacted_at = ? WHERE handle = ?",
      ).run(WEIGHT_BUMP, now, key);
    } else {
      db.prepare(
        `INSERT INTO accounts (handle, display_name, weight, added_at, last_interacted_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(key, handle, 1.0 + WEIGHT_BUMP, now, now);
    }
  });
  tx();

  const w = db.prepare("SELECT weight FROM accounts WHERE handle = ?").get(key) as {
    weight: number;
  };
  return {
    tweet_id: tweetId,
    author_handle: handle,
    action: "posted",
    new_weight: w.weight,
    alreadyDone: false,
  };
}

/** Record that I passed on a tweet. Sets it `skipped` and logs the action. No weight change. */
export function skip(tweetId: string): MarkResult {
  const db = getDb();
  const tweet = requireTweet(tweetId);
  if (tweet.status === "skipped") {
    return {
      tweet_id: tweetId,
      author_handle: tweet.author_handle,
      action: "skipped",
      alreadyDone: true,
    };
  }
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare("UPDATE tweets SET status = 'skipped' WHERE id = ?").run(tweetId);
    db.prepare(
      "INSERT INTO actions (tweet_id, action, reply_text, acted_at) VALUES (?, 'skipped', NULL, ?)",
    ).run(tweetId, now);
  });
  tx();
  return {
    tweet_id: tweetId,
    author_handle: tweet.author_handle,
    action: "skipped",
    alreadyDone: false,
  };
}
