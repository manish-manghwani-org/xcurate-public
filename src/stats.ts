import { bucketFeedbackStats, loadBuckets } from "./buckets.js";
import { loadSettings } from "./config.js";
import { getDb, type DB } from "./db.js";

interface CountRow {
  status: string;
  n: number;
}
interface RunRow {
  id: number;
  kind: string;
  started_at: string;
  finished_at: string | null;
  stats_json: string | null;
}

/** Print a compact summary of the DB and the most recent run of each kind. */
export function printStats(): void {
  const db = getDb();

  const totalTweets = (
    db.prepare("SELECT COUNT(*) AS n FROM tweets").get() as { n: number }
  ).n;
  const totalAccounts = (
    db.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number }
  ).n;
  const byStatus = db
    .prepare("SELECT status, COUNT(*) AS n FROM tweets GROUP BY status ORDER BY n DESC")
    .all() as CountRow[];

  console.log("xcurate — stats");
  console.log("─".repeat(48));
  console.log(`Tweets:   ${totalTweets}`);
  if (byStatus.length > 0) {
    console.log(`  by status: ${byStatus.map((s) => `${s.status}=${s.n}`).join("  ")}`);
  }
  console.log(`Accounts tracked: ${totalAccounts}`);

  const topAuthors = db
    .prepare(
      `SELECT author_handle AS h, COUNT(*) AS n FROM tweets
       GROUP BY author_handle ORDER BY n DESC LIMIT 5`,
    )
    .all() as Array<{ h: string; n: number }>;
  if (topAuthors.length > 0) {
    console.log(`  top authors: ${topAuthors.map((a) => `@${a.h}(${a.n})`).join("  ")}`);
  }

  const actions = db
    .prepare("SELECT action, COUNT(*) AS n FROM actions GROUP BY action")
    .all() as Array<{ action: string; n: number }>;
  if (actions.length > 0) {
    console.log(`Feedback logged: ${actions.map((a) => `${a.action}=${a.n}`).join("  ")}`);
  }

  printBucketStats(db);

  console.log("─".repeat(48));
  console.log("Most recent run per kind:");
  const kinds = ["ingest", "candidates", "calibrate", "buckets-apply"] as const;
  let any = false;
  for (const kind of kinds) {
    const run = db
      .prepare(
        `SELECT id, kind, started_at, finished_at, stats_json FROM runs
         WHERE kind = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(kind) as RunRow | undefined;
    if (!run) continue;
    any = true;
    const done = run.finished_at ? "" : "  (unfinished)";
    console.log(`  • ${run.kind}: ${run.started_at}${done}`);
    if (run.stats_json) {
      try {
        console.log(`      ${summarizeRunStats(run.kind, JSON.parse(run.stats_json))}`);
      } catch {
        /* ignore malformed stats */
      }
    }
  }
  if (!any) console.log("  (no runs yet — try `npm run ingest`)");
}

/**
 * Bucket section (PLANNING.md §2.4 B4): label coverage, per-bucket feedback
 * rates, and *suggested* multiplier changes. Suggestions are report-only —
 * applying one means editing config/buckets.json by hand.
 */
function printBucketStats(db: DB): void {
  console.log("─".repeat(48));
  const labeled = (
    db.prepare("SELECT COUNT(*) AS n FROM tweets WHERE bucket IS NOT NULL").get() as { n: number }
  ).n;
  const unlabeled = (
    db.prepare("SELECT COUNT(*) AS n FROM tweets WHERE bucket IS NULL AND is_repost = 0").get() as {
      n: number;
    }
  ).n;
  console.log(`Buckets: ${labeled} tweets labeled, ${unlabeled} awaiting /classify-tweets`);

  const byBucket = db
    .prepare(
      "SELECT bucket, COUNT(*) AS n FROM tweets WHERE bucket IS NOT NULL GROUP BY bucket ORDER BY n DESC",
    )
    .all() as Array<{ bucket: string; n: number }>;
  if (byBucket.length > 0) {
    console.log(`  labels: ${byBucket.map((b) => `${b.bucket}=${b.n}`).join("  ")}`);
  }

  const profiled = (
    db.prepare("SELECT COUNT(DISTINCT handle) AS n FROM account_buckets").get() as { n: number }
  ).n;
  if (profiled > 0) console.log(`  account profiles: ${profiled}`);

  let feedback;
  try {
    feedback = bucketFeedbackStats(db, loadSettings(), loadBuckets());
  } catch {
    return; // config missing/invalid — the commands that need it will say so
  }
  if (feedback.length === 0) return;
  console.log("  feedback (posted/skipped → suggested multiplier; edit config/buckets.json to apply):");
  for (const f of feedback) {
    const suggestion =
      f.suggestedMultiplier != null
        ? `suggest ×${f.suggestedMultiplier} (now ×${f.currentMultiplier})`
        : `×${f.currentMultiplier} ok`;
    console.log(
      `    ${f.bucket}: ${f.posted} posted / ${f.skipped} skipped (rate ${f.postRate}) — ${suggestion}`,
    );
  }
}

function summarizeRunStats(kind: string, stats: unknown): string {
  if (kind === "ingest" && stats && typeof stats === "object") {
    const s = stats as {
      following?: { fetched?: number; inserted?: number; updated?: number };
      accounts?: { attempted?: number; ok?: number; failed?: number; fetched?: number };
      aborted?: string;
    };
    const f = s.following ?? {};
    const a = s.accounts ?? {};
    const parts = [
      `following: ${f.fetched ?? 0} fetched (${f.inserted ?? 0} new, ${f.updated ?? 0} refreshed)`,
      `accounts: ${a.ok ?? 0}/${a.attempted ?? 0} ok, ${a.fetched ?? 0} fetched`,
    ];
    if (s.aborted) parts.push(`ABORTED: ${s.aborted}`);
    return parts.join(" · ");
  }
  return JSON.stringify(stats);
}
