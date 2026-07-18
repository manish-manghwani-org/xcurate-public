# manual-run.md — how to run everything by hand

_The runbook. The hourly schedule (see §5) does the routine fetching on its own; everything
here is for when **you** want to run, inspect, or fix something manually. All network access
is read-only against X — nothing here can post._

> Quick reference at any time: **`npm run help`** prints the full command cheat sheet.

---

## 0. Prerequisites (once, and whenever auth breaks)

```bash
npm run auth:check          # is the cookie still valid? (never prints the values)
```

If it fails: log into x.com in your browser → DevTools → Application → Cookies →
copy `auth_token` and `ct0` into `.env` (`TWITTER_AUTH_TOKEN`, `TWITTER_CT0`). Re-run the check.

---

## 1. The daily loop, manually

```bash
npm run daily               # full ingest (feed + tracked timelines) + candidates
# …or the pieces:
npm run ingest              # fetch + store (feed + tracked accounts, jittered)
npm run ingest -- --feed-only   # light version: one feed request only (what the hourly job runs)
npm run candidates          # rank stored tweets → data/candidates.json
```

Then, in Claude Code:

```
/daily-digest               # judges candidates, drafts replies → digest/YYYY-MM-DD.md
```

Review the digest, post replies **manually on X**, then record what you did:

```bash
npm run mark-posted -- --tweet <id> --reply "what I actually posted"
npm run skip -- --tweet <id>
```

(Each digest entry includes these commands pre-filled — copy-paste them.)

---

## 2. Buckets (topic classification)

```bash
npm run stats               # includes: labeled/unlabeled counts, per-bucket feedback
```

To label the backlog of stored tweets (builds account profiles), in Claude Code:

```
/classify-tweets            # one batch (≤300); re-run until "awaiting" hits 0
```

Under the hood (rarely needed by hand):

```bash
npm run buckets:export      # → data/unclassified.json (the batch for the agent)
npm run buckets:apply       # ← data/classifications.json → DB + recompute profiles
```

Taxonomy, reply stances, and rank multipliers live in `config/buckets.json` — edit by hand.
`npm run stats` **suggests** multiplier changes from your posted/skip history; it never
applies them.

---

## 3. Voice calibration (monthly-ish)

```bash
npm run calibrate:fetch     # heaviest read in the system — paced hard, takes a while
```

Then in Claude Code:

```
/calibrate-voice            # → config/voice.proposed.md + report + a diff for approval
```

`config/voice.md` is never overwritten without your explicit approval of the diff.

---

## 4. Cron health & recovery (manual intervention)

```bash
npm run cron:status                   # last 24h: ok / failed / missed hourly slots
npm run cron:status -- --hours 48     # longer lookback (max 168)
npm run cron:catchup                  # recover: full ingest + candidates + coverage report
```

- **failed** = a run started but aborted (auth failure, network) or never finished.
- **missed** = no run started that hour (machine stayed off, timer not installed, RTC wake
  unsupported).
- Catch-up honesty: the free reader can't page arbitrarily far back. Catch-up fetches the
  feed + tracked timelines once and reports how far back it actually reached; anything older
  is gone — expected, not a failure. It never hammers to fill a gap.
- Raw logs: `tail -50 data/cron.log` · run history: `npm run stats`.

---

## 5. The hourly schedule (wake → run → sleep)

Every hour the machine wakes (if suspended), runs a **feed-only ingest** (a single jittered
request) + candidates refresh, then goes back to sleep **only if it's clearly unattended**.

### Install (once)

```bash
sudo ops/install-schedule.sh
```

### Test immediately

```bash
sudo systemctl start xcurate-hourly.service
tail -20 data/cron.log
npm run cron:status
```

### How wake/sleep works

- `xcurate-hourly.timer` fires hourly (with up to 5 min random delay) and has
  `WakeSystem=true` → **wakes the machine from suspend** (your lid-closed state).
- After every run the script also arms the **RTC alarm** for the next hour, so the machine
  wakes even if it later **hibernates or is powered off** (needs BIOS support — most laptops
  have it; verify once by shutting down with lid closed and checking it woke, or
  `tail data/cron.log` for an rtcwake warning).
- After the run it goes back to sleep (default `suspend`) **only when all of these hold**:
  lid closed · no terminal/ssh session · no `data/stay-awake` file. Otherwise it stays awake
  — it will never sleep under you while you're working.

### Controls

```bash
touch data/stay-awake                 # docked / lid-closed-but-working: never auto-sleep
rm data/stay-awake                    # back to normal
$EDITOR ops/schedule.env              # XCURATE_SLEEP_ACTION = suspend | poweroff | none
systemctl list-timers xcurate-hourly.timer    # when is the next run?
journalctl -u xcurate-hourly.service -n 50    # service-level logs
sudo ops/uninstall-schedule.sh        # remove the schedule entirely
```

### Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| `cron:status` all **missed**, timer installed | Machine was fully off and BIOS RTC wake is off/unsupported — check BIOS "RTC alarm / wake on RTC" setting; runs resume on next boot (`Persistent=true`). |
| Slot **failed**: "auth failure" | Cookie expired — §0, then `npm run cron:catchup`. |
| Machine suspended while docked (lid closed) | That's the design — use `touch data/stay-awake`. |
| No network after wake | Script waits up to 90s for Wi-Fi; slower networks show as failed slot, next hour recovers. |
| Timer didn't wake the laptop from suspend | Check `/sys/class/rtc/rtc0` exists and the service ran at all (`journalctl -u xcurate-hourly.service`). Some aggressive vendor sleep modes (e.g. "modern standby" quirks) block CLOCK_ALARM — test once with lid closed. |

---

## 6. Accounts & misc

```bash
npm run accounts:add -- --handle someone --weight 1.5
npm run accounts:list
npm run stats               # DB totals, bucket coverage, per-bucket feedback, last runs
```
