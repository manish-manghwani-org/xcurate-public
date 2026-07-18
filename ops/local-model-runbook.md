# Local-model (Ollama) runbook

Operational notes for running the local tweet classifier and its eval.
Context: a modest CPU-only machine — no GPU assumed.

**Design of record (PLANNING.md §2.7.1):** classification runs on **`qwen2.5:3b-instruct`** against
the **6→5-bucket coarse taxonomy** (`professional`, `personal-social`, `ideas`, `civic`, `other`).
This is the intended long-term model, not a bridge — the larger-model / longer-eval track
was **retired** (S4, 2026-07-17) after the coarse taxonomy + a spot-check showed the 3B's true
accuracy is ~78–88%, plenty for feeding rolling account-profile distributions. The 3B is the
default in `config/settings.json` (`classify.model`), so no `--model` flag is needed.

Models (`ollama list`):
- `qwen2.5:3b-instruct` (1.9 GB) — the classifier.
- `qwen2.5:7b-instruct` (4.7 GB) — kept on disk only as an **optional** check for the one known
  3B weak spot: non-English and code-mixed tweets. Not used by default; costs ~4× the time.

Everything below is **fully local**: Ollama serves on `localhost:11434`, the eval reads
`data/eval-gold*.json` and writes local files. **No internet needed** while running (only the
one-time `ollama pull` needs the network). Never touches X. Zero Claude/API tokens.

---

## The eval (agreement vs the frozen reference labels)

The gold set (`data/eval-gold.json`) holds 16-bucket Opus reference labels. Fold them into the
coarse taxonomy first (deterministic, no re-labeling), then score the 3B against the coarse gold:

```bash
# 1. fold 16→5 via config/bucket-map.json (creator-promo is excluded — it's intent, not topic)
npx tsx src/cli.ts buckets eval --fold-coarse

# 2. score the 3B against the coarse gold
npx tsx src/cli.ts buckets eval --gold data/eval-gold.coarse.json --model qwen2.5:3b-instruct
```

- Coarse gold is ~1069 items. On CPU the 3B runs at a few seconds per item, so a full eval is a
  background job, not an interactive one — time a `--limit` run first to estimate your own rate.
- Quick smoke: add `--limit 60`.

### Reading the number
Raw agreement is **agreement with Opus**, which understates true accuracy by ~15–20 pts — most
disagreements are fuzzy-boundary calls (daily-life post vs thin @-reply; topic vs promo-intent)
where the local model's answer is defensible. The CLI prints a **directional ~60% raw bar**
(≈ ~78–85% real), not a hard gate. When a number looks low, **spot-check the disagreements**
(re-classify a stratified sample and hand-judge) before treating it as real error.

### Watch progress (if backgrounded)
```bash
grep -oE "evaluating [0-9]+/[0-9]+" <output-file> | tail -1        # latest count
watch -n 10 'grep -oE "evaluating [0-9]+/[0-9]+" <output-file> | tail -1'   # live
```

### Sanity checks while it runs
```bash
ollama ps          # model loaded; PROCESSOR shows CPU vs GPU split
free -h            # RAM headroom — the 3B needs ~2.2 GB resident
```

---

## Run the actual classification (backfill labeling)

```bash
npx tsx src/cli.ts buckets export       # DB → data/unclassified.json
npx tsx src/cli.ts buckets classify     # local model → data/classifications.json
npx tsx src/cli.ts buckets apply        # data/classifications.json → DB
```

Ollama unreachable → clean error, DB untouched (fail-safe, like `mark-posted`).

---

## Manage the model / free space

```bash
ollama ps                        # what's loaded in RAM right now
ollama stop qwen2.5:3b-instruct  # unload from RAM (auto-unloads after ~5 min idle)
ollama rm  qwen2.5:7b-instruct   # delete the retired 7B from DISK (frees ~4.7 GB) if space is tight
```

---

## Keep the machine awake during a long run (systemd-based Linux)

A full eval or a large backfill can outlast an idle-sleep or lid-close. On many desktop setups
`logind` handles the lid directly, so desktop-environment power settings are **not** enough on
their own — a run can take an unnoticed nap mid-job. Hold a `systemd-inhibit` block lock, which
stops sleep at the `logind` level (same mechanism `ops/xcurate-hourly.sh` uses):

```bash
# wrap the command so the lock lives exactly as long as the job (no sudo):
systemd-inhibit --what=sleep:handle-lid-switch --who="xcurate-eval" --mode=block \
  npx tsx src/cli.ts buckets eval --gold data/eval-gold.coarse.json --model qwen2.5:3b-instruct

systemd-inhibit --list | grep xcurate   # verify: WHAT=sleep:handle-lid-switch  MODE=block
```

Notes:
- On a laptop, keep it **plugged in** — sustained CPU inference drains a battery fast.
- Inhibitor locks are tied to the session; a full logout releases them.
- `data/stay-awake` only governs `ops/xcurate-hourly.sh`; it does **not** stop a lid-close suspend
  on its own — the inhibitor lock is what does that.

### Optional permanent change (needs sudo, survives reboots)
This makes the machine ignore lid-close entirely, for every program — a system-wide change, so
only do it if that's what you want:
```bash
sudo sed -i 's/^#\?HandleLidSwitch=.*/HandleLidSwitch=ignore/' /etc/systemd/logind.conf
sudo systemctl restart systemd-logind        # safe; does not kill user processes
```
