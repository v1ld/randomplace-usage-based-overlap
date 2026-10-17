#!/usr/bin/env bash
# Disables, unloads and removes the RandomPlace KWin script and its helper.
#   ./uninstall.sh          keep saved usage data
#   ./uninstall.sh --purge  also delete saved usage data
set -euo pipefail

ID=randomplace
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/randomplace"

kwriteconfig6 --file kwinrc --group Plugins --key "${ID}Enabled" false
busctl --user call org.kde.KWin /Scripting org.kde.kwin.Scripting \
  unloadScript s "$ID" >/dev/null 2>&1 || true

rm -f "$DATA/dbus-1/services/local.randomplace.Store.service"
pkill -f "kwin/scripts/$ID/contents/helper/randomplace-store.py" 2>/dev/null || true
kpackagetool6 --type=KWin/Script --remove "$ID" || true

if [ "${1:-}" = "--purge" ]; then
  rm -rf "$STATE"
  echo "Removed '$ID' and its saved usage data."
else
  echo "Removed '$ID'. Saved usage kept in $STATE (use --purge to delete)."
fi
