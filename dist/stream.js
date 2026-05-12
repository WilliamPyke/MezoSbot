"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setHealthStatusProvider = setHealthStatusProvider;
exports.startStream = startStream;
exports.stopStream = stopStream;
/**
 * Browser stream transport: Canvas + WebSocket with zlib compression
 * Fast, low-latency streaming using compressed frame data and HTML5 Canvas.
 */
const node_http_1 = require("node:http");
const node_url_1 = require("node:url");
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const ws_1 = require("ws");
const node_zlib_1 = require("node:zlib");
const node_util_1 = require("node:util");
const emulator_js_1 = require("./emulator.js");
const config_js_1 = require("./config.js");
const web_js_1 = require("./arcade/web.js");
const routes_js_1 = require("./web/routes.js");
const spectate_js_1 = require("./arcade/spectate.js");
const db_js_1 = require("./arcade/db.js");
const deflateAsync = (0, node_util_1.promisify)(node_zlib_1.deflate);
const streamClients = new Map();
let httpServer = null;
let wss = null;
let unsubscribeFrames = null;
let latestObservedFrame = null;
let healthStatusProvider = null;
const targetFps = Math.max(1, Math.min(config_js_1.config.streaming.maxFps, config_js_1.config.streaming.targetFps));
const stats = {
    producedFrames: 0,
    encodedFrames: 0,
    droppedFrames: 0,
    currentEncodeFps: targetFps,
    avgEncodeMs: 0,
    lastSourceFrameAtMs: 0,
    lastSentFrameAtMs: 0,
    lastProducedSeq: 0,
    activeClients: 0,
    avgCompressRatio: 0,
    avgCompressedSizeBytes: 0,
};
function streamBaseUrl() {
    return `http://0.0.0.0:${config_js_1.config.streaming.port}`;
}
function buildViewerHtml() {
    if (!config_js_1.config.gameboy.enabled) {
        return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>MezoSbot</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b0d12; color: #e7edf7; font-family: Inter, Segoe UI, Arial, sans-serif; }
    main { max-width: 520px; padding: 24px; }
    h1 { margin: 0 0 8px 0; font-size: 22px; }
    p { margin: 0; color: #a9b3c7; }
  </style>
</head>
<body>
  <main>
    <h1>Pokemon is disabled</h1>
    <p>The bot is running, but the Game Boy stream and controls are off.</p>
  </main>
</body>
</html>`;
    }
    const ws = emulator_js_1.GB_WIDTH * config_js_1.config.streaming.viewerScale;
    const hs = emulator_js_1.GB_HEIGHT * config_js_1.config.streaming.viewerScale;
    const wsUrl = `ws://${process.env.RENDER ? '${window.location.host}' : '0.0.0.0:' + config_js_1.config.streaming.port}`;
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>MezoSbot Stream</title>
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
    <h1>MezoSbot Browser Stream</h1>
    <p>Low-latency compressed streaming.</p>
    <canvas id="canvas" width="${emulator_js_1.GB_WIDTH}" height="${emulator_js_1.GB_HEIGHT}"></canvas>
    <div class="status" id="status">Connecting...</div>
  </div>
  <script>
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d', { alpha: false });
    const status = document.getElementById('status');

    // Disable image smoothing for pixel-perfect rendering
    ctx.imageSmoothingEnabled = false;

    let ws;
    let reconnectTimer;
    let frameCount = 0;
    let lastFpsUpdate = Date.now();

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

    function connect() {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(protocol + '//' + window.location.host + '/stream');

      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        status.textContent = 'Connected';
        status.style.color = '#10b981';
        frameCount = 0;
        lastFpsUpdate = Date.now();
      };

      ws.onmessage = async (event) => {
        if (event.data instanceof ArrayBuffer) {
          // Decompress and render frame
          const decompressed = await decompressFrame(event.data);
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
        }
      };

      ws.onerror = () => {
        status.textContent = 'Connection error';
        status.style.color = '#ef4444';
      };

      ws.onclose = () => {
        status.textContent = 'Disconnected - reconnecting...';
        status.style.color = '#f59e0b';

        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, 2000);
      };
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
async function tryServeWebApp(req, res, url) {
    if ((req.method ?? "GET").toUpperCase() !== "GET")
        return false;
    if (url.pathname.startsWith("/api/") || url.pathname === "/healthz" || url.pathname === "/metrics")
        return false;
    if (url.pathname === "/stream" || url.pathname.startsWith("/arcade") || url.pathname.startsWith("/web/play/"))
        return false;
    const webRoot = (0, node_path_1.join)(process.cwd(), "web", "dist");
    const requestedPath = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const normalized = (0, node_path_1.normalize)(requestedPath).replace(/^(\.\.[/\\])+/, "");
    const candidate = (0, node_path_1.join)(webRoot, normalized);
    try {
        const fileStat = await (0, promises_1.stat)(candidate);
        if (fileStat.isFile()) {
            const body = await (0, promises_1.readFile)(candidate);
            res.statusCode = 200;
            res.setHeader("Content-Type", contentType(candidate));
            if (!candidate.endsWith("index.html"))
                res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
            res.end(body);
            return true;
        }
    }
    catch {
        // Fall through to SPA fallback.
    }
    try {
        const index = await (0, promises_1.readFile)((0, node_path_1.join)(webRoot, "index.html"));
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache");
        res.end(index);
        return true;
    }
    catch {
        return false;
    }
}
function contentType(path) {
    if (path.endsWith(".html"))
        return "text/html; charset=utf-8";
    if (path.endsWith(".js"))
        return "text/javascript; charset=utf-8";
    if (path.endsWith(".css"))
        return "text/css; charset=utf-8";
    if (path.endsWith(".svg"))
        return "image/svg+xml";
    if (path.endsWith(".png"))
        return "image/png";
    if (path.endsWith(".ico"))
        return "image/x-icon";
    if (path.endsWith(".json"))
        return "application/json; charset=utf-8";
    return "application/octet-stream";
}
function setHealthStatusProvider(provider) {
    healthStatusProvider = provider;
}
function removeClient(id) {
    const client = streamClients.get(id);
    if (!client)
        return;
    try {
        client.ws.close();
    }
    catch {
        // no-op
    }
    streamClients.delete(id);
    stats.activeClients = streamClients.size;
    console.log(`[Stream] Client ${id} disconnected (${streamClients.size} active)`);
}
async function pushFrameToClients(rgba) {
    if (streamClients.size === 0)
        return;
    // Compress frame once for all clients
    const compressed = await deflateAsync(rgba);
    const compressRatio = rgba.length / compressed.length;
    stats.avgCompressRatio = stats.avgCompressRatio === 0 ? compressRatio : stats.avgCompressRatio * 0.9 + compressRatio * 0.1;
    stats.avgCompressedSizeBytes = stats.avgCompressedSizeBytes === 0 ? compressed.length : stats.avgCompressedSizeBytes * 0.9 + compressed.length * 0.1;
    const deadClients = [];
    const MAX_BUFFER_SIZE = 2 * 1024 * 1024; // 2MB backpressure limit per client
    // Send to all clients with backpressure handling
    for (const client of streamClients.values()) {
        if (client.ws.readyState !== ws_1.WebSocket.OPEN) {
            deadClients.push(client.id);
            continue;
        }
        // Backpressure check: skip frame if client's send buffer is backed up
        if (client.ws.bufferedAmount > MAX_BUFFER_SIZE) {
            stats.droppedFrames++;
            continue;
        }
        client.ws.send(compressed, { binary: true }, (err) => {
            if (err)
                deadClients.push(client.id);
        });
    }
    for (const id of deadClients) {
        removeClient(id);
    }
    stats.encodedFrames++;
    stats.lastSentFrameAtMs = Date.now();
}
async function handleHttpRequest(req, res) {
    const method = req.method ?? "GET";
    const url = new node_url_1.URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname.startsWith("/api/web") || url.pathname.startsWith("/web/play/")) {
        const handled = await (0, routes_js_1.handleWalletWebRequest)(req, res, url);
        if (handled)
            return;
    }
    if (url.pathname.startsWith("/arcade")) {
        const handled = await (0, web_js_1.handleArcadeWebRequest)(req, res, url);
        if (handled)
            return;
    }
    if (method === "GET" && url.pathname === "/gb-stream") {
        sendHtml(res, buildViewerHtml());
        return;
    }
    if (method === "GET" && url.pathname === "/healthz") {
        const health = healthStatusProvider?.() ?? {
            status: "ok",
            discordReady: true,
        };
        sendJson(res, health.discordReady ? 200 : 503, {
            ...health,
            pokemonEnabled: config_js_1.config.gameboy.enabled,
            stream: {
                ...stats,
                targetFps,
            },
        });
        return;
    }
    if (method === "GET" && url.pathname === "/metrics") {
        sendJson(res, 200, {
            pokemonEnabled: config_js_1.config.gameboy.enabled,
            stream: {
                ...stats,
                targetFps,
            },
        });
        return;
    }
    if (await tryServeWebApp(req, res, url))
        return;
    sendJson(res, 404, { error: "not_found" });
}
async function startStream() {
    if (httpServer)
        return;
    if (config_js_1.config.gameboy.enabled) {
        // Subscribe to emulator frames and forward immediately (no sampling loop)
        unsubscribeFrames = (0, emulator_js_1.subscribeFrames)((meta) => {
            latestObservedFrame = meta;
            stats.producedFrames += 1;
            stats.lastSourceFrameAtMs = meta.capturedAtMs;
            // Send frame immediately as emulator produces it
            const ref = (0, emulator_js_1.getLatestFrameRef)();
            if (ref) {
                pushFrameToClients(ref.frame).catch((err) => {
                    console.error("[Stream] Compression error:", err?.message ?? err);
                });
            }
        });
    }
    await new Promise((resolve) => {
        httpServer = (0, node_http_1.createServer)((req, res) => {
            handleHttpRequest(req, res).catch((err) => {
                console.error("[Stream] HTTP handler error:", err?.message ?? err);
                sendJson(res, 500, { error: "internal_error" });
            });
        });
        // Spectator WebSocket server for live arcade match viewing.
        const spectateWss = new ws_1.WebSocketServer({
            server: httpServer,
            path: "/arcade/spectate",
        });
        spectateWss.on("connection", async (ws, req) => {
            try {
                const reqUrl = new node_url_1.URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
                const matchIdRaw = reqUrl.searchParams.get("match");
                const matchId = matchIdRaw ? parseInt(matchIdRaw, 10) : NaN;
                if (!Number.isFinite(matchId) || matchId <= 0) {
                    ws.close(1008, "missing match id");
                    return;
                }
                const match = await (0, db_js_1.getMatch)(matchId);
                if (!match) {
                    ws.close(1008, "match not found");
                    return;
                }
                if (match.mode === "practice") {
                    ws.close(1008, "practice not spectatable");
                    return;
                }
                if (match.status === "completed" || match.status === "cancelled") {
                    // Send the final snapshot once and close.
                    const snap = await (0, spectate_js_1.buildSpectatorSnapshot)(matchId);
                    if (snap)
                        ws.send(JSON.stringify(snap));
                    ws.close(1000, "match completed");
                    return;
                }
                await (0, web_js_1.ensureMatchRuntimeLoaded)(matchId);
                (0, spectate_js_1.addSpectator)(matchId, ws);
                const snap = await (0, spectate_js_1.buildSpectatorSnapshot)(matchId);
                if (snap)
                    ws.send(JSON.stringify(snap));
            }
            catch (err) {
                console.error("[Spectate] connect error:", err?.message ?? err);
                try {
                    ws.close(1011, "internal error");
                }
                catch { }
            }
        });
        if (config_js_1.config.gameboy.enabled) {
            // WebSocket server with optimized settings
            wss = new ws_1.WebSocketServer({
                server: httpServer,
                path: "/stream",
                perMessageDeflate: false, // Disable compression for lower latency
                maxPayload: 10 * 1024 * 1024 // 10MB max payload
            });
            wss.on("connection", (ws, req) => {
                const clientId = `ws-${Date.now()}-${Math.random().toString(36).substring(7)}`;
                streamClients.set(clientId, {
                    id: clientId,
                    ws,
                    connectedAtMs: Date.now(),
                });
                stats.activeClients = streamClients.size;
                console.log(`[Stream] WebSocket client ${clientId} connected (${streamClients.size} active)`);
                ws.on("close", () => {
                    removeClient(clientId);
                });
                ws.on("error", () => {
                    removeClient(clientId);
                });
            });
        }
        httpServer.listen(config_js_1.config.streaming.port, "0.0.0.0", () => {
            resolve();
        });
    });
    console.log(`[Stream] HTTP server ready at ${streamBaseUrl()}/`);
    console.log(`[Stream] Health endpoint: ${streamBaseUrl()}/healthz`);
    if (config_js_1.config.gameboy.enabled) {
        console.log(`[Stream] ${emulator_js_1.GB_WIDTH}x${emulator_js_1.GB_HEIGHT} @ ${targetFps}fps with zlib compression`);
    }
    else {
        console.log("[Stream] Pokemon disabled; WebSocket stream is off");
    }
}
function stopStream() {
    if (unsubscribeFrames) {
        unsubscribeFrames();
        unsubscribeFrames = null;
    }
    for (const id of streamClients.keys()) {
        removeClient(id);
    }
    if (wss) {
        wss.close();
        wss = null;
    }
    if (httpServer) {
        httpServer.close();
        httpServer = null;
    }
}
