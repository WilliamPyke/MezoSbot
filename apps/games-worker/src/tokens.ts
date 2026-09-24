import { signCanonicalRequest, verifyCanonicalRequest } from "@mezosbot/contracts";

type PlayToken = { sub: string; game: "arcade" | "satscape"; exp: number; matchId?: number };

function encode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function decode(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

export async function issuePlayToken(secret: string, token: PlayToken): Promise<string> {
  const payload = encode(JSON.stringify(token));
  return `${payload}.${await signCanonicalRequest(secret, payload)}`;
}

export async function verifyPlayToken(
  secret: string,
  value: string | null,
  game?: PlayToken["game"],
  now = Date.now(),
): Promise<PlayToken | null> {
  if (!value) return null;
  const [payload, signature] = value.split(".");
  if (!payload || !signature || !(await verifyCanonicalRequest(secret, payload, signature))) return null;
  try {
    const parsed = JSON.parse(decode(payload)) as Record<string, unknown>;
    if (typeof parsed.sub !== "string" || parsed.sub.length === 0) return null;
    if (parsed.game !== "arcade" && parsed.game !== "satscape") return null;
    // A token without a finite numeric expiry never validates.
    if (typeof parsed.exp !== "number" || !Number.isFinite(parsed.exp) || parsed.exp < now) return null;
    if (parsed.matchId !== undefined && !Number.isSafeInteger(parsed.matchId)) return null;
    if (game && parsed.game !== game) return null;
    return { sub: parsed.sub, game: parsed.game, exp: parsed.exp, matchId: parsed.matchId as number | undefined };
  } catch {
    return null;
  }
}
