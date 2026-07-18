---
description: Read today's ranked candidates, drop the weak ones, and draft in-voice replies into digest/YYYY-MM-DD.md. Read-only against X — writes files only.
allowed-tools: Read, Write, Bash(npm run buckets:apply)
---

You are drafting my daily reply digest. This is the judgement step the deterministic
pipeline hands off to you. **You never touch X.** Your outputs are markdown/JSON files on disk.

## Hard rules (non-negotiable — see CLAUDE.md §2)

- **READ-ONLY.** Do not post, like, follow, DM, reply, retweet, or call any network/X tool.
  Do not run `bird`, `curl`, or any command that reaches X. The only command you may run is
  `npm run buckets:apply` (local DB only). Otherwise you only read local files and write files.
- **Never invent engagement numbers.** Use only the counts already in `candidates.json`.
- **Never expose secrets.** Ignore `.env`; never print or copy cookie values.

## Steps

1. **Read `config/voice.md` in full, every run, before drafting.** It defines how I sound. Also
   read `config/settings.json` (for `maxReplyChars`, default 280) and `config/buckets.json`
   (topic buckets — each has a `definition` and a `replyStance`).
2. **Read `data/candidates.json`.** Each entry has the tweet text, author (+ tracked weight and
   `buckets` profile), engagement, score, `age_hours`, `bucket` + `bucket_source`,
   `thread_context` (parent tweet if it's a reply), and a `reason`. If the file is missing or
   has zero candidates, write a digest that says so and stop.
3. **Bucket each candidate.** If `bucket_source` is `"label"`, keep that bucket. Otherwise
   judge it yourself against the definitions in `buckets.json` (one primary bucket; `other`
   when unsure — never invent names). Note the author's `buckets` profile: a tweet far outside
   the author's usual lane ("off-beat") is usually a skip, occasionally the most interesting
   one — say which in **Why** if you keep it.
4. **Judge each candidate. Drop the weak ones.** Apply the bucket's `replyStance` as the
   default posture (e.g. `civic` defaults to skip unless I genuinely know the topic). A smaller
   digest of genuinely good replies beats a full one of filler. Drop anything that is:
   - low-signal, pure vibes, or something I'd have nothing real to add to;
   - ragebait, ads, engagement-bait, or a pure link/screenshot with no substance I can see;
   - already fully answered in its own thread, or where a reply would be noise.
   Keeping 4 of 15 is a good outcome. Do not pad to hit a number.
5. **For each survivor, draft 1–2 reply options in my voice** (see `voice.md`), shaped by the
   bucket's `replyStance`:
   - First person, as me. Sound like a real person typing on their phone — not a brand or an AI.
   - **Vary the reply function across the digest** (question / agree-and-add / gentle pushback /
     just-warm / help-them-think). If every reply is "agree + build," that's a failure.
   - Match length to the tweet. Short tweet → short reply. Never pad.
   - Each option **must be within `maxReplyChars`**. Count characters and show the count.
   - No hashtags. Emojis rare. No "Great point," no "It's not just X, it's Y," no restating the
     tweet back, no empty praise.
   - Two options only when a genuinely different *angle* exists — otherwise one good reply.
   - Use `thread_context` so a reply to a reply actually makes sense in the conversation.
6. **Write `digest/YYYY-MM-DD.md`** (today's date) in the format below. Create the `digest/`
   folder if needed. Overwrite today's file if it already exists.
7. **Persist your bucket labels.** Write `data/classifications.json` (overwrite — it is
   consumed immediately) with one `{ "id", "bucket" }` entry for **every** candidate you
   bucketed in step 3 (kept *and* dropped, but not ones that already had `bucket_source`
   `"label"`), then run `npm run buckets:apply`.
8. Print a one-line summary (how many candidates, how many you kept, labels applied) and the
   digest file path.

## Output format (§8)

```markdown
# Reply digest — YYYY-MM-DD

_<N> candidates · <K> worth replying · sorted by score_

---

## 1. @handle · score 0.82 · 3h ago · professional
> the tweet text, quoted verbatim (include a short thread-context line if it's a reply)

🔗 <url>
**Why:** one line — why this is worth a reply, in my words. Mention off-beat if relevant
(author is mostly other buckets).

**Suggested replies**
- [ ] **A)** first reply option in my voice (NNN chars)
- [ ] **B)** alternative angle, if one genuinely exists (NNN chars)

`mark: npm run mark-posted -- --tweet <id> --reply "..."`   ·   `skip: npm run skip -- --tweet <id>`

---

## 2. @other · score 0.71 · 6h ago
...
```

Rules for the file: quote each tweet so I have context without opening X; end each entry header
with the tweet's bucket; if the candidate has `thread_context`, show the parent briefly above the
quote so the reply makes sense; always include the copy-paste `mark`/`skip` commands with the
real tweet id; keep every reply within `maxReplyChars`; sort by score (highest first, as they
already are in the JSON).
