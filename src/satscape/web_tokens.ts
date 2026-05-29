import crypto from "node:crypto";
import { config } from "../config.js";

/**
 * HMAC-signed browser-play token for SatScape.
 *
 * Embedded in /satscape/play?t=<token>. Authorises one Discord user to play in
 * the browser for a limited time. No DB lookup needed to verify — the signature
 * proves the bot issued it. Same HMAC scheme as the arcade token (src/arcade/tokens.ts),
 * but the payload is just the user id (SatScape has no per-match concept).
 *
 * Format: base64url(`${userId}.${expiresMs}`) + "." + sigPrefix
 */

const SIG_LEN = 24;
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — long-lived so the tab keeps working.

function secret(): string {
  return config.arcadeTokenSecret || "mezosbot-arcade-default-secret-change-me";
}

function sign(payload: string): string {
  return crypto.createHmac("sha256", secret()).update(payload).digest("base64url").slice(0, SIG_LEN);
}

export function issuePlayToken(userId: string, ttlMs = DEFAULT_TTL_MS): string {
  const payload = `${userId}.${Date.now() + ttlMs}`;
  return Buffer.from(payload, "utf8").toString("base64url") + "." + sign(payload);
}

export interface PlayTokenClaim {
  userId: string;
  expiresAt: number;
}

export function verifyPlayToken(token: string | null | undefined): PlayTokenClaim | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const b64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let payload: string;
  try {
    payload = Buffer.from(b64, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const expected = sign(payload);
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const parts = payload.split(".");
  if (parts.length !== 2) return null;
  const userId = parts[0];
  const expiresAt = parseInt(parts[1], 10);
  if (!userId || !Number.isFinite(expiresAt)) return null;
  if (Date.now() > expiresAt) return null;
  return { userId, expiresAt };
}

/** Build the browser-play URL posted in Discord (mirrors arcade's buildPlayUrl). */
export function buildSatscapePlayUrl(userId: string): string {
  const token = issuePlayToken(userId);
  return `${config.publicBaseUrl}/satscape/play?t=${encodeURIComponent(token)}`;
}
