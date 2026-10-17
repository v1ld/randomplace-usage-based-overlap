#!/usr/bin/env bash
# Installs (or upgrades) the RandomPlace KWin script plus its usage-store
# helper, enables the script and loads it into the running KWin.
set -euo pipefail

ID=randomplace
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$ID"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
PKG="$DATA/kwin/scripts/$ID"
MAIN="$PKG/contents/code/main.js"
HELPER="$PKG/contents/helper/randomplace-store.py"
SVC_DIR="$DATA/dbus-1/services"
SVC_NAME=local.randomplace.Store
SVC_FILE="$SVC_DIR/$SVC_NAME.service"

[ -f "$SRC/metadata.json" ] || { echo "Missing $SRC/metadata.json" >&2; exit 1; }
for tool in kpackagetool6 kwriteconfig6 kreadconfig6 busctl; do
  command -v "$tool" >/dev/null || { echo "$tool not found" >&2; exit 1; }
done

# ---- KWin script package -------------------------------------------------
kpackagetool6 --type=KWin/Script --upgrade "$SRC" >/dev/null 2>&1 \
  || kpackagetool6 --type=KWin/Script --install "$SRC"
kwriteconfig6 --file kwinrc --group Plugins --key "${ID}Enabled" true

# ---- usage-store helper (optional; enables remembering usage across logins)
persist="off"
if python3 -c 'import gi; gi.require_version("Gio", "2.0"); from gi.repository import Gio' 2>/dev/null; then
  mkdir -p "$SVC_DIR"
  cat > "$SVC_FILE" <<EOF
[D-BUS Service]
Name=$SVC_NAME
Exec=/usr/bin/env python3 $HELPER
EOF
  # Make the bus notice the new service file (harmless if it already did).
  busctl --user call org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus \
    ReloadConfig >/dev/null 2>&1 || true
  # Stop an old helper so the upgraded one is used on next call.
  pkill -f "$HELPER" 2>/dev/null || true
  sleep 0.3
  if reply=$(busctl --user call "$SVC_NAME" /local/randomplace/Store "$SVC_NAME" Load 2>&1); then
    persist="on"
  else
    echo "WARNING: usage-store helper did not answer: $reply" >&2
  fi
else
  cat >&2 <<'EOF'
WARNING: Python GObject bindings not found, so usage will not be remembered
         across logins (the script still works with session-only usage).
         Install them, then re-run ./install.sh:
           Arch/CachyOS/Manjaro:  sudo pacman -S python-gobject
           Fedora:                sudo dnf install python3-gobject
           Debian/Ubuntu/Kubuntu: sudo apt install python3-gi
           openSUSE:              sudo zypper install python3-gobject
EOF
fi

# ---- load into the running KWin right now -----------------------------------
kwin() { busctl --user call org.kde.KWin /Scripting org.kde.kwin.Scripting "$@"; }
kwin unloadScript s "$ID" >/dev/null 2>&1 || true
kwin loadScript ss "$MAIN" "$ID" >/dev/null
kwin start >/dev/null

echo "Installed to:        $PKG"
echo "kwinrc enabled flag: $(kreadconfig6 --file kwinrc --group Plugins --key "${ID}Enabled")"
echo "Loaded in KWin:      $(kwin isScriptLoaded s "$ID")"   # expect: b true
echo "Usage persistence:   $persist"
cat <<EOF

Shortcut: Meta+Ctrl+Shift+R (rebind in System Settings > Keyboard > Shortcuts, group "KWin").
Log:      journalctl --user -b -f | grep randomplace
EOF
