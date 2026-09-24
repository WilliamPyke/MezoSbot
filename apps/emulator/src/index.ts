import "dotenv/config";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import { Worker } from "node:worker_threads";
import { deflate } from "node:zlib";
import { WebSocketServer, WebSocket } from "ws";
import { isEmulatorVote, parseJsonObject, verifySignedRequest, type EmulatorVote, type ServiceResult } from "@mezosbot/contracts";
import { emulatorSupabase } from "../../../src/emulatorRuntime.js";
import { LeaseManager } from "./lease.js";
import { SettlementQueue, type SettleOutcome } from "./settleQueue.js";

const FRAME_BYTES = 160 * 144 * 4;
const LEASE_NAME = "emulator";
const framesBuffer = new SharedArrayBuffer(FRAME_BYTES * 2);
// control[0]=frame seq, [1]=frame slot, [2]=captured-at ms, [3]=1 while saves are permitted (lease valid)
const controlBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 4);
const frames = new Uint8Array(framesBuffer);
const control = new Int32Array(controlBuffer);
const port = Number(process.env.PORT ?? process.env.STREAM_PORT ?? 8787);
const romPath = required("ROM_PATH");
const signingSecret = required("INTERNAL_SIGNING_SECRET");
// Unique per process: a restarted or rolling-deployed instance can never reuse
// the previous holder id, lease, or round ids even if EMULATOR_INSTANCE_ID is fixed.
const runId = crypto.randomUUID();
const holderId = `${process.env.EMULATOR_INSTANCE_ID ?? os.hostname()}:${runId}`;
const minBid = Number(process.env.GB_MIN_BID ?? 0.001);
const maxBufferedBytes = Number(process.env.STREAM_MAX_BUFFERED_BYTES ?? 1_000_000);
const maxViewers = Number(process.env.STREAM_MAX_VIEWERS ?? 50);
const heartbeatMs = Number(process.env.STREAM_HEARTBEAT_MS ?? 15_000);
const slowClientMaxSkips = Number(process.env.STREAM_SLOW_CLIENT_MAX_SKIPS ?? 600);
const leaseTtlSeconds = Number(process.env.EMULATOR_LEASE_TTL_SECONDS ?? 30);
const rpcTimeoutMs = Number(process.env.EMULATOR_RPC_TIMEOUT_MS ?? 10_000);
const shutdownTimeoutMs = Number(process.env.GB_SHUTDOWN_TIMEOUT_MS ?? 15_000);

let engine: Worker | null = null;
let engineReady = false;
let shuttingDown = false;
let onEngineStopped: (() => void) | null = null;
let latestSeq = 0;
let compressedSeq = 0;
let compressionBusy = false;
let targetFps: 60 | 30 = 60;
let degradedUntil = 0;
let roundNumber = 0;
let encodedFrames = 0;
let droppedFrames = 0;
let backpressureDrops = 0;
let heartbeatDrops = 0;
let viewerRejects = 0;
let settledRounds = 0;
let encodingMs = 0;
const pendingVotes = new Map<string, (value: { ok: boolean; reason?: string }) => void>();

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env: ${key}`);
  return value;
}

function log(level: "info" | "warn" | "error", event: string, data: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, service: "emulator", event, holderId, ...data });
  if (level === "error") console.error(line); else console.log(line);
}

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await emulatorSupabase.rpc(name, args).abortSignal(AbortSignal.timeout(rpcTimeoutMs));
  if (error) throw new Error(`${name}: ${error.message}`);
  return data as T;
}

// Fail fast (before touching the lease) if the runtime ROM mount is missing.
fs.accessSync(romPath, fs.constants.R_OK);

/* ── Lease: standby until acquired, fatal on loss ─────────────────── */

const lease = new LeaseManager({
  acquire: () => rpc("acquire_service_lease_v1", { p_lease_name: LEASE_NAME, p_holder_id: holderId, p_ttl_seconds: leaseTtlSeconds }),
  release: () => rpc("release_service_lease_v1", { p_lease_name: LEASE_NAME, p_holder_id: holderId }),
  ttlMs: leaseTtlSeconds * 1_000,
  renewEveryMs: Math.floor((leaseTtlSeconds * 1_000) / 3),
  standbyPollMs: Number(process.env.EMULATOR_STANDBY_POLL_MS ?? 5_000),
  retryMs: 1_000,
  safetyMarginMs: Math.floor((leaseTtlSeconds * 1_000) / 6),
  onAcquired: () => {
    log("info", "lease_acquired");
    Atomics.store(control, 3, 1);
    startEngine();
  },
  onLost: (reason) => {
    // Another instance may already be running the game: stop saving and
    // settling immediately and let the orchestrator restart us as a standby.
    Atomics.store(control, 3, 0);
    engineReady = false;
    settlements.halt();
    log("error", "lease_lost", { reason });
    process.exit(1);
  },
  onError: (error) => log("warn", "lease_rpc_failed", { state: lease.state, error: String(error) }),
});

setInterval(() => Atomics.store(control, 3, lease.isValid() ? 1 : 0), 250).unref();

/* ── Settlement: serial, retried, button applied after debit ──────── */

type EngineRound = { winningButton: string; winningSats: number; winners: Array<{ userId: string; amount: number }>; totalBids: number };
type QueuedRound = EngineRound & { roundId: string };
type SettleResponse = { ok: boolean; code?: string; applied?: string[]; skipped?: Array<Record<string, unknown>>; debited_sats?: number };

const settlements = new SettlementQueue<QueuedRound>({
  settle: async (round, attempt): Promise<SettleOutcome> => {
    if (!lease.isValid()) throw new Error("lease not currently valid");
    const result = await rpc<SettleResponse>("settle_emulator_round_v1", {
      p_round_id: round.roundId,
      p_holder_id: holderId,
      p_button: round.winningButton,
      p_votes: round.winners.map((vote) => ({ user_id: vote.userId, amount_sats: vote.amount })),
      p_channel_id: process.env.GB_CHANNEL_ID ?? null,
    });
    if (result?.ok) {
      settledRounds += 1;
      if (result.skipped?.length) log("warn", "round_voters_skipped", { roundId: round.roundId, attempt, skipped: result.skipped });
      return { kind: "settled", apply: (result.applied?.length ?? 0) > 0 };
    }
    if (result?.code === "not_lease_holder") return { kind: "fenced", reason: "not_lease_holder" };
    return { kind: "rejected", reason: String(result?.code ?? "unknown") };
  },
  apply: (round) => engine?.postMessage({ type: "apply", button: round.winningButton }),
  onFatal: (reason) => {
    Atomics.store(control, 3, 0);
    engineReady = false;
    log("error", "settlement_fenced", { reason });
    process.exit(1);
  },
  onEvent: (event, data) => log(event === "round_settlement_retry" ? "warn" : "error", event, data),
  maxPending: Number(process.env.GB_MAX_PENDING_ROUNDS ?? 120),
});

/* ── Engine worker ────────────────────────────────────────────────── */

function startEngine(): void {
  if (engine || shuttingDown) return;
  const worker = new Worker(new URL("./engine-worker.js", import.meta.url), {
    workerData: { frames: framesBuffer, control: controlBuffer, romPath },
  });
  engine = worker;
  worker.on("message", (message: Record<string, unknown>) => {
    if (message.type === "ready") {
      engineReady = true;
      log("info", "engine_ready");
    } else if (message.type === "stopped") {
      onEngineStopped?.();
    } else if (message.type === "vote-result") {
      const callback = pendingVotes.get(String(message.requestId));
      pendingVotes.delete(String(message.requestId));
      callback?.(message.result as { ok: boolean; reason?: string });
    } else if (message.type === "round") {
      roundNumber += 1;
      settlements.enqueue({ ...(message.round as EngineRound), roundId: `${runId}:${roundNumber}` });
    }
  });
  // 'exit' always follows 'error'; exiting the process from inside the error
  // handler while the worker is still tearing down can abort Node on Windows.
  worker.on("error", (error) => {
    engineReady = false;
    log("error", "worker_error", { error: error.message });
  });
  worker.on("exit", (code) => {
    engineReady = false;
    onEngineStopped?.();
    if (shuttingDown) return;
    // The engine is dead (no more saves), so hand the lease over early and let
    // the orchestrator restart this process.
    log("error", "worker_exit", { code });
    Atomics.store(control, 3, 0);
    settlements.halt();
    setTimeout(() => process.exit(1), 3_000).unref();
    // Short delay lets worker teardown finish (immediate exit trips a libuv assert on Windows).
    void lease.stop().catch(() => undefined).finally(() => setTimeout(() => process.exit(1), 200));
  });
}

/** Asks the engine to stop (final save included) and waits for its 'stopped' message. */
async function stopEngine(timeoutMs: number): Promise<boolean> {
  const worker = engine;
  if (!worker) return true;
  const stopped = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    onEngineStopped = () => { clearTimeout(timer); resolve(true); };
    worker.postMessage({ type: "stop" });
  });
  onEngineStopped = null;
  if (!stopped) {
    log("error", "engine_stop_timeout", { timeoutMs });
    await worker.terminate();
  }
  return stopped;
}

/* ── HTTP API ─────────────────────────────────────────────────────── */

async function verifyBalance(vote: EmulatorVote): Promise<boolean> {
  const { data } = await emulatorSupabase.from("users").select("balance_sats").eq("discord_id", vote.actorId).maybeSingle();
  return Number(data?.balance_sats ?? 0) >= vote.amountSats;
}

function isActive(): boolean {
  return engineReady && !shuttingDown && lease.isValid();
}

async function submitVote(vote: EmulatorVote, requestId: string): Promise<{ ok: boolean; reason?: string }> {
  if (!isActive() || !engine) return { ok: false, reason: "Emulator is not ready" };
  if (vote.amountSats < minBid) return { ok: false, reason: `Minimum bid is ${minBid} sats.` };
  if (!(await verifyBalance(vote))) return { ok: false, reason: "Not enough sats." };
  const worker = engine;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => { pendingVotes.delete(requestId); resolve({ ok: false, reason: "Vote timed out" }); }, 2_000);
    pendingVotes.set(requestId, (result) => { clearTimeout(timeout); resolve(result); });
    worker.postMessage({ type: "vote", requestId, actorId: vote.actorId, button: vote.button, amountSats: vote.amountSats });
  });
}

async function authenticate(request: http.IncomingMessage, body: string): Promise<{ requestId: string } | null> {
  const host = request.headers.host ?? "localhost";
  const url = new URL(request.url ?? "/", `http://${host}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(",") : value);
  const verified = await verifySignedRequest({ secret: signingSecret, method: request.method ?? "GET", url, body, headers });
  if (!verified.ok) return null;
  const claimed = await rpc<boolean>("consume_integration_nonce_v1", {
    p_service: "emulator", p_nonce: verified.headers.nonce,
    p_expires_at: new Date(Number(verified.headers.timestamp) + 120_000).toISOString(),
  });
  return claimed ? { requestId: verified.headers.requestId } : null;
}

function sendJson(response: http.ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

async function readBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > 32_768) throw new Error("Request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  try {
    // Liveness: the process is up (standbys included). Wire to the liveness probe.
    if (url.pathname === "/livez") return sendJson(response, 200, { status: "alive", service: "emulator", leaseState: lease.state });
    // Readiness: only the leaseholder with a running engine. Wire to the readiness probe.
    if (url.pathname === "/healthz") return sendJson(response, isActive() ? 200 : 503, { status: isActive() ? "ok" : lease.state === "standby" ? "standby" : "starting", service: "emulator", leaseState: lease.state });
    if (url.pathname === "/metrics") return sendJson(response, 200, { service: "emulator", engineReady, leaseState: lease.state, leaseValid: lease.isValid(), targetFps, viewers: wss.clients.size, maxViewers, encodedFrames, droppedFrames, backpressureDrops, heartbeatDrops, viewerRejects, encodingMs, settledRounds, pendingSettlements: settlements.pending });
    if (url.pathname === "/internal/v1/emulator/status" && request.method === "GET") {
      const auth = await authenticate(request, "");
      if (!auth) return sendJson(response, 401, { ok: false, error: { code: "unauthorized", message: "Bad signature", retryable: false } });
      return sendJson(response, 200, { ok: true, value: { running: isActive(), viewers: wss.clients.size, targetFps, latestSeq }, requestId: auth.requestId } satisfies ServiceResult<unknown>);
    }
    if (url.pathname === "/internal/v1/emulator/votes" && request.method === "POST") {
      const body = await readBody(request);
      const auth = await authenticate(request, body);
      if (!auth) return sendJson(response, 401, { ok: false, error: { code: "unauthorized", message: "Bad signature or replay", retryable: false } });
      const parsed = parseJsonObject(body);
      if (!isEmulatorVote(parsed)) return sendJson(response, 400, { ok: false, error: { code: "invalid_contract", message: "Invalid EmulatorVote v1", retryable: false }, requestId: auth.requestId });
      const accepted = await submitVote(parsed, auth.requestId);
      if (!accepted.ok) return sendJson(response, 409, { ok: false, error: { code: "vote_rejected", message: accepted.reason ?? "Vote rejected", retryable: false }, requestId: auth.requestId });
      return sendJson(response, 202, { ok: true, value: { accepted: true, roundId: `${runId}:${roundNumber + 1}` }, requestId: auth.requestId });
    }
    if (url.pathname === "/" || url.pathname === "/play") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "public,max-age=300" });
      return response.end(PAGE);
    }
    sendJson(response, 404, { error: "not_found" });
  } catch (error) {
    log("error", "request_failed", { path: url.pathname, error: error instanceof Error ? error.message : String(error) });
    sendJson(response, 500, { ok: false, error: { code: "internal_error", message: "Request failed", retryable: true } });
  }
});

/* ── Frame stream ─────────────────────────────────────────────────── */

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
const aliveClients = new WeakSet<WebSocket>();
const skippedFrames = new WeakMap<WebSocket, number>();

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (url.pathname !== "/stream") return socket.destroy();
  if (shuttingDown || wss.clients.size >= maxViewers) {
    viewerRejects += 1;
    socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    return;
  }
  wss.handleUpgrade(request, socket, head, (client) => wss.emit("connection", client, request));
});

wss.on("connection", (client: WebSocket) => {
  aliveClients.add(client);
  client.on("pong", () => aliveClients.add(client));
  client.on("error", () => client.terminate());
});

// Heartbeat: drop half-open viewers that stopped answering pings.
setInterval(() => {
  for (const client of wss.clients) {
    if (!aliveClients.has(client)) {
      heartbeatDrops += 1;
      client.terminate();
      continue;
    }
    aliveClients.delete(client);
    client.ping();
  }
}, heartbeatMs).unref();

setInterval(() => {
  const seq = Atomics.load(control, 0);
  if (!engineReady || seq === compressedSeq || compressionBusy) {
    if (seq !== compressedSeq && compressionBusy) droppedFrames += 1;
    return;
  }
  if (targetFps === 30 && seq % 2 !== 0) return;
  if (Date.now() > degradedUntil) targetFps = 60;
  latestSeq = seq;
  const slot = Atomics.load(control, 1);
  const source = Buffer.from(frames.slice(slot * FRAME_BYTES, (slot + 1) * FRAME_BYTES));
  compressionBusy = true;
  const started = performance.now();
  deflate(source, { level: 1 }, (error, encoded) => {
    compressionBusy = false;
    if (error) return;
    compressionMsObserve(performance.now() - started);
    compressedSeq = seq;
    const header = Buffer.allocUnsafe(8);
    header.writeUInt32BE(seq, 0); header.writeUInt16BE(160, 4); header.writeUInt16BE(144, 6);
    const payload = Buffer.concat([header, encoded]);
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      // Per-client backpressure: skip frames for a slow viewer; evict one that never catches up.
      if (client.bufferedAmount > maxBufferedBytes) {
        backpressureDrops += 1;
        const skips = (skippedFrames.get(client) ?? 0) + 1;
        skippedFrames.set(client, skips);
        if (skips > slowClientMaxSkips) client.terminate();
        continue;
      }
      skippedFrames.delete(client);
      client.send(payload, { binary: true });
    }
    encodedFrames += 1;
  });
}, 1000 / 60).unref();

function compressionMsObserve(value: number): void {
  encodingMs = Math.round((encodingMs * 0.9 + value * 0.1) * 100) / 100;
  if (value > 16 || backpressureDrops > encodedFrames * 0.02) {
    targetFps = 30;
    degradedUntil = Date.now() + 5_000;
  }
}

/* ── Startup and shutdown ─────────────────────────────────────────── */

await new Promise<void>((resolve) => server.listen(port, "0.0.0.0", resolve));
log("info", "listening", { port, runId });
lease.start();

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  engineReady = false;
  log("info", "shutdown_started", { signal });
  setTimeout(() => process.exit(1), shutdownTimeoutMs).unref();
  settlements.close();
  if (!(await settlements.drain(3_000))) log("warn", "settlement_drain_timeout", { pending: settlements.pending });
  // Final save happens inside the worker; keep the lease until it has finished.
  await stopEngine(Math.max(1_000, shutdownTimeoutMs - 5_000));
  Atomics.store(control, 3, 0);
  await lease.stop().catch((error) => log("warn", "lease_release_failed", { error: String(error) }));
  for (const client of wss.clients) client.terminate();
  server.close();
  log("info", "shutdown_complete");
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Mezo Emulator</title><style>body{margin:0;background:#10130f;color:#eef5e8;font-family:system-ui;display:grid;place-items:center;min-height:100vh}canvas{width:min(90vw,640px);image-rendering:pixelated;border:8px solid #30382c}</style></head><body><main><h1>Mezo Emulator</h1><canvas width="160" height="144"></canvas><p>Vote from Discord. The latest frame wins when a viewer falls behind.</p></main><script>const c=document.querySelector('canvas'),x=c.getContext('2d');const ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/stream');ws.binaryType='arraybuffer';ws.onmessage=async e=>{const b=new Uint8Array(e.data),ds=new DecompressionStream('deflate'),raw=await new Response(new Blob([b.slice(8)]).stream().pipeThrough(ds)).arrayBuffer();x.putImageData(new ImageData(new Uint8ClampedArray(raw),160,144),0,0)}</script></body></html>`;
