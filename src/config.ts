import "dotenv/config";

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env: ${key}`);
  return val;
}

function optional(key: string, def: string): string {
  return process.env[key] ?? def;
}

function optionalBool(key: string, def: boolean): boolean {
  const val = process.env[key];
  if (val === undefined) return def;
  return val === "1" || val.toLowerCase() === "true";
}

function publicBaseUrl(): string {
  const fallback = `http://localhost:${process.env.STREAM_PORT ?? process.env.PORT ?? "8787"}`;
  const raw = (process.env.PUBLIC_BASE_URL ?? fallback).trim().replace(/\/+$/, "");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw;

  const host = raw.split("/")[0].toLowerCase();
  const local = host === "localhost" || host.startsWith("localhost:") ||
    host === "127.0.0.1" || host.startsWith("127.0.0.1:") ||
    host === "0.0.0.0" || host.startsWith("0.0.0.0:");
  return `${local ? "http" : "https"}://${raw}`;
}

export const config = {
  discord: {
    token: required("DISCORD_TOKEN"),
    clientId: required("DISCORD_CLIENT_ID"),
    adminIds: (process.env.ADMIN_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    guildMembersIntent: optionalBool("DISCORD_GUILD_MEMBERS_INTENT", false),
    messageContentIntent: optionalBool("DISCORD_MESSAGE_CONTENT_INTENT", false),
  },
  supabase: {
    url: required("SUPABASE_URL"),
    serviceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
  },
  evm: {
    rpcUrl: required("RPC_URL"),
    chainId: parseInt(optional("CHAIN_ID", "31612"), 10),
    tokenContract: required("TOKEN_CONTRACT"),
    tokenDecimals: parseInt(optional("TOKEN_DECIMALS", "18"), 10),
    treasuryPrivateKey: required("TREASURY_PRIVATE_KEY"),
    explorerUrl: optional("EXPLORER_URL", "https://explorer.mezo.org"),
    skipWithdrawalMin: process.env.SKIP_WITHDRAWAL_MIN === "1" || process.env.SKIP_WITHDRAWAL_MIN === "true",
  },
  depositWebUrl: optional("DEPOSIT_WEB_URL", "https://deposit.mallard.sh/sbot"),
  /**
   * Public base URL of this bot's HTTP server (no trailing slash).
   * Used to build the Slice Arcade browser-play links posted in Discord.
   * Falls back to local dev address if unset.
   */
  publicBaseUrl: publicBaseUrl(),
  arcadeTokenSecret: process.env.ARCADE_TOKEN_SECRET ?? process.env.TREASURY_PRIVATE_KEY ?? "",
  depositAdminOnly: process.env.DEPOSIT_ADMIN_ONLY === "1" || process.env.DEPOSIT_ADMIN_ONLY === "true",
  deposits: {
    pollMs: parseInt(optional("DEPOSIT_POLL_MS", "60000"), 10),
    addressRefreshMs: parseInt(optional("DEPOSIT_ADDRESS_REFRESH_MS", "900000"), 10),
    balanceConcurrency: parseInt(optional("DEPOSIT_BALANCE_CONCURRENCY", "8"), 10),
    balanceBatchSize: parseInt(optional("DEPOSIT_BALANCE_BATCH_SIZE", "25"), 10),
    initialPollDelayMs: parseInt(optional("DEPOSIT_INITIAL_POLL_DELAY_MS", "15000"), 10),
  },
  gameboy: {
    enabled: optionalBool("POKEMON_ENABLED", true),
    textInputEnabled: optionalBool("POKEMON_TEXT_INPUT_ENABLED", false),
    /** Text channel where users type button names to play */
    gameChannelId: optional("GB_CHANNEL_ID", ""),
    romPath: optional("ROM_PATH", ""),
    /** Minimum sats to bid per input */
    minBid: parseFloat(optional("GB_MIN_BID", "0.001")),
    /** Democracy round duration in ms — votes collected, button with highest total sats wins */
    roundMs: parseInt(optional("GB_ROUND_MS", "500"), 10),
    /** Full snapshot auto-save interval in ms */
    snapshotIntervalMs: parseInt(optional("GB_SNAPSHOT_INTERVAL_MS", "300000"), 10),
  },
  streaming: {
    port: parseInt(optional("STREAM_PORT", optional("PORT", "8787")), 10),
    targetFps: parseInt(optional("STREAM_TARGET_FPS", "30"), 10),
    minFps: parseInt(optional("STREAM_MIN_FPS", "20"), 10),
    maxFps: parseInt(optional("STREAM_MAX_FPS", "60"), 10),
    viewerScale: parseInt(optional("STREAM_VIEWER_SCALE", "4"), 10),
    autoTune: process.env.STREAM_AUTO_TUNE !== "0" && process.env.STREAM_AUTO_TUNE !== "false",
    stunServers: (process.env.STUN_SERVERS ?? "stun:stun.l.google.com:19302")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  },
};

/**
 * 1 BTC = 100,000,000 sats.
 * With 18-decimal BTC on EVM: 1 sat = 10^10 wei.
 * Preserves sub-sat precision (e.g. 0.5 sats, 0.0001 sats).
 */
export function tokenUnitsToSats(units: bigint): number {
  const decimals = BigInt(config.evm.tokenDecimals);
  if (decimals >= 8n) {
    const divisor = 10n ** (decimals - 8n); // 10^10 for 18 decimals
    const wholeSats = units / divisor;
    const remainder = units % divisor;
    return Number(wholeSats) + Number(remainder) / Number(divisor);
  }
  return Number(units * 10n ** (8n - decimals));
}

/**
 * Sats (number, supports floats like 0.5) to token units (bigint) for EVM transfers.
 * Uses string-based conversion to avoid floating-point drift at high precision.
 * With 18-decimal BTC: 1 sat = 10^10 wei.
 */
export function satsToTokenUnits(sats: number): bigint {
  if (sats <= 0) return 0n;
  // Convert to a fixed-point string with 10 decimal places (SATS_PRECISION)
  const satsFixed = sats.toFixed(10); // e.g. "0.5000000000"
  const [intStr, fracStr] = satsFixed.split(".");
  // Combine into a single scaled integer: sats * 10^10
  const scaledSats = BigInt(intStr + fracStr);
  // wei = sats * 10^(decimals - 8)
  // scaledSats = sats * 10^10
  // So: wei = scaledSats * 10^(decimals - 8 - 10) = scaledSats * 10^(decimals - 18)
  const exp = BigInt(config.evm.tokenDecimals) - 18n;
  if (exp >= 0n) return scaledSats * 10n ** exp;
  return scaledSats / 10n ** (-exp);
}
