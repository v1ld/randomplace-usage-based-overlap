#!/usr/bin/env python3
"""RandomPlace usage store.

KWin scripts cannot write files, so the RandomPlace script talks to this tiny
session-bus service to keep its per-app usage between sessions.

  bus name   local.randomplace.Store
  object     /local/randomplace/Store
  interface  local.randomplace.Store
    Load() -> s     the saved JSON text ("{}" if there is none)
    Save(s)         replace the saved JSON text

Data file: $XDG_STATE_HOME/randomplace/usage.json (default ~/.local/state/...).
Override with RANDOMPLACE_STORE=/path/to/file (used by the tests).

The service is D-Bus activated on first use and exits after a period without
calls; the next call simply starts it again.
"""
import json
import os
import sys
import tempfile
import time

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

NAME = "local.randomplace.Store"
PATH = "/local/randomplace/Store"
IFACE = "local.randomplace.Store"
MAX_BYTES = 512 * 1024
IDLE_EXIT_SEC = int(os.environ.get("RANDOMPLACE_IDLE_EXIT", "600"))

XML = """
<node>
  <interface name="local.randomplace.Store">
    <method name="Load"><arg type="s" direction="out"/></method>
    <method name="Save"><arg type="s" direction="in"/></method>
  </interface>
</node>
"""

last_activity = time.monotonic()


def data_file():
    override = os.environ.get("RANDOMPLACE_STORE")
    if override:
        return override
    base = os.environ.get("XDG_STATE_HOME") or os.path.join(
        os.path.expanduser("~"), ".local", "state")
    return os.path.join(base, "randomplace", "usage.json")


def load():
    try:
        with open(data_file(), "r", encoding="utf-8") as f:
            text = f.read(MAX_BYTES + 1)
        if len(text.encode("utf-8")) > MAX_BYTES:
            return "{}"
        json.loads(text)          # never hand back something unparseable
        return text
    except FileNotFoundError:
        return "{}"
    except (OSError, ValueError):
        return "{}"


def save(text):
    if len(text.encode("utf-8")) > MAX_BYTES:
        raise ValueError("payload too large")
    try:
        data = json.loads(text)
    except ValueError as e:
        raise ValueError("not valid JSON: %s" % e)
    if not isinstance(data, dict) or data.get("v") != 1 \
            or not isinstance(data.get("apps"), dict):
        raise ValueError("unexpected structure")

    path = data_file()
    folder = os.path.dirname(path)
    os.makedirs(folder, mode=0o700, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".usage-", dir=folder)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)     # atomic: readers never see a partial file
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def on_method_call(conn, sender, obj_path, iface, method, params, invocation):
    global last_activity
    last_activity = time.monotonic()
    try:
        if method == "Load":
            invocation.return_value(GLib.Variant("(s)", (load(),)))
        elif method == "Save":
            save(params.unpack()[0])
            invocation.return_value(None)
        else:
            invocation.return_dbus_error(
                "local.randomplace.Store.Error.UnknownMethod", method)
    except ValueError as e:
        invocation.return_dbus_error("local.randomplace.Store.Error.Invalid", str(e))
    except OSError as e:
        invocation.return_dbus_error("local.randomplace.Store.Error.IO", str(e))


def main():
    loop = GLib.MainLoop()
    node = Gio.DBusNodeInfo.new_for_xml(XML)

    def on_bus_acquired(conn, name):
        conn.register_object(PATH, node.interfaces[0], on_method_call, None, None)

    def on_name_lost(conn, name):
        # Another instance already owns the name (or the bus went away).
        loop.quit()

    Gio.bus_own_name(Gio.BusType.SESSION, NAME, Gio.BusNameOwnerFlags.NONE,
                     on_bus_acquired, None, on_name_lost)

    def idle_check():
        if time.monotonic() - last_activity > IDLE_EXIT_SEC:
            loop.quit()
            return False
        return True

    GLib.timeout_add_seconds(5 if IDLE_EXIT_SEC < 60 else 30, idle_check)
    loop.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
