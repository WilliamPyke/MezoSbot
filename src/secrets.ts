import { randomBytes } from "node:crypto";

const ephemeral = new Map<string, string>();

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/^0x/, "");
}

/**
 * HMAC secret for tokens and sessions. Uses the configured value unless it is
 * empty or reuses a wallet private key; otherwise a random per-process secret,
 * so links and sessions expire on restart instead of being forgeable. Never a
 * private key and never a public default string.
 */
export function hmacSecret(name: string, configured: string | undefined): string {
  const value = (configured ?? "").trim();
  const keys = [process.env.TREASURY_PRIVATE_KEY, process.env.SWEEP_GAS_SPONSOR_PRIVATE_KEY]
    .filter((key): key is string => !!key && key.trim().length > 0)
    .map(normalizeKey);
  if (value && !keys.includes(normalizeKey(value))) return value;

  let secret = ephemeral.get(name);
  if (!secret) {
    secret = randomBytes(32).toString("hex");
    ephemeral.set(name, secret);
    console.warn(
      `[Security] ${name} is ${value ? "a wallet private key" : "not set"}; using a random per-process secret. ` +
      `Set ${name} to a dedicated random value so links and sessions survive restarts.`,
    );
  }
  return secret;
}
