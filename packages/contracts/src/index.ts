export const CONTRACT_VERSION = 1 as const;

export type ArcadeCommand = {
  version: typeof CONTRACT_VERSION;
  domain: "arcade";
  action:
    | "create_practice"
    | "create_challenge"
    | "create_offer"
    | "create_tipfight"
    | "accept"
    | "cancel"
    | "status"
    | "leaderboard";
  actorId: string;
  guildId?: string;
  channelId?: string;
  matchId?: number;
  opponentId?: string;
  stakeSats?: number;
  durationMinutes?: number;
};

export type SatscapeCommand = {
  version: typeof CONTRACT_VERSION;
  domain: "satscape";
  action: "join" | "status" | "open_map" | "open_shop" | "open_quests";
  actorId: string;
  profileId?: string;
};

export type EmulatorButton = "A" | "B" | "UP" | "DOWN" | "LEFT" | "RIGHT" | "START" | "SELECT";

export type EmulatorVote = {
  version: typeof CONTRACT_VERSION;
  domain: "emulator";
  actorId: string;
  button: EmulatorButton;
  amountSats: number;
};

export type ServiceError = {
  code: string;
  message: string;
  retryable: boolean;
  requestId?: string;
};

export type ServiceResult<T> =
  | { ok: true; value: T; requestId?: string }
  | { ok: false; error: ServiceError; requestId?: string };

export type ArcadeMatchSettledEvent = {
  version: typeof CONTRACT_VERSION;
  type: "arcade.match_settled";
  eventId: string;
  occurredAt: string;
  matchId: number;
  winnerId: string | null;
  channelId: string | null;
};

export type EmulatorRoundResolvedEvent = {
  version: typeof CONTRACT_VERSION;
  type: "emulator.round_resolved";
  eventId: string;
  occurredAt: string;
  winningButton: EmulatorButton;
  winningSats: number;
  winnerIds: string[];
};

export type GameEvent = ArcadeMatchSettledEvent | EmulatorRoundResolvedEvent;

export type SignedRequestHeaders = {
  timestamp: string;
  nonce: string;
  requestId: string;
  idempotencyKey: string;
  signature: string;
};

const BUTTONS = new Set<EmulatorButton>(["A", "B", "UP", "DOWN", "LEFT", "RIGHT", "START", "SELECT"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || isNonEmptyString(value);
}

function isOptionalFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

export function isArcadeCommand(value: unknown): value is ArcadeCommand {
  if (!isRecord(value) || value.version !== 1 || value.domain !== "arcade" || !isNonEmptyString(value.actorId)) return false;
  if (!["create_practice", "create_challenge", "create_offer", "create_tipfight", "accept", "cancel", "status", "leaderboard"].includes(String(value.action))) return false;
  return isOptionalString(value.guildId) && isOptionalString(value.channelId) && isOptionalString(value.opponentId) &&
    isOptionalFiniteNumber(value.matchId) && isOptionalFiniteNumber(value.stakeSats) && isOptionalFiniteNumber(value.durationMinutes);
}

export function isSatscapeCommand(value: unknown): value is SatscapeCommand {
  return isRecord(value) && value.version === 1 && value.domain === "satscape" && isNonEmptyString(value.actorId) &&
    ["join", "status", "open_map", "open_shop", "open_quests"].includes(String(value.action)) && isOptionalString(value.profileId);
}

export function isEmulatorVote(value: unknown): value is EmulatorVote {
  return isRecord(value) && value.version === 1 && value.domain === "emulator" && isNonEmptyString(value.actorId) &&
    BUTTONS.has(value.button as EmulatorButton) && typeof value.amountSats === "number" && Number.isFinite(value.amountSats) && value.amountSats > 0;
}

export function isGameEvent(value: unknown): value is GameEvent {
  if (!isRecord(value) || value.version !== 1 || !isNonEmptyString(value.eventId) || !isNonEmptyString(value.occurredAt)) return false;
  if (value.type === "arcade.match_settled") {
    return typeof value.matchId === "number" && (value.winnerId === null || isNonEmptyString(value.winnerId)) &&
      (value.channelId === null || isNonEmptyString(value.channelId));
  }
  return value.type === "emulator.round_resolved" && BUTTONS.has(value.winningButton as EmulatorButton) &&
    typeof value.winningSats === "number" && Array.isArray(value.winnerIds) && value.winnerIds.every(isNonEmptyString);
}

export function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(value: string): Promise<string> {
  return bytesToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

export function canonicalRequest(input: {
  method: string;
  path: string;
  bodyHash: string;
  timestamp: string;
  nonce: string;
  requestId: string;
  idempotencyKey: string;
}): string {
  return [
    input.method.toUpperCase(),
    input.path,
    input.bodyHash,
    input.timestamp,
    input.nonce,
    input.requestId,
    input.idempotencyKey,
  ].join("\n");
}

async function importHmacKey(secret: string, usage: KeyUsage): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

export async function signCanonicalRequest(secret: string, canonical: string): Promise<string> {
  const key = await importHmacKey(secret, "sign");
  return bytesToHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonical)));
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[a-f0-9]{64}$/i.test(hex)) return null;
  const output = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let index = 0; index < output.length; index += 1) output[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return output;
}

export async function verifyCanonicalRequest(secret: string, canonical: string, signature: string): Promise<boolean> {
  const bytes = hexToBytes(signature);
  if (!bytes) return false;
  const key = await importHmacKey(secret, "verify");
  return crypto.subtle.verify("HMAC", key, bytes, new TextEncoder().encode(canonical));
}

export function readSignedHeaders(headers: Headers): SignedRequestHeaders | null {
  const value: SignedRequestHeaders = {
    timestamp: headers.get("x-mezo-timestamp") ?? "",
    nonce: headers.get("x-mezo-nonce") ?? "",
    requestId: headers.get("x-request-id") ?? "",
    idempotencyKey: headers.get("idempotency-key") ?? "",
    signature: headers.get("x-mezo-signature") ?? "",
  };
  return Object.values(value).every(isNonEmptyString) ? value : null;
}

export async function buildSignedHeaders(input: {
  secret: string;
  method: string;
  url: URL | string;
  body: string;
  requestId?: string;
  idempotencyKey?: string;
  timestampMs?: number;
  nonce?: string;
}): Promise<Headers> {
  const url = typeof input.url === "string" ? new URL(input.url) : input.url;
  const timestamp = String(input.timestampMs ?? Date.now());
  const nonce = input.nonce ?? crypto.randomUUID();
  const requestId = input.requestId ?? crypto.randomUUID();
  const idempotencyKey = input.idempotencyKey ?? requestId;
  const bodyHash = await sha256Hex(input.body);
  const canonical = canonicalRequest({ method: input.method, path: url.pathname, bodyHash, timestamp, nonce, requestId, idempotencyKey });
  const signature = await signCanonicalRequest(input.secret, canonical);
  return new Headers({
    "content-type": "application/json",
    "x-mezo-timestamp": timestamp,
    "x-mezo-nonce": nonce,
    "x-request-id": requestId,
    "idempotency-key": idempotencyKey,
    "x-mezo-signature": signature,
  });
}

export async function verifySignedRequest(input: {
  secret: string;
  method: string;
  url: URL | string;
  body: string;
  headers: Headers;
  nowMs?: number;
  maxSkewMs?: number;
}): Promise<{ ok: true; headers: SignedRequestHeaders } | { ok: false; reason: string }> {
  const signed = readSignedHeaders(input.headers);
  if (!signed) return { ok: false, reason: "missing_signature_headers" };
  const timestampMs = Number(signed.timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs((input.nowMs ?? Date.now()) - timestampMs) > (input.maxSkewMs ?? 60_000)) {
    return { ok: false, reason: "timestamp_out_of_range" };
  }
  const url = typeof input.url === "string" ? new URL(input.url) : input.url;
  const canonical = canonicalRequest({
    method: input.method,
    path: url.pathname,
    bodyHash: await sha256Hex(input.body),
    timestamp: signed.timestamp,
    nonce: signed.nonce,
    requestId: signed.requestId,
    idempotencyKey: signed.idempotencyKey,
  });
  return await verifyCanonicalRequest(input.secret, canonical, signed.signature)
    ? { ok: true, headers: signed }
    : { ok: false, reason: "bad_signature" };
}
