/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// BBStream: "Go Live" through StreamerV2 + Broadcast Box instead of Discord's own streaming.
// Going live announces the stream to our presence server (UDP); watching pulls WHEP from
// Broadcast Box. Nothing here makes a Discord API request.

import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { findComponentByCodeLazy } from "@webpack";
import { IconUtils, Menu, Popout, React, SelectedChannelStore, showToast, useRef, UserStore, useStateFromStores, VoiceStateStore } from "@webpack/common";

import { openPicker, Quality } from "./picker";
import managedStyle from "./style.css?managed";
import { closeViewer, unmountViewer, watch, WatchTarget } from "./viewer";

const Native = VencordNative.pluginHelpers.BBStream as PluginNative<typeof import("./native")>;
const PanelButton = findComponentByCodeLazy(".GREEN,positionKeyStemOverride:");

const POLL_MS = 3000;
const HEARTBEAT_MS = 3000;
const LINKS_POLL_MS = 5000;
const LINKS_IDLE_POLL_MS = 30000;
const NEARBY_POLL_MS = 2000;
/** Where new users get a stream, and where older clients that don't say their server stream to. */
const DEFAULT_SERVER = "https://b.siobud.com";

const settings = definePluginSettings({
    streamKey: {
        type: OptionType.STRING,
        description: "Your stream key. Leave empty to use the one linked to your Discord username (one is created on your first Go Live)",
        default: ""
    },
    server: {
        type: OptionType.STRING,
        description: "Broadcast Box server you stream to. Leave empty for the linked one",
        default: ""
    },
    streamerPath: {
        type: OptionType.STRING,
        description: "Path to StreamerV2.exe. Leave empty for the installed one (its encoder and quality settings are used)",
        default: ""
    },
    presenceHost: {
        type: OptionType.STRING,
        description: "Presence server host (UDP)",
        default: "191.252.200.60"
    },
    presencePort: {
        type: OptionType.NUMBER,
        description: "Presence server port (UDP)",
        default: 8200
    },
    popoutHotkey: {
        type: OptionType.STRING,
        description: "Global hotkey that pins/unpins pop-outs (pinned = click-through). Electron accelerator",
        default: "Shift+PageDown",
        onChange: (v: string) => Native.setPopoutHotkey(v)
    }
});

// --- shared state ------------------------------------------------------------------

type LiveMap = Record<string, [channelId: string, streamKey: string, serverHost?: string]>;
type LinkMap = Record<string, [server: string, streamKey: string, live: boolean]>;

/** Plugin users currently live (from the presence server). */
let live: LiveMap = {};
/** Friends without the plugin, linked by Discord username on the VPS to their own Broadcast Box clone. The VPS checks if they're online. */
let links: LinkMap = {};
/** My own, faster checks of linked friends in my voice channel, keyed by "server key". Wins over the VPS's answer. */
let nearby: Record<string, boolean> = {};

const isLinkLive = (link: LinkMap[string]) => nearby[`${link[0]} ${link[1]}`] ?? link[2];

interface MyStream { server: string; streamKey: string; channelId: string; source: string; quality: Quality; }
let mine: MyStream | null = null;

let version = 0;
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); };
const notify = () => { version++; listeners.forEach(fn => fn()); updateBadges(); };
const useVersion = () => React.useSyncExternalStore(subscribe, () => version);

const me = () => UserStore.getCurrentUser()?.id;

function displayName(userId: string) {
    const u = UserStore.getUser(userId);
    return u ? (u.globalName ?? u.username) : "Someone";
}

function avatarOf(userId: string) {
    const u = UserStore.getUser(userId);
    try { return u ? IconUtils.getUserAvatarURL(u, false, 128) : null; } catch { return null; }
}

function usersInVoice(channelId: string | null | undefined) {
    return channelId ? Object.keys(VoiceStateStore.getVoiceStatesForChannel(channelId) ?? {}) : [];
}

/** A linked friend's stream, only while it's actually online. */
function rawLinkFor(userId: string) {
    return links[UserStore.getUser(userId)?.username ?? ""] ?? links[userId];
}

function linkFor(userId: string) {
    const link = rawLinkFor(userId);
    return link && isLinkLive(link) ? link : null;
}

interface Stream { userId: string; server: string; streamKey: string; linked: boolean; }

const serverOf = ([, , host]: LiveMap[string]) => host ? `https://${host}` : DEFAULT_SERVER;

/** Streams watchable from a voice channel: plugin users live there plus linked friends present in it. */
function streamsIn(channelId: string | null | undefined): Stream[] {
    if (!channelId) return [];
    const streams: Stream[] = Object.entries(live)
        .filter(([, [ch]]) => ch === channelId)
        .map(([userId, entry]) => ({ userId, server: serverOf(entry), streamKey: entry[1], linked: false }));
    for (const userId of usersInVoice(channelId)) {
        const link = linkFor(userId);
        if (link && !live[userId]) streams.push({ userId, server: link[0], streamKey: link[1], linked: true });
    }
    return streams;
}

function streamFor(userId: string): Stream | null {
    if (live[userId]) return { userId, server: serverOf(live[userId]), streamKey: live[userId][1], linked: false };
    const link = linkFor(userId);
    if (link) return { userId, server: link[0], streamKey: link[1], linked: true };
    return null;
}

function watchStream(s: Stream) {
    watch({ userId: s.userId, name: displayName(s.userId), avatar: avatarOf(s.userId), server: s.server, streamKey: s.streamKey, self: s.userId === me() } satisfies WatchTarget);
}

// --- LIVE badges on voice channel rows -----------------------------------------------

let badgeStyle: HTMLStyleElement | null = null;

/** Voice rows carry data-bbstream-uid/-name (see patches); generated rules put a LIVE pill on the right ones. */
function updateBadges() {
    if (!badgeStyle?.isConnected) badgeStyle = document.head.appendChild(document.createElement("style"));
    const liveIds = Object.keys(live).filter(id => /^\d+$/.test(id));
    const linkedNames = Object.keys(links).filter(name => isLinkLive(links[name]) && /^[a-z0-9_.]+$/.test(name));
    const sel = [
        ...liveIds.map(id => `[data-bbstream-uid="${id}"]::after`),
        ...linkedNames.map(name => `[data-bbstream-name="${name}"]::after`)
    ];
    badgeStyle.textContent = sel.length ? `${sel.join(",")}{content:"LIVE"}` : "";
}

/** Clicking the LIVE pill (not the name) opens the stream, like Discord's own badge. */
function onBadgeClick(e: MouseEvent) {
    const el = (e.target as Element | null)?.closest?.("[data-bbstream-uid]") as HTMLElement | null;
    const uid = el?.dataset.bbstreamUid;
    if (!el || !uid) return;
    const stream = streamFor(uid);
    if (!stream) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    if (e.clientX <= range.getBoundingClientRect().right + 2) return;
    e.preventDefault();
    e.stopPropagation();
    watchStream(stream);
}

// --- presence ------------------------------------------------------------------------

async function poll() {
    const { presenceHost, presencePort } = settings.store;
    if (!SelectedChannelStore.getVoiceChannelId()) {
        if (Object.keys(live).length) { live = {}; notify(); }
        return;
    }
    const res = await Native.query(presenceHost, presencePort, "Q") as LiveMap | null;
    if (res && JSON.stringify(res) !== JSON.stringify(live)) { live = res; notify(); }
}

let linksPolledAt = 0;

/** Often while in voice (that's where badges matter), rarely otherwise. */
async function pollLinks() {
    if (!SelectedChannelStore.getVoiceChannelId() && Date.now() - linksPolledAt < LINKS_IDLE_POLL_MS) return;
    linksPolledAt = Date.now();
    const res = await Native.query(settings.store.presenceHost, settings.store.presencePort, "K") as LinkMap | null;
    if (res && JSON.stringify(res) !== JSON.stringify(links)) { links = res; notify(); }
}

/** Watches linked friends in my voice channel directly, so their LIVE badge shows up within a few seconds. */
async function checkNearby() {
    const vc = SelectedChannelStore.getVoiceChannelId();
    const targets = vc
        ? [...new Set(usersInVoice(vc).filter(id => id !== me() || !mine).map(rawLinkFor).filter(Boolean).map(l => `${l[0]} ${l[1]}`))]
        : [];
    const next = await Native.watchOnline(targets);
    if (JSON.stringify(next) !== JSON.stringify(nearby)) { nearby = next; notify(); }
}

function heartbeat() {
    if (!mine) return;
    const { presenceHost, presencePort } = settings.store;
    Native.heartbeat(presenceHost, presencePort, me(), mine.channelId, mine.streamKey, mine.server);
}

const trimServer = (url: string) => url.trim().replace(/\/+$/, "");

/**
 * Where I stream: the settings if filled in, else the link for my username on the presence server.
 * The first time, a fresh key on the default server is claimed for me, so nothing needs setting up.
 */
async function myLink(): Promise<{ server: string; streamKey: string; } | null> {
    const { presenceHost, presencePort } = settings.store;
    const server = trimServer(settings.store.server);
    const streamKey = settings.store.streamKey.trim();
    if (streamKey) return { server: server || DEFAULT_SERVER, streamKey };

    const username = UserStore.getCurrentUser()?.username;
    if (!username) return null;
    const lookup = async () => {
        const res = await Native.query(presenceHost, presencePort, "K") as LinkMap | null;
        if (res) { links = res; notify(); }
        return res?.[username];
    };
    let link = await lookup();
    if (!link) {
        const rand = Array.from(crypto.getRandomValues(new Uint8Array(6)), b => (b % 36).toString(36)).join("");
        const key = `bbs-${username.replace(/[^a-z0-9_]/g, "-")}-${rand}`;
        const reply = await Native.register(presenceHost, presencePort, username, DEFAULT_SERVER, key);
        if (reply === "ok") {
            Native.logLine(`claimed a stream key for ${username}`);
            return { server: server || DEFAULT_SERVER, streamKey: key };
        }
        if (reply === "taken") link = await lookup();
    }
    return link ? { server: server || link[0], streamKey: link[1] } : null;
}

// --- my stream -----------------------------------------------------------------------

let starting = false;

async function startGoLive() {
    const vc = SelectedChannelStore.getVoiceChannelId();
    if (!vc) return showToast({ text: "Join a voice channel to go live", variant: "critical" });
    if (starting) return;
    starting = true;
    const { streamerPath } = settings.store;
    const [status, link] = await Promise.all([Native.streamerStatus(streamerPath), mine ? { server: mine.server, streamKey: mine.streamKey } : myLink()]);
    starting = false;
    if (!status) {
        const s = await Native.streamState();
        return showToast({ text: s.error ?? "StreamerV2 didn't respond. Check its path in the BBStream settings.", variant: "critical" });
    }
    if (!link) return showToast({ text: "Couldn't reach the BBStream server to find your stream. Try again in a moment.", variant: "critical" });

    openPicker(streamerPath, { width: status.width, height: status.height, fps: status.fps, kbps: status.kbps }, link, (source, quality) => {
        const channelId = SelectedChannelStore.getVoiceChannelId();
        if (!channelId) { Native.stopLive(); return; }
        mine = { ...link, channelId, source: source.name, quality };
        Native.logLine(`live in ${channelId} from ${source.name}`);
        heartbeat();
        notify();
        setTimeout(poll, 300);
    });
}

async function stopGoLive(reason?: string) {
    if (!mine) return;
    Native.logLine(`stopGoLive: ${reason ?? "by user"}`);
    mine = null;
    const { presenceHost, presencePort } = settings.store;
    Native.stop(presenceHost, presencePort, me());
    notify();
    await Native.stopLive();
    if (reason) showToast({ text: reason });
    setTimeout(poll, 300);
}

/** After a Ctrl+R StreamerV2 is still streaming in the main process; pick it back up. */
let resumeUntil = 0;

async function resumeMine() {
    if (mine || Date.now() > resumeUntil) return;
    const s = await Native.streamState();
    if (s.phase !== "live") return;
    const channelId = SelectedChannelStore.getVoiceChannelId();
    // Voice may still be reconnecting after the reload; give up (and stop streaming) after a while.
    if (!channelId) {
        if (Date.now() > resumeUntil - 1500) Native.stopLive();
        return;
    }
    if (!s.link || mine) return;
    mine = { ...s.link, channelId, source: s.source ?? "your screen", quality: { width: s.width, height: s.height, fps: s.fps, kbps: s.kbps } };
    Native.logLine(`resumed stream after reload in ${channelId}`);
    heartbeat();
    notify();
}

/** Notices when StreamerV2 stops on its own (window closed, network gave up) or I leave voice. */
async function watchMine() {
    if (!mine) return resumeMine();
    const vc = SelectedChannelStore.getVoiceChannelId();
    if (vc !== mine.channelId) {
        if (vc) { mine.channelId = vc; heartbeat(); notify(); }
        else return stopGoLive("Stream ended: you left the voice channel");
    }
    const s = await Native.streamState();
    if (mine && s.phase !== "live" && s.phase !== "starting")
        stopGoLive(s.error ? `Stream ended: ${s.error}` : "Stream ended");
}

// --- account panel button ------------------------------------------------------------------

function GoLiveIcon({ live: on }: { live: boolean; }) {
    return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M4 3a3 3 0 0 0-3 3v9a3 3 0 0 0 3 3h7v2H8a1 1 0 1 0 0 2h8a1 1 0 1 0 0-2h-3v-2h7a3 3 0 0 0 3-3V6a3 3 0 0 0-3-3H4Z" />
            {on
                ? <rect x="7" y="7.5" width="10" height="6" rx="1.5" fill="var(--background-base-low, #000)" />
                : <path d="M12 6.5 8.5 10h2.5v3.5h2V10h2.5L12 6.5Z" fill="var(--background-base-low, #000)" />}
        </svg>
    );
}

function StreamMenu({ closePopout, vc }: { closePopout(): void; vc: string | null; }) {
    const others = streamsIn(vc).filter(s => s.userId !== me());
    return (
        <Menu.Menu navId="vc-bbstream-menu" onClose={closePopout}>
            {mine
                ? <Menu.MenuGroup label={`Streaming ${mine.source}`}>
                    <Menu.MenuItem id="vc-bbs-change" label="Change source…" action={() => startGoLive()} />
                    <Menu.MenuItem id="vc-bbs-preview" label="Preview my stream" action={() => watchStream({ userId: me(), server: mine!.server, streamKey: mine!.streamKey, linked: false })} />
                    <Menu.MenuItem id="vc-bbs-stop" label="Stop streaming" color="danger" action={() => stopGoLive()} />
                </Menu.MenuGroup>
                : <Menu.MenuItem id="vc-bbs-golive" label="Go Live…" disabled={!vc} action={() => startGoLive()} />}
            {others.length > 0 && (
                <Menu.MenuGroup label="Live in this channel">
                    {others.map(s => (
                        <Menu.MenuItem key={s.userId} id={`vc-bbs-w-${s.userId}`} label={displayName(s.userId)} subtext={s.linked ? "Linked stream" : undefined} action={() => watchStream(s)} />
                    ))}
                </Menu.MenuGroup>
            )}
            <Menu.MenuGroup>
                <Menu.MenuItem id="vc-bbs-pop-close" label="Close pop-outs" action={() => Native.closePopouts()} />
            </Menu.MenuGroup>
        </Menu.Menu>
    );
}

function BBStreamButton(props: { nameplate?: any; }) {
    useVersion();
    const buttonRef = useRef<HTMLButtonElement | null>(null);
    const vc = useStateFromStores([SelectedChannelStore], () => SelectedChannelStore.getVoiceChannelId() ?? null);
    // Re-render when people join/leave so linked friends show up in the menu.
    useStateFromStores([VoiceStateStore], () => usersInVoice(vc).join(), [vc]);

    if (!vc && !mine) return null; // like Discord's Go Live, only offered while in voice

    return (
        <Popout
            position="top"
            align="center"
            targetElementRef={buttonRef}
            renderPopout={({ closePopout }) => <StreamMenu closePopout={closePopout} vc={vc} />}
        >
            {popoutProps => (
                <PanelButton
                    ref={buttonRef}
                    tooltipText={mine ? "You're live: click for options" : "Go Live"}
                    icon={() => <GoLiveIcon live={!!mine} />}
                    role="button"
                    redGlow={!!mine}
                    plated={props?.nameplate != null}
                    // Not live: straight to the picker, like Discord. Live, or right click: the menu.
                    onClick={mine ? popoutProps.onClick : () => startGoLive()}
                    onContextMenu={popoutProps.onClick}
                />
            )}
        </Popout>
    );
}

// --- plugin ----------------------------------------------------------------------------

const timers: ReturnType<typeof setInterval>[] = [];

export default definePlugin({
    name: "BBStream",
    description: "Go Live through StreamerV2 + Broadcast Box instead of Discord streaming; friends with BBStream watch it right inside Discord.",
    authors: [{ name: "master0022", id: 0n }],
    enabledByDefault: true,
    settings,
    managedStyle,

    patches: [
        // Go Live button next to mute/deafen (same anchor GameActivityToggle uses)
        {
            find: "#{intl::USER_PROFILE_ACCOUNT_POPOUT_BUTTON_A11Y_LABEL}",
            replacement: {
                match: /children:\[(?=.{0,25}?accountContainerRef)/,
                replace: "children:[$self.BBStreamButton(arguments[0]),"
            }
        },
        // Tag voice channel rows with the user id for the LIVE pill (same anchor RoleColorEverywhere uses)
        {
            find: "#{intl::GUEST_NAME_SUFFIX})]",
            replacement: {
                match: /#{intl::GUEST_NAME_SUFFIX}.{0,50}?""\](?<=user:(\i).+?)/,
                replace: '$&,"data-bbstream-uid":$1?.id,"data-bbstream-name":$1?.username,'
            }
        }
    ],

    BBStreamButton: ErrorBoundary.wrap(BBStreamButton, { noop: true }),

    start() {
        Native.setPopoutHotkey(settings.store.popoutHotkey);
        timers.push(
            setInterval(poll, POLL_MS),
            setInterval(heartbeat, HEARTBEAT_MS),
            setInterval(watchMine, 1500),
            setInterval(pollLinks, LINKS_POLL_MS),
            setInterval(checkNearby, NEARBY_POLL_MS)
        );
        document.addEventListener("click", onBadgeClick, true);
        poll();
        pollLinks();
        resumeUntil = Date.now() + 20000;
        updateBadges();
    },

    stop() {
        timers.splice(0).forEach(clearInterval);
        document.removeEventListener("click", onBadgeClick, true);
        stopGoLive();
        closeViewer();
        unmountViewer();
        Native.watchOnline([]);
        live = {};
        badgeStyle?.remove();
        badgeStyle = null;
    }
});
