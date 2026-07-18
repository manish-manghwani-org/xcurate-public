#!/usr/bin/env bash
# Hourly runner for xcurate — invoked as root by xcurate-hourly.service.
#
# What it does, in order:
#   1. waits for the network (Wi-Fi takes a few seconds after wake-from-suspend)
#   2. runs the read-only pipeline as the normal user: feed-only ingest + candidates
#   3. arms the RTC to wake the machine for the next hour (covers hibernate/poweroff;
#      the systemd timer's WakeSystem= only covers suspend)
#   4. puts the machine back to sleep ONLY when it's clearly unattended
#
# Sleep safety rules (any one of these keeps the machine awake):
#   - XCURATE_SLEEP_ACTION=none in ops/schedule.env
#   - the file data/stay-awake exists        (touch it for docked/lid-closed use)
#   - the laptop lid is open (or lid state unknown — e.g. desktops)
#   - an active terminal/ssh session exists (`who` shows a pts)
set -u

REPO="${XCURATE_REPO:-$HOME/xcurate}"
RUN_USER="${XCURATE_USER:-$(id -un)}"
LOG="$REPO/data/cron.log"
ACTION="${XCURATE_SLEEP_ACTION:-suspend}"   # suspend | poweroff | none

log() { echo "[$(date -Is)] $*" >> "$LOG"; }

mkdir -p "$REPO/data"
touch "$LOG" && chown "$RUN_USER" "$LOG" 2>/dev/null || true

log "── hourly run starting (sleep action: $ACTION)"

arm_rtc() {
  # Arm the RTC for the next full hour, so the machine wakes even from
  # hibernate/poweroff (WakeSystem= only covers suspend). Harmless otherwise.
  local next_epoch
  next_epoch=$(date -d "$(date -d '+1 hour' '+%Y-%m-%d %H:00:00')" +%s)
  if command -v rtcwake >/dev/null 2>&1; then
    rtcwake -m no -t "$next_epoch" >> "$LOG" 2>&1 \
      || log "warning: rtcwake failed — BIOS may not support RTC wake from off/hibernate"
  fi
}

# 1) Arm the RTC FIRST: if anything below hangs or the box dies mid-run, the
#    next hourly wake is already scheduled (a mid-run suspend can otherwise leave
#    no alarm armed, causing missed slots).
arm_rtc

# 2) Network: after a timer wake the Wi-Fi needs a moment to reassociate.
if command -v nm-online >/dev/null 2>&1; then
  nm-online -q -t 90 || log "warning: network not online after 90s — trying anyway"
fi

# 3) The pipeline (read-only against X; one jittered feed request + local
#    ranking), under an inhibitor lock: after a lid-closed resume, logind
#    re-suspends the box ~30s later, which froze a run mid-fetch overnight.
#    The lock blocks sleep and lid handling until the run finishes.
systemd-inhibit --what=sleep:handle-lid-switch --who=xcurate --why="hourly ingest in progress" --mode=block \
  runuser -u "$RUN_USER" -- bash -c "cd '$REPO' && /usr/bin/npm run --silent hourly" >> "$LOG" 2>&1
status=$?
log "hourly run finished (exit $status)"

# 4) Re-arm for the *following* hour if the run straddled a boundary. Idempotent.
arm_rtc

# 5) Back to sleep, only when unattended.
if [ "$ACTION" = "none" ]; then
  log "sleep action disabled — staying awake"
  exit "$status"
fi
if [ -e "$REPO/data/stay-awake" ]; then
  log "data/stay-awake present — staying awake"
  exit "$status"
fi
lid_state=$(cat /proc/acpi/button/lid/*/state 2>/dev/null | awk '{print $2}' | head -1)
if [ "${lid_state:-unknown}" != "closed" ]; then
  log "lid is '${lid_state:-unknown}' — user may be around, staying awake"
  exit "$status"
fi
if who | grep -q 'pts/'; then
  log "active terminal/ssh session — staying awake"
  exit "$status"
fi

log "lid closed and unattended — systemctl $ACTION"
sleep 5
systemctl "$ACTION"
