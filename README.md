# RandomPlace – KWin script for Plasma 6

Spreads window positions around to reduce OLED burn-in.

- **New windows** get a random position.
- **Open space first:** candidates that avoid other windows are preferred. If overlap can't be avoided, the script covers the *least used* windows.
- **Usage is remembered per app across logins**, so "least used" is meaningful straight after you sign in.
- **Reshuffle on demand:** `Meta+Ctrl+Shift+R` re-places every movable window on the current desktop. Most-used windows are placed first, so they claim open space and the least-used ones end up overlapped.

## Install

```bash
chmod +x install.sh uninstall.sh
./install.sh
```

The installer:

1. installs the package with `kpackagetool6` into `~/.local/share/kwin/scripts/randomplace/`,
2. enables it in `kwinrc` (`[Plugins] randomplaceEnabled=true`),
3. registers the usage-store helper as a D-Bus service (`~/.local/share/dbus-1/services/local.randomplace.Store.service`) and checks it answers,
4. loads the script into the running KWin and prints its status. Expect `Loaded in KWin: b true` and `Usage persistence: on`.

You can also enable or disable the script in **System Settings → Window Management → KWin Scripts**.

**Requirement for persistence:** Python 3 with the GObject bindings (`python-gobject` on Arch/CachyOS, `python3-gobject` on Fedora/openSUSE, `python3-gi` on Debian/Ubuntu). Without them the script still works, but usage is kept only for the current session.

## How usage is measured

- **Per app** (window class, e.g. `firefox`, `org.kde.konsole`): total focus time, decaying with a half-life of `usageHalfLifeDays` (default 14 days). Old habits fade, and an app you used heavily last month counts less than one you use daily.
- **Per window** (this session only): how recently that window had focus.
- Each window's score blends the two (`recencyWeight`). A single focus stretch counts for at most `idleCapSec` (10 min), so leaving a window focused overnight doesn't inflate it.

### Why a helper service?

KWin scripts can read settings but cannot write files. The script therefore saves through `callDBus` to a small helper (`contents/helper/randomplace-store.py`). The helper starts on demand through D-Bus activation, writes `~/.local/state/randomplace/usage.json` atomically (mode 600), and exits after 10 idle minutes. The script never saves before it has loaded the existing data, so a missing or slow helper can't wipe your history. It saves every `saveIntervalSec` (2 min) when something changed, and whenever you reshuffle.

## Shortcut

The default is `Meta+Ctrl+Shift+R`. Change it in **System Settings → Keyboard → Shortcuts**, under the **KWin** group, entry "RandomPlace: Reshuffle windows".

## Settings (optional)

Set keys in the `[Script-randomplace]` group of `~/.config/kwinrc`:

```bash
kwriteconfig6 --file kwinrc --group Script-randomplace --key candidates 800
./install.sh   # reloads the script so the change takes effect
```

| Key | Default | Meaning |
|---|---|---|
| `candidates` | 600 | Random positions sampled per placement |
| `tolerance` | 0.15 | Accept positions within this fraction of the best cost, then pick randomly |
| `recencyWeight` | 0.6 | 0–1 balance between "this window was focused recently" and "this app gets a lot of use" |
| `recencyHalfLifeSec` | 600 | Seconds for the recency score to halve |
| `baseOverlapCost` | 0.15 | Cost of covering even an unused window |
| `margin` | 0 | Pixels kept clear of the usable-area edges |
| `excludeClasses` | krunner,plasmashell,… | Comma-separated window classes never moved (and not counted) |
| `persist` | true | Remember per-app usage across logins |
| `usageHalfLifeDays` | 14 | Days for remembered usage to halve |
| `saveIntervalSec` | 120 | Minimum seconds between saves |
| `idleCapSec` | 600 | Most that one uninterrupted focus stretch can count |
| `maxApps` | 200 | Apps kept in the saved file (least used dropped first) |
| `debug` | false | Log decisions |

Find a window's class with `kdotool getactivewindow getwindowclassname`, or in the KWin debug console.

## Troubleshooting

```bash
# Is it loaded in the running KWin? (expect: b true)
busctl --user call org.kde.KWin /Scripting org.kde.kwin.Scripting isScriptLoaded s randomplace

# Is the usage store reachable, and what does it hold?
busctl --user call local.randomplace.Store /local/randomplace/Store local.randomplace.Store Load

# Watch what it logs (the load line, the usage-store line and errors are always printed):
journalctl --user -b -f | grep randomplace
```

After loading you should see `randomplace: usage store: loaded N app(s)`. If you see `usage store not reachable` instead, check the second command above and the helper's own log with `journalctl --user -b | grep -i randomplace.Store`.

With `debug=true`, a reshuffle also logs every window's usage score, which shows what the script thinks you use most.

## Uninstall

```bash
./uninstall.sh           # keeps ~/.local/state/randomplace/usage.json
./uninstall.sh --purge   # also deletes the saved usage
```

## Notes and limits

- Windows that are fullscreen, maximized, tiled, minimized, dialogs or transients are left alone.
- Focus time that hasn't been saved yet (at most `saveIntervalSec`, or the current focus stretch) is lost if you log out abruptly.
- Window rules that force a position take precedence over this script.
- Some applications set their own geometry after the window appears. If one keeps snapping back, add its class to `excludeClasses` or use a window rule for it.
