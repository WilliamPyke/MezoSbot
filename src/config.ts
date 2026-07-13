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
    sweepGasSponsorPrivateKey: optional("SWEEP_GAS_SPONSOR_PRIVATE_KEY", ""),
    protocolGasReserveMinSats: parseFloat(optional("PROTOCOL_GAS_RESERVE_MIN_SATS", "1000")),
    explorerUrl: optional("EXPLORER_URL", "https://explorer.mezo.org"),
    skipWithdrawalMin: process.env.SKIP_WITHDRAWAL_MIN === "1" || process.env.SKIP_WITHDRAWAL_MIN === "true",
    tokens: {
      MUSD: {
        contractAddress: optional("MUSD_TOKEN_CONTRACT", "0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186"),
        decimals: parseInt(optional("MUSD_TOKEN_DECIMALS", "18"), 10),
      },
      MEZO: {
        contractAddress: optional("MEZO_TOKEN_CONTRACT", "0x7B7c000000000000000000000000000000000001"),
        decimals: parseInt(optional("MEZO_TOKEN_DECIMALS", "18"), 10),
      },
      MUSDC: {
        contractAddress: optional("MUSDC_TOKEN_CONTRACT", "0x04671C72Aab5AC02A03c1098314b1BB6B560c197"),
        decimals: parseInt(optional("MUSDC_TOKEN_DECIMALS", "6"), 10),
      },
    },
  },
  web: {
    mezoDefaultNetwork: optional(
      "MEZO_DEFAULT_NETWORK",
      optional("MEZO_NETWORK", optional("CHAIN_ID", "31612") === "31611" ? "testnet" : "mainnet")
    ),
    mainnetRpcUrl: optional("MEZO_MAINNET_RPC_URL", optional("RPC_URL", "https://rpc-http.mezo.boar.network")),
    testnetRpcUrl: optional("MEZO_TESTNET_RPC_URL", "https://rpc.test.mezo.org"),
    escrowContractAddress: optional("ESCROW_CONTRACT_ADDRESS", ""),
    escrowMainnetContractAddress: optional("ESCROW_MAINNET_CONTRACT_ADDRESS", ""),
    escrowTestnetContractAddress: optional("ESCROW_TESTNET_CONTRACT_ADDRESS", ""),
    escrowSettlerPrivateKey: optional("ESCROW_SETTLER_PRIVATE_KEY", ""),
    escrowTreasuryAddress: optional("ESCROW_TREASURY_ADDRESS", ""),
    escrowPlatformFeeBps: parseInt(optional("ESCROW_PLATFORM_FEE_BPS", "1000"), 10),
    walletConnectProjectId: optional("WALLETCONNECT_PROJECT_ID", ""),
    sessionSecret: optional("WEB_SESSION_SECRET", process.env.ARCADE_TOKEN_SECRET ?? process.env.TREASURY_PRIVATE_KEY ?? ""),
    joinWindowSeconds: parseInt(optional("WEB_JOIN_WINDOW_SECONDS", "900"), 10),
    playWindowSeconds: parseInt(optional("WEB_PLAY_WINDOW_SECONDS", "180"), 10),
    settlementGraceSeconds: parseInt(optional("WEB_SETTLEMENT_GRACE_SECONDS", "30"), 10),
  },
  depositWebUrl: optional("DEPOSIT_WEB_URL", "https://deposit.mallard.sh/sbot"),
  /**
   * Public base URL of this bot's HTTP server (no trailing slash).
   * Used to build the Slice Arcade browser-play links posted in Discord.
   * Falls back to local dev address if unset.
   */
  publicBaseUrl: publicBaseUrl(),
  arcadeTokenSecret: process.env.ARCADE_TOKEN_SECRET ?? process.env.TREASURY_PRIVATE_KEY ?? "",
  depositAdminOnly: optionalBool("DEPOSIT_ADMIN_ONLY", true),
  deposits: {
    pollMs: parseInt(optional("DEPOSIT_POLL_MS", "60000"), 10),
    addressRefreshMs: parseInt(optional("DEPOSIT_ADDRESS_REFRESH_MS", "900000"), 10),
    balanceConcurrency: parseInt(optional("DEPOSIT_BALANCE_CONCURRENCY", "8"), 10),
    balanceBatchSize: parseInt(optional("DEPOSIT_BALANCE_BATCH_SIZE", "25"), 10),
    initialPollDelayMs: parseInt(optional("DEPOSIT_INITIAL_POLL_DELAY_MS", "15000"), 10),
    erc20SweepDelayMs: parseInt(optional("ERC20_SWEEP_DELAY_MS", "300000"), 10),
    minimums: {
      MUSD: optional("MUSD_MIN_DEPOSIT", "0.10"),
      MEZO: optional("MEZO_MIN_DEPOSIT", "1.00"),
      MUSDC: optional("MUSDC_MIN_DEPOSIT", "0.10"),
    },
  },
  imgnai: {
    baseUrl: optional("IMGNAI_BASE_URL", "https://kat.imgnai.com").replace(/\/+$/, ""),
    x402TargetMusd: optional("IMGNAI_X402_TARGET_MUSD", "1.00"),
    modelCacheMs: parseInt(optional("IMGNAI_MODEL_CACHE_MS", "300000"), 10),
    imageTimeoutMs: parseInt(optional("IMGNAI_IMAGE_TIMEOUT_MS", "600000"), 10),
    promptMaxLength: parseInt(optional("IMGNAI_PROMPT_MAX_LENGTH", "2000"), 10),
  },
  walletVerification: {
    challengeSats: parseFloat(optional("WALLET_VERIFY_CHALLENGE_SATS", "10")),
    challengeHours: parseInt(optional("WALLET_VERIFY_CHALLENGE_HOURS", "24"), 10),
    scanBlocks: parseInt(optional("WALLET_VERIFY_SCAN_BLOCKS", "300"), 10),
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
  quests: {
    /** Delete duplicate target-link posts in quest channels for N minutes after a claim (0 = off). */
    linkDuplicateDeleteMinutes: parseInt(optional("QUEST_LINK_DUPLICATE_DELETE_MINUTES", "5"), 10),
  },
  satscape: {
    /** Discord IDs allowed to toggle SatScape god/admin mode (CSV). Distinct from ADMIN_IDS. */
    adminIds: (process.env.SATSCAPE_ADMIN_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  },
  ledger: {
    guildId: optional("LEDGER_GUILD_ID", ""),
    channelId: optional("LEDGER_CHANNEL_ID", ""),
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
