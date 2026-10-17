/*
 * RandomPlace - KWin script for Plasma 6
 *
 *  1. New windows are placed at a random position.
 *  2. Candidate positions that avoid other windows are preferred. If overlap
 *     is unavoidable, positions that cover the *least used* windows win.
 *  3. A global shortcut re-shuffles every window on the current desktop.
 *  4. Per-app usage is remembered across sessions through a small helper
 *     service (KWin scripts cannot write files). Without the helper the
 *     script still works, with session-only usage.
 *
 * Settings live in ~/.config/kwinrc under [Script-randomplace]; every key is
 * optional (see README.md).
 */
"use strict";

// ---------------------------------------------------------------- settings

function num(key, def) {
    const v = Number(readConfig(key, def));
    return isFinite(v) ? v : def;
}
function bool(key, def) {
    const v = readConfig(key, def);
    return v === true || v === "true" || v === 1 || v === "1";
}

const CFG = {
    candidates: Math.max(20, Math.round(num("candidates", 600))),
    // Accept any candidate whose cost is within this fraction of the best one,
    // then pick randomly among them (keeps placement random, not "best only").
    tolerance: Math.max(0, num("tolerance", 0.15)),
    // 0..1: how much recency counts vs. accumulated per-app focus time.
    recencyWeight: Math.min(1, Math.max(0, num("recencyWeight", 0.6))),
    recencyHalfLifeSec: Math.max(1, num("recencyHalfLifeSec", 600)),
    // Covering even an unused window costs a little; covering a hot one costs more.
    baseOverlapCost: Math.max(0, num("baseOverlapCost", 0.15)),
    // Pixels kept free from the edges of the usable screen area.
    margin: Math.max(0, num("margin", 0)),
    // Persistence of per-app usage.
    persist: bool("persist", true),
    usageHalfLifeDays: Math.max(0.1, num("usageHalfLifeDays", 14)),
    saveIntervalSec: Math.max(10, num("saveIntervalSec", 120)),
    // A single uninterrupted focus stretch never counts for more than this
    // (stops an idle, locked screen from inflating one app).
    idleCapSec: Math.max(10, num("idleCapSec", 600)),
    maxApps: Math.max(10, Math.round(num("maxApps", 200))),
    debug: bool("debug", false),
    excludeClasses: String(readConfig("excludeClasses",
        "krunner,plasmashell,ksplashqml,kwin_wayland,xwaylandvideobridge," +
        "org.kde.polkit-kde-authentication-agent-1,ksmserver-logout-greeter"))
        .split(",").map(function (s) { return s.trim().toLowerCase(); })
        .filter(function (s) { return s.length > 0; }),
};

const STORE = {
    service: "local.randomplace.Store",
    path: "/local/randomplace/Store",
    iface: "local.randomplace.Store",
};

// Always printed (load message, errors).
function say(msg) { print("randomplace: " + msg); }
// Only printed when debug=true.
function log(msg) { if (CFG.debug) say(msg); }

// Run fn; report any exception instead of failing silently inside KWin.
function guard(name, fn) {
    return function () {
        try {
            return fn.apply(null, arguments);
        } catch (e) {
            say("ERROR in " + name + ": " + e + (e && e.stack ? "\n" + e.stack : ""));
        }
    };
}

// -------------------------------------------------------- API compatibility

function allWindows() {
    if (typeof workspace.windowList === "function") return workspace.windowList();
    return workspace.stackingOrder || [];
}

function allOutputs() {
    if (workspace.screens && workspace.screens.length) return workspace.screens;
    return workspace.activeScreen ? [workspace.activeScreen] : [];
}

function clientAreaFor(output, desktop, win) {
    try {
        return workspace.clientArea(KWin.PlacementArea, output, desktop);
    } catch (e) {
        if (win) return workspace.clientArea(KWin.PlacementArea, win);
        throw e;
    }
}

// ---------------------------------------------------------- usage tracking
//
// apps:    app key (window class) -> { ms, ts, last }
//          ms is focus time that decays with a half-life of usageHalfLifeDays;
//          it is exact at time ts and decays from there.
// winLast: window id -> last time that window had focus (this session only).

const apps = new Map();
const winLast = new Map();
let current = null;        // currently focused window
let currentSince = 0;      // when its current focus stretch started
let dirty = false;         // usage changed since last save

const HALF_LIFE_MS = CFG.usageHalfLifeDays * 86400000;

function wid(w) { return String(w.internalId); }

function appKey(w) {
    const k = String(w.resourceClass || w.desktopFileName || "").trim().toLowerCase();
    return k || "unknown";
}

function excluded(w) {
    return CFG.excludeClasses.indexOf(String(w.resourceClass).toLowerCase()) !== -1;
}

function decayed(a, now) {
    return a.ms * Math.pow(0.5, Math.max(0, now - a.ts) / HALF_LIFE_MS);
}

// Book the focused window's time up to `now` to its app.
function credit(now) {
    const w = current;
    const since = currentSince;
    currentSince = now;
    if (!w || excluded(w)) return;
    const delta = Math.min(Math.max(0, now - since), CFG.idleCapSec * 1000);
    const k = appKey(w);
    let a = apps.get(k);
    if (!a) { a = { ms: 0, ts: now, last: 0 }; apps.set(k, a); }
    a.ms = decayed(a, now) + delta;
    a.ts = now;
    a.last = now;
    winLast.set(wid(w), now);
    if (delta > 0) dirty = true;
}

function onActivated(w) {
    const now = Date.now();
    credit(now);
    current = w || null;
    currentSince = now;
    if (current) winLast.set(wid(current), now);
    maybeSave(now, false);
}

// Usage score in 0..1 for each window: a blend of how recently that window
// was focused and how much (decayed) focus time its app has had, relative to
// the busiest app among `windows`.
function usageScores(windows) {
    const now = Date.now();
    credit(now);
    let maxFreq = 0;
    const freq = windows.map(function (w) {
        const a = apps.get(appKey(w));
        const v = a ? decayed(a, now) : 0;
        if (v > maxFreq) maxFreq = v;
        return v;
    });
    const out = new Map();
    windows.forEach(function (w, i) {
        const f = maxFreq > 0 ? freq[i] / maxFreq : 0;
        const last = winLast.get(wid(w)) || 0;
        const rec = last > 0
            ? Math.pow(0.5, (now - last) / 1000 / CFG.recencyHalfLifeSec)
            : 0;
        out.set(wid(w), CFG.recencyWeight * rec + (1 - CFG.recencyWeight) * f);
    });
    return out;
}

// -------------------------------------------------------------- persistence
//
// Saved format: { v: 1, saved: <epoch ms>, apps: { <key>: { ms, last } } }
// Nothing is saved until the stored data has been loaded and merged, so a
// slow or missing helper can never cause saved history to be overwritten.

let storeLoaded = false;
let loadTries = 0;
let lastLoadTry = 0;
let lastSave = Date.now();
let warnedNoStore = false;
const LOAD_RETRY_MS = 60000;
const LOAD_MAX_TRIES = 5;

function snapshot(now) {
    const list = [];
    apps.forEach(function (a, k) { list.push({ k: k, ms: decayed(a, now), last: a.last }); });
    list.sort(function (a, b) { return b.ms - a.ms; });
    const out = {};
    list.filter(function (e) { return e.ms >= 60000; })   // drop < 1 min of use
        .slice(0, CFG.maxApps)
        .forEach(function (e) { out[e.k] = { ms: Math.round(e.ms), last: e.last }; });
    return { v: 1, saved: now, apps: out };
}

// Merge saved data into `apps`; returns the number of apps merged.
function mergeStore(text, now) {
    let d;
    try { d = JSON.parse(text); } catch (e) { say("usage store unreadable: " + e); return 0; }
    if (!d || d.v !== 1 || !d.apps || typeof d.apps !== "object") return 0;
    const savedAt = isFinite(d.saved) ? Math.min(Number(d.saved), now) : now;
    let n = 0;
    Object.keys(d.apps).forEach(function (k) {
        const e = d.apps[k];
        if (!e || !isFinite(e.ms) || e.ms < 0) return;
        const stored = { ms: Number(e.ms), ts: savedAt, last: isFinite(e.last) ? Number(e.last) : 0 };
        const v = decayed(stored, now);
        const a = apps.get(k);
        if (a) {
            a.ms = decayed(a, now) + v;
            a.ts = now;
            a.last = Math.max(a.last, stored.last);
        } else {
            apps.set(k, { ms: v, ts: now, last: stored.last });
        }
        n++;
    });
    return n;
}

function tryLoad(now) {
    if (!CFG.persist || storeLoaded) return;
    if (loadTries >= LOAD_MAX_TRIES) {
        if (!warnedNoStore && now - lastLoadTry >= LOAD_RETRY_MS) {
            warnedNoStore = true;
            say("usage store not reachable; usage is kept for this session only (see README)");
        }
        return;
    }
    if (loadTries > 0 && now - lastLoadTry < LOAD_RETRY_MS) return;
    loadTries++;
    lastLoadTry = now;
    log("usage store: load attempt " + loadTries);
    callDBus(STORE.service, STORE.path, STORE.iface, "Load", guard("storeLoaded", function (reply) {
        if (storeLoaded) return;
        const text = (typeof reply === "string") ? reply
            : (reply && reply.length !== undefined && typeof reply[0] === "string") ? reply[0] : "";
        const n = mergeStore(text || "{}", Date.now());
        storeLoaded = true;
        lastSave = Date.now();
        say("usage store: loaded " + n + " app(s)");
    }));
}

function maybeSave(now, force) {
    if (!CFG.persist || !storeLoaded) return;
    if (!force && now - lastSave < CFG.saveIntervalSec * 1000) return;
    credit(now);
    lastSave = now;
    if (!dirty) return;
    dirty = false;
    const snap = snapshot(now);
    callDBus(STORE.service, STORE.path, STORE.iface, "Save", JSON.stringify(snap));
    log("usage store: saved " + Object.keys(snap.apps).length + " app(s)");
}

// Cheap periodic hook (KWin JS scripts have no timers): runs at most once a
// second off cursor movement and window events.
let lastBeat = 0;
function heartbeat() {
    const now = Date.now();
    if (now - lastBeat < 1000) return;
    lastBeat = now;
    try {
        if (!storeLoaded) tryLoad(now);
        else maybeSave(now, false);
    } catch (e) {
        say("ERROR in heartbeat: " + e);
    }
}

// ----------------------------------------------------------- window checks

function onDesktop(w, desktop) {
    if (w.onAllDesktops) return true;
    const ds = w.desktops || [];
    for (let i = 0; i < ds.length; i++) if (ds[i] === desktop) return true;
    return false;
}

function goodRect(a) {
    return a && isFinite(a.x) && isFinite(a.y) && a.width > 0 && a.height > 0;
}

function usableArea(win, output, desktop) {
    let a = null;
    try { a = clientAreaFor(output, desktop, win); } catch (e) { say("clientArea failed: " + e); }
    if (!goodRect(a)) {
        say("clientArea gave an unusable rectangle (" + JSON.stringify(a) + "); using output geometry");
        a = output && output.geometry;
    }
    if (!goodRect(a)) a = workspace.virtualScreenGeometry;
    if (!goodRect(a)) throw new Error("no usable screen area");
    const m = CFG.margin;
    return { x: a.x + m, y: a.y + m, width: a.width - 2 * m, height: a.height - 2 * m };
}

// A window we are allowed to relocate. Returns "" if yes, else the reason.
function whyNot(w) {
    if (!w) return "no window";
    if (!w.normalWindow) return "not a normal window";
    if (w.deleted) return "deleted";
    if (w.dialog) return "dialog";
    if (w.transient) return "transient";
    if (w.fullScreen) return "fullscreen";
    if (w.minimized) return "minimized";
    if (w.moveable === false) return "not moveable";
    if (w.tile) return "tiled";
    if (excluded(w)) return "excluded class " + w.resourceClass;
    return "";
}
function relocatable(w) { return whyNot(w) === ""; }

// Roughly maximized (covers the whole usable area): moving it is meaningless.
function fillsArea(w, area) {
    const g = w.frameGeometry;
    return g.width >= area.width - 2 && g.height >= area.height - 2;
}

// ---------------------------------------------------------------- geometry

function overlapArea(a, b) {
    const dx = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const dy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    return (dx > 0 && dy > 0) ? dx * dy : 0;
}

/*
 * Pick a top-left position for a window of `size` inside `area`.
 * obstacles: [{ rect, usage }]
 * Returns { x, y, cost }.
 */
function chooseSpot(size, area, obstacles) {
    const spanX = Math.max(0, area.width - size.width);
    const spanY = Math.max(0, area.height - size.height);

    const cands = [];
    let best = Infinity;
    for (let i = 0; i < CFG.candidates; i++) {
        const x = Math.round(area.x + Math.random() * spanX);
        const y = Math.round(area.y + Math.random() * spanY);
        const r = { x: x, y: y, width: size.width, height: size.height };
        let cost = 0;
        for (let j = 0; j < obstacles.length; j++) {
            const ov = overlapArea(r, obstacles[j].rect);
            if (ov > 0) cost += ov * (CFG.baseOverlapCost + obstacles[j].usage);
        }
        cands.push({ x: x, y: y, cost: cost });
        if (cost < best) best = cost;
    }

    // Free space exists -> uniform random among all free candidates.
    // Otherwise -> random among those nearly as cheap as the cheapest.
    const limit = best === 0 ? 0 : best * (1 + CFG.tolerance);
    const pool = cands.filter(function (c) { return c.cost <= limit; });
    return pool[Math.floor(Math.random() * pool.length)];
}

function applied(w, x, y) {
    const a = w.frameGeometry;
    return Math.abs(a.x - x) < 1 && Math.abs(a.y - y) < 1;
}

// Move a window and verify KWin actually accepted it; if the first way of
// assigning the geometry is ignored, retry with a plain object.
function moveTo(w, x, y) {
    if (!isFinite(x) || !isFinite(y)) {
        say("refusing to move '" + w.caption + "' to " + x + "," + y);
        return false;
    }
    const g = w.frameGeometry;     // copy, modify, assign back
    g.x = x;
    g.y = y;
    w.frameGeometry = g;
    let how = "rect copy";
    if (!applied(w, x, y)) {
        const c = w.frameGeometry;
        w.frameGeometry = { x: x, y: y, width: c.width, height: c.height };
        how = "plain object";
    }
    const a = w.frameGeometry;
    if (applied(w, x, y)) {
        log("moved '" + w.caption + "' to " + x + "," + y + " via " + how);
        return true;
    }
    say("KWin ignored move of '" + w.caption + "' (wanted " + x + "," + y +
        ", still at " + a.x + "," + a.y + ")");
    return false;
}

// Windows on this output + desktop that act as obstacles (visible, not full-size).
function obstaclesFor(output, desktop, area, exclude, usage) {
    const list = [];
    allWindows().forEach(function (o) {
        if (o === exclude || !o.normalWindow || o.deleted || o.minimized) return;
        if (o.output !== output || !onDesktop(o, desktop)) return;
        if (o.fullScreen || fillsArea(o, area)) return;
        list.push({ w: o, rect: o.frameGeometry, usage: usage.get(wid(o)) || 0 });
    });
    return list;
}

// ---------------------------------------------------------- new windows

const placeNew = guard("placeNew", function (w) {
    const reason = whyNot(w);
    if (reason) { log("skip '" + w.caption + "': " + reason); return; }

    const output = w.output;
    const ds = w.desktops || [];
    const desktop = ds.length ? ds[0] : workspace.currentDesktop;
    const area = usableArea(w, output, desktop);
    if (fillsArea(w, area)) { log("skip '" + w.caption + "': fills area"); return; }

    const others = allWindows().filter(function (o) {
        return o !== w && o.normalWindow && !o.deleted;
    });
    const usage = usageScores(others);
    const obstacles = obstaclesFor(output, desktop, area, w, usage).map(function (o) {
        return { rect: o.rect, usage: o.usage };
    });

    const g = w.frameGeometry;
    const spot = chooseSpot({ width: g.width, height: g.height }, area, obstacles);
    log("place '" + w.caption + "' at " + spot.x + "," + spot.y +
        " (cost " + Math.round(spot.cost) + ")");
    moveTo(w, spot.x, spot.y);
});

// Some windows report a 0x0 size at windowAdded; wait until they have one.
function whenSized(w, fn) {
    function ready() {
        const g = w.frameGeometry;
        return g.width > 1 && g.height > 1;
    }
    if (ready()) { fn(); return; }
    const handler = function () {
        if (!ready()) return;
        w.frameGeometryChanged.disconnect(handler);
        fn();
    };
    w.frameGeometryChanged.connect(handler);
}

// ------------------------------------------------------------- reshuffle

const reshuffle = guard("reshuffle", function () {
    say("reshuffle triggered");
    const desktop = workspace.currentDesktop;
    const outputs = allOutputs();

    for (let s = 0; s < outputs.length; s++) {
        const output = outputs[s];
        const area = usableArea(null, output, desktop);

        const visible = allWindows().filter(function (w) {
            return w.normalWindow && !w.deleted && !w.minimized &&
                   w.output === output && onDesktop(w, desktop) && !w.fullScreen;
        });
        const usage = usageScores(visible);
        if (CFG.debug) {
            visible.forEach(function (w) {
                log("usage " + (usage.get(wid(w)) || 0).toFixed(2) + "  " +
                    appKey(w) + "  '" + w.caption + "'");
            });
        }

        const movable = visible.filter(function (w) {
            const reason = whyNot(w) || (fillsArea(w, area) ? "fills area" : "");
            if (reason) log("reshuffle skips '" + w.caption + "': " + reason);
            return reason === "";
        });
        // Windows we must leave alone still occupy space.
        const placed = visible.filter(function (w) {
            return movable.indexOf(w) === -1 && !fillsArea(w, area);
        }).map(function (w) {
            return { rect: w.frameGeometry, usage: usage.get(wid(w)) || 0 };
        });

        // Most-used windows first -> they claim open space; the least-used
        // ones come last and are the ones that end up being overlapped.
        movable.sort(function (a, b) {
            return (usage.get(wid(b)) || 0) - (usage.get(wid(a)) || 0);
        });

        movable.forEach(function (w) {
            const g = w.frameGeometry;
            const spot = chooseSpot({ width: g.width, height: g.height }, area, placed);
            moveTo(w, spot.x, spot.y);
            placed.push({
                rect: { x: spot.x, y: spot.y, width: g.width, height: g.height },
                usage: usage.get(wid(w)) || 0,
            });
        });
        say("reshuffled " + movable.length + " of " + visible.length +
            " window(s) on output " + output.name + ", area " +
            area.x + "," + area.y + " " + area.width + "x" + area.height);
    }
    maybeSave(Date.now(), true);
});

// ---------------------------------------------------------------- wiring

workspace.windowActivated.connect(guard("onActivated", onActivated));
onActivated(workspace.activeWindow);

workspace.windowAdded.connect(guard("windowAdded", function (w) {
    heartbeat();
    const reason = whyNot(w);
    if (reason) { log("ignore new '" + w.caption + "': " + reason); return; }
    whenSized(w, function () { placeNew(w); });
}));

workspace.windowRemoved.connect(guard("windowRemoved", function (w) {
    const now = Date.now();
    if (w === current) {
        try { credit(now); } catch (e) { /* window may already be torn down */ }
        current = null;
        currentSince = now;
    }
    winLast.delete(wid(w));
    maybeSave(now, false);
}));

try {
    workspace.cursorPosChanged.connect(heartbeat);
} catch (e) {
    say("cursorPosChanged unavailable (" + e + "); saving only on window events");
}

registerShortcut(
    "RandomPlace Reshuffle",
    "RandomPlace: Reshuffle windows",
    "Meta+Ctrl+Shift+R",
    reshuffle
);

if (CFG.persist) tryLoad(Date.now());

say("loaded (windows=" + allWindows().length +
    ", outputs=" + allOutputs().length +
    ", persist=" + CFG.persist + ")");
