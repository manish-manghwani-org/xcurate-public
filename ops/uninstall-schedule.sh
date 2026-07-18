#!/usr/bin/env bash
# Remove the xcurate hourly schedule. Usage: sudo ops/uninstall-schedule.sh
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo: sudo ops/uninstall-schedule.sh" >&2
  exit 1
fi

systemctl disable --now xcurate-hourly.timer 2>/dev/null || true
rm -f /etc/systemd/system/xcurate-hourly.service /etc/systemd/system/xcurate-hourly.timer
systemctl daemon-reload
echo "Removed xcurate-hourly.service and .timer. (ops/schedule.env left in place.)"
