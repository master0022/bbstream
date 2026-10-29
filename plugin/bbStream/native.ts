/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Runs in Electron's main process: link packs, WHEP signalling and status feeds, StreamerV2, and the
// pop-out / overlay player windows. Nothing here talks to Discord.

import { ChildProcess, spawn } from "child_process";
import { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, IpcMainInvokeEvent, Rectangle, screen } from "electron";
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { createInterface } from "readline";

import { playerHtml, PRELOAD } from "./player";

// --- log ------------------------------------------------------------------
// %TEMP%/bbstream.log: what the streamer said and did, for when going live misbehaves.

const logPath = join(tmpdir(), "bbstream.log");

function log(text: string) {
    try {
        if (statSync(logPath, { throwIfNoEntry: false })?.size! > 1 << 20) writeFileSync(logPath, "");
        appendFileSync(logPath, `${new Date().toISOString()} ${text}\n`);
    } catch { }
}

export function logLine(_: IpcMainInvokeEvent, text: string) {
    log(`[ui] ${text}`);
}

// --- packs ----------------------------------------------------------------
// A pack is a JSON file anyone can host (a gist, a repo file): { "name": "...", "links": { "username": "https://server/key" } }.
// The installer can subscribe to some for you (%APPDATA%\BBStream\packs.txt, one URL per line).

const installerPacksPath = () => join(app.getPath("appData"), "BBStream", "packs.txt");
const packCachePath = () => join(app.getPath("userData"), "bbstream-packs.json");

export function installerPacks(): string[] {
    try { return readFileSync(installerPacksPath(), "utf8").split(/\s+/).filter(u => /^https?:\/\//.test(u)); } catch { return []; }
}

export interface Pack { name: string; links: Record<string, string>; }

/** Fetches each pack, falling back to the last copy that loaded so links survive being offline. */
export async function loadPacks(_: IpcMainInvokeEvent, urls: string[]): Promise<Record<string, Pack>> {
    let cache: Record<string, Pack> = {};
    try { cache = JSON.parse(readFileSync(packCachePath(), "utf8")); } catch { }
    const result: Record<string, Pack> = {};
    await Promise.all(urls.map(async url => {
        try {
            const res = await fetch(url, { headers: { "Cache-Control": "no-cache" }, signal: AbortSignal.timeout(10000) });
            const data = await res.json();
            if (!res.ok || typeof data?.links !== "object") throw new Error(`bad pack ${res.status}`);
            const links: Record<string, string> = {};
            for (const [who, link] of Object.entries(data.links)) if (typeof link === "string") links[who.toLowerCase()] = link;
            result[url] = { name: typeof data.name === "string" ? data.name : url, links };
        } catch (e) {
            log(`pack ${url}: ${e}`);
            if (cache[url]) result[url] = cache[url];
        }
    }));
    try { writeFileSync(packCachePath(), JSON.stringify(result)); } catch { }
    return result;
}

export async function whep(_: IpcMainInvokeEvent, server: string, streamKey: string, offerSdp: string) {
    try {
        const res = await fetch(`${server.replace(/\/+$/, "")}/api/whep`, {
            method: "POST",
            headers: { Authorization: `Bearer ${streamKey}`, "Content-Type": "application/sdp" },
            body: offerSdp
        });
        return { ok: res.ok, status: res.status, body: await res.text() };
    } catch (e) {
        return { ok: false, status: 0, body: String(e) };
    }
}

// Broadcast Box accepts WHEP for any key, so "is it live" comes from the session's SSE feed: a "status"
// event (isOnline) every few seconds. The session never connects and the server drops it after ~30s,
// so each watched stream keeps one feed open and reopens it when it closes.
// The offer must list the codecs a real viewer would (audio + H264 + AV1): an H264-only session
// stops Broadcast Box from forwarding an AV1 stream to everyone.
const PROBE_OFFER = [
    "v=0", "o=- 1 2 IN IP4 127.0.0.1", "s=-", "t=0 0", "a=group:BUNDLE 0 1",
    ...["audio 9 UDP/TLS/RTP/SAVPF 111", "video 9 UDP/TLS/RTP/SAVPF 96 45"].flatMap((m, i) => [
        `m=${m}`, "c=IN IP4 0.0.0.0", "a=ice-ufrag:bbpr", "a=ice-pwd:bbprobebbprobebbprobe12",
        "a=fingerprint:sha-256 " + Array(32).fill("7B").join(":"), "a=setup:actpass", `a=mid:${i}`, "a=recvonly", "a=rtcp-mux",
        ...i === 0
            ? ["a=rtpmap:111 opus/48000/2", "a=fmtp:111 minptime=10;useinbandfec=1"]
            : ["a=rtpmap:96 H264/90000", "a=fmtp:96 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f", "a=rtpmap:45 AV1/90000"]
    ]),
    ""
].join("\r\n");

interface Feed { stop: AbortController; online: boolean | null; }
const feeds = new Map<string, Feed>();

async function readFeed(server: string, streamKey: string, feed: Feed) {
    const attempt = new AbortController();
    const onStop = () => attempt.abort();
    feed.stop.signal.addEventListener("abort", onStop);
    let stall = setTimeout(onStop, 12000);
    try {
        const res = await fetch(`${server}/api/whep`, {
            method: "POST",
            headers: { Authorization: `Bearer ${streamKey}`, "Content-Type": "application/sdp" },
            body: PROBE_OFFER,
            signal: attempt.signal
        });
        await res.text();
        const sse = /<([^>]+)>\s*;\s*rel="urn:ietf:params:whep:ext:core:server-sent-events"/.exec(res.headers.get("link") ?? "")?.[1];
        if (res.status !== 201 || !sse) return;

        // identity: Cloudflare holds back compressed event streams.
        const events = await fetch(sse.includes("://") ? sse : server + sse, {
            headers: { Accept: "text/event-stream", "Accept-Encoding": "identity" },
            signal: attempt.signal
        });
        const reader = events.body!.getReader();
        const decoder = new TextDecoder();
        let buf = "", event = "";
        for (; ;) {
            const { done, value } = await reader.read();
            if (done) return;
            clearTimeout(stall);
            stall = setTimeout(onStop, 12000);
            buf += decoder.decode(value, { stream: true });
            let nl: number;
            while ((nl = buf.indexOf("\n")) !== -1) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                if (line.startsWith("event:")) event = line.slice(6).trim();
                else if (line.startsWith("data:") && event === "status") {
                    try { feed.online = !!JSON.parse(line.slice(5)).isOnline; } catch { }
                }
            }
        }
    } finally {
        clearTimeout(stall);
        feed.stop.signal.removeEventListener("abort", onStop);
        attempt.abort();
    }
}

async function runFeed(target: string, feed: Feed) {
    const [server, streamKey] = target.split(" ");
    while (feeds.get(target) === feed) {
        await readFeed(server.replace(/\/+$/, ""), streamKey, feed).catch(() => { });
        await new Promise(r => setTimeout(r, 1000));
    }
}

/** Keeps a status feed open for each "server key" in targets (and closes the rest); returns what they last said. */
export function watchOnline(_: IpcMainInvokeEvent, targets: string[]): Record<string, boolean> {
    for (const [target, feed] of feeds)
        if (!targets.includes(target)) { feeds.delete(target); feed.stop.abort(); }
    for (const target of targets) {
        if (feeds.has(target)) continue;
        const feed: Feed = { stop: new AbortController(), online: null };
        feeds.set(target, feed);
        runFeed(target, feed);
    }
    const state: Record<string, boolean> = {};
    for (const [target, feed] of feeds) if (feed.online != null) state[target] = feed.online;
    return state;
}

// --- StreamerV2 (`--serve` mode) --------------------------------------------
// One long-lived headless streamer process, started on first use. Discord closing
// closes its stdin, which makes it stop the stream and exit.

export interface StreamerState {
    phase: "off" | "idle" | "starting" | "live" | "error";
    error: string | null;
    source: string | null;
    encoder: string | null;
    width: number;
    height: number;
    fps: number;
    kbps: number;
    since: number;
}

let streamer: ChildProcess | null = null;
let streamerPath = "";
let streamerReady: Promise<boolean> | null = null;
const streamerWaiters = new Set<(m: any) => boolean>();
let streamerState: StreamerState = { phase: "off", error: null, source: null, encoder: null, width: 0, height: 0, fps: 0, kbps: 0, since: 0 };

function onStreamerMessage(m: any) {
    log(`[streamer] ${JSON.stringify(m).replace(/"streamKey":"[^"]*"/, '"streamKey":"…"')}`);
    switch (m.event) {
        case "starting":
            streamerState = { ...streamerState, phase: "starting", error: null, source: m.source ?? null, since: Date.now() };
            break;
        case "live":
            streamerState = { ...streamerState, phase: "live", encoder: m.encoder, width: m.width, height: m.height, fps: m.fps, kbps: m.kbps };
            break;
        case "ended":
            streamerState = { ...streamerState, phase: m.completed || !m.error ? "idle" : "error", error: m.completed ? null : m.error ?? null };
            break;
    }
    for (const w of [...streamerWaiters]) if (w(m)) streamerWaiters.delete(w);
}

function waitStreamer(match: (m: any) => boolean, timeoutMs: number): Promise<any | null> {
    return new Promise(resolve => {
        const timer = setTimeout(() => { streamerWaiters.delete(waiter); resolve(null); }, timeoutMs);
        const waiter = (m: any) => {
            if (!match(m)) return false;
            clearTimeout(timer);
            resolve(m);
            return true;
        };
        streamerWaiters.add(waiter);
    });
}

/** Where the installer puts StreamerV2 when the settings don't name another copy. */
const resolveStreamer = (path: string) => path.trim() || join(app.getPath("appData"), "BBStream", "StreamerV2", "StreamerV2.exe");

function ensureStreamer(configured: string): Promise<boolean> {
    const path = resolveStreamer(configured);
    if (streamer && streamerPath === path && streamerReady) return streamerReady;
    streamer?.kill();
    if (!path || !existsSync(path)) {
        streamerState = { ...streamerState, phase: "error", error: "StreamerV2 isn't installed. Run the BBStream installer again, or set its path in the BBStream settings." };
        return Promise.resolve(false);
    }

    const proc = streamer = spawn(path, ["--serve"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, cwd: dirname(path) });
    streamerPath = path;
    createInterface({ input: proc.stdout! }).on("line", line => {
        try { onStreamerMessage(JSON.parse(line)); } catch { }
    });
    log(`spawned ${path} pid=${proc.pid}`);
    createInterface({ input: proc.stderr! }).on("line", line => log(`[streamer stderr] ${line}`));
    proc.on("exit", code => {
        log(`streamer exited code=${code}`);
        if (streamer !== proc) return;
        streamer = null;
        streamerReady = null;
        if (streamerState.phase === "live" || streamerState.phase === "starting")
            streamerState = { ...streamerState, phase: "error", error: "StreamerV2 exited unexpectedly." };
        else if (streamerState.phase !== "error")
            streamerState = { ...streamerState, phase: "off" };
    });
    proc.on("error", e => { streamerState = { ...streamerState, phase: "error", error: e.message }; });

    streamerReady = waitStreamer(m => m.event === "ready", 15000).then(m => {
        if (m && streamerState.phase !== "live" && streamerState.phase !== "starting")
            streamerState = { ...streamerState, phase: "idle", error: null };
        if (!m && streamer === proc) { proc.kill(); streamer = null; streamerReady = null; }
        return !!m;
    });
    return streamerReady;
}

function sendStreamer(cmd: object) {
    log(`-> ${JSON.stringify(cmd).replace(/"streamKey":"[^"]*"/, '"streamKey":"…"')}`);
    streamer?.stdin?.write(JSON.stringify(cmd) + "\n");
}

/** Starts StreamerV2 in the background so going live is instant later. */
export async function prewarm(_: IpcMainInvokeEvent, path: string) {
    await ensureStreamer(path);
}

export async function streamerStatus(_: IpcMainInvokeEvent, path: string) {
    if (!await ensureStreamer(path)) return null;
    const reply = waitStreamer(m => m.event === "status", 5000);
    sendStreamer({ cmd: "status" });
    return reply as Promise<{ hasKey: boolean; streamKey: string; endpoint: string; width: number; height: number; fps: number; kbps: number; } | null>;
}

/** True while goLive is switching streams, so the old stream ending doesn't read as "stopped". */
let switching = false;

export interface StreamLink { server: string; streamKey: string; }
/** Where the current stream goes, so the UI can pick it back up after a reload. */
let liveLink: StreamLink | null = null;

export function streamState(): StreamerState & { link: StreamLink | null; } {
    return { ...streamerState, phase: switching ? "starting" : streamerState.phase, link: liveLink };
}

export interface CaptureSource {
    id: string;
    name: string;
    kind: "window" | "screen";
    thumbnail: string;
    icon: string | null;
}

/** Windows and screens with thumbnails, like Discord's own picker. Discord's and our player windows are left out. */
export async function getSources(_: IpcMainInvokeEvent, thumbWidth: number): Promise<CaptureSource[]> {
    const own = new Set(BrowserWindow.getAllWindows().map(w => w.getMediaSourceId()));
    const sources = await desktopCapturer.getSources({
        types: ["window", "screen"],
        thumbnailSize: { width: thumbWidth, height: Math.round(thumbWidth * 9 / 16) },
        fetchWindowIcons: true
    });
    return sources
        .filter(s => !own.has(s.id) && !(s.id.startsWith("window:") && s.thumbnail.isEmpty()))
        .map(s => ({
            id: s.id.startsWith("screen:") ? `screen:${s.display_id}` : s.id,
            name: s.name,
            kind: s.id.startsWith("screen:") ? "screen" as const : "window" as const,
            thumbnail: "data:image/jpeg;base64," + s.thumbnail.toJPEG(72).toString("base64"),
            icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null
        }));
}

/** StreamerV2 numbers monitors like Windows does; Electron uses display ids. Match them by on-screen position. */
async function monitorIndexFor(displayId: string) {
    const reply = waitStreamer(m => m.event === "monitors", 5000);
    sendStreamer({ cmd: "monitors" });
    const monitors: { index: number; x: number; y: number; }[] = (await reply)?.monitors ?? [];
    const byPos = (a: { x: number; y: number; }, b: { x: number; y: number; }) => a.x - b.x || a.y - b.y;
    const displays = [...screen.getAllDisplays()].sort((a, b) => byPos(a.bounds, b.bounds));
    const i = displays.findIndex(d => String(d.id) === displayId);
    return [...monitors].sort(byPos)[i]?.index ?? 0;
}

export async function goLive(_: IpcMainInvokeEvent, path: string, sourceId: string, quality: { width: number; height: number; fps: number; kbps: number; }, link: StreamLink) {
    log(`goLive ${sourceId} ${JSON.stringify(quality)} to ${link.server} (phase ${streamerState.phase})`);
    if (!await ensureStreamer(path)) return { ok: false, error: streamerState.error };
    switching = true;
    try {
        const result = await startStream(sourceId, quality, link);
        liveLink = result.ok ? link : null;
        log(`goLive -> ${JSON.stringify(result)}`);
        return result;
    } finally {
        switching = false;
    }
}

async function startStream(sourceId: string, quality: { width: number; height: number; fps: number; kbps: number; }, link: StreamLink) {
    // StreamerV2 stops the old stream before starting a new one, and that stop emits "ended".
    // Finish it first so the reply below belongs to the new stream.
    if (streamerState.phase === "live" || streamerState.phase === "starting") {
        const ended = waitStreamer(m => m.event === "ended", 12000);
        sendStreamer({ cmd: "stop" });
        await ended;
    }

    const target = sourceId.startsWith("screen:")
        ? { monitorIndex: await monitorIndexFor(sourceId.slice("screen:".length)) }
        : { hwnd: "0x" + Number(sourceId.split(":")[1]).toString(16) };

    const result = waitStreamer(m => m.event === "live" || m.event === "ended", 25000);
    // Leave this Discord (voice, viewer, pop-outs) out of a screen capture's sound, or it feeds back.
    sendStreamer({ cmd: "start", ...target, ...quality, excludePid: process.pid, endpoint: `${link.server}/api/whip`, streamKey: link.streamKey });
    const m = await result;
    if (!m) return { ok: false, error: "StreamerV2 didn't start in time." };
    return m.event === "live" ? { ok: true, error: null } : { ok: false, error: m.error ?? "The stream ended." };
}

export async function stopLive() {
    if (!streamer) return;
    const ended = waitStreamer(m => m.event === "ended", 12000);
    sendStreamer({ cmd: "stop" });
    await ended;
    streamerState = { ...streamerState, phase: "idle", error: null };
}

// --- persisted window prefs -----------------------------------------------

interface Prefs { volume: number; opacity: number; bounds?: Rectangle; }

const prefsPath = () => join(app.getPath("userData"), "bbstream.json");
let prefs: Prefs | null = null;

function getPrefs(): Prefs {
    if (prefs) return prefs;
    try { prefs = { volume: 1, opacity: 1, ...JSON.parse(readFileSync(prefsPath(), "utf8")) }; } catch { prefs = { volume: 1, opacity: 1 }; }
    return prefs!;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function savePrefs() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try { writeFileSync(prefsPath(), JSON.stringify(getPrefs())); } catch { }
    }, 500);
}

let preloadPath: string | null = null;
function getPreload() {
    if (!preloadPath) {
        preloadPath = join(app.getPath("userData"), "bbstream-preload.js");
        writeFileSync(preloadPath, PRELOAD);
    }
    return preloadPath;
}

// --- pop-out windows --------------------------------------------------------
// Frameless, 16:9, always on top (works over borderless games). Pinned = click-through and unfocusable,
// toggled per window or for all of them with the global hotkey. One window per stream.

interface Popout { win: BrowserWindow; pinned: boolean; hover: boolean; restore: Rectangle | null; }
const popouts = new Map<string, Popout>();
let hotkey: string | null = null;
let hoverTimer: ReturnType<typeof setInterval> | undefined;

function send(p: Popout, cmd: string, arg: unknown) {
    if (!p.win.isDestroyed()) p.win.webContents.send("bbstream-player", cmd, arg);
}

function setPinned(p: Popout, on: boolean) {
    p.pinned = on;
    p.win.setIgnoreMouseEvents(on);
    p.win.setFocusable(!on);
    if (on) p.win.blur();
    send(p, "pinned", on);
}

/** Fills the work area of the screen it's on (not fullscreen), or goes back to its previous size. */
function toggleMaximize(p: Popout) {
    if (p.restore) {
        p.win.setBounds(p.restore);
        p.win.setAspectRatio(16 / 9);
        p.restore = null;
    } else {
        p.restore = p.win.getBounds();
        p.win.setAspectRatio(0);
        p.win.setBounds(screen.getDisplayMatching(p.restore).workArea);
    }
    send(p, "maximized", !!p.restore);
}

/** Pins all if any is unpinned, else unpins all. */
function togglePinAll() {
    const all = [...popouts.values()];
    const pin = all.some(p => !p.pinned);
    for (const p of all) setPinned(p, pin);
}

/** Drag regions swallow mouse events, so hover is tracked from here. */
function trackHover() {
    const p = screen.getCursorScreenPoint();
    for (const po of popouts.values()) {
        if (po.win.isDestroyed()) continue;
        const b = po.win.getBounds();
        const inside = !po.pinned && p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
        if (inside !== po.hover) { po.hover = inside; send(po, "hover", inside); }
    }
}

function syncGlobals() {
    if (popouts.size && !hotkey) {
        try { if (globalShortcut.register(hotkeyAccel, togglePinAll)) hotkey = hotkeyAccel; } catch { }
    } else if (!popouts.size && hotkey) {
        globalShortcut.unregister(hotkey);
        hotkey = null;
    }
    if (popouts.size && !hoverTimer) hoverTimer = setInterval(trackHover, 80);
    else if (!popouts.size && hoverTimer) { clearInterval(hoverTimer); hoverTimer = undefined; }
}

function initialBounds(): Rectangle {
    const saved = getPrefs().bounds;
    const width = saved?.width ?? 480, height = Math.round(width * 9 / 16);
    const { workArea } = saved ? screen.getDisplayMatching(saved) : screen.getPrimaryDisplay();
    // extra windows cascade up-left from the remembered spot
    const step = popouts.size * 32;
    const x = (saved?.x ?? workArea.x + workArea.width - width - 16) - step;
    const y = (saved?.y ?? workArea.y + workArea.height - height - 16) - step;
    return {
        x: Math.min(Math.max(x, workArea.x), workArea.x + workArea.width - width),
        y: Math.min(Math.max(y, workArea.y), workArea.y + workArea.height - height),
        width,
        height
    };
}

let hotkeyAccel = "Shift+PageDown";

/** The pin-all hotkey; takes effect the next time pop-outs open. */
export function setPopoutHotkey(_: IpcMainInvokeEvent, accel: string) {
    if (accel) hotkeyAccel = accel;
}

export function popout(_: IpcMainInvokeEvent, server: string, streamKey: string, name: string, self = false) {
    server = server.replace(/\/+$/, "");
    const id = `${server} ${streamKey}`;
    const existing = popouts.get(id);
    if (existing && !existing.win.isDestroyed()) {
        if (existing.pinned) setPinned(existing, false);
        existing.win.show();
        return;
    }

    const volume = Math.min(2, getPrefs().volume), opacity = Math.max(0.3, getPrefs().opacity);
    const win = new BrowserWindow({
        ...initialBounds(),
        title: name,
        frame: false,
        show: false,
        backgroundColor: "#000000",
        alwaysOnTop: true,
        maximizable: false,
        fullscreenable: false,
        minWidth: 240,
        minHeight: 135,
        webPreferences: {
            preload: getPreload(),
            sandbox: true,
            contextIsolation: true,
            backgroundThrottling: false,
            // our own static page only: lets it POST to WHEP servers without CORS preflight issues
            webSecurity: false,
            autoplayPolicy: "no-user-gesture-required"
        }
    });
    win.setAspectRatio(16 / 9);
    win.setAlwaysOnTop(true, "screen-saver");
    win.setOpacity(opacity);

    const p: Popout = { win, pinned: false, hover: false, restore: null };
    popouts.set(id, p);
    const remember = () => { if (!win.isDestroyed() && !p.restore) { getPrefs().bounds = win.getBounds(); savePrefs(); } };
    win.on("moved", remember);
    win.on("resized", remember);
    win.once("ready-to-show", () => win.show());
    win.on("closed", () => {
        popouts.delete(id);
        syncGlobals();
    });

    win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(playerHtml({ server, streamKey, name, volume, opacity, hotkey: hotkeyAccel, self })));
    syncGlobals();
}

export function closePopouts() {
    for (const p of [...popouts.values()]) p.win.close();
}

ipcMain.on("bbstream-player", (e, cmd: string, arg: any) => {
    const p = [...popouts.values()].find(p => !p.win.isDestroyed() && p.win.webContents === e.sender);
    if (!p) return;
    switch (cmd) {
        case "close": p.win.close(); break;
        case "pin": setPinned(p, !p.pinned); break;
        case "max": toggleMaximize(p); break;
        case "volume":
            getPrefs().volume = Math.max(0, Math.min(2, Number(arg) || 0));
            savePrefs();
            break;
        case "opacity": {
            const opacity = Math.max(0.3, Math.min(1, Number(arg) || 1));
            p.win.setOpacity(opacity);
            getPrefs().opacity = opacity;
            savePrefs();
            break;
        }
    }
});
