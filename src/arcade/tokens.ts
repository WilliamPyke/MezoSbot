import crypto from "node:crypto";
import { config } from "../config.js";

/**
 * HMAC-signed match-access token.
 *
 * Embedded in /arcade/play?t=<token>. The token authorises one Discord user
 * to act as one player in one match for a limited time. No DB lookup needed
 * to verify — the signature proves the bot issued it.
 *
 * Format: base64url(`${matchId}.${userId}.${expiresMs}`) + "." + sigPrefix
 */

const SIG_LEN = 24;
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // Keeps browser rematch chains alive without returning to Discord.

function secret(): string {
  return config.arcadeTokenSecret || "mezosbot-arcade-default-secret-change-me";
}

function sign(payload: string): string {
  return crypto.createHmac("sha256", secret()).update(payload).digest("base64url").slice(0, SIG_LEN);
}

export function issueMatchToken(matchId: number, userId: string, ttlMs = DEFAULT_TTL_MS): string {
  const payload = `${matchId}.${userId}.${Date.now() + ttlMs}`;
  const sig = sign(payload);
  return Buffer.from(payload, "utf8").toString("base64url") + "." + sig;
}

export type MatchTokenClaim = {
  matchId: number;
  userId: string;
  expiresAt: number;
};

export function verifyMatchToken(token: string | null | undefined): MatchTokenClaim | null {
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
  if (parts.length !== 3) return null;
  const matchId = parseInt(parts[0], 10);
  const userId = parts[1];
  const expiresAt = parseInt(parts[2], 10);
  if (!Number.isFinite(matchId) || !userId || !Number.isFinite(expiresAt)) return null;
  if (Date.now() > expiresAt) return null;
  return { matchId, userId, expiresAt };
}
