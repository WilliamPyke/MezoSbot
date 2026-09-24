import {
  buildSignedHeaders,
  type ArcadeCommand,
  type EmulatorVote,
  type SatscapeCommand,
  type ServiceResult,
} from "@mezosbot/contracts";
import { config } from "./config.js";

/**
 * Error code returned when the service did not answer within the timeout
 * after one same-key retry. The request may still complete on the service
 * side; because the idempotency key is derived from the Discord interaction,
 * a later replay of the same interaction returns the original result instead
 * of creating a second match / funding / vote.
 */
export const STILL_PROCESSING = "still_processing";

export const STILL_PROCESSING_MESSAGE =
  "⏳ Still processing — the game service is taking longer than usual. Your request was not lost and will not be applied twice. Please don't resubmit; check back in a moment.";

/**
 * Stable idempotency key for a Discord-originated request. Discord guarantees
 * interaction/message snowflakes are unique, so every retry of the same
 * interaction (our timeout retry, a gateway redelivery) maps to the same key
 * and the service/DB dedupes it.
 */
export function discordIdempotencyKey(sourceId: string, action: string): string {
  return `discord:${sourceId}:${action}`;
}

/**
 * True when the match was created by the games Worker (create_arcade_match_v1
 * sets arcade_matches.runtime = 'remote'). Rows without the column (pre-
 * migration) or with 'legacy' belong to the in-process legacy path. Each match
 * is driven and settled only by the runtime that created it.
 */
export function isRemoteArcadeMatch(match: object): boolean {
  return (match as { runtime?: string | null }).runtime === "remote";
}

type SignedRequest = {
  method: "GET" | "POST";
  baseUrl: string;
  path: string;
  body: string;
  secret: string;
  idempotencyKey: string;
  /** Retry once with the same key on timeout. Only for services that dedupe on the key. */
  retryOnTimeout?: boolean;
};

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

async function sendOnce<T>(request: SignedRequest, requestId: string): Promise<ServiceResult<T>> {
  const url = new URL(request.path, `${request.baseUrl}/`);
  // Fresh nonce per attempt (the service rejects nonce reuse); requestId and
  // idempotency key stay fixed so the attempts correlate and dedupe.
  const headers = await buildSignedHeaders({
    secret: request.secret,
    method: request.method,
    url,
    body: request.body,
    requestId,
    idempotencyKey: request.idempotencyKey,
  });
  const response = await fetch(url, {
    method: request.method,
    headers,
    body: request.method === "POST" ? request.body : undefined,
    signal: AbortSignal.timeout(config.services.requestTimeoutMs),
  });
  let value: ServiceResult<T>;
  try {
    value = await response.json() as ServiceResult<T>;
  } catch {
    return { ok: false, error: { code: "bad_service_response", message: `Service returned HTTP ${response.status}`, retryable: response.status >= 500 }, requestId };
  }
  if (!response.ok && value.ok) {
    return { ok: false, error: { code: "bad_service_response", message: `Service returned HTTP ${response.status}`, retryable: response.status >= 500 }, requestId };
  }
  return value;
}

async function sendSigned<T>(request: SignedRequest): Promise<ServiceResult<T>> {
  if (!request.secret) {
    return { ok: false, error: { code: "missing_service_secret", message: "The service signing secret is not configured", retryable: false } };
  }
  const requestId = crypto.randomUUID();
  // One same-key retry on timeout: safe because the service dedupes on the
  // idempotency key (a concurrent duplicate waits on the DB advisory lock and
  // then replays the stored response).
  const attempts = request.retryOnTimeout === false ? 1 : 2;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await sendOnce<T>(request, requestId);
    } catch (error) {
      if (isTimeout(error)) continue;
      return { ok: false, error: { code: "service_unavailable", message: error instanceof Error ? error.message : String(error), retryable: true }, requestId };
    }
  }
  return { ok: false, error: { code: STILL_PROCESSING, message: STILL_PROCESSING_MESSAGE, retryable: true }, requestId };
}

/** User-facing text for a failed service call. */
export function serviceErrorMessage(error: { code: string; message: string }): string {
  if (error.code === STILL_PROCESSING) return STILL_PROCESSING_MESSAGE;
  if (error.code === "service_unavailable") return "❌ The game service is unreachable right now. Please try again shortly.";
  return `❌ ${error.message}`;
}

export function sendArcadeCommand(command: ArcadeCommand, idempotencyKey: string): Promise<ServiceResult<{ playUrl?: string; match?: { id: number; status: string; duration_seconds: number } }>> {
  return sendSigned({
    method: "POST", baseUrl: config.services.gamesBaseUrl, path: "/internal/v1/arcade/command",
    body: JSON.stringify(command), secret: config.services.gamesSigningSecret, idempotencyKey,
  });
}

export function sendSatscapeCommand(command: SatscapeCommand, idempotencyKey: string): Promise<ServiceResult<{ playUrl: string; view: Record<string, unknown> }>> {
  return sendSigned({
    method: "POST", baseUrl: config.services.gamesBaseUrl, path: "/internal/v1/satscape/command",
    body: JSON.stringify(command), secret: config.services.gamesSigningSecret, idempotencyKey,
  });
}

export function sendEmulatorVote(vote: EmulatorVote, idempotencyKey: string): Promise<ServiceResult<{ accepted: true; roundId: string }>> {
  return sendSigned({
    method: "POST", baseUrl: config.services.emulatorBaseUrl, path: "/internal/v1/emulator/votes",
    body: JSON.stringify(vote), secret: config.services.emulatorSigningSecret, idempotencyKey,
    // A vote is only useful for the ~500ms round it lands in; a late retry
    // would land in a later round, so never resend. The key is still sent so
    // the emulator can drop gateway/HTTP-level duplicates.
    retryOnTimeout: false,
  });
}

export function getEmulatorStatus(): Promise<ServiceResult<Record<string, unknown>>> {
  return sendSigned({
    method: "GET", baseUrl: config.services.emulatorBaseUrl, path: "/internal/v1/emulator/status",
    body: "", secret: config.services.emulatorSigningSecret, idempotencyKey: `status:${crypto.randomUUID()}`,
    retryOnTimeout: false,
  });
}
