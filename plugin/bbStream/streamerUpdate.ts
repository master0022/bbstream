/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Keeps the installed StreamerV2 on the version of the latest release, like the installer does,
// but without anyone running it again. The new copy is downloaded and unpacked beside the old
// one while everything keeps working; swapping the two folders takes a moment and waits until
// nothing is being streamed.

import { execFile } from "child_process";
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

export interface StreamerUpdateHooks {
    log(text: string): void;
    /** Resolves once nothing is streaming and StreamerV2 is closed. Nothing may start it again until the returned function is called. */
    pause(): Promise<() => void>;
}

const readVersion = (dir: string) => {
    try { return readFileSync(join(dir, "version.txt"), "utf8").trim(); } catch { return ""; }
};

/**
 * @param root where the installer put things (%APPDATA%\BBStream)
 * @param base URL of the release's files, ending in "/"
 */
export async function updateStreamer(root: string, base: string, hooks: StreamerUpdateHooks) {
    const dir = join(root, "StreamerV2"), next = join(root, "StreamerV2.new"), old = join(root, "StreamerV2.old");
    if (!existsSync(join(dir, "StreamerV2.exe"))) return;
    rmSync(old, { recursive: true, force: true });

    const res = await fetch(base + "streamer-version.txt");
    const wanted = (await res.text()).trim();
    if (!res.ok || !/^[\w.-]{1,40}$/.test(wanted) || wanted === readVersion(dir)) return;

    // version.txt is written last, so a download or unpack that was cut short starts over.
    if (readVersion(next) !== wanted) {
        hooks.log(`StreamerV2 ${wanted}: downloading`);
        rmSync(next, { recursive: true, force: true });
        mkdirSync(next, { recursive: true });
        const zip = join(root, "StreamerV2.zip.part");
        const download = await fetch(base + "StreamerV2-win-x64.zip");
        if (!download.ok || !download.body) throw new Error(`StreamerV2 download: ${download.status}`);
        await pipeline(Readable.fromWeb(download.body as any), createWriteStream(zip));
        // Windows' own tar (it reads zip); a tar from PATH might be one that doesn't.
        const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
        await new Promise<void>((resolve, reject) =>
            execFile(tar, ["-xf", zip, "-C", next], { windowsHide: true }, e => e ? reject(e) : resolve()));
        rmSync(zip, { force: true });
        if (!existsSync(join(next, "StreamerV2.exe"))) throw new Error("StreamerV2 download has no StreamerV2.exe");
        writeFileSync(join(next, "version.txt"), wanted);
    }

    const resume = await hooks.pause();
    try {
        // Saved settings and anything else that lives beside the exe come along.
        for (const entry of readdirSync(dir, { withFileTypes: true }))
            if (entry.isFile() && !existsSync(join(next, entry.name))) copyFileSync(join(dir, entry.name), join(next, entry.name));
        renameSync(dir, old);
        try { renameSync(next, dir); } catch (e) { renameSync(old, dir); throw e; }
    } finally {
        resume();
    }
    rmSync(old, { recursive: true, force: true });
    hooks.log(`StreamerV2 updated to ${wanted}`);
}
