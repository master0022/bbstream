/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// "Go Live" source picker, laid out like Discord's own screen share dialog.

import ErrorBoundary from "@components/ErrorBoundary";
import { PluginNative } from "@utils/types";
import { Modal, openModal, React, useEffect, useState } from "@webpack/common";

import type { CaptureSource, StreamLink } from "./native";

const Native = VencordNative.pluginHelpers.BBStream as PluginNative<typeof import("./native")>;

export interface Quality { width: number; height: number; fps: number; kbps: number; }

const RESOLUTIONS = [{ label: "720p", width: 1280, height: 720 }, { label: "1080p", width: 1920, height: 1080 }, { label: "1440p", width: 2560, height: 1440 }];
const FRAMERATES = [30, 60];
const BITRATE: Record<number, Record<number, number>> = { 720: { 30: 2500, 60: 4000 }, 1080: { 30: 4500, 60: 8000 }, 1440: { 30: 8000, 60: 12000 } };

interface PickerProps {
    streamerPath: string;
    link: StreamLink;
    defaults: Quality | null;
    onLive(source: CaptureSource, quality: Quality): void;
    onClose(): void;
    transitionState: any;
}

function Chips<T>({ value, options, label, onChange }: { value: T; options: { value: T; label: string; }[]; label: string; onChange(v: T): void; }) {
    return (
        <div className="vc-bbs-chips" role="radiogroup" aria-label={label}>
            {options.map(o => (
                <button key={o.label} role="radio" aria-checked={o.value === value} className={"vc-bbs-chip" + (o.value === value ? " vc-bbs-chip-on" : "")} onClick={() => onChange(o.value)}>
                    {o.label}
                </button>
            ))}
        </div>
    );
}

function Picker({ streamerPath, link, defaults, onLive, onClose, transitionState }: PickerProps) {
    const [sources, setSources] = useState<CaptureSource[] | null>(null);
    const [tab, setTab] = useState<"window" | "screen">("window");
    const [selected, setSelected] = useState<string | null>(null);
    const [height, setHeight] = useState(defaults && BITRATE[defaults.height] ? defaults.height : 1080);
    const [fps, setFps] = useState(defaults?.fps === 30 ? 30 : 60);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let alive = true;
        const load = () => Native.getSources(400).then(s => { if (alive) setSources(s); });
        load();
        // Live-ish previews, like Discord's picker.
        const timer = setInterval(load, 2500);
        return () => { alive = false; clearInterval(timer); };
    }, []);

    const shown = sources?.filter(s => s.kind === tab) ?? [];
    const chosen = sources?.find(s => s.id === selected) ?? null;

    async function goLive() {
        if (!chosen) return;
        const res = RESOLUTIONS.find(r => r.height === height)!;
        const kbps = defaults && defaults.height === height && defaults.fps === fps ? defaults.kbps : BITRATE[height][fps];
        const quality = { width: res.width, height: res.height, fps, kbps };
        setBusy(true);
        setError(null);
        const result = await Native.goLive(streamerPath, chosen.id, quality, link);
        setBusy(false);
        if (!result.ok) return setError(result.error ?? "Couldn't start the stream.");
        onLive(chosen, quality);
        onClose();
    }

    return (
        <Modal
            transitionState={transitionState}
            onClose={onClose}
            title="Go Live"
            subtitle="Streams through Broadcast Box. Only friends with BBStream see it here."
            size="lg"
            actions={[
                { text: "Cancel", variant: "secondary", onClick: onClose },
                { text: busy ? "Starting…" : "Go Live", variant: "primary", onClick: goLive, disabled: !chosen || busy, loading: busy }
            ]}
        >
            <div className="vc-bbs-picker">
                <div className="vc-bbs-tabs" role="tablist">
                    {(["window", "screen"] as const).map(t => (
                        <button key={t} role="tab" aria-selected={tab === t} className={"vc-bbs-tab" + (tab === t ? " vc-bbs-tab-on" : "")} onClick={() => setTab(t)}>
                            {t === "window" ? "Applications" : "Screens"}
                        </button>
                    ))}
                </div>

                <div className="vc-bbs-grid">
                    {sources == null
                        ? Array.from({ length: 6 }, (_, i) => <div key={i} className="vc-bbs-card vc-bbs-skeleton"><div className="vc-bbs-thumb" /><div className="vc-bbs-card-label" /></div>)
                        : shown.length === 0
                            ? <div className="vc-bbs-empty">{tab === "window" ? "No windows to share." : "No screens found."}</div>
                            : shown.map(s => (
                                <button
                                    key={s.id}
                                    className={"vc-bbs-card" + (s.id === selected ? " vc-bbs-card-on" : "")}
                                    onClick={() => setSelected(s.id)}
                                    onDoubleClick={() => { setSelected(s.id); setTimeout(goLive); }}
                                >
                                    <div className="vc-bbs-thumb"><img src={s.thumbnail} alt="" draggable={false} /></div>
                                    <div className="vc-bbs-card-label">
                                        {s.icon && <img className="vc-bbs-card-icon" src={s.icon} alt="" />}
                                        <span>{s.name}</span>
                                    </div>
                                </button>
                            ))}
                </div>

                <div className="vc-bbs-quality">
                    <div className="vc-bbs-quality-item">
                        <div className="vc-bbs-quality-label">Resolution</div>
                        <Chips label="Resolution" value={height} onChange={setHeight} options={RESOLUTIONS.map(r => ({ value: r.height, label: r.label }))} />
                    </div>
                    <div className="vc-bbs-quality-item">
                        <div className="vc-bbs-quality-label">Frame rate</div>
                        <Chips label="Frame rate" value={fps} onChange={setFps} options={FRAMERATES.map(f => ({ value: f, label: `${f} FPS` }))} />
                    </div>
                </div>

                {error && <div className="vc-bbs-error">{error}</div>}
            </div>
        </Modal>
    );
}

export function openPicker(streamerPath: string, defaults: Quality | null, link: StreamLink, onLive: PickerProps["onLive"]) {
    Native.prewarm(streamerPath);
    openModal(props => (
        <ErrorBoundary>
            <Picker {...props} streamerPath={streamerPath} link={link} defaults={defaults} onLive={onLive} />
        </ErrorBoundary>
    ));
}
