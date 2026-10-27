/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The in-Discord stream view. Like Discord's own call view it takes over the main
// content area (right of the channel list); switching to another channel shrinks it
// into a picture-in-picture tile in the corner, and clicking that brings it back.

import ErrorBoundary from "@components/ErrorBoundary";
import { PluginNative } from "@utils/types";
import { createRoot, React, SelectedChannelStore, useEffect, useRef, useState, useStateFromStores } from "@webpack/common";

const Native = VencordNative.pluginHelpers.BBStream as PluginNative<typeof import("./native")>;

export interface WatchTarget {
    userId: string;
    name: string;
    avatar: string | null;
    server: string;
    streamKey: string;
    /** My own stream: always muted, or its sound would play back into the stream. */
    self?: boolean;
}

interface ViewerState {
    target: WatchTarget;
    /** The channel that was open when the stream was opened; leaving it switches to PiP. */
    anchor: string | null;
    expanded: boolean;
}

let state: ViewerState | null = null;
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); };
const setState = (s: ViewerState | null) => { state = s; listeners.forEach(fn => fn()); };
const useViewer = () => React.useSyncExternalStore(subscribe, () => state);

let volume = 1;

export function watch(target: WatchTarget) {
    mount();
    setState({ target, anchor: SelectedChannelStore.getChannelId() ?? null, expanded: true });
}

export function closeViewer() {
    setState(null);
}

export const isWatching = (streamKey: string) => state?.target.streamKey === streamKey;

// --- layout -------------------------------------------------------------------

/** Discord's main content area. Re-queried because Discord can replace it when routes change. */
const findPage = () => document.querySelector<HTMLElement>('[class*="base_"] > [class*="content_"] > [class^="page_"]');

function usePageRect() {
    const [rect, setRect] = useState<DOMRect | null>(() => findPage()?.getBoundingClientRect() ?? null);
    useEffect(() => {
        let page: HTMLElement | null = null;
        let frame = 0;
        const update = () => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
                const r = page?.isConnected ? page.getBoundingClientRect() : null;
                setRect(prev => r && prev && r.x === prev.x && r.y === prev.y && r.width === prev.width && r.height === prev.height ? prev : r);
            });
        };
        const observer = new ResizeObserver(update);
        const attach = () => {
            const next = findPage();
            if (next === page) return;
            if (page) observer.unobserve(page);
            page = next;
            if (page) observer.observe(page);
            update();
        };
        attach();
        const poll = setInterval(attach, 400);
        addEventListener("resize", update);
        return () => { clearInterval(poll); observer.disconnect(); removeEventListener("resize", update); cancelAnimationFrame(frame); };
    }, []);
    return rect;
}

// --- WHEP connection ------------------------------------------------------------

function useWhep(target: WatchTarget, videoRef: React.RefObject<HTMLVideoElement | null>) {
    const [status, setStatus] = useState<string | null>("Connecting…");

    useEffect(() => {
        let pc: RTCPeerConnection | null = null;
        let retry: ReturnType<typeof setTimeout> | undefined;
        let disposed = false;
        const later = (ms: number) => { clearTimeout(retry); retry = setTimeout(connect, ms); };

        async function connect() {
            pc?.close();
            const p = pc = new RTCPeerConnection();
            const media = new MediaStream();
            p.addTransceiver("audio", { direction: "recvonly" });
            p.addTransceiver("video", { direction: "recvonly" });
            p.ontrack = e => {
                media.addTrack(e.track);
                if (videoRef.current && videoRef.current.srcObject !== media) videoRef.current.srcObject = media;
            };
            p.onconnectionstatechange = () => {
                if (p !== pc || disposed) return;
                if (p.connectionState === "failed") { setStatus("Reconnecting…"); later(1000); }
            };
            try {
                const offer = await p.createOffer();
                await p.setLocalDescription(offer);
                const res = await Native.whep(target.server, target.streamKey, offer.sdp!);
                if (disposed || p !== pc) return;
                if (!res.ok) {
                    p.close();
                    setStatus(`Waiting for ${target.name} to go live…`);
                    return later(3000);
                }
                await p.setRemoteDescription({ type: "answer", sdp: res.body });
            } catch {
                if (disposed || p !== pc) return;
                setStatus("Can't reach the stream server. Retrying…");
                later(4000);
            }
        }

        connect();
        return () => { disposed = true; clearTimeout(retry); pc?.close(); };
    }, [target.server, target.streamKey]);

    return [status, setStatus] as const;
}

// --- view -----------------------------------------------------------------------

const Icons = {
    close: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M17.3 18.7a1 1 0 0 0 1.4-1.4L13.42 12l5.3-5.3a1 1 0 0 0-1.42-1.4L12 10.58l-5.3-5.3a1 1 0 0 0-1.4 1.42L10.58 12l-5.3 5.3a1 1 0 1 0 1.42 1.4L12 13.42l5.3 5.3Z" /></svg>,
    full: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M4 6c0-1.1.9-2 2-2h3a1 1 0 0 0 0-2H6a4 4 0 0 0-4 4v3a1 1 0 0 0 2 0V6ZM4 18c0 1.1.9 2 2 2h3a1 1 0 1 1 0 2H6a4 4 0 0 1-4-4v-3a1 1 0 1 1 2 0v3ZM18 4a2 2 0 0 1 2 2v3a1 1 0 1 0 2 0V6a4 4 0 0 0-4-4h-3a1 1 0 1 0 0 2h3ZM20 18a2 2 0 0 1-2 2h-3a1 1 0 1 0 0 2h3a4 4 0 0 0 4-4v-3a1 1 0 1 0-2 0v3Z" /></svg>,
    popout: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M15 2a1 1 0 1 0 0 2h3.59l-6.3 6.3a1 1 0 1 0 1.42 1.4L20 5.42V9a1 1 0 1 0 2 0V3a1 1 0 0 0-1-1h-6Z" /><path d="M5 5a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1v-5a1 1 0 1 1 2 0v5a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3h5a1 1 0 1 1 0 2H5Z" /></svg>,
    expand: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M14 3a1 1 0 1 0 0 2h3.59l-4.3 4.3a1 1 0 0 0 1.42 1.4L19 6.42V10a1 1 0 1 0 2 0V4a1 1 0 0 0-1-1h-6ZM10 21a1 1 0 1 0 0-2H6.41l4.3-4.3a1 1 0 0 0-1.42-1.4L5 17.58V14a1 1 0 1 0-2 0v6a1 1 0 0 0 1 1h6Z" /></svg>,
    vol: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3a1 1 0 0 0-1-1h-.06a1 1 0 0 0-.74.32L5.92 7H3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2.92l4.28 4.68a1 1 0 0 0 .74.32H11a1 1 0 0 0 1-1V3ZM15.1 20.75c-.58.14-1.1-.33-1.1-.92v-.03c0-.5.37-.92.85-1.05a7 7 0 0 0 0-13.5A1.11 1.11 0 0 1 14 4.2v-.03c0-.6.52-1.06 1.1-.92a9 9 0 0 1 0 17.5Z" /><path d="M15.16 16.51c-.57.28-1.16-.2-1.16-.83v-.14c0-.43.28-.8.63-1.02a3 3 0 0 0 0-5.04c-.35-.23-.63-.6-.63-1.02v-.14c0-.63.59-1.1 1.16-.83a5 5 0 0 1 0 9.02Z" /></svg>,
    mute: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3a1 1 0 0 0-1-1h-.06a1 1 0 0 0-.74.32L5.92 7H3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2.92l4.28 4.68a1 1 0 0 0 .74.32H11a1 1 0 0 0 1-1V3Z" /><path d="M22.7 8.7a1 1 0 0 0-1.4-1.4L19 9.58l-2.3-2.3a1 1 0 0 0-1.4 1.42L17.58 11l-2.3 2.3a1 1 0 1 0 1.42 1.4L19 12.42l2.3 2.3a1 1 0 0 0 1.4-1.42L20.42 11l2.3-2.3Z" /></svg>
};

function IconButton({ label, onClick, children, danger }: { label: string; onClick(): void; children: React.ReactNode; danger?: boolean; }) {
    return (
        <button className={"vc-bbs-btn" + (danger ? " vc-bbs-btn-danger" : "")} aria-label={label} title={label} onClick={e => { e.stopPropagation(); onClick(); }}>
            {children}
        </button>
    );
}

function Viewer({ view }: { view: ViewerState; }) {
    const { target } = view;
    const rootRef = useRef<HTMLDivElement>(null);
    const videoRef = useRef<HTMLVideoElement>(null);
    const rect = usePageRect();
    const channelId = useStateFromStores([SelectedChannelStore], () => SelectedChannelStore.getChannelId());
    const [status, setStatus] = useWhep(target, videoRef);
    const [muted, setMuted] = useState(false);
    const [vol, setVol] = useState(volume);

    const pip = !view.expanded || (channelId ?? null) !== view.anchor;

    useEffect(() => {
        if (videoRef.current) { videoRef.current.volume = vol; videoRef.current.muted = muted || !!target.self; }
    }, [vol, muted]);

    useEffect(() => {
        if (pip) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape" && !document.fullscreenElement && !document.querySelector('[class*="layerContainer"] [role="dialog"]'))
                setState({ ...view, expanded: false });
        };
        addEventListener("keydown", onKey);
        return () => removeEventListener("keydown", onKey);
    }, [pip, view]);

    if (!rect) return null;

    const PIP_W = 400, PIP_H = 225, M = 16;
    const box = pip
        ? { left: rect.right - PIP_W - M, top: rect.bottom - PIP_H - M, width: PIP_W, height: PIP_H }
        : { left: rect.left, top: rect.top, width: rect.width, height: rect.height };

    const expand = () => setState({ ...view, anchor: SelectedChannelStore.getChannelId() ?? null, expanded: true });
    const handOff = () => {
        Native.popout(target.server, target.streamKey, target.name, !!target.self);
        closeViewer();
    };

    return (
        <div
            ref={rootRef}
            className={"vc-bbs-viewer" + (pip ? " vc-bbs-pip" : "")}
            style={box}
            onClick={pip ? expand : undefined}
            onDoubleClick={pip ? undefined : () => document.fullscreenElement ? document.exitFullscreen() : rootRef.current?.requestFullscreen()}
        >
            <video
                ref={videoRef}
                autoPlay
                playsInline
                onPlaying={() => setStatus(null)}
            />

            {status && (
                <div className="vc-bbs-status">
                    {target.avatar && <img className="vc-bbs-status-avatar" src={target.avatar} alt="" />}
                    <div className="vc-bbs-status-row"><span className="vc-bbs-spinner" />{status}</div>
                </div>
            )}

            <div className="vc-bbs-top">
                <span className="vc-bbs-live">LIVE</span>
                <span className="vc-bbs-name">{target.name}</span>
                <span className="vc-bbs-spacer" />
                {pip
                    ? <>
                        <IconButton label="Expand" onClick={expand}>{Icons.expand()}</IconButton>
                        <IconButton label="Stop watching" onClick={closeViewer}>{Icons.close()}</IconButton>
                    </>
                    : <IconButton label="Minimize" onClick={() => setState({ ...view, expanded: false })}>{Icons.close()}</IconButton>}
            </div>

            {!pip && (
                <div className="vc-bbs-bottom" onClick={e => e.stopPropagation()}>
                    <div className="vc-bbs-group">
                        <IconButton label={target.self ? "Your own stream stays muted (no echo)" : muted ? "Unmute" : "Mute"} onClick={() => !target.self && setMuted(m => !m)}>{muted || vol === 0 || target.self ? Icons.mute() : Icons.vol()}</IconButton>
                        <input
                            className="vc-bbs-volume"
                            type="range" min={0} max={1} step={0.01}
                            disabled={target.self}
                            value={muted || target.self ? 0 : vol}
                            onChange={e => { volume = +e.currentTarget.value; setVol(volume); setMuted(false); }}
                        />
                    </div>
                    <div className="vc-bbs-group">
                        <IconButton label="Pop out (stays on top)" onClick={handOff}>{Icons.popout()}</IconButton>
                        <IconButton label="Fullscreen" onClick={() => document.fullscreenElement ? document.exitFullscreen() : rootRef.current?.requestFullscreen()}>{Icons.full()}</IconButton>
                    </div>
                    <button className="vc-bbs-stop" onClick={closeViewer}>Stop Watching</button>
                </div>
            )}
        </div>
    );
}

function ViewerRoot() {
    const view = useViewer();
    // Keyed by stream so switching streams starts a fresh connection while PiP <-> full keeps the same one.
    return view ? <ErrorBoundary noop><Viewer key={view.target.streamKey + view.target.server} view={view} /></ErrorBoundary> : null;
}

let host: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

function mount() {
    if (host?.isConnected) return;
    // Inside Discord's app container so its popouts, menus and modals (later siblings) stay on top.
    const parent = document.querySelector('#app-mount [class^="app_"]') ?? document.body;
    host = document.createElement("div");
    host.id = "vc-bbs-viewer-host";
    parent.appendChild(host);
    root = createRoot(host);
    root.render(<ViewerRoot />);
}

export function unmountViewer() {
    setState(null);
    root?.unmount();
    host?.remove();
    root = null;
    host = null;
}
