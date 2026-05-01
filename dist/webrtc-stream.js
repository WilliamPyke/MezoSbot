"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startStream = startStream;
exports.stopStream = stopStream;
/**
 * WebRTC-based Game Boy stream with DataChannel compression
 * Much more efficient than raw WebSocket frames
 */
const node_http_1 = require("node:http");
const node_url_1 = require("node:url");
const ws_1 = require("ws");
// @ts-ignore - @koush/wrtc doesn't have TypeScript definitions
const wrtc_1 = require("@koush/wrtc");
const node_zlib_1 = require("node:zlib");
const node_util_1 = require("node:util");
const emulator_js_1 = require("./emulator.js");
const config_js_1 = require("./config.js");
const deflateAsync = (0, node_util_1.promisify)(node_zlib_1.deflate);
const webrtcClients = new Map();
let httpServer = null;
let signalWss = null;
let unsubscribeFrames = null;
let latestFrame = null;
const stats = {
    producedFrames: 0,
    sentFrames: 0,
    droppedFrames: 0,
    activeClients: 0,
    avgCompressRatio: 0,
    avgFrameSizeBytes: 0,
};
function streamBaseUrl() {
    return `http://0.0.0.0:${config_js_1.config.streaming.port}`;
}
function buildViewerHtml() {
    const ws = emulator_js_1.GB_WIDTH * config_js_1.config.streaming.viewerScale;
    const hs = emulator_js_1.GB_HEIGHT * config_js_1.config.streaming.viewerScale;
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>MezoSbot WebRTC Stream</title>
  <style>
    body { margin: 0; background: #0b0d12; color: #e7edf7; font-family: Inter, Segoe UI, Arial, sans-serif; }
    .wrap { max-width: 960px; margin: 32px auto; padding: 0 16px; }
    h1 { margin: 0 0 8px 0; font-size: 22px; }
    p { margin: 0 0 18px 0; color: #a9b3c7; }
    canvas { width: ${ws}px; height: ${hs}px; image-rendering: pixelated; border-radius: 12px; border: 1px solid #1d2330; background: black; display: block; }
    .status { font-size: 14px; color: #6b7280; margin-top: 12px; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>MezoSbot WebRTC Stream</h1>
    <p>Low-latency compressed streaming via WebRTC DataChannel</p>
    <canvas id="canvas" width="${emulator_js_1.GB_WIDTH}" height="${emulator_js_1.GB_HEIGHT}"></canvas>
    <div class="status" id="status">Connecting...</div>
  </div>
  <script>
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d', { alpha: false });
    const status = document.getElementById('status');
    ctx.imageSmoothingEnabled = false;

    let pc = null;
    let dataChannel = null;
    let signalWs = null;
    let frameCount = 0;
    let lastFpsUpdate = Date.now();
    let reconnectTimer = null;

    function connect() {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      signalWs = new WebSocket(protocol + '//' + window.location.host + '/signal');

      signalWs.onopen = () => {
        status.textContent = 'Signaling connected, waiting for offer...';

        // Create peer connection
        pc = new RTCPeerConnection({
          iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
        });

        // Handle ICE candidates
        pc.onicecandidate = (event) => {
          if (event.candidate) {
            signalWs.send(JSON.stringify({ type: 'ice', candidate: event.candidate }));
          }
        };

        // Connection state changes
        pc.onconnectionstatechange = () => {
          if (pc.connectionState === 'connected') {
            status.textContent = 'Connected';
            status.style.color = '#10b981';
          } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
            status.textContent = 'Disconnected - reconnecting...';
            status.style.color = '#f59e0b';
            clearTimeout(reconnectTimer);
            reconnectTimer = setTimeout(connect, 2000);
          }
        };

        // Handle incoming data channel
        pc.ondatachannel = (event) => {
          dataChannel = event.channel;

          dataChannel.onopen = () => {
            frameCount = 0;
            lastFpsUpdate = Date.now();
          };

          dataChannel.onmessage = async (event) => {
            // Decompress and render frame
            const compressed = await event.data.arrayBuffer();
            const decompressed = await decompressFrame(compressed);

            const rgba = new Uint8ClampedArray(decompressed);
            const imageData = new ImageData(rgba, ${emulator_js_1.GB_WIDTH}, ${emulator_js_1.GB_HEIGHT});
            ctx.putImageData(imageData, 0, 0);

            // Update FPS counter
            frameCount++;
            const now = Date.now();
            if (now - lastFpsUpdate >= 1000) {
              status.textContent = 'Connected - ' + frameCount + ' fps';
              frameCount = 0;
              lastFpsUpdate = now;
            }
          };
        };
      };

      signalWs.onmessage = async (event) => {
        const msg = JSON.parse(event.data);

        if (msg.type === 'offer') {
          // Receive offer from server, create answer
          await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          signalWs.send(JSON.stringify({ type: 'answer', sdp: answer }));
        } else if (msg.type === 'ice') {
          await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
        }
      };

      signalWs.onerror = () => {
        status.textContent = 'Connection error';
        status.style.color = '#ef4444';
      };

      signalWs.onclose = () => {
        if (pc) pc.close();
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, 2000);
      };
    }

    // Decompress frame using browser's native DecompressionStream
    async function decompressFrame(compressed) {
      const ds = new DecompressionStream('deflate');
      const writer = ds.writable.getWriter();
      writer.write(new Uint8Array(compressed));
      writer.close();

      const chunks = [];
      const reader = ds.readable.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }

      const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
      const result = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
      }
      return result.buffer;
    }

    connect();
  </script>
</body>
</html>`;
}
function sendJson(res, status, payload) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(payload));
}
function sendHtml(res, html) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(html);
}
function removeClient(id) {
    const client = webrtcClients.get(id);
    if (!client)
        return;
    try {
        if (client.dataChannel)
            client.dataChannel.close();
        client.pc.close();
        client.signalWs.close();
    }
    catch {
        // no-op
    }
    webrtcClients.delete(id);
    stats.activeClients = webrtcClients.size;
    console.log(`[WebRTC] Client ${id} disconnected (${webrtcClients.size} active)`);
}
async function broadcastFrame(rgba) {
    if (webrtcClients.size === 0)
        return;
    // Compress frame once for all clients
    const compressed = await deflateAsync(rgba);
    const compressRatio = rgba.length / compressed.length;
    stats.avgCompressRatio = stats.avgCompressRatio === 0 ? compressRatio : stats.avgCompressRatio * 0.9 + compressRatio * 0.1;
    stats.avgFrameSizeBytes = stats.avgFrameSizeBytes === 0 ? compressed.length : stats.avgFrameSizeBytes * 0.9 + compressed.length * 0.1;
    const deadClients = [];
    for (const client of webrtcClients.values()) {
        if (!client.dataChannel || client.dataChannel.readyState !== "open") {
            if (client.pc.connectionState === "failed" || client.pc.connectionState === "closed") {
                deadClients.push(client.id);
            }
            continue;
        }
        try {
            // Check buffered amount (backpressure)
            if (client.dataChannel.bufferedAmount > 1024 * 1024) {
                stats.droppedFrames++;
                continue;
            }
            client.dataChannel.send(compressed);
            stats.sentFrames++;
        }
        catch (err) {
            deadClients.push(client.id);
        }
    }
    for (const id of deadClients) {
        removeClient(id);
    }
}
async function handleHttpRequest(req, res) {
    const method = req.method ?? "GET";
    const url = new node_url_1.URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (method === "GET" && url.pathname === "/") {
        sendHtml(res, buildViewerHtml());
        return;
    }
    if (method === "GET" && url.pathname === "/healthz") {
        sendJson(res, 200, {
            status: "ok",
            stream: stats,
        });
        return;
    }
    if (method === "GET" && url.pathname === "/metrics") {
        sendJson(res, 200, { stream: stats });
        return;
    }
    sendJson(res, 404, { error: "not_found" });
}
async function startStream() {
    if (httpServer)
        return;
    // Subscribe to emulator frames
    unsubscribeFrames = (0, emulator_js_1.subscribeFrames)((meta) => {
        const ref = (0, emulator_js_1.getLatestFrameRef)();
        if (ref) {
            latestFrame = ref.frame;
            stats.producedFrames++;
            // Broadcast to all WebRTC clients
            broadcastFrame(ref.frame).catch((err) => {
                console.error("[WebRTC] Broadcast error:", err?.message ?? err);
            });
        }
    });
    await new Promise((resolve) => {
        httpServer = (0, node_http_1.createServer)((req, res) => {
            handleHttpRequest(req, res).catch((err) => {
                console.error("[WebRTC] HTTP handler error:", err?.message ?? err);
                sendJson(res, 500, { error: "internal_error" });
            });
        });
        // WebSocket signaling server
        signalWss = new ws_1.WebSocketServer({
            server: httpServer,
            path: "/signal",
        });
        signalWss.on("connection", async (ws) => {
            const clientId = `rtc-${Date.now()}-${Math.random().toString(36).substring(7)}`;
            const pc = new wrtc_1.RTCPeerConnection({
                iceServers: config_js_1.config.streaming.stunServers.map((url) => ({ urls: url })),
            });
            const dataChannel = pc.createDataChannel("frames", {
                ordered: false,
                maxRetransmits: 0,
            });
            webrtcClients.set(clientId, {
                id: clientId,
                pc,
                dataChannel,
                signalWs: ws,
                connectedAtMs: Date.now(),
            });
            stats.activeClients = webrtcClients.size;
            console.log(`[WebRTC] Client ${clientId} connecting (${webrtcClients.size} active)`);
            pc.onicecandidate = (event) => {
                if (event.candidate) {
                    ws.send(JSON.stringify({ type: "ice", candidate: event.candidate }));
                }
            };
            ws.on("message", async (data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    if (msg.type === "answer") {
                        await pc.setRemoteDescription(new wrtc_1.RTCSessionDescription(msg.sdp));
                    }
                    else if (msg.type === "ice") {
                        await pc.addIceCandidate(new wrtc_1.RTCIceCandidate(msg.candidate));
                    }
                }
                catch (err) {
                    console.error("[WebRTC] Signaling error:", err?.message ?? err);
                }
            });
            ws.on("close", () => {
                removeClient(clientId);
            });
            ws.on("error", () => {
                removeClient(clientId);
            });
            // Server creates offer (because server creates DataChannel)
            try {
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                ws.send(JSON.stringify({ type: "offer", sdp: offer }));
            }
            catch (err) {
                console.error("[WebRTC] Failed to create offer:", err?.message ?? err);
                removeClient(clientId);
            }
        });
        httpServer.listen(config_js_1.config.streaming.port, "0.0.0.0", () => {
            resolve();
        });
    });
    console.log(`[WebRTC] Stream ready at ${streamBaseUrl()}/`);
    console.log(`[WebRTC] ${emulator_js_1.GB_WIDTH}x${emulator_js_1.GB_HEIGHT} @ 60fps with DataChannel compression`);
}
function stopStream() {
    if (unsubscribeFrames) {
        unsubscribeFrames();
        unsubscribeFrames = null;
    }
    for (const id of webrtcClients.keys()) {
        removeClient(id);
    }
    if (signalWss) {
        signalWss.close();
        signalWss = null;
    }
    if (httpServer) {
        httpServer.close();
        httpServer = null;
    }
}
