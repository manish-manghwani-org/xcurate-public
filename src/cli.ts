import { Command } from "commander";
import { authCheck } from "./auth.js";
import { fetchFollowingFeed } from "./bird.js";
import { runIngest } from "./ingest.js";
import { writeCandidates } from "./candidates.js";
import { runCalibrateFetch } from "./calibrate.js";
import { markPosted, skip } from "./mark.js";
import { addAccount, listAccounts } from "./accounts.js";
import { printStats } from "./stats.js";
import { applyClassifications, exportUnclassified } from "./buckets.js";
import { runClassify } from "./classify.js";
import { foldGold, runEval, snapshotGold } from "./eval.js";
import { printCronStatus, runCatchup } from "./cron.js";
import { loadSettings } from "./config.js";

const program = new Command();
program
  .name("xcurate")
  .description("Read X (read-only), curate tweets worth replying to, draft replies in my voice.")
  .version("0.1.0");

// --- auth check (§10) --------------------------------------------------------
const auth = program.command("auth").description("cookie / authentication utilities");
auth
  .command("check")
  .description("verify the X cookie is still valid (never prints secret values)")
  .action(async () => {
    const status = await authCheck();
    if (status.ok) {
      console.log(`✅ ${status.detail}`);
    } else {
      console.error(`❌ ${status.detail}`);
      process.exitCode = 1;
    }
  });

// --- Phase 1 smoke test: fetch Following feed and print a few tweets ----------
program
  .command("feed-sample")
  .description("fetch the Following feed and print a few real tweets (auth smoke test)")
  .option("-n, --number <n>", "how many tweets to print", "5")
  .action(async (opts: { number: string }) => {
    const n = Number.parseInt(opts.number, 10) || 5;
    const tweets = await fetchFollowingFeed(n);
    console.log(`Fetched ${tweets.length} tweet(s) from your Following feed:\n`);
    tweets.forEach((t, i) => {
      const text = t.text.replace(/\s+/g, " ").trim();
      console.log(`${i + 1}. @${t.author.username} — ${t.author.name}`);
      console.log(`   ${text.length > 220 ? text.slice(0, 220) + "…" : text}`);
      console.log(
        `   ♥ ${t.likeCount}  ↩ ${t.replyCount}  🔁 ${t.retweetCount}  ·  ${t.createdAt}`,
      );
      console.log(`   https://x.com/${t.author.username}/status/${t.id}\n`);
    });
  });

// --- ingest (§10): fetch following feed + tracked timelines, normalize, store
program
  .command("ingest")
  .description("fetch the Following feed + tracked timelines, normalize, dedup, store")
  .option("--feed-only", "fetch only the following feed (hourly-schedule mode: one request)")
  .option("--min-jitter <seconds>", "override config jitter minimum (seconds)")
  .option("--max-jitter <seconds>", "override config jitter maximum (seconds)")
  .action(async (opts: { feedOnly?: boolean; minJitter?: string; maxJitter?: string }) => {
    const options: Parameters<typeof runIngest>[0] = {};
    if (opts.feedOnly) options.feedOnly = true;
    if (opts.minJitter !== undefined) options.jitterMinSeconds = Number(opts.minJitter);
    if (opts.maxJitter !== undefined) options.jitterMaxSeconds = Number(opts.maxJitter);
    const stats = await runIngest(options);
    const f = stats.following;
    console.log(
      `Following feed: ${f.fetched} fetched (${f.inserted} new, ${f.updated} refreshed)`,
    );
    if (!stats.feedOnly) {
      const a = stats.accounts;
      console.log(
        `Tracked accounts: ${a.ok}/${a.attempted} ok, ${a.fetched} fetched ` +
          `(${a.inserted} new, ${a.updated} refreshed)`,
      );
      for (const fail of a.failures) {
        console.log(`  ⚠ @${fail.handle}: ${fail.error}`);
      }
    }
    if (stats.aborted) {
      console.error(`❌ Ingest aborted: ${stats.aborted}`);
      process.exitCode = 1;
    }
  });

// --- candidates (§7): rank stored tweets and export data/candidates.json
program
  .command("candidates")
  .description("rank stored tweets and write data/candidates.json")
  .action(() => {
    const result = writeCandidates();
    console.log(`Wrote ${result.count} candidate(s) to ${result.path}`);
  });

// --- calibrate-fetch (§12): fetch my own replies, bucketed, into my-replies.json
program
  .command("calibrate-fetch")
  .description("fetch my own authored replies (bucketed by age) into data/my-replies.json")
  .option("--min-jitter <seconds>", "override the hard jitter floor (test only)")
  .option("--max-jitter <seconds>", "override the hard jitter ceiling (test only)")
  .action(async (opts: { minJitter?: string; maxJitter?: string }) => {
    console.log("Fetching your replies (heaviest read — jittered hard, this takes a while)…");
    const options: Parameters<typeof runCalibrateFetch>[0] = {};
    if (opts.minJitter !== undefined) options.jitterMinSeconds = Number(opts.minJitter);
    if (opts.maxJitter !== undefined) options.jitterMaxSeconds = Number(opts.maxJitter);
    const { path: outPath, file } = await runCalibrateFetch(options);
    const c = file.counts;
    console.log(`\nWrote ${c.total} replies to ${outPath}`);
    console.log(`  buckets: A(0-4wk)=${c.A}  B(4-12wk)=${c.B}  C(12-26wk)=${c.C}`);
    console.log(
      `  range: ${file.range_fetched.earliest ?? "—"} … ${file.range_fetched.latest ?? "—"}`,
    );
    console.log(`  requests used: ${file.requests_used}${file.partial ? "  (partial)" : ""}`);
    for (const n of file.notes) console.log(`  · ${n}`);
    console.log("\nNext: run /calibrate-voice in Claude Code to synthesize voice.proposed.md.");
  });

// --- mark-posted / skip (§10): the feedback loop (records only — never posts)
program
  .command("mark-posted")
  .description("record that I posted a reply (manually) — bumps the author's weight")
  .requiredOption("--tweet <id>", "the tweet id I replied to")
  .option("--reply <text>", "the reply text I posted (recorded as the chosen draft)")
  .action((opts: { tweet: string; reply?: string }) => {
    const r = markPosted(opts.tweet, opts.reply);
    if (r.alreadyDone) {
      console.log(`Already marked posted: ${r.tweet_id} (@${r.author_handle}). No change.`);
      return;
    }
    console.log(
      `✅ Posted recorded for ${r.tweet_id} — @${r.author_handle} weight is now ${r.new_weight}.`,
    );
  });

program
  .command("skip")
  .description("record that I passed on a tweet")
  .requiredOption("--tweet <id>", "the tweet id to skip")
  .action((opts: { tweet: string }) => {
    const r = skip(opts.tweet);
    if (r.alreadyDone) {
      console.log(`Already skipped: ${r.tweet_id}. No change.`);
      return;
    }
    console.log(`Skipped ${r.tweet_id} (@${r.author_handle}).`);
  });

// --- accounts add / list (§10)
const accounts = program.command("accounts").description("manage tracked accounts");
accounts
  .command("add")
  .description("add or update a tracked account's weight")
  .requiredOption("--handle <handle>", "the account handle (with or without @)")
  .option("--weight <n>", "interaction weight", "1.0")
  .action((opts: { handle: string; weight: string }) => {
    const row = addAccount(opts.handle, Number(opts.weight));
    console.log(`Tracking @${row.handle} at weight ${row.weight}.`);
  });
accounts
  .command("list")
  .description("list tracked accounts by weight")
  .action(() => {
    const rows = listAccounts();
    if (rows.length === 0) {
      console.log("No tracked accounts yet. Add one with `npm run accounts:add -- --handle <h>`.");
      return;
    }
    console.log("Tracked accounts (by weight):");
    for (const r of rows) {
      const last = r.last_interacted_at ? ` · last replied ${r.last_interacted_at.slice(0, 10)}` : "";
      console.log(`  ${r.weight.toFixed(1).padStart(5)}  @${r.handle}${last}`);
    }
  });

// --- buckets (PLANNING.md §2): agent-classification handoff, local DB only
const buckets = program
  .command("buckets")
  .description("tweet/account bucketing — export unlabeled tweets, apply agent labels");
buckets
  .command("export")
  .description("write data/unclassified.json for /classify-tweets (newest unlabeled first)")
  .option("--limit <n>", "max tweets in this batch (default from settings.buckets.exportLimit)")
  .action((opts: { limit?: string }) => {
    const settings = loadSettings();
    const limit = opts.limit !== undefined ? Number(opts.limit) : settings.buckets.exportLimit;
    const r = exportUnclassified(limit);
    console.log(`Wrote ${r.exported} unlabeled tweet(s) to ${r.path}`);
    if (r.remaining > 0) {
      console.log(`  ${r.remaining} more still unlabeled — re-run after applying this batch.`);
    }
  });
buckets
  .command("classify")
  .description("classify unlabeled tweets locally via Ollama → data/classifications.json")
  .option("--limit <n>", "max tweets in this batch (default from settings.buckets.exportLimit)")
  .option("--model <name>", "override settings.classify.model (A/B without editing config)")
  .option("--dry-run", "print the label distribution without writing classifications.json")
  .option("--reuse-export", "classify the existing data/unclassified.json (skip re-export)")
  .action(
    async (opts: { limit?: string; model?: string; dryRun?: boolean; reuseExport?: boolean }) => {
      const settings = loadSettings();
      const options: Parameters<typeof runClassify>[1] = {};
      if (opts.limit !== undefined) options.limit = Number(opts.limit);
      if (opts.model !== undefined) options.model = opts.model;
      if (opts.dryRun) options.dryRun = true;
      if (opts.reuseExport) options.reuseExport = true;
      options.onProgress = (done, total) => {
        process.stderr.write(`\r  classifying ${done}/${total}…`);
        if (done === total) process.stderr.write("\n");
      };
      const r = await runClassify(settings, options);
      console.log(
        `Classified ${r.total} tweet(s) with ${r.model}` +
          (r.prefiltered > 0 ? ` (${r.prefiltered} pre-filtered to "other", no model call)` : "") +
          (r.fallbacks > 0 ? ` (${r.fallbacks} fell back to "other" after errors)` : ""),
      );
      for (const d of r.distribution) console.log(`  ${String(d.count).padStart(4)}  ${d.bucket}`);
      if (r.path) {
        console.log(`Wrote ${r.path}`);
        console.log(`  next: npm run buckets:apply  (or use npm run classify:all)`);
      } else {
        console.log(`(dry run — nothing written)`);
      }
      if (r.remaining > 0) {
        console.log(`  ${r.remaining} more still unlabeled — re-run after applying this batch.`);
      }
    },
  );
buckets
  .command("apply")
  .description("apply data/classifications.json to the DB and recompute account profiles")
  .action(() => {
    const r = applyClassifications(loadSettings());
    console.log(`Applied ${r.applied} label(s); recomputed profiles for ${r.profiledAuthors} account(s).`);
    if (r.unknownIds > 0) console.log(`  ⚠ ${r.unknownIds} id(s) not in the DB — skipped.`);
    if (r.invalidBuckets.length > 0) {
      console.log(
        `  ⚠ invalid bucket name(s) skipped: ${r.invalidBuckets.join(", ")} — not in config/buckets.json.`,
      );
    }
  });

buckets
  .command("eval")
  .description("score the local classifier against a frozen reference-label set")
  .option("--snapshot", "freeze the current DB labels as data/eval-gold.json, then stop")
  .option("--fold-coarse", "fold data/eval-gold.json through config/bucket-map.json → data/eval-gold.coarse.json, then stop")
  .option("--gold <path>", "score against this gold file instead of data/eval-gold.json")
  .option("--limit <n>", "evaluate only the first N gold items (fast smoke)")
  .option("--model <name>", "override settings.classify.model")
  .action(async (opts: { snapshot?: boolean; foldCoarse?: boolean; gold?: string; limit?: string; model?: string }) => {
    if (opts.snapshot) {
      const s = snapshotGold(opts.limit !== undefined ? Number(opts.limit) : undefined);
      console.log(`Snapshotted ${s.count} current DB label(s) as gold → ${s.path}`);
      console.log(
        `  ⚠ only meaningful if these are your reference labels (Opus), not local-model output.`,
      );
      console.log(`  next: npm run buckets:eval  (no --snapshot) to score the local model.`);
      return;
    }
    if (opts.foldCoarse) {
      const f = foldGold();
      console.log(`Folded ${f.count} gold label(s) through the 16→6 map → ${f.path}`);
      console.log(`  coarse distribution:`);
      for (const d of f.distribution) console.log(`    ${String(d.count).padStart(4)}  ${d.bucket}`);
      console.log(`  next: npm run buckets:eval -- --gold ${f.path} --model qwen2.5:3b-instruct`);
      return;
    }
    const settings = loadSettings();
    const evalOpts: Parameters<typeof runEval>[1] = {
      onProgress: (done, total) => {
        process.stderr.write(`\r  evaluating ${done}/${total}…`);
        if (done === total) process.stderr.write("\n");
      },
    };
    if (opts.limit !== undefined) evalOpts.limit = Number(opts.limit);
    if (opts.model !== undefined) evalOpts.model = opts.model;
    if (opts.gold !== undefined) evalOpts.goldPath = opts.gold;
    const r = await runEval(settings, evalOpts);
    const pct = (r.agreement * 100).toFixed(1);
    console.log(`\nAgreement: ${r.agree}/${r.total} (${pct}%) with ${r.model}`);
    if (r.fallbacks > 0) console.log(`  ${r.fallbacks} tweet(s) fell back to "other" after errors.`);
    console.log(`\nPer gold bucket (recall — how often the local model agreed):`);
    for (const b of r.perBucket) {
      console.log(
        `  ${(b.recall * 100).toFixed(0).padStart(3)}%  ${b.correct}/${b.n}  ${b.bucket}`,
      );
    }
    if (r.confusion.length > 0) {
      console.log(`\nTop disagreements (gold → predicted):`);
      for (const c of r.confusion.slice(0, 12)) {
        console.log(`  ${String(c.count).padStart(3)}  ${c.gold} → ${c.predicted}`);
      }
    }
    // Directional bar, not a hard gate. Raw agreement is measured against Opus gold, which the
    // S2b spot-check (PLANNING.md §2.7.1) showed understates TRUE accuracy by ~15-20 pts — most
    // "disagreements" are fuzzy-boundary calls where the local model's answer is defensible. So
    // ~60% raw ≈ ~78-85% real, which is fine for feeding rolling account distributions.
    const bar = 60;
    console.log(
      `\n${r.agreement * 100 >= bar ? "✅" : "⚠"} directional bar ~${bar}% raw agreement — ` +
        `${r.agreement * 100 >= bar ? "clears it" : "below it"}. ` +
        `Note: raw agreement runs ~15-20 pts under true accuracy (fuzzy-boundary calls vs Opus gold); ` +
        `spot-check disagreements before treating a low number as real error.`,
    );
  });

// --- cron (PLANNING.md §3): hourly-schedule health + manual recovery
const cron = program
  .command("cron")
  .description("hourly-schedule health: what failed/missed, and manual catch-up");
cron
  .command("status")
  .description("show ok/failed/missed hourly ingest slots over the lookback window")
  .option("--hours <n>", "lookback window in hours", "24")
  .action((opts: { hours: string }) => {
    const hours = Math.max(1, Math.min(168, Number.parseInt(opts.hours, 10) || 24));
    printCronStatus(hours);
  });
cron
  .command("catchup")
  .description("recover after failures: one full ingest + candidates, with coverage report")
  .action(async () => {
    await runCatchup();
  });

// --- stats (§10): last run summary
program
  .command("stats")
  .description("show DB totals and the last run of each kind")
  .action(() => {
    printStats();
  });

// --- commands: the human-friendly cheat sheet (`npm run help`)
program
  .command("commands")
  .description("list everything you can run (npm scripts + Claude Code commands)")
  .action(() => {
    console.log(`xcurate — all commands
${"═".repeat(62)}

THE DAILY LOOP
  npm run daily                 full ingest (feed + tracked timelines) + candidates
  npm run ingest                fetch + store (add -- --feed-only for one light request)
  npm run candidates            rank stored tweets → data/candidates.json
  /daily-digest                 (in Claude Code) judge candidates, draft replies
                                → digest/YYYY-MM-DD.md — you post manually on X

FEEDBACK (after you post manually)
  npm run mark-posted -- --tweet <id> --reply "<text>"
                                record a posted reply; bumps the author's weight
  npm run skip -- --tweet <id>  record a pass

BUCKETS (topic classification)
  npm run classify:all          local model (Ollama) labels a batch + applies it
  npm run buckets:classify      classify → data/classifications.json (--dry-run to preview)
  npm run buckets:export        → data/unclassified.json (batch)
  npm run buckets:apply         ← data/classifications.json → DB + profiles
  npm run buckets:eval          score the local model vs frozen reference labels
                                (--snapshot once to freeze them first)
  /classify-tweets              (in Claude Code) manual fallback labeling
                                edit taxonomy/stances/multipliers: config/buckets.json
                                local model: config/settings.json → "classify"

VOICE CALIBRATION (monthly-ish)
  npm run calibrate:fetch       fetch my own replies (heaviest read — paced hard)
  /calibrate-voice              (in Claude Code) → voice.proposed.md + diff for approval

HOURLY SCHEDULE & RECOVERY
  npm run hourly                what the schedule runs: feed-only ingest + candidates
  npm run cron:status           ok/failed/missed hourly slots (-- --hours 48 for more)
  npm run cron:catchup          recover after failures: full ingest + coverage report
  sudo ops/install-schedule.sh    install the wake→run→sleep timer (once)
  sudo ops/uninstall-schedule.sh  remove it
  touch data/stay-awake         never auto-sleep (docked / lid-closed use); rm to undo

ACCOUNTS & HEALTH
  npm run auth:check            is the X cookie still valid? (never prints values)
  npm run accounts:add -- --handle <h> --weight <n>
  npm run accounts:list         tracked accounts by weight
  npm run stats                 DB totals, bucket coverage, per-bucket feedback, runs
  npm run typecheck             TypeScript check (dev)

Full runbook with explanations: manual-run.md`);
  });

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
