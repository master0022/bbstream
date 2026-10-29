/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Who streams where. Everyone with BBStream has a default stream derived from their user id, so
// friends find each other with nothing set up. Anyone (with BBStream or not) can instead be given
// a link: saved by hand, or from a pack (a shared JSON list of username -> link).

export interface StreamLink { server: string; streamKey: string; }

export const DEFAULT_SERVER = "https://b.siobud.com";

/** The stream a BBStream user goes live on unless they set their own. */
export const defaultLink = (userId: string): StreamLink => ({ server: DEFAULT_SERVER, streamKey: `bbs-${userId}` });

/** "https://server/key" (what a Broadcast Box player URL looks like) -> link. */
export function parseLink(url: string): StreamLink | null {
    try {
        const u = new URL(url.trim());
        if (u.protocol !== "https:" && u.protocol !== "http:") return null;
        const parts = u.pathname.split("/").filter(Boolean);
        if (parts.length !== 1) return null;
        const streamKey = decodeURIComponent(parts[0]);
        return /^[^\s/]{1,128}$/.test(streamKey) ? { server: u.origin, streamKey } : null;
    } catch {
        return null;
    }
}

export const linkUrl = (link: StreamLink) => `${link.server}/${encodeURIComponent(link.streamKey)}`;
export const linkId = (link: StreamLink) => `${link.server} ${link.streamKey}`;
export const sameLink = (a: StreamLink | null, b: StreamLink | null) => !!a && !!b && linkId(a) === linkId(b);
