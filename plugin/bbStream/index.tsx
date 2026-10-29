/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// BBStream: "Go Live" through StreamerV2 + Broadcast Box instead of Discord's own streaming.
// Everyone streams to a link (see links.ts); viewers watch the links of people in voice for
// whether they're online, and play them over WHEP. No server of our own, and nothing here
// makes a Discord API request.

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { copyToClipboard } from "@utils/clipboard";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import type { Message, User } from "@vencord/discord-types";
import { findComponentByCodeLazy } from "@webpack";
import { IconUtils, Menu, Popout, React, SelectedChannelStore, SelectedGuildStore, showToast, useRef, UserStore, useStateFromStores, VoiceStateStore } from "@webpack/common";

import { openLinkModal } from "./linkModal";
import { DEFAULT_SERVER, defaultLink, linkId, linkUrl, parseLink, sameLink, StreamLink } from "./links";
import { openPicker, Quality } from "./picker";
import managedStyle from "./style.css?managed";
import { closeViewer, unmountViewer, watch, WatchTarget } from "./viewer";

const Native = VencordNative.pluginHelpers.BBStream as PluginNative<typeof import("./native")>;
const PanelButton = findComponentByCodeLazy(".GREEN,positionKeyStemOverride:");

const ONLINE_POLL_MS = 2000;
const PACKS_REFRESH_MS = 30 * 60 * 1000;
/** Status feeds kept open at once: everyone in my voice channel first, then linked people in this server's other channels. */
const MAX_WATCHED = 24;

const settings = definePluginSettings({
    streamKey: {
        type: OptionType.STRING,
        description: "Your stream key. Leave empty for your BBStream default (or your link from a pack)",
        default: ""
    },
    server: {
        type: OptionType.STRING,
        description: "Broadcast Box server you stream to. Leave empty for the default",
        default: ""
    },
    packs: {
        type: OptionType.STRING,
        description: "Link packs to load, one URL per line: shared lists of who streams where",
        default: "",
        onChange: () => refreshPacks()
    },
    savedLinks: {
        type: OptionType.COMPONENT,
        description: "",
        component: () => <SavedLinks />
    },
    streamerPath: {
        type: OptionType.STRING,
        description: "Path to StreamerV2.exe. Leave empty for the installed one (its encoder and quality settings are used)",
        default: ""
    },
    popoutHotkey: {
        type: OptionType.STRING,
        description: "Global hotkey that pins/unpins pop-outs (pinned = click-through). Electron accelerator",
        default: "Shift+PageDown",
        onChange: (v: string) => Native.setPopoutHotkey(v)
    },
    /** username -> stream link, saved from the user menu or a link in chat. */
    links: {
        type: OptionType.CUSTOM,
        default: {} as Record<string, string>
    }
});

// --- shared state ------------------------------------------------------------------

/** username -> link, from the loaded packs, and which pack each came from. */
let packLinks: Record<string, string> = {};
let packOf: Record<string, string> = {};
/** "server key" -> online, from the status feeds. */
let online: Record<string, boolean> = {};

interface MyStream extends StreamLink { channelId: string; source: string; quality: Quality; }
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

// --- links ---------------------------------------------------------------------------

/** A link saved by hand or from a pack, if this user has one. */
function explicitLink(userId: string): StreamLink | null {
    const username = UserStore.getUser(userId)?.username;
    if (!username) return null;
    const url = settings.store.links[username] ?? packLinks[username];
    return url ? parseLink(url) : null;
}

/** Where a user streams: my own settings for me, else their saved/pack link, else their BBStream default. */
function linkOf(userId: string): StreamLink {
    if (userId === me()) {
        const key = settings.store.streamKey.trim();
        const server = settings.store.server.trim().replace(/\/+$/, "");
        if (key) return { server: server || DEFAULT_SERVER, streamKey: key };
        const link = explicitLink(userId) ?? defaultLink(userId);
        return server ? { ...link, server } : link;
    }
    return explicitLink(userId) ?? defaultLink(userId);
}

function saveLink(username: string, url: string | null) {
    const links = { ...settings.store.links };
    if (url) links[username] = url;
    else delete links[username];
    settings.store.links = links;
    online = {};
    notify();
    checkOnline();
}

function isLive(userId: string) {
    if (userId === me() && mine) return true;
    return online[linkId(linkOf(userId))] === true;
}

interface Stream extends StreamLink { userId: string; }

const streamFor = (userId: string): Stream | null => isLive(userId) ? { userId, ...(userId === me() && mine ? mine : linkOf(userId)) } : null;

/** Streams watchable from a voice channel: the people in it who are live. */
const streamsIn = (channelId: string | null | undefined) =>
    usersInVoice(channelId).map(streamFor).filter((s): s is Stream => s != null);

function watchStream(s: Stream) {
    watch({ userId: s.userId, name: displayName(s.userId), avatar: avatarOf(s.userId), server: s.server, streamKey: s.streamKey, self: s.userId === me() } satisfies WatchTarget);
}

// --- packs ---------------------------------------------------------------------------

const packUrls = () => [...new Set([...settings.store.packs.split(/\s+/), ...installerUrls].filter(u => /^https?:\/\//.test(u)))];
let installerUrls: string[] = [];

async function refreshPacks() {
    installerUrls = await Native.installerPacks();
    const packs = await Native.loadPacks(packUrls());
    const links: Record<string, string> = {}, from: Record<string, string> = {};
    for (const pack of Object.values(packs))
        for (const [who, url] of Object.entries(pack.links))
            if (!(who in links)) { links[who] = url; from[who] = `the ${pack.name} pack`; }
    packLinks = links;
    packOf = from;
    notify();
}

// --- LIVE badges on voice channel rows -----------------------------------------------

let badgeStyle: HTMLStyleElement | null = null;

/** Voice rows carry data-bbstream-uid (see patches); generated rules put a LIVE pill on the right ones. */
function updateBadges() {
    if (!badgeStyle?.isConnected) badgeStyle = document.head.appendChild(document.createElement("style"));
    const ids = new Set(watched);
    const myId = me();
    if (myId && mine) ids.add(myId);
    const sel = [...ids].filter(id => /^\d+$/.test(id) && isLive(id)).map(id => `[data-bbstream-uid="${id}"]::after`);
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

// --- who's online --------------------------------------------------------------------

/** User ids whose links have a status feed open right now. */
let watched: string[] = [];

/**
 * Everyone in my voice channel (they may have BBStream with its default link), then people in
 * this server's other voice channels who have a link: their badges show without joining.
 */
function watchList() {
    const myId = me();
    const vc = SelectedChannelStore.getVoiceChannelId();
    const guildId = SelectedGuildStore.getGuildId();
    const ids = usersInVoice(vc);
    const elsewhere = guildId ? Object.keys(VoiceStateStore.getVoiceStates(guildId) ?? {}) : [];
    for (const id of elsewhere) if (!ids.includes(id) && explicitLink(id)) ids.push(id);
    return ids.filter(id => !(id === myId && mine)).slice(0, MAX_WATCHED);
}

async function checkOnline() {
    watched = watchList();
    const next = await Native.watchOnline([...new Set(watched.map(id => linkId(linkOf(id))))]);
    if (JSON.stringify(next) !== JSON.stringify(online)) { online = next; notify(); }
}

// --- my stream -----------------------------------------------------------------------

let starting = false;

async function startGoLive() {
    const vc = SelectedChannelStore.getVoiceChannelId();
    const myId = me();
    if (!vc || !myId) return showToast({ text: "Join a voice channel to go live", variant: "critical" });
    if (starting) return;
    starting = true;
    const { streamerPath } = settings.store;
    const status = await Native.streamerStatus(streamerPath);
    starting = false;
    if (!status) {
        const s = await Native.streamState();
        return showToast({ text: s.error ?? "StreamerV2 didn't respond. Check its path in the BBStream settings.", variant: "critical" });
    }
    const link: StreamLink = mine ? { server: mine.server, streamKey: mine.streamKey } : linkOf(myId);

    openPicker(streamerPath, { width: status.width, height: status.height, fps: status.fps, kbps: status.kbps }, link, (source, quality) => {
        const channelId = SelectedChannelStore.getVoiceChannelId();
        if (!channelId) { Native.stopLive(); return; }
        mine = { ...link, channelId, source: source.name, quality };
        Native.logLine(`live in ${channelId} from ${source.name}`);
        notify();
    });
}

async function stopGoLive(reason?: string) {
    if (!mine) return;
    Native.logLine(`stopGoLive: ${reason ?? "by user"}`);
    mine = null;
    notify();
    await Native.stopLive();
    if (reason) showToast({ text: reason });
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
    notify();
}

/** Notices when StreamerV2 stops on its own (window closed, network gave up) or I leave voice. */
async function watchMine() {
    if (!mine) return resumeMine();
    const vc = SelectedChannelStore.getVoiceChannelId();
    if (vc !== mine.channelId) {
        if (vc) { mine.channelId = vc; notify(); }
        else return stopGoLive("Stream ended: you left the voice channel");
    }
    const s = await Native.streamState();
    if (mine && s.phase !== "live" && s.phase !== "starting")
        stopGoLive(s.error ? `Stream ended: ${s.error}` : "Stream ended");
}

function copyMyLink() {
    const myId = me();
    if (!myId) return;
    copyToClipboard(linkUrl(mine ?? linkOf(myId)));
    showToast({ text: "Stream link copied. Friends without BBStream can open it in a browser." });
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
                    <Menu.MenuItem id="vc-bbs-preview" label="Preview my stream" action={() => watchStream({ userId: me()!, server: mine!.server, streamKey: mine!.streamKey })} />
                    <Menu.MenuItem id="vc-bbs-stop" label="Stop streaming" color="danger" action={() => stopGoLive()} />
                </Menu.MenuGroup>
                : <Menu.MenuItem id="vc-bbs-golive" label="Go Live…" disabled={!vc} action={() => startGoLive()} />}
            {others.length > 0 && (
                <Menu.MenuGroup label="Live in this channel">
                    {others.map(s => (
                        <Menu.MenuItem key={s.userId} id={`vc-bbs-w-${s.userId}`} label={displayName(s.userId)} action={() => watchStream(s)} />
                    ))}
                </Menu.MenuGroup>
            )}
            <Menu.MenuGroup>
                <Menu.MenuItem id="vc-bbs-copy" label="Copy my stream link" action={copyMyLink} />
                <Menu.MenuItem id="vc-bbs-pop-close" label="Close pop-outs" action={() => Native.closePopouts()} />
            </Menu.MenuGroup>
        </Menu.Menu>
    );
}

function BBStreamButton(props: { nameplate?: any; }) {
    useVersion();
    const buttonRef = useRef<HTMLButtonElement | null>(null);
    const vc = useStateFromStores([SelectedChannelStore], () => SelectedChannelStore.getVoiceChannelId() ?? null);
    // Re-render when people join/leave so their streams show up in the menu.
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

// --- user menu: set someone's link, watch them --------------------------------------------

function editLink(user: User) {
    const saved = settings.store.links[user.username];
    openLinkModal({
        name: user.globalName ?? user.username,
        current: saved ?? packLinks[user.username] ?? "",
        source: saved ? null : packOf[user.username] ?? null,
        onSave: url => saveLink(user.username, url)
    });
}

const userContextPatch: NavContextMenuPatchCallback = (children, { user }: { user?: User; }) => {
    if (!user || user.bot) return;
    const stream = streamFor(user.id);
    children.push(
        <Menu.MenuGroup>
            {stream && <Menu.MenuItem id="vc-bbs-u-watch" label="Watch stream" action={() => watchStream(stream)} />}
            {user.id === me()
                ? <Menu.MenuItem id="vc-bbs-u-copy" label="Copy my stream link" action={copyMyLink} />
                : <Menu.MenuItem id="vc-bbs-u-link" label="Set stream link…" action={() => editLink(user)} />}
        </Menu.MenuGroup>
    );
};

// --- a stream link posted in chat: offer to save it as the author's -------------------------

const URL_RE = /https?:\/\/[^\s<>()]+/g;

/** Hosts known to be Broadcast Box servers: the default one and any used by a link we have. */
function knownServers() {
    const servers = new Set([DEFAULT_SERVER]);
    for (const url of [...Object.values(settings.store.links), ...Object.values(packLinks)]) {
        const link = parseLink(url);
        if (link) servers.add(link.server);
    }
    return servers;
}

function LinkOffer({ message }: { message: Message; }) {
    useVersion();
    const { author } = message;
    if (!author || author.id === me() || author.bot) return null;
    const servers = knownServers();
    const link = (message.content.match(URL_RE) ?? []).map(parseLink).find(l => l && servers.has(l.server));
    if (!link || sameLink(link, explicitLink(author.id))) return null;
    const name = author.globalName ?? author.username;
    return (
        <div className="vc-bbs-offer">
            <span>Is this where {name} streams?</span>
            <button className="vc-bbs-offer-btn" onClick={() => { saveLink(author.username, linkUrl(link)); showToast({ text: `Saved. You'll see when ${name} is live.` }); }}>
                Save as {name}'s stream
            </button>
        </div>
    );
}

const LinkOfferSafe = ErrorBoundary.wrap(LinkOffer, { noop: true });

// --- settings: saved links ---------------------------------------------------------------

function SavedLinks() {
    useVersion();
    const links = Object.entries(settings.store.links);
    const packs = Object.keys(packLinks).length;
    return (
        <div className="vc-bbs-saved">
            <div className="vc-bbs-saved-title">Saved stream links</div>
            {links.length === 0
                ? <div className="vc-bbs-hint">None yet. Right click someone → Set stream link, or click "Save" on a stream link they post in chat.</div>
                : links.map(([who, url]) => (
                    <div key={who} className="vc-bbs-saved-row">
                        <span className="vc-bbs-saved-who">{who}</span>
                        <span className="vc-bbs-saved-url">{url}</span>
                        <button className="vc-bbs-offer-btn" onClick={() => saveLink(who, null)}>Remove</button>
                    </div>
                ))}
            {packs > 0 && <div className="vc-bbs-hint">Plus {packs} from packs.</div>}
        </div>
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
                replace: '$&,"data-bbstream-uid":$1?.id,'
            }
        }
    ],

    contextMenus: {
        "user-context": userContextPatch
    },

    BBStreamButton: ErrorBoundary.wrap(BBStreamButton, { noop: true }),

    renderMessageAccessory: props => <LinkOfferSafe message={props.message} />,

    start() {
        Native.setPopoutHotkey(settings.store.popoutHotkey);
        timers.push(
            setInterval(watchMine, 1500),
            setInterval(checkOnline, ONLINE_POLL_MS),
            setInterval(refreshPacks, PACKS_REFRESH_MS)
        );
        document.addEventListener("click", onBadgeClick, true);
        refreshPacks();
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
        online = {};
        badgeStyle?.remove();
        badgeStyle = null;
    }
});
