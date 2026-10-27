/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Page shown in pop-out windows. Talks to the main process through the `bb` bridge exposed by PRELOAD.
// The whole window is a native drag region (smooth moves, no JS); the main process tells the page when
// the cursor is over it, since drag regions swallow mouse events.

export interface PlayerConfig {
    server: string;
    streamKey: string;
    name: string;
    volume: number;
    opacity: number;
    hotkey: string;
    /** My own stream: locked muted, or its sound would play back into the stream. */
    self: boolean;
}

export const PRELOAD = `
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("bb", {
    cmd: (c, a) => ipcRenderer.send("bbstream-player", c, a),
    // braces matter: returning ipcRenderer across the bridge throws
    on: f => { ipcRenderer.on("bbstream-player", (_e, c, a) => f(c, a)); }
});
`;

const svg = (body: string) => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const speaker = '<path d="M11 4.7a.7.7 0 0 0-1.2-.5L6.4 7.6A1.4 1.4 0 0 1 5.4 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.4a1.4 1.4 0 0 1 1 .4l3.4 3.4a.7.7 0 0 0 1.2-.5z"/>';
const icons = {
    pin: svg('<path d="M12 17v5"/><path d="M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2v.8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.8a2 2 0 0 0-1.1-1.8l-1.8-.9a2 2 0 0 1-1.1-1.8V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>'),
    close: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
    max: svg('<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>'),
    restore: svg('<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>'),
    vol: svg(speaker + '<path d="M16 9a5 5 0 0 1 0 6"/><path d="M19.4 18.4a9 9 0 0 0 0-12.8"/>'),
    mute: svg(speaker + '<path d="m22 9-6 6M16 9l6 6"/>'),
    opacity: svg('<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none"/>')
};

const css = `
html,body{margin:0;height:100%;overflow:hidden;background:#000;color:#fff;user-select:none;-webkit-app-region:drag;
  font:500 12px "gg sans","Noto Sans","Segoe UI",sans-serif}
video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}
.ui{position:absolute;inset:0;opacity:0;transition:opacity .12s;pointer-events:none}
body.hover:not(.pinned) .ui{opacity:1}
body.hover:not(.pinned) .ui .ctl{pointer-events:auto}
.top,.bottom{position:absolute;left:0;right:0;display:flex;align-items:center;gap:2px;padding:6px}
.top{top:0;background:linear-gradient(#000a,#0000)}
.bottom{bottom:0;align-items:flex-end;padding-top:24px;background:linear-gradient(#0000,#000c)}
.name{display:flex;align-items:center;gap:6px;min-width:0;padding-left:4px;font-weight:600;text-shadow:0 1px 2px #000}
.name span{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.dot{width:7px;height:7px;flex:none;border-radius:50%;background:#f23f43}
.sp{flex:1}
.ctl{-webkit-app-region:no-drag}
button.ctl{width:28px;height:28px;padding:0;border:0;border-radius:6px;background:none;color:#fffd;display:grid;place-items:center;cursor:pointer}
button.ctl:hover{background:#ffffff1f;color:#fff}
button.ctl.on{color:#fff;background:#ffffff2e}
.sliders{display:flex;flex-direction:column;gap:2px;width:min(46%,300px);min-width:150px}
.row{display:flex;align-items:center;gap:4px}
.row button.ctl{width:26px;height:26px;flex:none}
#opBtn{cursor:default}#opBtn:hover{background:none}
.val{width:34px;flex:none;color:#ffffffa6;font-size:10px;font-variant-numeric:tabular-nums;text-align:right}
input.ctl{flex:1;min-width:0;height:22px;margin:0;background:none;-webkit-appearance:none;cursor:pointer}
input.ctl::-webkit-slider-runnable-track{height:4px;border-radius:2px;
  background:linear-gradient(90deg,#fff var(--p,50%),#ffffff40 var(--p,50%))}
input.ctl::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;margin-top:-5px;border-radius:50%;background:#fff;
  box-shadow:0 1px 3px #0008;transition:transform .1s}
input.ctl:hover::-webkit-slider-thumb,input.ctl:active::-webkit-slider-thumb{transform:scale(1.2)}
.hint{flex:none;padding-right:4px;color:#ffffff73;font-size:10px;white-space:nowrap}
.state{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;
  color:#ffffff8c;font-size:11px;transition:opacity .2s;pointer-events:none}
.state.hide{opacity:0}
.spin{width:18px;height:18px;border-radius:50%;border:2px solid #ffffff26;border-top-color:#ffffffb3;animation:r .9s linear infinite}
@keyframes r{to{transform:rotate(360deg)}}
@media (max-width:380px){.hint{display:none}.sliders{width:auto;flex:1}}
`;

// Wrapped in a function: a top-level "bb" would collide with the bridge global and kill the script.
const script = `(() => {
const C = window.__CFG, bb = window.bb, $ = id => document.getElementById(id);
const v = $("v"), state = $("state"), stateText = $("stateText"), vol = $("vol"), op = $("op"), muteBtn = $("mute");
vol.value = C.volume; op.value = C.opacity;

// Volume goes to 200%, past what the video element can do: play through a gain node instead.
let ctx = null, gain = null, srcNode = null, muted = C.self;
if (C.self) { vol.disabled = true; muteBtn.disabled = true; muteBtn.title = "Your own stream stays muted (no echo)"; }
v.muted = true;
function applyVolume() { if (gain) gain.gain.value = muted ? 0 : +vol.value; }
function hookAudio(stream) {
    if (!stream.getAudioTracks().length) return;
    ctx ??= new AudioContext({ latencyHint: "interactive" });
    gain ??= ctx.createGain();
    srcNode?.disconnect();
    srcNode = ctx.createMediaStreamSource(stream);
    srcNode.connect(gain).connect(ctx.destination);
    applyVolume();
    if (ctx.state === "suspended") ctx.resume();
}
const fill = (el, min, max) => el.style.setProperty("--p", ((el.value - min) / (max - min) * 100) + "%");
function paint() {
    fill(vol, 0, 2); fill(op, 0.3, 1);
    $("volVal").textContent = (muted ? 0 : Math.round(vol.value * 100)) + "%";
    $("opVal").textContent = Math.round(op.value * 100) + "%";
}

const MUTE = ${JSON.stringify(icons.mute)}, VOL = ${JSON.stringify(icons.vol)};
const setMuteIcon = () => muteBtn.innerHTML = muted || +vol.value === 0 ? MUTE : VOL;
setMuteIcon();

function show(text) {
    stateText.textContent = text || "";
    state.classList.toggle("hide", !text);
}

// Broadcast Box answers WHEP for any key, live or not, so "connected" means frames arriving.
let pc = null, timer = null, gotFrame = false;
function retry(ms) { clearTimeout(timer); timer = setTimeout(connect, ms); }
async function connect() {
    clearTimeout(timer);
    pc?.close();
    gotFrame = false;
    const p = pc = new RTCPeerConnection();
    p.addTransceiver("audio", { direction: "recvonly" });
    p.addTransceiver("video", { direction: "recvonly" });
    const ms = new MediaStream();
    p.ontrack = e => {
        ms.addTrack(e.track);
        if (v.srcObject !== ms) v.srcObject = ms;
        if (e.track.kind === "audio") hookAudio(ms);
    };
    p.onconnectionstatechange = () => {
        if (p !== pc) return;
        if (p.connectionState === "failed" || p.connectionState === "closed") retry(1000);
        else if (p.connectionState === "disconnected") retry(3000);
        else if (p.connectionState === "connected") clearTimeout(timer);
    };
    try {
        await p.setLocalDescription(await p.createOffer());
        const r = await fetch(C.server + "/api/whep", { method: "POST", headers: { Authorization: "Bearer " + C.streamKey, "Content-Type": "application/sdp" }, body: p.localDescription.sdp });
        if (p !== pc) return;
        if (!r.ok) throw new Error(r.status);
        await p.setRemoteDescription({ type: "answer", sdp: await r.text() });
        // nothing to show yet: the stream is probably offline; keep trying quietly
        timer = setTimeout(() => { if (p === pc && !gotFrame) { show(C.name + " isn't live right now"); connect(); } }, 8000);
    } catch {
        if (p !== pc) return;
        show("Can't reach the stream, retrying…");
        retry(4000);
    }
}

const onFrame = () => {
    if (!gotFrame) { gotFrame = true; clearTimeout(timer); show(""); }
    v.requestVideoFrameCallback(onFrame);
};
v.requestVideoFrameCallback(onFrame);
v.addEventListener("emptied", () => { gotFrame = false; });

vol.oninput = () => { muted = false; applyVolume(); setMuteIcon(); paint(); bb.cmd("volume", +vol.value); };
vol.ondblclick = () => { vol.value = 1; vol.oninput(); };
muteBtn.onclick = () => { muted = !muted; applyVolume(); setMuteIcon(); paint(); };
op.oninput = () => { paint(); bb.cmd("opacity", +op.value); };
op.ondblclick = () => { op.value = 1; op.oninput(); };
$("max").onclick = () => bb.cmd("max");
paint();
$("pin").onclick = () => bb.cmd("pin");
$("close").onclick = () => bb.cmd("close");

bb.on((c, a) => {
    if (c === "hover") document.body.classList.toggle("hover", a);
    else if (c === "maximized") $("max").innerHTML = a ? ${JSON.stringify(icons.restore)} : ${JSON.stringify(icons.max)};
    else if (c === "pinned") { document.body.classList.toggle("pinned", a); $("pin").classList.toggle("on", a); }
});

show("Connecting…");
connect();
})();
`;

const esc = (s: string) => s.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);

/** "Shift+PageDown" -> "Shift + PageDown" */
const prettyKey = (accel: string) => accel.replace(/CommandOrControl|CmdOrCtrl/g, "Ctrl").split("+").join(" + ");

export function playerHtml(cfg: PlayerConfig) {
    return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(cfg.name)}</title><style>${css}</style></head>
<body>
<video id="v" autoplay playsinline></video>
<div class="state" id="state"><div class="spin"></div><div id="stateText"></div></div>
<div class="ui">
<div class="top"><div class="name"><span class="dot"></span><span>${esc(cfg.name)}</span></div><span class="sp"></span>
<button class="ctl" id="max" title="Fill screen">${icons.max}</button><button class="ctl" id="pin" title="Pin: click-through">${icons.pin}</button><button class="ctl" id="close" title="Close">${icons.close}</button></div>
<div class="bottom"><div class="sliders">
<div class="row"><button class="ctl" id="mute" title="Mute"></button><input class="ctl" id="vol" type="range" min="0" max="2" step="0.01" title="Volume (double-click: 100%)"><span class="val" id="volVal"></span></div>
<div class="row"><button class="ctl" id="opBtn" title="Opacity" tabindex="-1">${icons.opacity}</button><input class="ctl" id="op" type="range" min="0.3" max="1" step="0.01" title="Opacity (double-click: 100%)"><span class="val" id="opVal"></span></div>
</div><span class="sp"></span><span class="hint">${esc(prettyKey(cfg.hotkey))} to pin</span></div>
</div>
<script>window.__CFG=${JSON.stringify(cfg).replace(/</g, "\\u003c")};${script}</script>
</body></html>`;
}
