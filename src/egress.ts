/**
 * Hourly log of the bot's outbound traffic.
 *
 * Render counts everything a service sends to the internet against the
 * workspace's monthly bandwidth (5 GB on Hobby), requests the bot makes
 * included, and stops the service when it runs out. The line shows the total
 * and where it went, so a regression is visible within the hour:
 *
 *   [Egress] 60 min: 1.9 MB sent in total (1.4 GB a month at this rate); fetch: rpc.example 0.6 MB/360, ...; served 0.1 MB
 *
 * The total comes from the kernel's interface counters (Linux only). The
 * per-host figures cover global fetch (RPC, Supabase, imgnAI) and estimate
 * headers; Discord traffic is in the total but not broken out.
 *
 * Import this module before anything that captures fetch (src/db.ts does).
 */
import { readFileSync } from "node:fs";
import type { Server } from "node:http";

const REPORT_MS = 60 * 60_000;
/** Request line, default headers and TLS/TCP framing of one request: an estimate. */
const REQUEST_OVERHEAD_BYTES = 350;

const sent = new Map<string, { requests: number; bytes: number }>();
let servedBytes = 0;

function bodyBytes(body: unknown): number {
  if (typeof body === "string") return Buffer.byteLength(body);
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return body.byteLength;
  return 0;
}

function headerBytes(headers: unknown): number {
  if (!headers || typeof headers !== "object") return 0;
  let total = 0;
  const add = (value: unknown, key: unknown) => {
    total += String(key).length + String(value).length + 4;
  };
  if (headers instanceof Headers) headers.forEach(add);
  else if (Array.isArray(headers)) for (const [key, value] of headers) add(value, key);
  else for (const [key, value] of Object.entries(headers)) add(value, key);
  return total;
}

const nativeFetch = globalThis.fetch;
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  try {
    const request = typeof input === "object" && "url" in input ? input : null;
    const url = request ? request.url : String(input);
    const host = new URL(url).host;
    const tally = sent.get(host) ?? { requests: 0, bytes: 0 };
    tally.requests += 1;
    tally.bytes += REQUEST_OVERHEAD_BYTES + url.length + bodyBytes(init?.body) + headerBytes(init?.headers ?? request?.headers);
    sent.set(host, tally);
  } catch {
    // Metering never gets in the way of a request.
  }
  return nativeFetch(input, init);
}) as typeof fetch;

/** Count what an HTTP server of ours writes back to its clients. */
export function meterServer(server: Server): void {
  server.on("connection", (socket) => {
    socket.once("close", () => {
      servedBytes += socket.bytesWritten;
    });
  });
}

/** Bytes transmitted on every interface but loopback since boot, or null where /proc/net/dev is unavailable. */
function transmittedBytes(): number | null {
  try {
    let total = 0;
    for (const line of readFileSync("/proc/net/dev", "utf8").split("\n").slice(2)) {
      const [name, counters] = line.split(":");
      if (!counters || name!.trim() === "lo") continue;
      total += Number(counters.trim().split(/\s+/)[8]);
    }
    return Number.isFinite(total) ? total : null;
  } catch {
    return null;
  }
}

const megabytes = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;

let lastTransmitted = transmittedBytes();

function report(): void {
  const transmitted = transmittedBytes();
  const total = transmitted != null && lastTransmitted != null ? transmitted - lastTransmitted : null;
  lastTransmitted = transmitted;
  const hosts = [...sent.entries()]
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .slice(0, 8)
    .map(([host, tally]) => `${host} ${megabytes(tally.bytes)}/${tally.requests}`);
  const totalText = total == null
    ? "total unknown on this platform"
    : `${megabytes(total)} sent in total (${((total * 24 * 30) / 1e9).toFixed(1)} GB a month at this rate)`;
  console.log(`[Egress] 60 min: ${totalText}; fetch: ${hosts.join(", ") || "none"}; served ${megabytes(servedBytes)}`);
  sent.clear();
  servedBytes = 0;
}

setInterval(report, REPORT_MS).unref();
