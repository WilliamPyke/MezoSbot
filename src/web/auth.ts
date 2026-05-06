import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ethers } from "ethers";
import { config } from "../config.js";
import { supabase } from "../db.js";

const COOKIE_NAME = "mallard_session";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export type WalletSession = {
  address: string;
  chainId: number;
  issuedAt: number;
};

export function normalizeWalletAddress(address: string): string {
  return ethers.getAddress(address).toLowerCase();
}

export function makeLoginMessage(input: {
  address: string;
  chainId: number;
  nonce: string;
  issuedAt: string;
}): string {
  return [
    "Mallard Arcade",
    "",
    "Sign in to create and play wallet-backed Mezo game sessions.",
    "",
    `Address: ${ethers.getAddress(input.address)}`,
    `Chain ID: ${input.chainId}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt}`,
  ].join("\n");
}

export async function createNonce(address: string, chainId: number) {
  const normalized = normalizeWalletAddress(address);
  const nonce = randomBytes(16).toString("hex");
  const issuedAt = new Date().toISOString();
  const message = makeLoginMessage({ address: normalized, chainId, nonce, issuedAt });

  const { error } = await supabase.from("web_auth_nonces").insert({
    nonce,
    wallet_address: normalized,
    chain_id: chainId,
    message,
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });
  if (error) throw new Error(`Could not create login nonce: ${error.message}`);

  return { nonce, message, issuedAt };
}

export async function verifyLogin(input: {
  address: string;
  chainId: number;
  nonce: string;
  signature: string;
}) {
  const normalized = normalizeWalletAddress(input.address);
  const { data, error } = await supabase
    .from("web_auth_nonces")
    .select("*")
    .eq("nonce", input.nonce)
    .eq("wallet_address", normalized)
    .eq("chain_id", input.chainId)
    .is("used_at", null)
    .maybeSingle();

  if (error) throw new Error(`Could not read login nonce: ${error.message}`);
  if (!data) return { ok: false as const, error: "Login challenge was not found or was already used" };
  if (Date.parse(data.expires_at) < Date.now()) {
    return { ok: false as const, error: "Login challenge expired" };
  }

  const recovered = normalizeWalletAddress(ethers.verifyMessage(data.message, input.signature));
  if (recovered !== normalized) return { ok: false as const, error: "Signature does not match wallet" };

  await supabase
    .from("web_auth_nonces")
    .update({ used_at: new Date().toISOString() })
    .eq("nonce", input.nonce);

  return { ok: true as const, session: { address: normalized, chainId: input.chainId, issuedAt: Date.now() } };
}

export function setSessionCookie(res: ServerResponse, session: WalletSession) {
  const token = signSession(session);
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${token}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; SameSite=Lax`
  );
}

export function clearSessionCookie(res: ServerResponse) {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
}

export function readSession(req: IncomingMessage): WalletSession | null {
  const token = parseCookies(req.headers.cookie ?? "")[COOKIE_NAME];
  if (!token) return null;
  return verifySessionToken(token);
}

function signSession(session: WalletSession): string {
  const payload = base64Url(JSON.stringify(session));
  const signature = hmac(payload);
  return `${payload}.${signature}`;
}

function verifySessionToken(token: string): WalletSession | null {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = hmac(payload);
  const sig = Buffer.from(signature);
  const exp = Buffer.from(expected);
  if (sig.length !== exp.length || !timingSafeEqual(sig, exp)) return null;

  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as WalletSession;
    if (!session.address || !session.chainId || !session.issuedAt) return null;
    if (Date.now() - session.issuedAt > SESSION_TTL_SECONDS * 1000) return null;
    return { ...session, address: normalizeWalletAddress(session.address) };
  } catch {
    return null;
  }
}

function hmac(payload: string): string {
  const secret = config.web.sessionSecret || "mallard-dev-session-secret";
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function base64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (!rawKey || rawValue.length === 0) continue;
    out[rawKey] = decodeURIComponent(rawValue.join("="));
  }
  return out;
}
