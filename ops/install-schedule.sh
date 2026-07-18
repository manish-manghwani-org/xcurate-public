#!/usr/bin/env bash
# Install the xcurate hourly schedule (system-level systemd units).
# System-level is required: WakeSystem= (wake from suspend) doesn't work in
# user units. The service itself drops to the normal user for the pipeline.
#
# Usage: sudo ops/install-schedule.sh
set -euo pipefail
cd "$(dirname "$0")"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo: sudo ops/install-schedule.sh" >&2
  exit 1
fi

[ -f schedule.env ] || cp schedule.env.example schedule.env
chmod +x xcurate-hourly.sh

cp systemd/xcurate-hourly.service systemd/xcurate-hourly.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now xcurate-hourly.timer

echo
systemctl list-timers xcurate-hourly.timer --no-pager
echo
echo "Installed. Useful next steps:"
echo "  test one run now:   sudo systemctl start xcurate-hourly.service && tail -20 ../data/cron.log"
echo "  watch the schedule: npm run cron:status"
echo "  change sleep mode:  edit ops/schedule.env (suspend | poweroff | none)"
