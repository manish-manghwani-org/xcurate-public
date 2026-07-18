import { writeCandidates } from "./candidates.js";
import { getDb, type DB } from "./db.js";
import { runIngest, type IngestStats } from "./ingest.js";

const HOUR_MS = 3_600_000;

// The schedule contract: one ingest run per hour (ops/systemd/xcurate-hourly.timer).
// A slot is "failed" if a run started but aborted/never finished, "missed" if no
// run started at all (machine off and RTC wake didn't fire, timer not installed…).

interface RunRow {
  started_at: string;
  finished_at: string | null;
  stats_json: string | null;
}

type SlotStatus = "ok" | "failed" | "running" | "missed" | "pending";

export interface Slot {
  start: Date;
  status: SlotStatus;
  detail?: string;
}

function abortedOf(r: RunRow): string | null {
  if (!r.stats_json) return null;
  try {
    const s = JSON.parse(r.stats_json) as { aborted?: string };
    return s.aborted ?? null;
  } catch {
    return null;
  }
}

/** One entry per hourly slot in the lookback window, oldest first. */
export function cronSlots(db: DB, hours: number, now: number = Date.now()): Slot[] {
  const cutoffIso = new Date(now - hours * HOUR_MS).toISOString();
  const runs = db
    .prepare(
      `SELECT started_at, finished_at, stats_json FROM runs
       WHERE kind = 'ingest' AND started_at >= ? ORDER BY started_at`,
    )
    .all(cutoffIso) as RunRow[];

  const slots: Slot[] = [];
  // Align slots to *local* hour boundaries — epoch-hour alignment would be
  // shifted in timezones with a half-hour or quarter-hour UTC offset.
  const alignedNow = new Date(now);
  alignedNow.setMinutes(0, 0, 0);
  const currentSlotStart = alignedNow.getTime();
  for (let i = hours - 1; i >= 0; i--) {
    const start = currentSlotStart - i * HOUR_MS;
    const inSlot = runs.filter((r) => {
      const t = Date.parse(r.started_at);
      return t >= start && t < start + HOUR_MS;
    });

    let status: SlotStatus;
    let detail: string | undefined;
    const ok = inSlot.find((r) => r.finished_at && !abortedOf(r));
    const stillRunning = inSlot.find(
      (r) => !r.finished_at && now - Date.parse(r.started_at) < 30 * 60_000,
    );
    if (ok) {
      status = "ok";
    } else if (stillRunning) {
      status = "running";
    } else if (inSlot.length > 0) {
      status = "failed";
      const last = inSlot[inSlot.length - 1]!;
      detail = abortedOf(last) ?? "started but never finished (crash or power loss mid-run)";
    } else if (start === currentSlotStart && now - start < 15 * 60_000) {
      // Current hour, timer (with its randomized delay) may not have fired yet.
      status = "pending";
    } else {
      status = "missed";
    }
    slots.push({ start: new Date(start), status, ...(detail !== undefined ? { detail } : {}) });
  }
  return slots;
}

const fmtHour = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:00`;

const GLYPH: Record<SlotStatus, string> = {
  ok: "✅",
  failed: "❌",
  missed: "⬜",
  running: "🔄",
  pending: "·",
};

/** `npm run cron:status` — how the hourly schedule has been doing. */
export function printCronStatus(hours: number): void {
  const db = getDb();
  const slots = cronSlots(db, hours);
  const count = (s: SlotStatus): number => slots.filter((x) => x.status === s).length;

  console.log(`xcurate — cron status (last ${hours}h, expecting one ingest run per hour)`);
  console.log("─".repeat(60));
  console.log(`  ok=${count("ok")}  failed=${count("failed")}  missed=${count("missed")}` +
    (count("running") > 0 ? `  running=${count("running")}` : ""));
  console.log(`  timeline (oldest → newest): ${slots.map((s) => GLYPH[s.status]).join("")}`);

  const failed = slots.filter((s) => s.status === "failed");
  if (failed.length > 0) {
    console.log("\nFailed slots:");
    for (const s of failed) console.log(`  ❌ ${fmtHour(s.start)} — ${s.detail}`);
  }
  const missed = slots.filter((s) => s.status === "missed");
  if (missed.length > 0) {
    console.log(`\nMissed slots (no run started): ${missed.map((s) => fmtHour(s.start).slice(11)).join(", ")}`);
  }

  if (count("ok") === 0 && count("running") === 0) {
    console.log(
      "\n⚠ No successful ingest in the window. If the timer should be active, check:\n" +
        "    systemctl list-timers xcurate-hourly.timer\n" +
        "    tail -30 data/cron.log\n" +
        "  (Install: sudo ops/install-schedule.sh — see manual-run.md.)",
    );
  }
  if (count("failed") > 0 || count("missed") > 0) {
    console.log("\nTo recover manually: npm run cron:catchup");
  }
  console.log("\nRun log: data/cron.log · run history: `npm run stats`");
}

function printIngestSummary(stats: IngestStats): void {
  const f = stats.following;
  console.log(`Following feed: ${f.fetched} fetched (${f.inserted} new, ${f.updated} refreshed)`);
  if (!stats.feedOnly) {
    const a = stats.accounts;
    console.log(
      `Tracked accounts: ${a.ok}/${a.attempted} ok, ${a.fetched} fetched ` +
        `(${a.inserted} new, ${a.updated} refreshed)`,
    );
    for (const fail of a.failures) console.log(`  ⚠ @${fail.handle}: ${fail.error}`);
  }
}

/**
 * `npm run cron:catchup` — manual recovery after failed/missed slots: one full
 * ingest (feed + tracked timelines, for depth the hourly feed-only runs don't
 * have) followed by a candidates refresh, with an honest coverage report.
 * Gaps older than the feed/timelines reach are unrecoverable — a free reader
 * can't page arbitrarily far back, and we don't hammer trying.
 */
export async function runCatchup(): Promise<void> {
  const db = getDb();
  const lastOk = db
    .prepare(
      `SELECT started_at, stats_json FROM runs
       WHERE kind = 'ingest' AND finished_at IS NOT NULL
       ORDER BY started_at DESC`,
    )
    .all()
    .map((r) => r as RunRow)
    .find((r) => !abortedOf(r));

  if (lastOk) {
    const gapH = (Date.now() - Date.parse(lastOk.started_at)) / HOUR_MS;
    console.log(`Last successful ingest: ${lastOk.started_at} (${gapH.toFixed(1)}h ago)`);
  } else {
    console.log("No successful ingest on record.");
  }
  console.log("Running a full catch-up ingest (feed + tracked timelines, jittered — takes a few minutes)…\n");

  const startIso = new Date().toISOString();
  const stats = await runIngest(); // full ingest: catch-up wants depth
  printIngestSummary(stats);
  if (stats.aborted) {
    console.error(`\n❌ Catch-up aborted: ${stats.aborted}`);
    process.exitCode = 1;
    return;
  }

  const oldest = (
    db
      .prepare("SELECT MIN(created_at) AS m FROM tweets WHERE fetched_at >= ?")
      .get(startIso) as { m: string | null }
  ).m;
  if (oldest) {
    console.log(`\nCoverage: this fetch reached back to tweets from ${oldest}.`);
    if (lastOk && Date.parse(oldest) > Date.parse(lastOk.started_at)) {
      console.log(
        `⚠ The gap since ${lastOk.started_at} extends beyond what the feed still serves — ` +
          "anything older than the coverage above is unrecoverable (expected; we don't page deeper).",
      );
    }
  }

  const res = writeCandidates();
  console.log(`\nWrote ${res.count} candidate(s) to ${res.path}`);
  console.log("Next: run /daily-digest in Claude Code if you want a fresh digest.");
}
