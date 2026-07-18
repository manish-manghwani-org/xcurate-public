---
description: Label stored tweets with a topic bucket (backfill) so account profiles build from the full picture. Local files + local DB only — never touches X.
allowed-tools: Read, Write, Bash(npm run buckets:*)
---

You are the classification step of the bucketing feature (PLANNING.md §2). The deterministic
pipeline exports unlabeled tweets; you judge each one into exactly one topic bucket; the
pipeline applies your labels and recomputes account profiles. **You never touch X.**

## Hard rules (non-negotiable — see CLAUDE.md §2)

- **READ-ONLY against X.** Do not run `bird`, `curl`, or anything that reaches the network.
  The only commands you may run are `npm run buckets:export` and `npm run buckets:apply` —
  both are local-DB-only.
- **Never expose secrets.** Ignore `.env`; never print or copy cookie values.
- **Never invent bucket names.** Use only the names in `config/buckets.json`. When unsure,
  use `other` — never force-fit.

## Steps

1. Run `npm run buckets:export`. It writes `data/unclassified.json` (a batch of unlabeled
   tweets, newest first) and prints how many remain beyond this batch.
2. Read `config/buckets.json` — the `definition` line of each bucket is your rubric.
3. Read `data/unclassified.json`. For each tweet, pick **one primary bucket** by name (the
   taxonomy is 5 buckets: `professional`, `personal-social`, `ideas`, `civic`, `other`):
   - Judge the tweet's *topic*, not its mood or format. Work and building (code, AI/ML,
     startups, product, markets, jobs) is `professional` — even a joke about it, unless the
     topic is only a prop for the joke.
   - Classify promotional / self-marketing tweets by their surface *topic* too (a launch of an
     AI tool is `professional`; a "follow me" over a movie clip is `personal-social`). There is
     no promo bucket.
   - Public affairs (elections, policy, activism, causes, breaking news) is `civic`.
   - Everyday human and cultural life is `personal-social`: the author's own daily life,
     family, food, outings, milestones; health and fitness; memes and jokes; movies, music,
     books, sports, pop culture.
   - Research, science, psychology, history, and philosophy / faith / mindset are `ideas`.
   - When genuinely torn or the tweet is too thin to tell — a bare @-reply, a greeting, a
     topicless fragment — use `other`. Never force-fit.
4. Write `data/classifications.json` (overwrite — it is consumed immediately):
   ```json
   {
     "classified_at": "<ISO timestamp>",
     "classifications": [
       { "id": "<tweet id>", "bucket": "<bucket name>" }
     ]
   }
   ```
   Every tweet from the batch gets exactly one entry.
5. Run `npm run buckets:apply`. It validates names, writes labels to the DB, and recomputes
   account profiles.
6. Print a one-line summary: tweets labeled, count per bucket (descending), profiles
   recomputed, and how many tweets remain unlabeled (from step 1's output). If many remain,
   suggest running `/classify-tweets` again — do not loop on your own.
