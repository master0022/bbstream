/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// "Stream link for X": paste the Broadcast Box link someone streams to.

import ErrorBoundary from "@components/ErrorBoundary";
import { Modal, openModal, React, TextInput, useState } from "@webpack/common";

import { parseLink } from "./links";

interface Props {
    name: string;
    current: string;
    /** Where the current link comes from, when it isn't saved by hand ("the Friends pack"). */
    source: string | null;
    onSave(url: string | null): void;
    onClose(): void;
    transitionState: any;
}

function LinkModal({ name, current, source, onSave, onClose, transitionState }: Props) {
    const [value, setValue] = useState(current);
    const [error, setError] = useState<string | null>(null);

    function save() {
        const url = value.trim();
        if (url && !parseLink(url)) return setError("That doesn't look like a stream link. It should look like https://b.siobud.com/their-key");
        onSave(url || null);
        onClose();
    }

    return (
        <Modal
            transitionState={transitionState}
            onClose={onClose}
            title={`Stream link for ${name}`}
            subtitle="Paste the Broadcast Box link they stream to. You'll see a LIVE badge on them in voice channels while they're streaming, even if they don't have BBStream."
            actions={[
                { text: "Cancel", variant: "secondary", onClick: onClose },
                { text: "Save", variant: "primary", onClick: save }
            ]}
        >
            <div className="vc-bbs-linkmodal">
                <TextInput
                    value={value}
                    placeholder="https://b.siobud.com/their-key"
                    onChange={(v: string) => { setValue(v); setError(null); }}
                    onKeyDown={(e: React.KeyboardEvent) => { if (e.key === "Enter") save(); }}
                    autoFocus
                />
                {error
                    ? <div className="vc-bbs-error">{error}</div>
                    : <div className="vc-bbs-hint">{source ? `Right now this comes from ${source}. Saving here overrides it.` : "Leave it empty to use their BBStream default."}</div>}
            </div>
        </Modal>
    );
}

export function openLinkModal(props: Omit<Props, "onClose" | "transitionState">) {
    openModal(modal => (
        <ErrorBoundary>
            <LinkModal {...modal} {...props} />
        </ErrorBoundary>
    ));
}
