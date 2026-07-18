# xcurate — knowledge graph

**Audience: Claude, not humans.** This is a compressed entity/relation index of the whole
repo, written so a future session can answer questions from *this file alone* without
re-reading `src/`. Humans should read [`architecture.md`](architecture.md) instead.

Conventions: `A --rel--> B` is a directed edge. `file.ts:NN` anchors are real. Constants are
exact values as of the last update. `§N` = section in `../xcurate.md`; `PLANNING.md §N` = a
gitignored local doc that will usually be absent.

**Staleness rule:** before recommending or editing anything named here, verify it still exists.
This file records what was true at last update, not what is true now.

---

## 0 · Identity

| | |
|---|---|
| **What** | Terminal-first tool to *read* X/Twitter, curate tweets worth replying to, draft replies in the owner's voice |
| **Owner** | manish-manghwani (`manghwani.manish1996@gmail.com`) |
| **Repo** | `/home/manish/work/xcurate-public`, default branch `main` |
| **Runtime** | Node ≥22, ESM (`"type": "module"`), TypeScript via `tsx` (no build step; `npm run typecheck` = `tsc --noEmit`) |
| **Deps** | `@steipete/bird` ^0.8 (X reader), `better-sqlite3` ^12.4, `commander` ^14, `zod` ^4, `dotenv`, `pino` |
| **Version** | `0.1.0`, private |

---

## 1 · The five hard constraints (§2 — non-negotiable)

These override everything. Sourced from `../CLAUDE.md`.

| # | Constraint | Enforcement |
|---|---|---|
| 1 | **Read-only against X.** Never post, like, follow, DM, retweet, bookmark, or write anything | 4 layers → §2 below. If a task seems to need writing to X: **stop and flag it, don't build it** |
| 2 | **Free.** No paid X API tier, no paid services | Local Ollama for bulk classification; agent judgement runs inside Claude Code (no API key) |
| 3 | **Human-in-the-loop.** Output is a review document; a human approves and posts manually | `mark-posted` *records* what the human already did — it never posts |
| 4 | **The cookie is a secret.** `TWITTER_AUTH_TOKEN` / `TWITTER_CT0` live only in `.env` (gitignored) | Never logged/printed/committed/embedded in digests, reports, or `raw_json`. `redact()` + pre-commit hook |
| 5 | **Gentle on the source.** Hourly = feed-only, one jittered request | Jitter every request, exponential backoff, abort on auth failure, cache aggressively |
| 6 | **No auto-posting escape hatches.** No flag, config key, or env var may enable posting | If posting is ever wanted: official paid API, separate explicitly-gated module, never the cookie/GraphQL reader |

**Owner decision (2026-07-12):** scheduled ingest is hourly and feed-only, a single jittered
request per run. Full ingests (feed + tracked timelines) are manual/daily only, a few times a
day max. Never add scheduled fetching beyond this without flagging it.

---

## 2 · The read-only guarantee

```
pipeline code --all X requests--> src/bird.ts --execFile--> bird CLI --> X
                                      |
                     scripts/check-readonly.mjs --guards--> (CI, required check)
```

`src/bird.ts` is **the single choke point**. Every X request in the codebase passes through it.

- **`READ_ONLY_COMMANDS`** (`bird.ts:30`) — 16 allowed subcommands:
  `home, read, thread, replies, search, mentions, user-tweets, list-timeline, lists,
  following, followers, about, whoami, check, help, query-ids`
- **`FORBIDDEN_COMMANDS`** (`bird.ts:50`) — belt-and-suspenders denylist, 10 write verbs:
  `tweet, reply, unbookmark, bookmark, like, unlike, follow, unfollow, dm, retweet`
- **`runBird()`** (`bird.ts:73`) throws if `sub` is in the denylist **or** absent from the
  allowlist. Runs `process.execPath [BIRD_CLI, ...args]` — no shell, so no argument injection.
- **Cookie via child env only** (`bird.ts:84`, `env: process.env`) — never in argv, so it can't
  leak into a process listing.
- **`BIRD_CLI`** (`bird.ts:18`) resolved via `require.resolve("@steipete/bird/package.json")`
  → `dist/cli.js`. No reliance on PATH or the `.bin` shim.
- **`redact(s)`** (`bird.ts:64`) — replaces `/[A-Fa-f0-9]{16,}/g` with `<REDACTED>`. Applied to
  every error message before it is thrown.
- Limits: `maxBuffer` 32 MB, `timeout` 60 s.

**`scripts/check-readonly.mjs`** runs in CI as a required status check and asserts three
*structural* properties (a naive grep for `like(` is useless — `console.log("tweet(s)")` matches):

1. `FORBIDDEN_COMMANDS` exists and still names every one of the 10 write verbs
2. no write verb has crept into `READ_ONLY_COMMANDS`
3. **no module other than `bird.ts` may spawn a process or resolve the reader package** ← the
   one that matters most; without it the allowlist could be bypassed entirely and 1–2 still pass

Consequences to internalise: `mark-posted` records, never posts. There is no posting flag/env
var, and adding one is out of scope by design. The digest is a file; publishing it is the human's
job, done in a browser.

### Cookie secrecy (constraint 4)

- Both cookie values are **bare hex with no provider prefix** → **GitHub secret scanning cannot
  detect them.** The local hook is the only thing that will.
- `.githooks/pre-commit` blocks: (1) a `TWITTER_(AUTH_TOKEN|CT0)=` assignment with a non-empty
  value, (2) any 40+ char bare hex run in staged additions (excluding `package-lock.json`,
  `node_modules/`), (3) `.env` being staged at all.
- Not carried by a clone — enable once per machine: `git config core.hooksPath .githooks`
- Bypass a false positive with `git commit --no-verify` (full git SHAs can trip rule 2).
- If a cookie is ever pushed: treat as compromised, rotate by **logging out of x.com**
  (invalidates the token) — amending is not enough.

---

## 3 · Pipeline (the spine)

```
X --cookie/GraphQL read--> bird.ts --> ingest.ts (normalize) --upsert--> data/app.db (SQLite)
data/app.db --> rank.ts (filter+score) --> candidates.ts (diversity cap) --> data/candidates.json
data/candidates.json --> /daily-digest (Claude Code + config/voice.md) --> digest/YYYY-MM-DD.md
digest --> HUMAN posts manually on X --> npm run mark-posted --> mark.ts --> data/app.db
classify.ts <--> data/app.db   (local Ollama topic labels)
```

**The one idea:** finding what *might* deserve a reply is mechanical (rules, ms, free,
deterministic). Deciding what *actually* deserves one and what to say is judgement. xcurate
refuses to blur them. The deterministic half narrows hundreds of tweets to ~15 and hands over a
plain JSON file. `data/candidates.json` is the **entire contract** between the halves — no
shared memory, no API, no coupling. Inspectable, diffable, hand-editable.

### 3.1 Fetch — `src/bird.ts`

| Function | bird subcommand | Used by |
|---|---|---|
| `fetchFollowingFeed(limit)` :108 | `home --following -n N --json` | `auth feed-sample` smoke test |
| `fetchFollowingFeedFull(limit)` :113 | `home --following -n N --json-full` | ingest |
| `fetchUserTweetsFull(handle, limit)` :119 | `user-tweets @h -n N --json-full` | ingest (tracked timelines) |
| `searchFull(query, limit)` :134 | `search Q -n N --json-full` | calibration (`from:me filter:replies`) |
| `readTweetFull(idOrUrl)` :140 | `read ID --json-full` | calibration (a reply's parent); returns `null` if unreadable |

`--json-full` output shape is **not stable**: may be a bare array or a wrapper object.
`extractTweetArray()` (:153) accepts an array or `{tweets|data|timeline|items: [...]}`.

### 3.2 Normalize + store — `src/ingest.ts`, `src/db.ts`

- `normalizeTweet(tweet, fetchedAt)` (`ingest.ts:42`) → `TweetRow`. **Defensive**: field names
  vary across response shapes, so every read falls back rather than throwing (`legacyOf`,
  `numOr`, `isRepost`, `toIso`). Full payload kept in `raw_json` for thread context later.
- `upsertTweets()` (`ingest.ts:78`) — `INSERT … ON CONFLICT(id) DO UPDATE`. Refreshes
  `like/reply/repost/quote_count`, `raw_json`, `fetched_at`. **Deliberately preserves `status`,
  `text`, `created_at`** → re-ingesting can never resurrect a skipped tweet. Insert-vs-update is
  invisible in `info.changes`, so existence is checked first in the same transaction for
  accurate counts.
- `seedAccounts()` (:119) — `INSERT OR IGNORE` from `config/accounts.seed.json`.
- **Pacing** (`ingest.ts:148–197`): `jitterMs()` 20–90 s between requests; `withBackoff()`
  exponential from `backoffBaseSeconds` 30; `isAuthError()` **aborts the entire run
  immediately** rather than hammering a dead cookie; `isRetryable()`/`isNotFound()` classify
  the rest.
- `runIngest(opts)` (:228) — `opts.feedOnly` = hourly mode (one request).

**DB** (`src/db.ts`): `data/app.db`, singleton via `getDb()` (:140). Pragmas: `journal_mode=WAL`,
`foreign_keys=ON`, `busy_timeout=5000`. `migrate()` (:115) applies versioned migrations, each
exactly once, in a transaction, bumping `user_version`. **Never edit an applied migration —
append the next version.**

### 3.3 Rank — `src/rank.ts`

`rankTweets(db, settings, buckets)` (:113). Returns the **full** ranked pool sorted desc; the
caller slices, so it can also report how many were considered.

**Coarse filter** (SQL + loop) drops: `is_repost = 1`, `status IN ('posted','skipped')`, muted
handles (`settings.mutedHandles`, `@`-stripped + lowercased), `isLinkOrAd(text)`, and anything
with `ageHours > windowHours` / `< 0` / non-finite.

**Score:**

```
score = bucketMultiplier × (wRecency·recency + wAuthor·normalizedWeight + wEngagement·engagement)
        − wPenalty·penalty
      = M × (1.0·recency + 1.4·normWeight + 0.8·engagement) − 0.6·penalty
```

| Term | Definition | Range |
|---|---|---|
| `recency` | `recencyFactor()` :51 — linear `max(0, 1 − age/window)`; `decay:"exp"` gives `exp(−age/(window/3))` ≈ 0.05 at the edge | 0–1 |
| `normalizedWeight` | `(account_weight ?? 1.0) / maxWeight` where `maxWeight` = highest in the pool | 0–1 |
| `engagement` | `min(rawEngagement / baseline, 3) / 3`. `rawEngagement = likes + 2·replies + quotes` (**replies doubled** — they signal conversation) | 0–1 |
| `penalty` | `penaltyFor()` :57 — `+0.5` if `len > 600`, `+0.6` if `letters < 5 && emoji ≥ 1`, `+0.4` if `hashtags ≥ 3`, capped at 1 | 0–1 |
| `bucketMultiplier` | from `config/buckets.json`; `1.0` if no effective bucket | 0.8–1.0 |

**Two subtleties that matter:**
1. **Engagement is relative, not absolute.** `baselineFor(handle)` = that author's own mean once
   we have **≥3** of their tweets in the pool, else the pool mean; floored at 1. So a quiet
   account's unusually busy post can out-rank a big account's routine one.
2. **The bucket multiplier scales only the positive terms, never the penalty.** Down-weighting a
   topic must never make a low-quality tweet look better than it is.

**Effective bucket** (:170): the tweet's own `bucket` label wins (`bucketSource: "label"`); else
the author's **dominant** profile bucket (`"profile"`); else `null`.

`isLinkOrAd()` :69 — true if it has a link and <12 chars of non-link text, or matches
`giveaway|airdrop|promo code|use code|discount code|buy now|limited offer|sign up now|link in bio`.

`buildReason()` :78 builds the human-readable `reason` string shown in the digest
(tracked account + weight, bucket + source + multiplier, freshness, above-baseline engagement,
question detected, in a thread, penalized).

### 3.4 Diversity cap + export — `src/candidates.ts`

`applyDiversityCap()` (:79) walks the ranked pool taking at most `maxPerBucket` (**4**) per
effective bucket, up to `candidateLimit` (**15**). **Tweets with no bucket signal bypass the
cap** — early on, before labels accumulate, everything should still flow through.

`writeCandidates()` (:102): logs a `runs` row (`kind='candidates'`) → rank → cap → build
`Candidate[]` (zod-validated) → write `data/candidates.json` → promote emitted rows
`seen → candidate` (only from `seen`, so `drafted` etc. aren't disturbed) → close the run row
with `{emitted, considered}`.

`threadContext()` (:12) reconstructs parent context from `raw_json` so the agent sees the thread.

---

## 4 · Data model

```
accounts 1--* tweets (author_handle → handle, LOWER-joined)
tweets   1--* drafts
tweets   1--* actions
accounts 1--* account_buckets
runs     (standalone log)
```

**Migration 1 `initial-schema`** (§7 verbatim in intent):

| Table | Columns |
|---|---|
| `accounts` | `handle` PK, `display_name`, `weight` REAL DEFAULT 1.0, `added_at` NOT NULL, `last_interacted_at` |
| `tweets` | `id` PK, `author_handle` NOT NULL, `text` NOT NULL, `created_at` NOT NULL, `url` NOT NULL, `like_count`, `reply_count`, `repost_count`, `quote_count`, `is_reply`, `is_repost`, `conversation_id`, `raw_json`, `fetched_at` NOT NULL, `status` DEFAULT `'seen'` |
| `drafts` | PK (`tweet_id`, `draft_index`), `reply_text` NOT NULL, `rationale`, `chosen` DEFAULT 0, `created_at` |
| `actions` | `id` PK AUTOINCREMENT, `tweet_id`, `action` (`posted`\|`skipped`), `reply_text`, `acted_at` |
| `runs` | `id` PK AUTOINCREMENT, `kind` (`ingest`\|`candidates`\|`calibrate`), `started_at`, `finished_at`, `stats_json` |

Indexes: `idx_tweets_status`, `idx_tweets_author`, `idx_tweets_created`.

**Migration 2 `bucketing`**: `ALTER TABLE tweets ADD COLUMN bucket TEXT` + index
`idx_tweets_bucket`; new table `account_buckets` (PK `handle`+`bucket`, `share` REAL 0..1 summing
to ~1 per handle, `tweet_count`, `updated_at`). `handle` is lowercase. Fully recomputed on every
`buckets:apply`.

**Tweet lifecycle** — `seen → candidate → drafted → posted | skipped`. `posted` and `skipped`
are **terminal** and filtered out of all future ranking, which is what makes re-ingesting always
safe. `skip` can also be applied directly from `candidate`.

---

## 5 · The judgement layer (agent)

Lives as **prompts, not code**, in `.claude/commands/` — tuning it is editing prose. No redeploy,
no API key, no model plumbing.

| Command | Reads | Writes |
|---|---|---|
| `/daily-digest` | `data/candidates.json`, `config/voice.md` | `digest/YYYY-MM-DD.md` |
| `/calibrate-voice` | `data/my-replies.json` | `config/voice.proposed.md` + report |
| `/classify-tweets` | `data/unclassified.json` | `data/classifications.json` |

**Reply-voice rules** (from `../CLAUDE.md`, load-bearing):
- **Read `config/voice.md` every run before drafting.** Draft in **first person, as the human.**
- **Vary the reply function** — don't make every reply an "agree + build". Some are a joke, a
  question, a disagreement, a warm reaction.
- **Drop aggressively.** If a tweet doesn't deserve a reply, drop it: a smaller digest of good
  replies beats a full one of filler.
- Every reply within `maxReplyChars` (**280**). **Never invent engagement numbers.** Never touch
  X — output is a file only.
- Honour the per-bucket `replyStance` (see §6).

**Digest output shape:** each tweet quoted for context, one or two drafted replies with character
counts, and pre-filled `mark-posted` commands to copy after posting.

**Voice calibration (§12) safety rule:** it may propose an improved voice file, but it writes to
`config/voice.proposed.md` + a report and **never overwrites `config/voice.md` without the
owner's explicit approval via a shown diff.**

---

## 6 · Topic buckets

Exactly **five** labels, `config/buckets.json` (`version: 2`), each with `definition`,
`replyStance`, `rankMultiplier`:

| Bucket | Covers | Reply stance (condensed) | Mult |
|---|---|---|---|
| `professional` | code, dev tools, infra, AI/ML, startups, product, growth, markets, investing, crypto, jobs, career | Engage as a peer: concrete experience, a gotcha, a sharper question. Never generic agreement. Only where there's real hands-on ground; skip hype. **Never investment advice or predictions** | 1.0 |
| `personal-social` | daily life, family, food, milestones, health/fitness, memes, jokes, movies/music/books/sports/pop culture | Warm, specific, human. Celebrate wins, be light back when it's a joke. **Never unsolicited advice, never prescribe.** Only reply if it adds warmth or is actually funny | 1.0 |
| `ideas` | research, science, space, psychology, history, explainers; faith, meditation, mindset, meaning, philosophy | Curious questions beat hot takes. **Respectful of faith — engage the thought, never debate someone's beliefs** | 1.0 |
| `civic` | elections, policy, government, partisan takes, activism, justice, breaking news | **Default skip** unless genuinely knowledgeable with real substance. **Never dunk, never pile on, never performative agreement** | **0.8** |
| `other` | Mandatory fallback: thin @-replies, greetings, fragments, anything topicless | Judge on its own merits; if unclear why it'd deserve a reply, skip | 1.0 |

**Why so few:** an earlier **16-bucket** taxonomy was collapsed after evidence showed **12 of
those buckets changed no downstream decision at all.** If a bucket doesn't alter ranking or how
you'd reply, it's overhead. `MAX_BUCKETS = 20` (`types.ts:145`) is the schema ceiling.

`config/bucket-map.json` (`version: 2`) is the deterministic 16→5 fold, used to reuse old gold
labels without re-labeling. **`creator-promo` is intentionally NOT mapped** and sits in
`exclude`: promo is an *intent*, not a topic, so it was dropped as a bucket — its gold items have
no correct topic answer and are dropped from the folded eval set. Live promo tweets get
classified by their **surface topic** instead.

### Labelling — `src/classify.ts`

Runs on a **local Ollama model**, not a paid API — bulk classification is mechanics, not
judgement. Config in `settings.classify`: endpoint `http://127.0.0.1:11434`, model
`qwen2.5:3b-instruct`, `concurrency: 1`, `timeoutMs: 60000`, `maxRetries: 2`.

- Output is **schema-constrained to an enum of bucket names** → an invalid label is impossible by
  construction. Response format: `{"bucket": "<name>"}`.
- `ensureModel()` (:99) checks `/api/tags` and fails with actionable errors
  (`ollama serve` / `ollama pull <model>`). If Ollama isn't running the step fails cleanly and
  **the DB is left untouched.**
- `isObviousOther(text)` (:79) — a **conservative** pre-filter that labels obvious `other`
  locally so the model never sees it. Strips links, `@`/`#` tokens, emoji and punctuation, then:
  empty residue → true; residue in the ~45-entry `GREETING_ACK` set (`gm`, `thanks`, `lol`, `hi`,
  `congrats`, …) → true; an **@-led reply** whose residue is ≤3 words → true. A short *standalone*
  tweet ("Argentina won") still goes to the model.
- Fully local: tweet text is read from SQLite and sent only to `127.0.0.1`.

### Account profiles — `src/buckets.ts`

`recomputeProfiles(db, settings)` (:66) — **fully recomputed** (`DELETE` then rebuild) on every
`buckets:apply`. Takes labelled tweets from the last `profileWindowDays` (**90**), newest-first,
capped at `profileMaxTweets` (**200**) per author; authors with fewer than `minProfileTweets`
(**3**) labels are skipped. `share` = count/total rounded to 3 decimals.

Labels do **double duty**: a tweet's own label feeds the multiplier, and the rolling distribution
across an author's labelled tweets **predicts a bucket for tweets not yet classified**.

`getAccountProfiles(db)` (:46) → `Map<handle, ProfileEntry[]>` sorted by share desc — `[0]` is
the dominant bucket used by `rank.ts`.

### Eval harness — `src/eval.ts`

Measures the local classifier against frozen reference labels **before its output is ever trusted
to feed account profiles.** Two steps by design:

1. `buckets:eval --snapshot` freezes **current DB labels** to `data/eval-gold.json`. Do this
   **while those labels are still the reference labeler's (Opus)** — once the local model writes
   back, the DB is no longer a clean gold set.
2. A plain run classifies each snapshotted tweet locally and reports agreement + per-bucket
   recall + a confusion table of the disagreements.

`foldGold()` (:46) maps `eval-gold.json` through `config/bucket-map.json` →
`data/eval-gold.coarse.json`, dropping `exclude`d labels.

---

## 7 · Feedback loop

The **one** place the system learns preferences. `src/mark.ts`, `WEIGHT_BUMP = 0.5`.

`markPosted(tweetId, replyText?)` (:36), all in one transaction:
1. `tweets.status = 'posted'`
2. insert an `actions` row (`'posted'`, `reply_text`, `acted_at`)
3. if `replyText`: insert a `drafts` row with `rationale = 'posted via mark-posted'`,
   `chosen = 1`, at `MAX(draft_index)+1`, and clear `chosen` on all other drafts for that tweet.
   (The agent drafts to a *file*, so the `drafts` table is otherwise empty — this closes the loop)
4. `accounts.weight += 0.5` + `last_interacted_at`; **if the author isn't tracked, start tracking
   them at `1.0 + 0.5`**
- **Idempotent**: if already `posted`, returns `alreadyDone: true` and changes nothing.

`skip(tweetId)` (:107) — sets `skipped`, logs the action, **no weight change**. Also idempotent.

Higher weight → that author's tweets rank higher next run → the system converges on the people
the owner actually talks to.

`src/stats.ts` `printStats()` (:18) aggregates DB totals + the last run of each kind;
`printBucketStats()` (:89) surfaces per-bucket posted/skipped rates and **suggested** multiplier
changes (`suggestMinSamples: 5`). It only ever **suggests — it never edits config.**
`bucketFeedbackStats()` lives in `buckets.ts:229`.

---

## 8 · Command surface

`src/cli.ts` (commander). npm scripts wrap `tsx src/cli.ts <cmd>`.

| npm script | CLI | Does |
|---|---|---|
| `auth:check` | `auth check` | Verify the cookie is valid. **Never prints secret values** |
| — | `auth feed-sample -n 5` | Fetch feed + print a few real tweets (auth smoke test) |
| `ingest` | `ingest [--feed-only] [--min-jitter] [--max-jitter]` | Feed + tracked timelines → normalize → dedup → store |
| `candidates` | `candidates` | Rank + write `data/candidates.json` |
| `daily` | `ingest && candidates` | The manual daily path |
| `hourly` | `ingest --feed-only && candidates` | The scheduled path — **one request** |
| `calibrate:fetch` | `calibrate-fetch` | Fetch own authored replies → `data/my-replies.json` |
| `mark-posted` | `mark-posted --tweet ID [--reply TEXT]` | Record a manual post; bumps author weight |
| `skip` | `skip --tweet ID` | Record passing on a tweet |
| `accounts:add` / `:list` | `accounts add --weight N` / `list` | Manage tracked accounts |
| `buckets:export` | `buckets export [--limit]` | Write `data/unclassified.json`, newest unlabeled first |
| `buckets:classify` | `buckets classify [--limit] [--model] [--dry-run] [--reuse-export]` | Local Ollama → `data/classifications.json` |
| `buckets:apply` | `buckets apply` | Apply classifications to DB + recompute profiles |
| `classify:all` | classify && apply | The usual labelling path |
| `buckets:eval` | `buckets eval [--snapshot] [--fold-coarse] [--gold P] [--limit N] [--model]` | Score the classifier vs frozen gold |
| `cron:status` | `cron status [--hours 24]` | ok/failed/missed hourly slots |
| `cron:catchup` | `cron catchup` | One full ingest + candidates, with coverage report |
| `stats` | `stats` | DB totals + last run of each kind |
| `help` | `commands` | List everything runnable (npm scripts + Claude Code commands) |
| `typecheck` | — | `tsc --noEmit` |

---

## 9 · Scheduling & ops

**Two cadences.** *Hourly, automated:* systemd timer (+ up to 5 min jitter) → feed-only ingest
(**one** request) → rank + export. *Daily, manual:* `npm run daily` (feed + tracked timelines) →
`/daily-digest` → review + post. Deep reads (tracked timelines, calibration fetch) stay on the
manual path, a few times a day at most.

`ops/xcurate-hourly.sh` runs as **root** via `xcurate-hourly.service`, in order:
1. **Arm the RTC first** (`rtcwake -m no -t <next hour>`) — before anything that could hang, so a
   mid-run suspend can't leave no alarm armed (a real cause of missed slots). systemd's
   `WakeSystem=` only covers suspend; RTC also covers hibernate/poweroff. Re-armed after the run
   in case it straddled an hour boundary.
2. Wait for network (`nm-online -q -t 90`) — Wi-Fi needs a moment to reassociate after a wake.
3. Run the pipeline as the normal user under `systemd-inhibit --what=sleep:handle-lid-switch
   --mode=block` — **without this, after a lid-closed resume logind re-suspends ~30 s later,
   which froze a run mid-fetch overnight.**
4. Sleep again **only when clearly unattended.** Any one of these keeps it awake:
   `XCURATE_SLEEP_ACTION=none`, `data/stay-awake` exists, the lid is open *or unknown*, or `who`
   shows an active `pts/` session.

Config: `ops/schedule.env` (`XCURATE_REPO`, `XCURATE_USER`, `XCURATE_SLEEP_ACTION` =
`suspend|poweroff|none`). Log: `data/cron.log`. Install/uninstall: `ops/install-schedule.sh`,
`ops/uninstall-schedule.sh`.

**`src/cron.ts` `cronSlots(db, hours, now)`** (:36) buckets `runs` rows of `kind='ingest'` into
hour slots, **aligned to *local* hour boundaries** (epoch-hour alignment breaks in timezones with
half/quarter-hour UTC offsets). Statuses: `ok` (finished, not aborted) ✅ · `running` (unfinished,
<30 min old) 🔄 · `failed` (rows exist but none ok) ❌ · `pending` (current hour, <15 min in —
the randomized timer delay may not have fired) `·` · `missed` ⬜. `runCatchup()` (:150) recovers
after failures.

---

## 10 · Config reference

**`config/settings.json`** (zod schema `Settings`, `src/config.ts:6`):

```
windowHours 24 · candidateLimit 15 · maxReplyChars 280 · decay "linear" · mutedHandles []
ingest:    feedTypes ["following"] · maxPerFeed 100 · jitterMin 20s · jitterMax 90s · backoffBase 30s
weights:   wRecency 1.0 · wAuthor 1.4 · wEngagement 0.8 · wPenalty 0.6
buckets:   maxPerBucket 4 · profileWindowDays 90 · profileMaxTweets 200 · minProfileTweets 3
           suggestMinSamples 5 · exportLimit 300
calibrate: buckets {calibrateWeeks 4, validateWeeks 12, testWeeks 26} · maxRequests 40
           engagementWeighting true
classify:  provider "ollama" · endpoint http://127.0.0.1:11434 · model qwen2.5:3b-instruct
           concurrency 1 · timeoutMs 60000 · maxRetries 2
```

Other config: `config/buckets.json` (taxonomy), `config/bucket-map.json` (16→5 fold),
`config/voice.md` (**how replies sound — the owner's to edit**, ships as a placeholder),
`config/accounts.seed.json` (tracked accounts, also a placeholder).

---

## 11 · Voice calibration (§12) — `src/calibrate.ts`

The **heaviest read in the system.** Fetches the owner's own authored replies as deep as the
reader reliably allows, bucketed by age into three windows (`bucketWindows()` :99):

| Window | Span | Purpose |
|---|---|---|
| **A** | now − 4 weeks → now + 1 day | calibrate |
| **B** | now − 12 weeks → now − 4 weeks | validate |
| **C** | now − 26 weeks → now − 12 weeks | test |

`runCalibrateFetch()` (:123): requires `authCheck()` to pass (needs the handle to search
`from:me`) → logs a `runs` row (`kind='calibrate'`) → walks windows within a
`maxRequests` budget (**40**) → writes `data/my-replies.json` (`MyRepliesFile`, zod).

**Paced hardest of all reads:** jitter floor `max(20, ingest.jitterMin)`, ceiling
`max(90, ingest.jitterMax)`, backoff base `max(30, …)`, `maxRetries: 4`. The `--min-jitter` /
`--max-jitter` overrides exist **for local test runs only** — production keeps the floor.
**Checkpoints to disk after each bucket** so a stop can resume; sets `partial: true` and records
`notes` when the budget runs out.

---

## 12 · File map

```
src/
  bird.ts        🚦 read-only choke point — every X request (allow/denylist, redact)
  ingest.ts      fetch → normalize → upsert (jitter, backoff, auth-abort)
  db.ts          SQLite singleton, versioned migrations, WAL
  rank.ts        coarse filter + score
  candidates.ts  diversity cap → data/candidates.json
  buckets.ts     taxonomy load, account profiles, export/apply, feedback stats
  classify.ts    local Ollama classifier + isObviousOther pre-filter
  eval.ts        classifier eval vs frozen gold, coarse fold
  calibrate.ts   voice calibration fetch (§12)
  mark.ts        record posted/skipped — never posts (WEIGHT_BUMP 0.5)
  stats.ts       feedback aggregation, suggested weights (suggests only)
  cron.ts        hourly slot health + catch-up
  accounts.ts    add/list tracked accounts
  auth.ts        assertCredentialsPresent, authCheck (never prints values)
  config.ts      Settings + SeedAccount zod schemas + loaders
  types.ts       all shared zod schemas (Bird*, Candidate, MyReply, Bucket*, TweetRow)
  cli.ts         commander surface

config/          settings.json · buckets.json · bucket-map.json · voice.md · accounts.seed.json
.claude/commands/  daily-digest.md · calibrate-voice.md · classify-tweets.md  ← judgement layer
scripts/check-readonly.mjs   CI-enforced read-only invariant
.githooks/pre-commit         cookie guard (opt-in per clone)
ops/             xcurate-hourly.sh · systemd/{service,timer} · install/uninstall · schedule.env.example
                 local-model-runbook.md
docs/            architecture.md (human tour) · knowledge-graph.md (this file) · banner.webp
data/            app.db, candidates.json, my-replies.json, unclassified.json,
                 classifications.json, eval-gold*.json, cron.log      ← gitignored
digest/          YYYY-MM-DD.md drafted replies                        ← gitignored
```

`data/` and `digest/` never leave the machine. `.env` holds the cookie and is gitignored.

**Docs:** `../README.md` quick start · `../manual-run.md` runbook · `../xcurate.md` full build
spec with the `§` numbers the code cites · `../CLAUDE.md` always-loaded agent rules ·
`ops/local-model-runbook.md` Ollama classifier + eval · `PLANNING.md` living tracker
(**gitignored, local-only, often absent — carry on without it**).

---

## 13 · Working rules for me

- **Build phase by phase per the Build Plan (§13). Stop at every CHECKPOINT**, summarize, show
  the key files, and wait for explicit approval before the next phase.
- Read `PLANNING.md` before planning or building anything new; update it when features are
  discussed, decided, or shipped. Absent in a fresh clone — proceed without it.
- Before shipping, the codebase should **grep clean for any post/like/follow/DM/retweet write
  call.**
- Any task that seems to require writing to X: **stop and flag it.** Do not build it.
- Never overwrite `config/voice.md` without a shown diff and explicit approval.
- Never add scheduled fetching beyond hourly feed-only without flagging it.
