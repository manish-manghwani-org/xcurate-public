# CLAUDE.md — project context for xcurate

xcurate is a terminal-first tool to **read** X/Twitter, curate the tweets worth replying to,
and draft replies in my voice. The full build spec is in `xcurate.md`. Read it for detail; this
file is the always-loaded summary of the rules that must never be violated.

**`PLANNING.md` is the living thinking-and-execution tracker** — build status, feature plans
(currently: account/tweet bucketing), decision log, open questions. Read it before planning or
building anything new, and update it when features are discussed, decided, or shipped.
It is gitignored and local-only, so it won't be present in a fresh clone; `§`-numbered
references to it in code comments point at that private doc. Carry on without it if absent.

## Hard constraints (§2 — non-negotiable)

1. **Read-only network access to X.** Fetching uses cookie auth via an unofficial GraphQL
   reader (`bird`). The code **must never post, like, follow, DM, retweet, bookmark, or write
   anything to X.** Any code path that would mutate state on X is out of scope and forbidden.
   If a task seems to require writing to X, **stop and flag it** — do not build it.
2. **Free.** No paid X API tier, no paid services.
3. **Human-in-the-loop.** The pipeline's final output is a review document. A human approves and
   posts **manually**. `mark-posted` only *records* what the human already did — it never posts.
4. **The cookie is a secret.** `TWITTER_AUTH_TOKEN` / `TWITTER_CT0` live only in `.env`
   (gitignored). **Never log, print, echo, commit, or embed them** in digests, reports, error
   messages, or `raw_json`. `auth:check` reports validity without dumping values.
5. **Gentle on the source.** Scheduled ingest is **hourly and feed-only** — a single jittered
   request per run (owner's decision 2026-07-12, see PLANNING.md §3). Full ingests (feed +
   tracked timelines) are for manual/daily/catch-up use only, at most a few times a day. Jitter
   every request, exponential backoff on errors, stop on repeated auth failures. Cache
   aggressively; don't re-fetch within the window. The calibration deep-fetch is the heaviest
   read — pace it hardest. Never add scheduled fetching beyond this without flagging it.
6. **No auto-posting escape hatches.** No flag, config, or env var may enable posting to X. If
   posting is ever wanted it must go through the official paid API in a separate, explicitly
   gated module — never the cookie/GraphQL reader.

Before shipping, the codebase should grep clean for any post/like/follow/DM/retweet write call.

## Reply-voice reminder

When drafting replies (the `/daily-digest` command), **read `config/voice.md` every run before
drafting.** Draft in first person, as the human. Vary the reply function — don't make every
reply an "agree + build." If a tweet doesn't deserve a reply, **drop it**: a smaller digest of
good replies beats a full one of filler. Keep every reply within `maxReplyChars`
(default 280). Never invent engagement numbers. Never touch X — output is a file only.

Voice calibration (§12) may propose an improved `config/voice.md`, but it writes to
`config/voice.proposed.md` + a report and **never overwrites `config/voice.md` without my
explicit approval via a shown diff.**

## Architecture (§3)

- **Deterministic TypeScript pipeline** (`src/`): fetch → normalize → store (SQLite) → dedup →
  rank → export `data/candidates.json`.
- **Claude Code (agent) does the judgement in-run** via slash commands
  (`.claude/commands/daily-digest.md`, `.claude/commands/calibrate-voice.md`) — no LLM API key
  needed. Reads `candidates.json` + `voice.md`, decides what's worth replying to, drafts,
  writes `digest/YYYY-MM-DD.md`.

## Build discipline

Build phase by phase per the Build Plan (§13). **Stop at every CHECKPOINT**, summarize, show the
key files, and wait for explicit approval before the next phase.
