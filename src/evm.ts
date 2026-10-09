import { randomUUID } from "node:crypto";
import { ethers } from "ethers";
import { config, satsToTokenUnits, tokenUnitsToSats } from "./config.js";
import { supabase } from "./db.js";
import { roundSats } from "./format.js";
import { recordLedgerEntry } from "./ledger.js";
import { verifyWalletFromDeposit } from "./walletVerification.js";
import { CUSTODY_PAUSED_MESSAGE, isCompromisedAddress } from "./custody/compromised.js";
import { registerForwarderAddress, startForwarderDeposits } from "./custody/deposits.js";
import { getHoldingsUnits } from "./custody/holdings.js";
import {
  expectedPayoutForRow,
  explainRevertedPayout,
  gatherPayoutProof,
  isRefPaid,
  payoutRef,
  planPayout,
} from "./custody/payout.js";
import {
  DAY_MS,
  checkUserDailyCap,
  encodePayoutCall,
  isPayoutAnomaly,
  sumRecentSatsWithdrawals,
  withdrawalDestinationProblem,
  type V2Settings,
} from "./custody/policy.js";
import { freezeCustody } from "./custody/watchdog.js";
import { withdrawalKey } from "./custody/watchdogCore.js";
import { recordSignedTx } from "./custody/signing.js";
import {
  assertCanSign,
  getConfiguredV2Settings,
  isRuntimeCompromised,
  getCustodyMode,
  getOperatorWallet,
  getSweepGasWallet,
  getV2Settings,
  isCustodyFrozen,
  withdrawalsBlockedMessage,
} from "./custody/state.js";
import {
  explainWithdrawalOutcome,
  isDefiniteDbFailure,
  meetsPublicDepositMinimum,
  nextSweepTime,
  pollWithdrawalOutcome,
  preservesGasReserve,
  satsBackingShortfallWei,
  satsExitAllowed,
  satsMintCovered,
  satsWithdrawalCovered,
  sumInFlightSatsLiabilities,
  withdrawalGasFundingShortfall,
  type InFlightSatsLiabilities,
  type WithdrawalObservation,
  type WithdrawalOutcome,
  type WithdrawalOutcomeReason,
  type WithdrawalReceiptLike,
} from "./depositPolicy.js";
import { TOKEN_SYMBOLS, assertTokenConfigured, tokenAmountToUnits, tokenDecimalToUnits, tokenUnitsToAmount, type TokenSymbol } from "./tokens.js";

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
];
const ERC20_INTERFACE = new ethers.Interface(ERC20_ABI);

let provider: ethers.JsonRpcProvider;
/** Legacy treasury hot wallet; null when TREASURY_PRIVATE_KEY is unset (custody v2). */
let wallet: ethers.Wallet | null = null;
/** Legacy (v1) ERC-20 sweep/withdrawal gas sponsor; null without a treasury or sponsor key. */
let sweepGasSponsorWallet: ethers.Wallet | null = null;
let lastSweepGasError: string | null = null;

export function getProvider() {
  return provider;
}

/**
 * Raw JSON-RPC call that bypasses ethers.js batching.
 * The Mezo RPC occasionally wraps single responses in a batch array
 * (e.g. `[{"jsonrpc":"2.0","result":{...}}]`), which causes ethers v6 to
 * throw BAD_DATA.  This helper unwraps the array before parsing.
 */
let depositRpcQueue: Promise<void> = Promise.resolve();
let nextDepositRpcAt = 0;

async function waitForDepositRpcSlot(): Promise<void> {
  const requestsPerSecond = clampPositiveInt(config.deposits.rpcRequestsPerSecond, 8);
  const intervalMs = Math.ceil(1000 / requestsPerSecond);
  const slot = depositRpcQueue.then(async () => {
    const waitMs = Math.max(0, nextDepositRpcAt - Date.now());
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    nextDepositRpcAt = Date.now() + intervalMs;
  });
  depositRpcQueue = slot.catch(() => {});
  await slot;
}

async function rawRpcCall(
  method: string,
  params: unknown[],
  options: { rateLimited?: boolean } = {},
): Promise<unknown> {
  const attempts = 4;
  let lastError: unknown = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      if (options.rateLimited) await waitForDepositRpcSlot();
      const res = await fetch(config.evm.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      });

      const text = await res.text();
      if (!res.ok) {
        throw new Error(`RPC HTTP ${res.status}: ${text.slice(0, 200)}`);
      }

      const data: unknown = text ? JSON.parse(text) : null;
      const item = Array.isArray(data) ? data[0] : data;
      const rpc = item as { error?: { message?: string; code?: unknown; data?: unknown }; result?: unknown };
      if (rpc.error) {
        const rpcError = new Error(rpc.error.message ?? JSON.stringify(rpc.error)) as RpcError;
        rpcError.rpcError = true;
        rpcError.code = rpc.error.code;
        rpcError.data = rpc.error.data;
        throw rpcError;
      }
      return rpc.result ?? null;
    } catch (err) {
      lastError = err;
      if ((err as RpcError)?.rpcError) throw err;
      if (attempt === attempts - 1) break;
      await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
    }
  }

  throw lastError;
}

/** The legacy treasury signer. Only legacy-mode code paths call this. */
function treasury(): ethers.Wallet {
  if (!wallet) throw new Error("No legacy treasury key is configured (TREASURY_PRIVATE_KEY)");
  return wallet;
}

export function getTreasuryAddress(): string {
  return treasury().address;
}

/** Legacy treasury address, or null without TREASURY_PRIVATE_KEY. Read-only uses only. */
export function getLegacyTreasuryAddress(): string | null {
  return wallet?.address ?? null;
}

let treasuryCompromised = false;

/** True when TREASURY_PRIVATE_KEY belongs to a known-compromised address. */
export function isTreasuryCompromised(): boolean {
  return treasuryCompromised;
}

/**
 * The treasury hot wallet may sign (on-chain swaps, rebalancing, v1 sweeps)
 * only in legacy mode. Custody v2 has no treasury signer at all.
 */
export function treasurySignerAvailable(): boolean {
  return getCustodyMode() === "legacy" && !!wallet && !treasuryCompromised;
}

export class CustodyPausedError extends Error {
  constructor(message: string = CUSTODY_PAUSED_MESSAGE) {
    super(message);
    this.name = "CustodyPausedError";
  }
}

/**
 * Refuses any v1 action that signs with or derives from the treasury key:
 * v1 deposit addresses and sweeps. Allowed only in legacy mode.
 */
export function assertCustodyAvailable(): void {
  if (!treasurySignerAvailable()) throw new CustodyPausedError();
}

export function getTreasurySigner(): ethers.Wallet {
  if (!treasurySignerAvailable()) throw new CustodyPausedError();
  return treasury();
}

/**
 * Wallet that pays deposit-sweep gas: SWEEP_GAS_PRIVATE_KEY in v2, the v1
 * sponsor in legacy mode. Never surfaced while custody is paused (the v1
 * sponsor then derives from a retired key).
 */
export function getSweepGasSponsorAddress(): string {
  const mode = getCustodyMode();
  const v2 = mode === "v2" ? getSweepGasWallet() : null;
  if (v2) return v2.address;
  if (mode !== "legacy" || !sweepGasSponsorWallet) throw new Error("No sweep gas wallet is available while custody is paused");
  return sweepGasSponsorWallet.address;
}

function sweepSponsor(): ethers.Wallet {
  if (!sweepGasSponsorWallet) throw new Error("No v1 sweep gas sponsor is configured");
  return sweepGasSponsorWallet;
}

/** Exported for swap gas quotes and other protocol ops that share Mezo RPC helpers. */
export { rawRpcCall, addGasLimitBuffer };

export async function getGasPriceWei(): Promise<bigint> {
  return getGasPrice();
}

export function initEVM() {
  const network = { chainId: config.evm.chainId, name: "mezo" };
  provider = new ethers.JsonRpcProvider(config.evm.rpcUrl, network, {
    staticNetwork: true,
    batchMaxCount: 1,
  });
  // A malformed key is ignored (custody stays paused), never a crash.
  try {
    wallet = config.evm.treasuryPrivateKey ? new ethers.Wallet(config.evm.treasuryPrivateKey, provider) : null;
  } catch {
    console.error("[Custody] TREASURY_PRIVATE_KEY is not a valid private key; it is ignored.");
    wallet = null;
  }
  let sponsorKeyWallet: ethers.Wallet | null = null;
  try {
    sponsorKeyWallet = config.evm.sweepGasSponsorPrivateKey ? new ethers.Wallet(config.evm.sweepGasSponsorPrivateKey, provider) : null;
  } catch {
    console.error("[Custody] SWEEP_GAS_SPONSOR_PRIVATE_KEY is not a valid private key; it is ignored.");
  }
  if (sponsorKeyWallet) {
    sweepGasSponsorWallet = sponsorKeyWallet;
  } else if (wallet) {
    const derivedSweepSponsorKey = ethers.keccak256(ethers.toUtf8Bytes(
      `mezosbot-sweep-gas-sponsor-v1:${config.evm.treasuryPrivateKey}`,
    ));
    sweepGasSponsorWallet = new ethers.Wallet(derivedSweepSponsorKey, provider);
    if (getCustodyMode() === "legacy") {
      console.log(`[Deposits] Using derived sweep gas sponsor ${sweepGasSponsorWallet.address}`);
    }
  }
  treasuryCompromised = !!wallet && isCompromisedAddress(wallet.address);
  if (treasuryCompromised && wallet) {
    console.error(
      `[Custody] TREASURY_PRIVATE_KEY belongs to compromised address ${wallet.address}. ` +
      "It is never used to move funds; remove it from the environment once custody v2 runs.",
    );
  }
  if (isCompromisedAddress(config.web.escrowTreasuryAddress)) {
    console.error("[Custody] ESCROW_TREASURY_ADDRESS is the compromised treasury address; point it at the vault.");
  }

  provider.on("error", () => {});

  return { provider, wallet };
}

/**
 * Derive a unique deposit wallet for a Discord user.
 * Deterministic: same user always gets the same address.
 */
export function getUserDepositWallet(discordId: string): ethers.Wallet {
  if (!config.evm.treasuryPrivateKey) throw new Error("v1 deposit addresses need TREASURY_PRIVATE_KEY");
  const seed = `mezosbot-deposit-v1:${config.evm.treasuryPrivateKey}:${discordId}`;
  const derivedKey = ethers.keccak256(ethers.toUtf8Bytes(seed));
  return new ethers.Wallet(derivedKey, provider);
}

/** Get the unique deposit address for a user */
export function getUserDepositAddress(discordId: string): string {
  return getUserDepositWallet(discordId).address;
}

type DepositAddressRow = {
  discord_id: string;
  address: string;
  last_checked_balance: string | null;
  deposits_enabled: boolean;
  native_sweep_tx_hash: string | null;
  native_sweep_balance: string | null;
  native_sweep_started_at: string | null;
};

type RpcError = Error & { rpcError?: boolean; code?: unknown; data?: unknown };

/** Per-attempt timeout for a JSON-RPC request; rawRpcCall retries transport failures. */
const RPC_TIMEOUT_MS = 15_000;

const depositAddressCache = new Map<string, DepositAddressRow>();
const depositRegistrationPromises = new Map<string, Promise<string>>();
const sweepPromises = new Map<string, Promise<string | null>>();
let depositAddressCacheLoadedAt = 0;
let depositAddressCacheRefresh: Promise<void> | null = null;
const depositTokenBalanceCache = new Map<string, bigint>();
const depositTokenSweepAfterCache = new Map<string, number | null>();
const erc20SweepPromises = new Map<string, Promise<string | null>>();
let depositTokenCacheLoadedAt = 0;
let depositTokenCacheRefresh: Promise<void> | null = null;
const depositWarningLastLoggedAt = new Map<string, number>();
const depositWarningSuppressed = new Map<string, number>();
const DEPOSIT_UPDATE_BATCH_SIZE = 500;
const DEPOSIT_WARNING_INTERVAL_MS = 15 * 60_000;

function clampPositiveInt(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function warnDepositOnce(key: string, message: string): void {
  const now = Date.now();
  const last = depositWarningLastLoggedAt.get(key) ?? 0;
  if (now - last < DEPOSIT_WARNING_INTERVAL_MS) {
    depositWarningSuppressed.set(key, (depositWarningSuppressed.get(key) ?? 0) + 1);
    return;
  }
  const suppressed = depositWarningSuppressed.get(key) ?? 0;
  depositWarningLastLoggedAt.set(key, now);
  depositWarningSuppressed.set(key, 0);
  console.warn(`${message}${suppressed > 0 ? ` (${suppressed} similar warnings suppressed)` : ""}`);
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      try {
        results[index] = { status: "fulfilled", value: await mapper(items[index]) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
      await yieldToEventLoop();
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function normalizeDepositRow(row: DepositAddressRow): DepositAddressRow {
  return {
    discord_id: row.discord_id,
    // Null once the custody v2 migration retired the address.
    address: (row.address ?? "").toLowerCase(),
    last_checked_balance: row.last_checked_balance ?? "0",
    deposits_enabled: row.deposits_enabled ?? false,
    native_sweep_tx_hash: row.native_sweep_tx_hash ?? null,
    native_sweep_balance: row.native_sweep_balance ?? null,
    native_sweep_started_at: row.native_sweep_started_at ?? null,
  };
}

async function refreshDepositAddressCache(force = false): Promise<void> {
  const now = Date.now();
  if (
    !force &&
    depositAddressCacheLoadedAt > 0 &&
    now - depositAddressCacheLoadedAt < config.deposits.addressRefreshMs
  ) {
    return;
  }

  if (depositAddressCacheRefresh) return depositAddressCacheRefresh;

  depositAddressCacheRefresh = (async () => {
    let query = supabase
      .from("deposit_addresses")
      .select("discord_id, address, last_checked_balance, deposits_enabled, native_sweep_tx_hash, native_sweep_balance, native_sweep_started_at")
      .eq("deposits_enabled", true);
    const { data, error } = await query;

    if (error) {
      console.error("Failed to refresh deposit address cache:", error.message);
      return;
    }

    depositAddressCache.clear();
    for (const row of (data ?? []) as DepositAddressRow[]) {
      const normalized = normalizeDepositRow(row);
      // Only v1 addresses this key derives are polled by the v1 poller.
      if (normalized.address !== getUserDepositAddress(normalized.discord_id).toLowerCase()) continue;
      depositAddressCache.set(normalized.discord_id, normalized);
    }
    depositAddressCacheLoadedAt = Date.now();
  })().finally(() => {
    depositAddressCacheRefresh = null;
  });

  return depositAddressCacheRefresh;
}

async function refreshDepositTokenCache(force = false): Promise<void> {
  const now = Date.now();
  if (
    !force &&
    depositTokenCacheLoadedAt > 0 &&
    now - depositTokenCacheLoadedAt < config.deposits.addressRefreshMs
  ) {
    return;
  }
  if (depositTokenCacheRefresh) return depositTokenCacheRefresh;

  depositTokenCacheRefresh = (async () => {
    let query = supabase
      .from("deposit_token_balances")
      .select("discord_id, token, last_checked_balance, sweep_after");
    const { data, error } = await query;
    if (error) {
      warnDepositOnce("checkpoint-refresh", `[Deposits] Failed to refresh token checkpoints: ${error.message}`);
      return;
    }

    depositTokenBalanceCache.clear();
    depositTokenSweepAfterCache.clear();
    for (const checkpoint of data ?? []) {
      const key = `${checkpoint.discord_id}:${checkpoint.token}`;
      depositTokenBalanceCache.set(key, BigInt(checkpoint.last_checked_balance ?? "0"));
      depositTokenSweepAfterCache.set(
        key,
        checkpoint.sweep_after ? new Date(checkpoint.sweep_after).getTime() : null,
      );
    }
    depositTokenCacheLoadedAt = Date.now();
  })().finally(() => {
    depositTokenCacheRefresh = null;
  });

  return depositTokenCacheRefresh;
}

async function updateDepositAddressBalances(
  updates: Array<{ row: DepositAddressRow; balance: string }>,
): Promise<void> {
  if (updates.length === 0) return;

  for (let i = 0; i < updates.length; i += DEPOSIT_UPDATE_BATCH_SIZE) {
    const batch = updates.slice(i, i + DEPOSIT_UPDATE_BATCH_SIZE);
    const payload = batch.map(({ row, balance }) => ({
      discord_id: row.discord_id,
      last_checked_balance: balance,
    }));

    const { error } = await supabase.rpc("update_deposit_address_balances", {
      p_updates: payload,
    });

    if (error) {
      console.warn(
        "Batch deposit balance update failed; falling back to per-row updates:",
        error.message
      );
      await Promise.all(
        batch.map(async ({ row, balance }) => {
          await supabase
            .from("deposit_addresses")
            .update({ last_checked_balance: balance })
            .eq("discord_id", row.discord_id);
        })
      );
    }

    for (const { row, balance } of batch) {
      row.last_checked_balance = balance;
      depositAddressCache.set(row.discord_id, row);
    }
  }
}

/**
 * Register a user's deposit address for polling: a keyless forwarder in
 * custody v2, a key derived from the treasury key in legacy mode, nothing
 * while custody is paused.
 */
export async function registerDepositAddress(
  discordId: string,
  options: { enableDeposits?: boolean } = {},
): Promise<string> {
  const v2 = getCustodyMode() === "v2" ? getV2Settings() : null;
  if (v2) return registerForwarderAddress(v2, discordId, options.enableDeposits === true);
  // v1 deposit keys derive from the treasury key: issue none outside legacy mode.
  if (!treasurySignerAvailable()) {
    if (options.enableDeposits) throw new CustodyPausedError();
    return "";
  }
  const address = getUserDepositAddress(discordId);
  const normalizedAddress = address.toLowerCase();
  const cached = depositAddressCache.get(discordId);

  if (cached?.address === normalizedAddress && (!options.enableDeposits || cached.deposits_enabled)) return address;

  const pending = depositRegistrationPromises.get(discordId);
  if (pending) {
    const pendingAddress = await pending;
    if (options.enableDeposits && !depositAddressCache.get(discordId)?.deposits_enabled) {
      return registerDepositAddress(discordId, options);
    }
    return pendingAddress;
  }

  const registration = (async () => {
    // Never overwrite an address from another custody version, and never
    // reissue one the custody v2 migration retired (address NULL): legacy
    // code only serves rows that still hold this key's v1 address.
    const { data: current, error: currentError } = await supabase
      .from("deposit_addresses")
      .select("address")
      .eq("discord_id", discordId)
      .maybeSingle();
    if (currentError) throw currentError;
    const currentAddress = (current?.address as string | null | undefined)?.toLowerCase() ?? null;
    if (current && currentAddress !== normalizedAddress) {
      if (options.enableDeposits) throw new CustodyPausedError();
      return "";
    }
    if (options.enableDeposits) {
      const { error: enableError } = await supabase
        .from("deposit_addresses")
        .upsert(
          { discord_id: discordId, address: normalizedAddress, deposits_enabled: true },
          { onConflict: "discord_id" },
        );
      if (enableError) throw enableError;
    }

    const { data, error } = await supabase
      .from("deposit_addresses")
      .upsert(
        { discord_id: discordId, address: normalizedAddress, deposits_enabled: options.enableDeposits === true },
        { onConflict: "discord_id", ignoreDuplicates: true }
      )
      .select("discord_id, address, last_checked_balance, deposits_enabled, native_sweep_tx_hash, native_sweep_balance, native_sweep_started_at")
      .maybeSingle();

    if (error) throw error;

    let row = data as DepositAddressRow | null;

    if (!row) {
      const { data: existing, error: existingError } = await supabase
        .from("deposit_addresses")
        .select("discord_id, address, last_checked_balance, deposits_enabled, native_sweep_tx_hash, native_sweep_balance, native_sweep_started_at")
        .eq("discord_id", discordId)
        .maybeSingle();

      if (existingError) throw existingError;
      row = existing as DepositAddressRow | null;
    }

    depositAddressCache.set(
      discordId,
      normalizeDepositRow(
        row ?? {
          discord_id: discordId,
          address: normalizedAddress,
          last_checked_balance: "0",
          deposits_enabled: options.enableDeposits === true,
          native_sweep_tx_hash: null,
          native_sweep_balance: null,
          native_sweep_started_at: null,
        }
      )
    );

    return address;
  })().finally(() => {
    depositRegistrationPromises.delete(discordId);
  });

  depositRegistrationPromises.set(discordId, registration);
  return registration;
}

/**
 * Get a reliable gas price with multiple fallbacks.
 * The Mezo RPC sometimes returns null from getFeeData(), so we
 * try several approaches before falling back to a safe default.
 */
async function getGasPrice(): Promise<bigint> {
  // 1) Standard ethers fee data
  try {
    const feeData = await provider.getFeeData();
    if (feeData.gasPrice && feeData.gasPrice > 0n) return feeData.gasPrice;
    if (feeData.maxFeePerGas && feeData.maxFeePerGas > 0n) return feeData.maxFeePerGas;
  } catch {}

  // 2) Direct eth_gasPrice RPC call
  try {
    const raw = await rawRpcCall("eth_gasPrice", []) as string;
    const price = BigInt(raw);
    if (price > 0n) return price;
  } catch {}

  // 3) Conservative fallback based on observed Mezo gas (~1.3M wei/gas)
  return 2_000_000n;
}

const NATIVE_TRANSFER_GAS_LIMIT = 21000n;

function addGasLimitBuffer(estimatedGas: bigint): bigint {
  if (estimatedGas <= NATIVE_TRANSFER_GAS_LIMIT) return NATIVE_TRANSFER_GAS_LIMIT;
  return estimatedGas + estimatedGas / 5n + 1000n;
}

async function estimateNativeTransferGas(to: string, value: bigint): Promise<bigint> {
  const code = await provider.getCode(to);
  if (code === "0x") return NATIVE_TRANSFER_GAS_LIMIT;

  const estimatedGas = await provider.estimateGas({
    from: treasury().address,
    to,
    value,
  });

  return addGasLimitBuffer(estimatedGas);
}

export async function getNativeBalance(address: string): Promise<bigint> {
  const raw = await rawRpcCall("eth_getBalance", [address, "latest"]) as string;
  return BigInt(raw ?? "0x0");
}

export async function getTokenBalance(address: string, token: TokenSymbol): Promise<bigint> {
  if (token === "SATS") return getNativeBalance(address);
  const cfg = assertTokenConfigured(token);
  const data = ERC20_INTERFACE.encodeFunctionData("balanceOf", [address]);
  const raw = await rawRpcCall("eth_call", [{ to: cfg.contractAddress, data }, "latest"]) as string;
  return BigInt(raw ?? "0x0");
}

/** Rate-limited balance read for deposit polling (DEPOSIT_RPC_REQUESTS_PER_SECOND). */
export async function getDepositNativeBalance(address: string): Promise<bigint> {
  const raw = await rawRpcCall(
    "eth_getBalance",
    [address, "latest"],
    { rateLimited: true },
  ) as string;
  return BigInt(raw ?? "0x0");
}

export async function getDepositTokenBalance(
  address: string,
  token: Exclude<TokenSymbol, "SATS">,
): Promise<bigint> {
  const cfg = assertTokenConfigured(token);
  const data = ERC20_INTERFACE.encodeFunctionData("balanceOf", [address]);
  const raw = await rawRpcCall(
    "eth_call",
    [{ to: cfg.contractAddress, data }, "latest"],
    { rateLimited: true },
  ) as string;
  return BigInt(raw ?? "0x0");
}

async function sweepErc20ToTreasury(
  discordId: string,
  token: Exclude<TokenSymbol, "SATS">,
  creditedUnits?: bigint,
  allowGasSponsorship = true,
): Promise<string | null> {
  const key = `${discordId}:${token}`;
  const pending = erc20SweepPromises.get(key);
  if (pending) return pending;
  const sweep = sweepErc20ToTreasuryUnlocked(discordId, token, creditedUnits, allowGasSponsorship).finally(() => {
    erc20SweepPromises.delete(key);
  });
  erc20SweepPromises.set(key, sweep);
  return sweep;
}

async function sweepErc20ToTreasuryUnlocked(
  discordId: string,
  token: Exclude<TokenSymbol, "SATS">,
  creditedUnits?: bigint,
  allowGasSponsorship = true,
): Promise<string | null> {
  const cfg = assertTokenConfigured(token);
  const userWallet = getUserDepositWallet(discordId);
  const liveBalance = await getTokenBalance(userWallet.address, token);
  const tokenBalance = creditedUnits == null ? liveBalance : (liveBalance < creditedUnits ? liveBalance : creditedUnits);
  if (tokenBalance <= 0n) return null;

  const gasPrice = await getGasPrice();
  const transferData = ERC20_INTERFACE.encodeFunctionData("transfer", [treasury().address, tokenBalance]);
  const estimatedRaw = await rawRpcCall("eth_estimateGas", [{
    from: userWallet.address,
    to: cfg.contractAddress,
    data: transferData,
  }]) as string;
  const estimated = BigInt(estimatedRaw);
  const gasLimit = addGasLimitBuffer(estimated);
  const requiredGas = gasLimit * gasPrice;
  const nativeBalance = await getNativeBalance(userWallet.address);
  if (nativeBalance < requiredGas) {
    if (!allowGasSponsorship) throw new Error(`${token} deposit wallet does not have enough gas`);
    const funding = requiredGas - nativeBalance;
    const sponsorBalance = await getNativeBalance(sweepSponsor().address);
    const sponsorIsTreasury = sweepSponsor().address.toLowerCase() === treasury().address.toLowerCase();
    // A dedicated hot wallet contains no user backing, so every sat deposited
    // into it is explicitly available for sweep gas. The configured reserve is
    // only meaningful when sponsorship falls back to the treasury.
    const minimumReserve = sponsorIsTreasury
      ? satsToTokenUnits(config.evm.protocolGasReserveMinSats)
      : 0n;
    let protectedBacking = 0n;
    if (sponsorIsTreasury) {
      const liabilities = await getProtocolOperationalSnapshot();
      protectedBacking = satsToTokenUnits(liabilities.userSatsLiability + liabilities.poolSatsLiability);
    }
    const sponsorTxGas = NATIVE_TRANSFER_GAS_LIMIT * gasPrice;
    if (!preservesGasReserve(sponsorBalance, funding + sponsorTxGas, protectedBacking, minimumReserve)) {
      const availableSats = tokenUnitsToSats(sponsorBalance);
      const requiredSats = tokenUnitsToSats(funding + sponsorTxGas + protectedBacking + minimumReserve);
      lastSweepGasError = sponsorIsTreasury
        ? `Treasury sponsorship would breach protected SATS backing (available ${availableSats}, required ${requiredSats} sats); configure and fund SWEEP_GAS_SPONSOR_PRIVATE_KEY`
        : `Dedicated sweep sponsor needs at least ${requiredSats} sats but has ${availableSats}`;
      throw new Error(lastSweepGasError);
    }

    const operationId = randomUUID();
    const { error: gasOperationError } = await supabase.from("protocol_gas_operations").insert({
      id: operationId,
      operation_type: "erc20_sweep_funding",
      discord_id: discordId,
      token,
      sponsor_address: sweepSponsor().address,
      recipient_address: userWallet.address,
      amount_wei: funding.toString(),
      status: "pending",
    });
    if (gasOperationError) throw gasOperationError;
    try {
      const hash = await sendRawNativeTransfer(sweepSponsor(), userWallet.address, funding, NATIVE_TRANSFER_GAS_LIMIT, gasPrice);
      for (let i = 0; i < 20; i++) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        if (await getNativeBalance(userWallet.address) >= requiredGas) {
          await supabase.from("protocol_gas_operations").update({
            status: "completed", tx_hash: hash, updated_at: new Date().toISOString(),
          }).eq("id", operationId);
          lastSweepGasError = null;
          break;
        }
        if (i === 19) throw new Error(`Gas funding ${hash} did not confirm`);
      }
    } catch (error) {
      lastSweepGasError = (error as Error).message;
      await supabase.from("protocol_gas_operations").update({
        status: "failed", error_message: lastSweepGasError, updated_at: new Date().toISOString(),
      }).eq("id", operationId);
      throw error;
    }
  }
  const nonceRaw = await rawRpcCall("eth_getTransactionCount", [userWallet.address, "pending"]) as string;
  const signed = await userWallet.signTransaction({
    to: cfg.contractAddress!,
    data: transferData,
    gasLimit,
    gasPrice,
    nonce: Number(BigInt(nonceRaw ?? "0x0")),
    chainId: config.evm.chainId,
    type: 0,
  });
  const expectedHash = ethers.keccak256(signed);
  let txHash = expectedHash;
  try {
    txHash = (await rawRpcCall("eth_sendRawTransaction", [signed]) as string | null) ?? expectedHash;
  } catch (error) {
    const message = String((error as Error)?.message ?? error).toLowerCase();
    if (!message.includes("already known") && !message.includes("known transaction")) throw error;
  }
  for (let i = 0; i < 40; i++) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const receipt = await rawRpcCall("eth_getTransactionReceipt", [txHash]) as { status: string } | null;
    if (!receipt) continue;
    if (parseInt(receipt.status, 16) !== 1) throw new Error(`${token} sweep reverted`);
    return txHash;
  }
  throw new Error(`${token} sweep confirmation timed out`);
}

/** Immediately sweep an ERC-20 deposit wallet with sponsored gas.
 * This moves on-chain assets only and never debits a user's credited balance. */
export async function sweepDepositTokenToTreasury(
  discordId: string,
  token: Exclude<TokenSymbol, "SATS">,
  allowGasSponsorship = true,
): Promise<{ txHash: string | null; amountAtomic: bigint }> {
  assertCustodyAvailable();
  const userWallet = getUserDepositWallet(discordId);
  const amountAtomic = await getTokenBalance(userWallet.address, token);
  if (amountAtomic <= 0n) return { txHash: null, amountAtomic: 0n };

  const txHash = await sweepErc20ToTreasury(discordId, token, amountAtomic, allowGasSponsorship);
  if (!txHash) return { txHash: null, amountAtomic: 0n };

  const key = `${discordId}:${token}`;
  const now = new Date().toISOString();
  const { error } = await supabase.from("deposit_token_balances").upsert({
    discord_id: discordId,
    token,
    last_checked_balance: "0",
    sweep_after: null,
    last_sweep_at: now,
    last_sweep_error: null,
    updated_at: now,
  }, { onConflict: "discord_id,token" });

  depositTokenBalanceCache.set(key, 0n);
  depositTokenSweepAfterCache.set(key, null);
  if (error) {
    throw new Error(`${token} swept in ${txHash}, but checkpoint reset failed: ${error.message}`);
  }
  return { txHash, amountAtomic };
}

async function sendRawNativeTransfer(
  signer: ethers.Wallet,
  to: string,
  value: bigint,
  gasLimit: bigint,
  gasPrice: bigint,
): Promise<string> {
  const nonceRaw = await rawRpcCall("eth_getTransactionCount", [signer.address, "pending"]) as string;
  const signed = await signer.signTransaction({
    to,
    value,
    gasLimit,
    gasPrice,
    nonce: Number(BigInt(nonceRaw ?? "0x0")),
    chainId: config.evm.chainId,
    type: 0,
  });
  const hash = ethers.keccak256(signed);
  try {
    const submitted = await rawRpcCall("eth_sendRawTransaction", [signed]) as string | null;
    return submitted ?? hash;
  } catch (err) {
    const msg = ((err as Error)?.message ?? "").toLowerCase();
    if (msg.includes("already known") || msg.includes("known transaction")) return hash;
    throw err;
  }
}

export type ProtocolOperationalSnapshot = {
  userSatsLiability: number;
  poolSatsLiability: number;
  userMusdAtomic: bigint;
  unsweptMusdAtomic: bigint;
  pendingMusdAtomic: bigint;
  pendingSweeps: number;
  sweepErrors: number;
};

export async function getProtocolOperationalSnapshot(): Promise<ProtocolOperationalSnapshot> {
  const { data, error } = await supabase.rpc("get_protocol_operational_snapshot");
  if (error) throw error;
  const row = (data ?? {}) as Record<string, unknown>;
  return {
    userSatsLiability: Number(row.user_sats_liability ?? 0),
    poolSatsLiability: Number(row.pool_sats_liability ?? 0),
    userMusdAtomic: BigInt(String(row.user_musd_atomic ?? "0")),
    unsweptMusdAtomic: BigInt(String(row.unswept_musd_atomic ?? "0")),
    pendingMusdAtomic: BigInt(String(row.pending_musd_atomic ?? "0")),
    pendingSweeps: Number(row.pending_sweeps ?? 0),
    sweepErrors: Number(row.sweep_errors ?? 0),
  };
}

export async function getSweepGasSponsorBalanceSats(): Promise<number> {
  return tokenUnitsToSats(await getNativeBalance(getSweepGasSponsorAddress()));
}

export function getLastSweepGasError(): string | null {
  return lastSweepGasError;
}

async function ensureErc20WithdrawalGas(
  token: Exclude<TokenSymbol, "SATS">,
  gasCost: bigint,
  gasPrice: bigint,
): Promise<void> {
  const treasuryNative = await getNativeBalance(treasury().address);
  // The caller has already reserved the quoted gas from the user's SATS
  // balance, reducing protocol liabilities by at least gasCost. Paying that
  // gas therefore cannot worsen an existing backing gap. Sponsorship is only
  // needed when the treasury lacks enough native balance for this transaction;
  // requiring it to repair historical under-backing blocks every ERC-20
  // withdrawal and misreports the entire gap as a withdrawal gas requirement.
  const requiredTreasuryBalance = gasCost;
  const funding = withdrawalGasFundingShortfall(treasuryNative, gasCost);
  if (funding === 0n) return;
  const sponsorBalance = await getNativeBalance(sweepSponsor().address);
  const sponsorTxGas = NATIVE_TRANSFER_GAS_LIMIT * gasPrice;
  if (sponsorBalance < funding + sponsorTxGas) {
    throw new Error(
      `Gas sponsor needs about ${tokenUnitsToSats(funding + sponsorTxGas)} sats ` +
      `but has ${tokenUnitsToSats(sponsorBalance)} sats`,
    );
  }

  const operationId = randomUUID();
  const { error: operationError } = await supabase.from("protocol_gas_operations").insert({
    id: operationId,
    operation_type: "erc20_withdrawal_funding",
    token,
    sponsor_address: sweepSponsor().address,
    recipient_address: treasury().address,
    amount_wei: funding.toString(),
    status: "pending",
  });
  if (operationError) throw operationError;

  try {
    const hash = await sendRawNativeTransfer(
      sweepSponsor(),
      treasury().address,
      funding,
      NATIVE_TRANSFER_GAS_LIMIT,
      gasPrice,
    );
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      if (await getNativeBalance(treasury().address) >= requiredTreasuryBalance) {
        await supabase.from("protocol_gas_operations").update({
          status: "completed", tx_hash: hash, updated_at: new Date().toISOString(),
        }).eq("id", operationId);
        return;
      }
    }
    throw new Error(`Withdrawal gas funding ${hash} did not confirm`);
  } catch (error) {
    await supabase.from("protocol_gas_operations").update({
      status: "failed",
      error_message: String((error as Error).message).slice(0, 2000),
      updated_at: new Date().toISOString(),
    }).eq("id", operationId);
    throw error;
  }
}

/**
 * Sweep funds from a user's deposit address to the treasury.
 * Gas price is pinned on the tx, so cost = exactly gasLimit * gasPrice.
 * value = balance - gasCost → wallet is drained to 0 with no dust.
 */
export async function sweepToTreasury(
  discordId: string,
  maximumBalance?: bigint,
  expectedCheckpoint?: bigint,
): Promise<string | null> {
  assertCustodyAvailable();
  const pending = sweepPromises.get(discordId);
  if (pending) return pending;

  const sweep = sweepToTreasuryUnlocked(discordId, maximumBalance, expectedCheckpoint).finally(() => {
    sweepPromises.delete(discordId);
  });
  sweepPromises.set(discordId, sweep);
  return sweep;
}

async function sweepToTreasuryUnlocked(
  discordId: string,
  maximumBalance?: bigint,
  expectedCheckpoint?: bigint,
): Promise<string | null> {
  const userWallet = getUserDepositWallet(discordId);
  const balance = await getNativeBalance(userWallet.address);
  if (balance === 0n) return null;

  // Never sweep funds that arrived after the poll snapshot being credited.
  const sweepBalance = maximumBalance == null || balance < maximumBalance ? balance : maximumBalance;

  const gasPrice = await getGasPrice();
  const gasLimit = 21000n;
  const gasCost = gasLimit * gasPrice;

  // No buffer needed: we pin gasPrice on the tx, so actual cost is
  // exactly gasLimit * gasPrice.  value + gasCost = balance → 0 dust.
  const sendAmount = sweepBalance - gasCost;
  if (sendAmount <= 0n) {
    console.log(
      `Sweep skipped for ${discordId}: balance ${sweepBalance} wei < gas ${gasCost} wei`
    );
    return null;
  }

  const nonceRaw = await rawRpcCall("eth_getTransactionCount", [userWallet.address, "pending"]) as string;
  const signed = await userWallet.signTransaction({
    to: treasury().address,
    value: sendAmount,
    gasLimit,
    gasPrice,
    nonce: Number(BigInt(nonceRaw ?? "0x0")),
    chainId: config.evm.chainId,
    type: 0,
  });
  const expectedHash = ethers.keccak256(signed);

  const { data: began, error: beginError } = await supabase.rpc("begin_native_deposit_sweep", {
    p_discord_id: discordId,
    p_expected_balance: (expectedCheckpoint ?? sweepBalance).toString(),
    p_tx_hash: expectedHash,
  });
  if (beginError) throw beginError;
  if (began !== true) return null;

  const row = depositAddressCache.get(discordId);
  if (row) {
    row.native_sweep_tx_hash = expectedHash;
    row.native_sweep_balance = sweepBalance.toString();
    row.native_sweep_started_at = new Date().toISOString();
  }

  try {
    return (await rawRpcCall("eth_sendRawTransaction", [signed]) as string | null) ?? expectedHash;
  } catch (error) {
    const message = String((error as Error)?.message ?? error).toLowerCase();
    if (message.includes("already known") || message.includes("known transaction")) return expectedHash;
    // Keep the durable pending marker: a gateway timeout can be ambiguous, and
    // the poller will reconcile the expected hash before allowing more credit.
    throw error;
  }
}

/**
 * Fund gas from treasury to a user's deposit wallet, wait for it to arrive,
 * then sweep the deposit wallet to treasury.
 * Used by the admin /sweep command for wallets where balance < gas cost.
 */
export async function fundGasAndSweep(discordId: string): Promise<string | null> {
  assertCustodyAvailable();
  const userWallet = getUserDepositWallet(discordId);
  const balance = await getNativeBalance(userWallet.address);
  if (balance === 0n) return null;

  const gasPrice = await getGasPrice();
  const gasLimit = 21000n;
  const gasCost = gasLimit * gasPrice;

  // Send exactly enough gas for the sweep tx
  const gasFunding = gasCost;

  console.log(`Funding gas for ${discordId}: sending ${gasFunding} wei from treasury`);
  const fundHash = await sendRawNativeTransfer(treasury(), userWallet.address, gasFunding, gasLimit, gasPrice);
  console.log(`Gas funding tx: ${fundHash}`);

  // Wait for the funding tx to be mined (poll manually since tx.wait() is broken)
  let funded = false;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const newBal = await getNativeBalance(userWallet.address);
    if (newBal > balance) {
      funded = true;
      break;
    }
  }

  if (!funded) {
    console.error(`Gas funding for ${discordId} did not confirm in time`);
    return null;
  }

  // Now sweep — deposit wallet has enough for gas
  return sweepToTreasury(discordId, balance + gasFunding, balance);
}

async function reconcileNativeDepositSweep(row: DepositAddressRow): Promise<"ready" | "pending"> {
  const txHash = row.native_sweep_tx_hash;
  if (!txHash) return "ready";

  const receipt = await rawRpcCall("eth_getTransactionReceipt", [txHash]) as { status: string } | null;
  if (receipt) {
    const rpc = parseInt(receipt.status, 16) === 1
      ? "finish_native_deposit_sweep"
      : "cancel_native_deposit_sweep";
    const { data: changed, error } = await supabase.rpc(rpc, {
      p_discord_id: row.discord_id,
      p_tx_hash: txHash,
    });
    if (error) throw error;
    if (changed === true) {
      if (rpc === "finish_native_deposit_sweep") row.last_checked_balance = "0";
      row.native_sweep_tx_hash = null;
      row.native_sweep_balance = null;
      row.native_sweep_started_at = null;
    }
    return "ready";
  }

  const startedAt = row.native_sweep_started_at ? Date.parse(row.native_sweep_started_at) : Date.now();
  if (Date.now() - startedAt < 10 * 60_000) return "pending";

  // A hash absent from both receipt and transaction lookups for ten minutes is
  // treated as never broadcast/dropped. Clearing only the sweep marker leaves
  // the already-credited checkpoint intact, so retrying cannot double-credit.
  const tx = await rawRpcCall("eth_getTransactionByHash", [txHash]) as unknown;
  if (tx != null) return "pending";
  const { data: changed, error } = await supabase.rpc("cancel_native_deposit_sweep", {
    p_discord_id: row.discord_id,
    p_tx_hash: txHash,
  });
  if (error) throw error;
  if (changed === true) {
    row.native_sweep_tx_hash = null;
    row.native_sweep_balance = null;
    row.native_sweep_started_at = null;
  }
  return "ready";
}

/**
 * Poll all registered deposit addresses for new funds.
 * Auto-credits users and schedules durable ERC-20 sweeps to treasury.
 *
 * KEY INVARIANT: `last_checked_balance` is ALWAYS set to the real on-chain
 * balance.  We never manually reset it to "0" — that caused the old
 * double-credit bug where the poller would re-credit deposits whose sweep
 * hadn't mined yet.
 */
export function startDepositPoller(
  onDeposit?: (discordId: string, amount: number, gasSats: number, txHash: string, token: TokenSymbol) => void
) {
  if (getConfiguredV2Settings()) {
    // v1 addresses are never polled under custody v2. If the boot check has
    // not passed yet the v2 poller starts once it does.
    startForwarderDeposits(onDeposit);
    return;
  }
  if (!treasurySignerAvailable()) {
    // Crediting v1 deposits the bot cannot secure would mint unbacked balance.
    console.error("[Deposits] Poller not started: custody is paused.");
    return;
  }
  let isPolling = false;
  const balanceConcurrency = clampPositiveInt(config.deposits.balanceConcurrency, 8);
  const balanceBatchSize = Math.max(
    balanceConcurrency,
    clampPositiveInt(config.deposits.balanceBatchSize, 25),
  );
  const initialPollDelayMs = clampPositiveInt(config.deposits.initialPollDelayMs, 15_000);

  const poll = async () => {
    if (isPolling) {
      console.warn("Deposit poll skipped: previous poll is still running");
      return;
    }

    isPolling = true;
    const startedAt = Date.now();

    try {
      await refreshDepositAddressCache(depositAddressCacheLoadedAt === 0);
      // Once an address has been issued it remains polled even if configuration
      // later becomes more restrictive, so funds sent to an old address cannot
      // become stranded. New addresses are enabled only after an access check.
      const rows = Array.from(depositAddressCache.values());

      if (rows.length === 0) return;

      const updates: Array<{ row: DepositAddressRow; balance: string }> = [];
      let gasPriceForPoll: bigint | null = null;
      let balanceCheckFailures = 0;
      let firstBalanceCheckError = "";

      const captureBalanceFailure = (reason: unknown) => {
        balanceCheckFailures += 1;
        if (!firstBalanceCheckError) {
          firstBalanceCheckError = String((reason as Error)?.message ?? reason)
            .replace(/\s+/g, " ")
            .slice(0, 300);
        }
      };

      const configuredErc20 = TOKEN_SYMBOLS.filter((symbol): symbol is Exclude<TokenSymbol, "SATS"> => {
        if (symbol === "SATS") return false;
        try { return !!assertTokenConfigured(symbol).contractAddress; } catch { return false; }
      });
      if (configuredErc20.length > 0) {
        await refreshDepositTokenCache(depositTokenCacheLoadedAt === 0);
      }
      const checkpointMap = depositTokenBalanceCache;
      const sweepAfterMap = depositTokenSweepAfterCache;

      for (let i = 0; i < rows.length; i += balanceBatchSize) {
        const batch = rows.slice(i, i + balanceBatchSize);
        const balanceChecks = await mapWithConcurrency(
          batch,
          balanceConcurrency,
          async (row) => {
            if (await reconcileNativeDepositSweep(row) === "pending") {
              return { row, bal: null };
            }
            const bal = await getDepositNativeBalance(row.address);
            return { row, bal };
          },
        );

        for (const result of balanceChecks) {
          if (result.status === "rejected") {
            captureBalanceFailure(result.reason);
            continue;
          }

          const { row, bal } = result.value;
          if (bal !== null) {
            const prev = BigInt(row.last_checked_balance || "0");

            // Credit only when balance INCREASES (new deposit arrived).
            if (bal > prev) {
              const diff = bal - prev;
              const usedForWalletVerification = await verifyWalletFromDeposit(
                row.discord_id,
                row.address,
                provider,
              ).catch((err) => {
                console.warn(
                  `[WalletVerify] Deposit verification check failed for ${row.discord_id}:`,
                  (err as Error)?.message ?? err,
                );
                return false;
              });

              // Exact gas cost: matches the pinned gasPrice on the sweep tx.
              gasPriceForPoll ??= await getGasPrice();
              const gasCost = 21000n * gasPriceForPoll;
              const netDeposit = diff - gasCost;

              if (usedForWalletVerification) {
                const { data: advanced, error } = await supabase.rpc("advance_native_deposit_checkpoint", {
                  p_discord_id: row.discord_id,
                  p_expected_balance: prev.toString(),
                  p_observed_balance: bal.toString(),
                });
                if (error) throw error;
                if (advanced === true) {
                  row.last_checked_balance = bal.toString();
                  sweepToTreasury(row.discord_id, bal).catch((err) => {
                    console.error(`Verification sweep failed for ${row.discord_id}:`, (err as Error)?.message ?? err);
                  });
                }
                console.log(`Wallet verification deposit locked for ${row.discord_id}`);
              } else if (netDeposit > 0n) {
                const netSats = tokenUnitsToSats(netDeposit);
                const gasSats = tokenUnitsToSats(gasCost);

                if (netSats > 0) {
                  const txId = `auto-${Date.now()}-${row.discord_id}`;
                  const { data: credited, error } = await supabase.rpc("credit_native_deposit", {
                    p_discord_id: row.discord_id,
                    p_expected_balance: prev.toString(),
                    p_observed_balance: bal.toString(),
                    p_amount_sats: netSats,
                    p_tx_hash: txId,
                  });
                  if (error) throw error;
                  if (credited === true) {
                    row.last_checked_balance = bal.toString();
                    onDeposit?.(row.discord_id, netSats, gasSats, txId, "SATS");
                    sweepToTreasury(row.discord_id, bal).catch((err) => {
                      console.error(`Sweep failed for ${row.discord_id}:`, (err as Error)?.message ?? err);
                    });
                  }
                }
              } else {
                console.log(
                  `Deposit too small to cover gas for ${row.discord_id}: ${diff} wei < gas ${gasCost} wei`
                );
              }
            }

            // A decrease outside a recorded sweep can only be an older/manual
            // sweep. Reset to zero so any funds left or arriving concurrently
            // are observed as a fresh increase on the next poll.
            if (bal < prev) updates.push({ row, balance: "0" });
          }

          for (const token of configuredErc20) {
            try {
              const current = await getDepositTokenBalance(row.address, token);
              const key = `${row.discord_id}:${token}`;
              const previous = checkpointMap.get(key) ?? 0n;
              let belowPublicMinimum = false;
              if (current > previous) {
                const amountAtomic = current - previous;
                const amount = tokenUnitsToAmount(amountAtomic, token);
                const isAdmin = config.discord.adminIds.includes(row.discord_id);
                const minimumAtomic = isAdmin ? 0n : tokenDecimalToUnits(config.deposits.minimums[token], token);
                belowPublicMinimum = !meetsPublicDepositMinimum(current, minimumAtomic, isAdmin);
                if (belowPublicMinimum) {
                  console.log(`[Deposits] ${token} deposit for ${row.discord_id} is below the public minimum; awaiting more funds`);
                }
                if (!belowPublicMinimum && amount > 0) {
                  const txId = `auto-${token.toLowerCase()}-${Date.now()}-${row.discord_id}`;
                  const { data: credited, error: creditError } = token === "MUSD"
                    ? await supabase.rpc("credit_musd_deposit_atomic", {
                      p_discord_id: row.discord_id,
                      p_expected_balance: previous.toString(),
                      p_observed_balance: current.toString(),
                      p_amount_atomic: amountAtomic.toString(),
                      p_tx_hash: txId,
                    })
                    : await supabase.rpc("credit_token_deposit", {
                      p_discord_id: row.discord_id,
                      p_token: token,
                      p_expected_balance: previous.toString(),
                      p_observed_balance: current.toString(),
                      p_amount: amount,
                      p_tx_hash: txId,
                    });
                  if (creditError) throw creditError;
                  if (credited === true) {
                    onDeposit?.(row.discord_id, amount, 0, txId, token);
                    const sweepAfter = nextSweepTime(Date.now(), config.deposits.erc20SweepDelayMs);
                    checkpointMap.set(key, current);
                    sweepAfterMap.set(key, sweepAfter);
                    await supabase.from("deposit_token_balances").update({
                      sweep_after: new Date(sweepAfter).toISOString(),
                      last_sweep_error: null,
                      updated_at: new Date().toISOString(),
                    }).eq("discord_id", row.discord_id).eq("token", token);
                  }
                }
              }
              let sweepAfter = sweepAfterMap.get(key) ?? null;
              if (!belowPublicMinimum && current > 0n && sweepAfter == null) {
                sweepAfter = nextSweepTime(Date.now(), config.deposits.erc20SweepDelayMs);
                sweepAfterMap.set(key, sweepAfter);
                await supabase.from("deposit_token_balances").update({
                  sweep_after: new Date(sweepAfter).toISOString(), updated_at: new Date().toISOString(),
                }).eq("discord_id", row.discord_id).eq("token", token);
              }
              if (!belowPublicMinimum && current > 0n && sweepAfter != null && sweepAfter <= Date.now()) {
                try {
                  await sweepErc20ToTreasury(row.discord_id, token, current);
                  sweepAfterMap.set(key, null);
                  const { data: sweptCheckpoint, error: sweepCheckpointError } = await supabase
                    .from("deposit_token_balances")
                    .update({
                      last_checked_balance: "0",
                      sweep_after: null,
                      last_sweep_at: new Date().toISOString(),
                      last_sweep_error: null,
                      updated_at: new Date().toISOString(),
                    })
                    .eq("discord_id", row.discord_id)
                    .eq("token", token)
                    .eq("last_checked_balance", current.toString())
                    .select("discord_id");
                  if (sweepCheckpointError || !sweptCheckpoint?.length) {
                    throw sweepCheckpointError ?? new Error("Sweep checkpoint changed before completion");
                  }
                  checkpointMap.set(key, 0n);
                } catch (error) {
                  warnDepositOnce(
                    `sweep-${token}`,
                    `[Deposits] ${token} sweep failed: ${String((error as Error).message).slice(0, 300)}`,
                  );
                  const retryAt = new Date(Date.now() + Math.max(60_000, config.deposits.pollMs)).toISOString();
                  sweepAfterMap.set(key, new Date(retryAt).getTime());
                  await supabase.from("deposit_token_balances").update({
                    sweep_after: retryAt, last_sweep_error: (error as Error).message.slice(0, 2000), updated_at: new Date().toISOString(),
                  }).eq("discord_id", row.discord_id).eq("token", token);
                }
              }
              const wasSwept = checkpointMap.get(key) === 0n && previous !== 0n && sweepAfterMap.get(key) == null;
              const checkpointBalance = wasSwept ? 0n : current;
              if (!belowPublicMinimum && !wasSwept && checkpointBalance !== previous) {
                await supabase.from("deposit_token_balances").upsert({
                  discord_id: row.discord_id, token, last_checked_balance: checkpointBalance.toString(), updated_at: new Date().toISOString(),
                }, { onConflict: "discord_id,token" });
                checkpointMap.set(key, checkpointBalance);
              }
            } catch (error) {
              captureBalanceFailure(error);
            }
          }
        }

        await yieldToEventLoop();
      }

      await updateDepositAddressBalances(updates);
      if (balanceCheckFailures > 0) {
        warnDepositOnce(
          "balance-check",
          `[Deposits] ${balanceCheckFailures} balance check(s) failed during this poll; first error: ${firstBalanceCheckError}`,
        );
      }
      if (Date.now() - startedAt > config.deposits.pollMs) {
        warnDepositOnce(
          "slow-poll",
          `[Deposits] Poll took ${Date.now() - startedAt}ms for ${rows.length} address(es); checks are rate-limited to protect the RPC endpoint`,
        );
      }
    } finally {
      isPolling = false;
    }
  };

  setInterval(poll, config.deposits.pollMs);
  // Initial poll after Discord has had a moment to settle.
  setTimeout(poll, initialPollDelayMs);
}

export interface WithdrawResult {
  /** completed | refund | pending — see classifyWithdrawalOutcome. */
  outcome: WithdrawalOutcome;
  reason: WithdrawalOutcomeReason;
  txHash?: string;
  error?: string;
  /** Native: gas charged against the amount (incl. buffer). ERC-20: gas paid, when known. */
  gasSats?: number;
  sentSats?: number;
  /** Gas actually paid according to the receipt. */
  actualGasSats?: number;
}

export interface Erc20WithdrawalGasQuote {
  gasLimit: bigint;
  gasPrice: bigint;
  gasSats: number;
}

/** Quote the maximum native gas charged for an ERC-20 withdrawal. */
export async function quoteErc20WithdrawalGas(
  toAddress: string,
  amount: number,
  token: Exclude<TokenSymbol, "SATS">,
): Promise<Erc20WithdrawalGasQuote> {
  const normalized = toAddress.toLowerCase().trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(normalized)) throw new Error("Invalid address");
  const v2 = getCustodyMode() === "v2" ? getV2Settings() : null;
  if (v2) {
    // HotPayout.payToken from the operator, simulated.
    const plan = await planPayout(v2, { withdrawalId: null, to: normalized, token, amount });
    if (!plan.ok) throw new Error(plan.error);
    return { gasLimit: plan.gasLimit, gasPrice: plan.gasPrice, gasSats: plan.gasSats };
  }
  const cfg = assertTokenConfigured(token);
  const units = tokenAmountToUnits(amount, token);
  if (units <= 0n) throw new Error("Amount too small");
  const data = ERC20_INTERFACE.encodeFunctionData("transfer", [normalized, units]);
  const estimated = BigInt(await rawRpcCall("eth_estimateGas", [{
    from: treasury().address, to: cfg.contractAddress, data,
  }]) as string);
  const gasLimit = addGasLimitBuffer(estimated);
  const gasPrice = await getGasPrice();
  return { gasLimit, gasPrice, gasSats: tokenUnitsToSats(gasLimit * gasPrice) };
}

/**
 * withdrawals row lifecycle (migrations/2026-10-08_withdrawal_safety.sql):
 *   reserve_withdrawal_v2: debit + insert 'pending' (one transaction)
 *   → hash, nonce, raw tx, signed_at persisted → broadcast
 *   → complete_withdrawal_v2 ('completed') | refund_withdrawal_v2 ('failed')
 * Every step is idempotent by status, so a lost database response is settled
 * by retrying (recovery) rather than by guessing.
 */
export type WithdrawalRecord = {
  id: number;
  discord_id: string;
  amount_sats: number;
  token: TokenSymbol;
  to_address: string;
  tx_hash: string | null;
  created_at: string;
  nonce: number | null;
  raw_tx: string | null;
  gas_reserved_sats: number | null;
  /** 2 = persist-before-broadcast pipeline; null = legacy row. */
  pipeline_version: number | null;
  signed_at: string | null;
  /** Custody v2: the operator that signed the HotPayout call; null for treasury rows. */
  signer_address: string | null;
  /** Custody v2: HotPayout ref (withdrawalRef(id)), written with tx_hash before broadcast. */
  payout_ref: string | null;
};

function toWithdrawalRecord(row: Record<string, unknown>): WithdrawalRecord {
  const token = (row.token ?? "SATS") as TokenSymbol;
  if (!TOKEN_SYMBOLS.includes(token)) throw new Error(`unknown withdrawal token ${String(row.token)}`);
  const nonce = row.nonce == null ? null : Number(row.nonce);
  const gasReserved = row.gas_reserved_sats == null ? null : Number(row.gas_reserved_sats);
  const pipeline = row.pipeline_version == null ? null : Number(row.pipeline_version);
  return {
    id: Number(row.id),
    discord_id: String(row.discord_id),
    amount_sats: Number(row.amount_sats),
    token,
    to_address: String(row.to_address).toLowerCase(),
    tx_hash: (row.tx_hash as string | null) ?? null,
    created_at: String(row.created_at),
    nonce: nonce != null && Number.isSafeInteger(nonce) ? nonce : null,
    raw_tx: (row.raw_tx as string | null) ?? null,
    gas_reserved_sats: gasReserved != null && Number.isFinite(gasReserved) ? gasReserved : null,
    pipeline_version: pipeline != null && Number.isFinite(pipeline) ? pipeline : null,
    signed_at: (row.signed_at as string | null) ?? null,
    signer_address: row.signer_address ? String(row.signer_address).toLowerCase() : null,
    payout_ref: row.payout_ref ? String(row.payout_ref).toLowerCase() : null,
  };
}

async function readWithdrawalStatus(id: number): Promise<string | null> {
  const { data } = await supabase.from("withdrawals").select("status").eq("id", id).maybeSingle();
  return (data?.status as string | undefined) ?? null;
}

/** Write the signed tx identity onto the row while it is still pending and hashless. */
async function persistWithdrawalBroadcast(
  id: number,
  txHash: string,
  nonce: number,
  rawTx: string,
  signedAt: number,
  payout?: { signer_address: string; payout_ref: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data, error } = await supabase
    .from("withdrawals")
    .update({ tx_hash: txHash, nonce, raw_tx: rawTx, signed_at: new Date(signedAt).toISOString(), ...(payout ?? {}) })
    .eq("id", id)
    .eq("status", "pending")
    .is("tx_hash", null)
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!data?.length) return { ok: false, error: "withdrawal is no longer pending" };
  return { ok: true };
}

export type WithdrawalReservation =
  | { ok: true; record: WithdrawalRecord }
  | { ok: false; reason: "insufficient_token" | "insufficient_sats" | "unavailable" | "unconfirmed"; error?: string };

/**
 * Debit the user and create the pending row in one transaction. If the
 * response is lost ("unconfirmed") the reservation either never happened or
 * left a hashless pipeline-2 pending row, which recovery refunds as never
 * broadcast. All solvency/coverage checks belong before this call.
 */
export async function reserveWithdrawal(input: {
  discordId: string;
  toAddress: string;
  amount: number;
  token: TokenSymbol;
  /** SATS network fee reserved alongside an ERC-20 withdrawal. */
  gasSats?: number;
}): Promise<WithdrawalReservation> {
  const blocked = withdrawalsBlockedMessage();
  if (blocked) throw new CustodyPausedError(blocked);
  const toAddress = input.toAddress.toLowerCase().trim();
  const gasReservedSats = input.token === "SATS" ? null : roundSats(input.gasSats ?? 0);
  const { data, error } = await supabase.rpc("reserve_withdrawal_v2", {
    p_discord_id: input.discordId,
    p_to_address: toAddress,
    p_token: input.token,
    p_amount: input.amount,
    p_gas_sats: gasReservedSats ?? 0,
  });
  if (error) {
    if (isDefiniteDbFailure(error)) return { ok: false, reason: "unavailable", error: error.message };
    console.error(
      `[Withdraw] Reservation for ${input.discordId} (${input.amount} ${input.token} → ${toAddress}) is unconfirmed ` +
      `(${error.message}); if it committed, recovery refunds the hashless row`,
    );
    return { ok: false, reason: "unconfirmed", error: error.message };
  }

  const result = (data ?? {}) as { status?: string; id?: unknown; created_at?: unknown };
  if (result.status === "insufficient_token" || result.status === "insufficient_sats") {
    return { ok: false, reason: result.status };
  }
  if (result.status !== "ok" || result.id == null) {
    return { ok: false, reason: "unavailable", error: `unexpected reservation result ${JSON.stringify(data)}` };
  }
  return {
    ok: true,
    record: {
      id: Number(result.id),
      discord_id: input.discordId,
      amount_sats: input.amount,
      token: input.token,
      to_address: toAddress,
      tx_hash: null,
      created_at: String(result.created_at),
      nonce: null,
      raw_tx: null,
      gas_reserved_sats: gasReservedSats,
      pipeline_version: 2,
      signed_at: null,
      signer_address: null,
      payout_ref: null,
    },
  };
}

/**
 * Per-user rolling 24h soft cap on SATS withdrawals (pending and completed
 * rows count; refunded ones do not). Checked before reserving.
 */
export async function checkUserWithdrawalCap(
  discordId: string,
  token: TokenSymbol,
  amount: number,
): Promise<{ ok: boolean; remainingSats: number; capSats: number }> {
  const capSats = config.withdrawals.userDailyMaxSats;
  if (token !== "SATS" || !(capSats > 0)) return { ok: true, remainingSats: Number.POSITIVE_INFINITY, capSats };
  const now = Date.now();
  const { data, error } = await supabase
    .from("withdrawals")
    .select("amount_sats, token, status, created_at")
    .eq("discord_id", discordId)
    .gte("created_at", new Date(now - DAY_MS).toISOString());
  if (error) throw new Error(`Could not check the daily withdrawal limit: ${error.message}`);
  return { ...checkUserDailyCap(sumRecentSatsWithdrawals(data ?? [], now), amount, capSats), capSats };
}

export type WithdrawalPreflight =
  | { ok: true }
  | {
    ok: false;
    /** payout_limit: HotPayout paused, a cap reached or the float low (custody v2). */
    code: "underbacked" | "backing_unavailable" | "treasury_short" | "invalid" | "payout_limit" | "unavailable";
    error: string;
  };

/**
 * Checks that must pass before any debit. Native SATS: the treasury must be
 * solvent overall, hold the full amount, and the amount must cover gas.
 * ERC-20: the treasury must hold the token amount (gas is quoted separately).
 */
export async function preflightWithdrawal(
  toAddress: string,
  amount: number,
  token: TokenSymbol,
): Promise<WithdrawalPreflight> {
  const normalized = toAddress.toLowerCase().trim();
  if (!/^0x[a-f0-9]{40}$/.test(normalized)) return { ok: false, code: "invalid", error: "Invalid address" };
  try {
    const refusal = await withdrawalDestinationRefusal(normalized);
    if (refusal) return { ok: false, code: "invalid", error: refusal };
  } catch (error) {
    return { ok: false, code: "unavailable", error: (error as Error).message };
  }
  try {
    if (token === "SATS") {
      const solvency = await checkSatsExitSolvency();
      if (!solvency.ok) {
        return solvency.reason === "underbacked"
          ? { ok: false, code: "underbacked", error: "Treasury SATS backing is below liabilities plus reserve" }
          : { ok: false, code: "backing_unavailable", error: solvency.error };
      }
    }
    const v2 = getCustodyMode() === "v2" ? getV2Settings() : null;
    if (v2) {
      // Caps, pause, float and recipient, by simulating the HotPayout call.
      const plan = await planPayout(v2, { withdrawalId: null, to: normalized, token, amount });
      if (plan.ok) return { ok: true };
      const code = plan.code === "already_paid" || plan.code === "paid_unknown" ? "unavailable" : plan.code;
      return { ok: false, code, error: plan.error };
    }
    if (token === "SATS") {
      const plan = await planNativeWithdrawal(normalized, amount);
      return plan.ok ? { ok: true } : { ok: false, code: plan.code, error: plan.error };
    }
    const units = tokenAmountToUnits(amount, token);
    if (units <= 0n) return { ok: false, code: "invalid", error: "Amount too small" };
    if (await getTokenBalance(treasury().address, token) < units) {
      return { ok: false, code: "treasury_short", error: `Treasury has insufficient ${token}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, code: "backing_unavailable", error: describeNativeWithdrawalError(error) };
  }
}

/**
 * Destinations that never receive withdrawals: any deposit address (current
 * forwarders and retired v1 addresses), the custody contracts and role
 * wallets, and known-compromised addresses.
 */
async function withdrawalDestinationRefusal(normalized: string): Promise<string | null> {
  const v2 = getConfiguredV2Settings();
  const blocked = v2
    ? [
      { label: "vault", address: v2.vault },
      { label: "deposit factory", address: v2.factory },
      { label: "deposit forwarder implementation", address: v2.implementation },
      { label: "withdrawal contract", address: v2.payout },
      { label: "payout operator wallet", address: v2.operator },
      { label: "payout guardian wallet", address: v2.guardian },
    ]
    : [];
  // legacy_address exists once the custody v2 migration is applied, which v2 requires.
  const query = supabase.from("deposit_addresses").select("discord_id").limit(1);
  const { data, error } = v2
    ? await query.or(`address.eq.${normalized},legacy_address.eq.${normalized}`)
    : await query.eq("address", normalized);
  if (error) throw new Error(`Could not check the destination address: ${error.message}`);
  return withdrawalDestinationProblem(normalized, blocked, (data?.length ?? 0) > 0, isRuntimeCompromised);
}

type NativeWithdrawalPlan =
  | { ok: true; sendValue: bigint; gasLimit: bigint; gasPrice: bigint; gasSats: number; sentSats: number }
  | { ok: false; code: "treasury_short" | "invalid"; error: string };

/** Gas is deducted from the send amount (with a 50% buffer the treasury keeps). */
async function planNativeWithdrawal(toAddress: string, amountSats: number): Promise<NativeWithdrawalPlan> {
  const value = satsToTokenUnits(amountSats);
  if (value <= 0n) return { ok: false, code: "invalid", error: "Amount too small" };

  const treasuryNative = await getNativeBalance(treasury().address);
  if (!satsWithdrawalCovered(treasuryNative, value)) {
    return { ok: false, code: "treasury_short", error: "Treasury has insufficient SATS to cover this withdrawal" };
  }

  const gasPrice = await getGasPrice();
  let gasLimit: bigint;
  try {
    gasLimit = await estimateNativeTransferGas(toAddress, value);
  } catch (e: unknown) {
    const err = e as { message?: string; reason?: string };
    return { ok: false, code: "invalid", error: `Unable to estimate withdrawal gas: ${err?.reason ?? err?.message ?? String(e)}` };
  }

  let gasCost = gasLimit * gasPrice;
  // 50% buffer on withdrawals — treasury keeps the surplus
  let chargedGas = gasCost + gasCost / 2n;
  let gasSats = tokenUnitsToSats(chargedGas);

  let sendValue = value - chargedGas;
  if (sendValue <= 0n) {
    return { ok: false, code: "invalid", error: `Amount too small to cover network gas (~${gasSats} sats)` };
  }

  try {
    const refinedGasLimit = await estimateNativeTransferGas(toAddress, sendValue);
    if (refinedGasLimit > gasLimit) {
      gasLimit = refinedGasLimit;
      gasCost = gasLimit * gasPrice;
      chargedGas = gasCost + gasCost / 2n;
      gasSats = tokenUnitsToSats(chargedGas);
      sendValue = value - chargedGas;

      if (sendValue <= 0n) {
        return { ok: false, code: "invalid", error: `Amount too small to cover network gas (~${gasSats} sats)` };
      }
    }
  } catch (e: unknown) {
    const err = e as { message?: string; reason?: string };
    return { ok: false, code: "invalid", error: `Unable to estimate withdrawal gas: ${err?.reason ?? err?.message ?? String(e)}` };
  }

  return { ok: true, sendValue, gasLimit, gasPrice, gasSats, sentSats: tokenUnitsToSats(sendValue) };
}

/** Serializes treasury withdrawal nonce assignment → persist → broadcast in this process. */
let withdrawalSendQueue: Promise<void> = Promise.resolve();

async function withWithdrawalSendLock<T>(fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prev = withdrawalSendQueue;
  withdrawalSendQueue = prev.then(() => gate);
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

type WithdrawalTxRequest = { to: string; value?: bigint; data?: string; gasLimit: bigint; gasPrice: bigint };
type WithdrawalBroadcast =
  | { broadcast: true; txHash: string; nonce: number; signedAt: number }
  | { broadcast: false; error: string };

/**
 * Assign a nonce, sign locally, persist hash + nonce (+ raw tx) on the
 * still-pending row, then broadcast. Nothing is sent unless the persist
 * landed; once it has, every outcome counts as possibly broadcast.
 */
async function signPersistAndBroadcast(
  record: WithdrawalRecord,
  request: WithdrawalTxRequest,
  payout?: { signer: ethers.Wallet; payoutRef: string },
): Promise<WithdrawalBroadcast> {
  if (!payout) assertCustodyAvailable();
  const signer = payout?.signer ?? treasury();
  return withWithdrawalSendLock(async () => {
    if (payout) assertCanSign();
    const nonceRaw = await rawRpcCall("eth_getTransactionCount", [signer.address, "pending"]) as string;
    const nonce = Number(BigInt(nonceRaw ?? "0x0"));
    const signedTx = await signer.signTransaction({
      ...request,
      nonce,
      chainId: config.evm.chainId,
      type: 0,
    });
    const txHash = ethers.keccak256(signedTx);
    const signedAt = Date.now();
    if (payout) {
      // The watchdog freezes custody on any operator nonce without a record.
      try {
        await recordSignedTx({ signer: signer.address, nonce, txHash, purpose: "withdrawal", ref: payout.payoutRef });
      } catch (error) {
        return { broadcast: false, error: (error as Error).message };
      }
    }
    // If this write's response is lost after it committed, nothing is sent
    // now; the refund then sees the hash and recovery rebroadcasts raw_tx.
    const persisted = await persistWithdrawalBroadcast(
      record.id,
      txHash,
      nonce,
      signedTx,
      signedAt,
      payout ? { signer_address: signer.address.toLowerCase(), payout_ref: payout.payoutRef } : undefined,
    );
    if (!persisted.ok) {
      return { broadcast: false, error: `Could not record the transaction before sending it: ${persisted.error}` };
    }

    try {
      await rawRpcCall("eth_sendRawTransaction", [signedTx]);
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      if (!/already known|known transaction/i.test(message)) {
        // Ambiguous: the node may have accepted the tx before the error
        // surfaced. The persisted hash/nonce settle it from chain state.
        console.warn(`[Withdraw] ${record.id}: broadcast of ${txHash} errored; resolving on-chain: ${message.slice(0, 300)}`);
      }
    }
    return { broadcast: true, txHash, nonce, signedAt };
  });
}

/**
 * One read of a withdrawal tx. The mined nonce is read BEFORE the receipt: if
 * the tx mines between the two reads the receipt shows it, whereas the
 * reverse order could mistake a just-mined tx for a dropped one.
 */
async function observeWithdrawalTx(
  txHash: string,
  knownNonce: number | null,
  signedAtMs: number,
  signerAddress: string,
): Promise<WithdrawalObservation> {
  let minedNonce: number | null = null;
  try {
    const raw = await rawRpcCall("eth_getTransactionCount", [signerAddress, "latest"]) as string | null;
    if (raw != null) minedNonce = Number(BigInt(raw));
  } catch {
    // Unknown mined nonce → no drop verdict this round.
  }

  let receipt: WithdrawalReceiptLike | null | undefined;
  try {
    receipt = await rawRpcCall("eth_getTransactionReceipt", [txHash]) as WithdrawalReceiptLike | null;
  } catch {
    receipt = undefined;
  }

  let txNonce = knownNonce;
  let txMined = false;
  // Only a possible drop needs the tx lookup (is it mined? which nonce?).
  const nonceMayBeConsumed = txNonce == null || (minedNonce != null && minedNonce > txNonce);
  if (receipt === null && nonceMayBeConsumed) {
    try {
      const tx = await rawRpcCall("eth_getTransactionByHash", [txHash]) as {
        blockNumber?: string | null;
        nonce?: string | null;
      } | null;
      txMined = tx?.blockNumber != null;
      if (txNonce == null && tx?.nonce != null) txNonce = Number(BigInt(tx.nonce));
    } catch {
      receipt = undefined;
    }
  }

  return { broadcast: true, receipt, txMined, txNonce, minedNonce, signedAgeMs: Date.now() - signedAtMs };
}

function receiptGasSats(
  receipt: WithdrawalReceiptLike | null | undefined,
  fallbackGasPrice: bigint | null,
): number | undefined {
  if (!receipt?.gasUsed) return undefined;
  try {
    const price = receipt.effectiveGasPrice != null ? BigInt(receipt.effectiveGasPrice) : fallbackGasPrice;
    return price == null ? undefined : tokenUnitsToSats(BigInt(receipt.gasUsed) * price);
  } catch {
    return undefined;
  }
}

const WITHDRAWAL_POLL_INTERVAL_MS = 3_000;
const WITHDRAWAL_POLL_ATTEMPTS = 40; // ~2 minutes

/**
 * Send a reserved withdrawal and wait up to ~2 minutes for a verdict. Errors
 * before signing mean nothing was sent (refund). After the hash is persisted
 * only a receipt or a consumed nonce can decide it; otherwise it stays
 * pending for recovery.
 */
export async function executeWithdrawal(
  record: WithdrawalRecord,
  gasQuote?: Erc20WithdrawalGasQuote,
): Promise<WithdrawResult> {
  const v2 = getCustodyMode() === "v2" ? getV2Settings() : null;
  if (v2) return executePayoutWithdrawal(record, v2);
  const token = record.token;
  let sent: WithdrawalBroadcast;
  let gasPrice: bigint;
  let gasSats: number | undefined;
  let sentSats: number | undefined;
  try {
    if (token === "SATS") {
      const plan = await planNativeWithdrawal(record.to_address, record.amount_sats);
      if (!plan.ok) return { outcome: "refund", reason: "never_broadcast", error: plan.error };
      gasPrice = plan.gasPrice;
      gasSats = plan.gasSats;
      sentSats = plan.sentSats;
      sent = await signPersistAndBroadcast(record, {
        to: record.to_address,
        value: plan.sendValue,
        gasLimit: plan.gasLimit,
        gasPrice: plan.gasPrice,
      });
    } else {
      const cfg = assertTokenConfigured(token);
      const units = tokenAmountToUnits(record.amount_sats, token);
      if (units <= 0n) return { outcome: "refund", reason: "never_broadcast", error: "Amount too small" };
      const treasuryBalance = await getTokenBalance(treasury().address, token);
      if (treasuryBalance < units) {
        return { outcome: "refund", reason: "never_broadcast", error: `Treasury has insufficient ${token}` };
      }
      gasPrice = gasQuote?.gasPrice ?? await getGasPrice();
      const gasLimit = gasQuote?.gasLimit
        ?? (await quoteErc20WithdrawalGas(record.to_address, record.amount_sats, token)).gasLimit;
      await ensureErc20WithdrawalGas(token, gasLimit * gasPrice, gasPrice);
      sentSats = record.amount_sats;
      sent = await signPersistAndBroadcast(record, {
        to: cfg.contractAddress!,
        data: ERC20_INTERFACE.encodeFunctionData("transfer", [record.to_address, units]),
        gasLimit,
        gasPrice,
      });
    }
  } catch (error) {
    // Thrown before the hash was persisted, so nothing was broadcast. (If the
    // persist itself landed despite an error, finalize sees the hash and
    // leaves the row pending.)
    return { outcome: "refund", reason: "never_broadcast", error: describeNativeWithdrawalError(error) };
  }

  if (!sent.broadcast) {
    return { outcome: "refund", reason: "never_broadcast", error: sent.error, gasSats, sentSats };
  }

  const { txHash, nonce, signedAt } = sent;
  const poll = await pollWithdrawalOutcome({
    attempts: WITHDRAWAL_POLL_ATTEMPTS,
    intervalMs: WITHDRAWAL_POLL_INTERVAL_MS,
    observe: () => observeWithdrawalTx(txHash, nonce, signedAt, treasury().address),
  });
  const actualGasSats = receiptGasSats(poll.observation?.receipt, gasPrice);
  const result: WithdrawResult = {
    outcome: poll.outcome,
    reason: poll.reason,
    txHash,
    gasSats: token === "SATS" ? gasSats : actualGasSats ?? gasQuote?.gasSats,
    sentSats,
    actualGasSats,
  };
  if (poll.outcome === "refund") {
    result.error = poll.reason === "reverted" ? "Transaction reverted on-chain" : "Transaction was dropped by the network";
  } else if (poll.outcome === "pending") {
    console.warn(`[Withdraw] ${record.id}: ${txHash} unresolved after ~2 minutes (${poll.reason}); recovery will finalize it`);
  }
  return result;
}

/**
 * Custody v2: pay the reserved withdrawal through HotPayout.payNative /
 * payToken from the operator. The exact call is simulated first; a revert
 * (paused, cap, float, recipient) means nothing is signed and the user is
 * refunded. Completion needs a status-1 receipt carrying the matching Paid
 * log; a refund needs paid(ref) to read false.
 */
async function executePayoutWithdrawal(record: WithdrawalRecord, settings: V2Settings): Promise<WithdrawResult> {
  const operator = getOperatorWallet();
  let ready: Extract<Awaited<ReturnType<typeof planPayout>>, { ok: true }>;
  let sent: WithdrawalBroadcast;
  try {
    if (!operator) throw new Error("the payout operator key is unavailable");
    const plan = await planPayout(settings, {
      withdrawalId: record.id,
      to: record.to_address,
      token: record.token,
      amount: record.amount_sats,
    });
    if (!plan.ok) {
      if (plan.code === "already_paid") {
        // The bot never signed this ref, yet HotPayout shows it paid: never
        // refund it, and stop all custody signing until an admin looks.
        await freezeCustody(`HotPayout already shows withdrawal ${record.id}'s ref as paid before the bot signed it.`, withdrawalKey(record.id));
        return { outcome: "pending", reason: "payout_unproven", error: plan.error };
      }
      // paid(ref) unreadable: nothing was signed, but a refund needs paid(ref)
      // to read false, so recovery settles the hashless row.
      if (plan.code === "paid_unknown") return { outcome: "pending", reason: "lookup_failed", error: plan.error };
      return { outcome: "refund", reason: "never_broadcast", error: plan.error };
    }
    ready = plan;
    sent = await signPersistAndBroadcast(record, {
      to: settings.payout,
      data: encodePayoutCall(plan.expected),
      gasLimit: plan.gasLimit,
      gasPrice: plan.gasPrice,
    }, { signer: operator, payoutRef: plan.expected.ref });
  } catch (error) {
    // Thrown before the hash was persisted, so nothing was broadcast.
    return { outcome: "refund", reason: "never_broadcast", error: describeNativeWithdrawalError(error) };
  }

  const { gasSats, sentSats, expected } = ready;
  if (!sent.broadcast) return { outcome: "refund", reason: "never_broadcast", error: sent.error, gasSats, sentSats };

  const { txHash, nonce, signedAt } = sent;
  const signerAddress = operator.address;
  const poll = await pollWithdrawalOutcome({
    attempts: WITHDRAWAL_POLL_ATTEMPTS,
    intervalMs: WITHDRAWAL_POLL_INTERVAL_MS,
    observe: async () => {
      const observation = await observeWithdrawalTx(txHash, nonce, signedAt, signerAddress);
      observation.payout = await gatherPayoutProof(settings, { ref: expected.ref, expected, observation, ownTxHash: txHash });
      return observation;
    },
  });
  const actualGasSats = receiptGasSats(poll.observation?.receipt, ready.gasPrice);
  const result: WithdrawResult = {
    outcome: poll.outcome,
    reason: poll.reason,
    txHash,
    gasSats: record.token === "SATS" ? gasSats : actualGasSats ?? gasSats,
    sentSats,
    actualGasSats,
  };
  if (poll.outcome === "refund") {
    const reverted = poll.reason === "reverted"
      ? await explainRevertedPayout(settings, expected, (poll.observation?.receipt as { blockNumber?: unknown } | null)?.blockNumber)
      : null;
    result.error = poll.reason === "reverted"
      ? reverted ?? "Transaction reverted on-chain"
      : "Transaction was dropped by the network";
  } else if (isPayoutAnomaly(poll)) {
    console.error(`[Withdraw] MANUAL REVIEW: withdrawal ${record.id} (${txHash}) has no matching HotPayout Paid log; held pending`);
    await freezeCustody(`Withdrawal ${record.id} (tx ${txHash}): HotPayout shows no Paid log matching the call the bot signed.`, withdrawalKey(record.id));
  } else if (poll.outcome === "pending") {
    console.warn(`[Withdraw] ${record.id}: ${txHash} unresolved after ~2 minutes (${poll.reason}); recovery will finalize it`);
  }
  return result;
}

/** ERC-20 gas reservation of a row that predates gas_reserved_sats (it lives in the ledger). */
async function legacyGasReservation(record: WithdrawalRecord): Promise<number | null> {
  if (record.token === "SATS" || record.gas_reserved_sats != null) return null;
  const { data } = await supabase
    .from("ledger_entries")
    .select("amount_sats")
    .eq("type", "withdrawal_network_fee")
    .eq("reference_type", "withdrawals")
    .eq("reference_id", String(record.id))
    .limit(1)
    .maybeSingle();
  const amount = Number(data?.amount_sats ?? 0);
  if (amount > 0) return amount;
  console.error(`[Withdraw] MANUAL REVIEW: withdrawal ${record.id} has no recorded gas reservation; none will be returned`);
  return null;
}

export type WithdrawalFinalState =
  /** Confirmed on-chain (see `recorded`). */
  | "completed"
  /** This call refunded the user. */
  | "refunded"
  /** Outcome unknown; the row stays pending for recovery. */
  | "pending"
  /** Proven failed, but the refund call failed or its response was lost; recovery retries it (idempotent). */
  | "refund_pending"
  /** Another worker settled the row first; see currentStatus. */
  | "already_final";

export type WithdrawalFinalization = {
  state: WithdrawalFinalState;
  /** completed only: false when the row update did not confirm (recovery retries it). */
  recorded?: boolean;
  unusedGasRefundSats?: number;
  currentStatus?: string | null;
};

type LedgerClient = Parameters<typeof recordLedgerEntry>[0];

/**
 * Apply a verdict through the atomic SQL functions, shared by the live
 * command and recovery. Each function locks the row and acts only while it is
 * 'pending', so a failed or lost call is simply retried by recovery's next
 * pass and can never credit twice.
 */
export async function finalizeWithdrawal(
  record: WithdrawalRecord,
  result: Pick<WithdrawResult, "outcome" | "reason" | "txHash" | "actualGasSats">,
  context: { client?: LedgerClient; guildId?: string | null } = {},
): Promise<WithdrawalFinalization> {
  if (result.outcome === "pending") return { state: "pending" };

  const client = context.client ?? null;
  const ledgerBase = {
    senderId: "treasury",
    receiverId: record.discord_id,
    guildId: context.guildId ?? null,
    referenceType: "withdrawals",
    referenceId: String(record.id),
  } as const;
  const details =
    `withdrawal ${record.id} (${record.discord_id}, ${record.amount_sats} ${record.token} → ${record.to_address}, ` +
    `tx ${result.txHash ?? record.tx_hash ?? "none"}, ${result.reason})`;
  const fallbackGasSats = await legacyGasReservation(record);

  if (result.outcome === "completed") {
    const { data, error } = await supabase.rpc("complete_withdrawal_v2", {
      p_withdrawal_id: record.id,
      p_actual_gas_sats: result.actualGasSats ?? null,
      p_fallback_gas_sats: fallbackGasSats,
    });
    if (error) {
      console.error(`[Withdraw] ${details}: confirmed on-chain but not recorded (${error.message}); recovery will retry`);
      return { state: "completed", recorded: false };
    }
    const response = (data ?? {}) as { status?: string; unused_gas_sats?: unknown; current?: unknown };
    if (response.status !== "completed") return settledElsewhere(response, details);
    const unused = Number(response.unused_gas_sats ?? 0);
    if (unused > 0) {
      recordLedgerEntry(client, {
        ...ledgerBase,
        type: "withdrawal_network_fee_refund",
        amountSats: unused,
        token: "SATS",
        metadata: { reason: "unused_gas_reservation" },
      });
    }
    return { state: "completed", recorded: true, unusedGasRefundSats: unused > 0 ? unused : undefined };
  }

  // A never-broadcast refund also requires the row to be hashless and from
  // the persist-before-broadcast pipeline (checked under the row lock).
  const { data, error } = await supabase.rpc("refund_withdrawal_v2", {
    p_withdrawal_id: record.id,
    p_require_no_hash: result.reason === "never_broadcast",
    p_fallback_gas_sats: fallbackGasSats,
  });
  if (error) {
    console.error(
      `[Withdraw] ${details}: refund ${isDefiniteDbFailure(error) ? "failed" : "unconfirmed (if it committed, its ledger entry is missing)"}: ` +
      `${error.message}; recovery retries it`,
    );
    return { state: "refund_pending" };
  }
  const response = (data ?? {}) as { status?: string; gas_sats?: unknown; current?: unknown };
  if (response.status === "has_hash") return { state: "pending" };
  if (response.status === "legacy_row") {
    console.error(`[Withdraw] MANUAL REVIEW: ${details}: legacy hashless row is not refunded automatically`);
    return { state: "pending" };
  }
  if (response.status !== "refunded") return settledElsewhere(response, details);

  recordLedgerEntry(client, {
    ...ledgerBase,
    type: "withdrawal_refund",
    amountSats: record.amount_sats,
    token: record.token,
    metadata: { reason: result.reason },
  });
  const gasSats = Number(response.gas_sats ?? 0);
  if (gasSats > 0) {
    recordLedgerEntry(client, {
      ...ledgerBase,
      type: "withdrawal_network_fee_refund",
      amountSats: gasSats,
      token: "SATS",
      metadata: { reason: result.reason },
    });
  }
  return { state: "refunded" };
}

function settledElsewhere(
  response: { status?: string; current?: unknown },
  details: string,
): WithdrawalFinalization {
  if (response.status === "not_pending") {
    return { state: "already_final", currentStatus: response.current == null ? null : String(response.current) };
  }
  console.error(`[Withdraw] ${details}: unexpected settlement result ${JSON.stringify(response)}`);
  return { state: "pending" };
}

/** Current status of a row, for replies after another worker settled it. */
export async function getWithdrawalStatus(id: number): Promise<string | null> {
  return readWithdrawalStatus(id);
}

const WITHDRAWAL_RECOVERY_INTERVAL_MS = 60_000;
/** Live commands poll ~2 minutes; recovery leaves younger rows to them. */
const WITHDRAWAL_RECOVERY_MIN_AGE_MS = 5 * 60_000;
const WITHDRAWAL_REVIEW_AFTER_MS = 30 * 60_000;
const WITHDRAWAL_REVIEW_LOG_INTERVAL_MS = 60 * 60_000;
let withdrawalRecoveryTimer: ReturnType<typeof setInterval> | null = null;
let withdrawalRecoveryRunning = false;
const withdrawalReviewLoggedAt = new Map<number, number>();

function logWithdrawalForReview(id: number, message: string): void {
  const last = withdrawalReviewLoggedAt.get(id) ?? 0;
  if (Date.now() - last < WITHDRAWAL_REVIEW_LOG_INTERVAL_MS) return;
  withdrawalReviewLoggedAt.set(id, Date.now());
  console.error(`[Recovery] MANUAL REVIEW withdrawal ${id}: ${message}`);
}

/**
 * Resolve withdrawals the live command could not finish (restart mid-poll,
 * receipt timeout, lost database responses) with the same rules as the live
 * path. Called at startup; it then re-runs itself every minute.
 */
export async function recoverPendingWithdrawals(): Promise<void> {
  if (!withdrawalRecoveryTimer) {
    withdrawalRecoveryTimer = setInterval(() => {
      recoverPendingWithdrawals().catch((err) =>
        console.error("[Recovery] Withdrawal pass failed:", (err as Error)?.message ?? err),
      );
    }, WITHDRAWAL_RECOVERY_INTERVAL_MS);
    withdrawalRecoveryTimer.unref?.();
  }
  if (withdrawalRecoveryRunning) return;
  withdrawalRecoveryRunning = true;
  try {
    await recoverPendingWithdrawalsOnce();
  } finally {
    withdrawalRecoveryRunning = false;
  }
}

async function recoverPendingWithdrawalsOnce(): Promise<void> {
  const cutoff = new Date(Date.now() - WITHDRAWAL_RECOVERY_MIN_AGE_MS).toISOString();
  const { data: stale, error } = await supabase
    .from("withdrawals")
    .select("*")
    .eq("status", "pending")
    .lt("created_at", cutoff)
    .order("id")
    .limit(100);
  if (error) throw new Error(error.message);

  for (const row of stale ?? []) {
    try {
      await recoverOneWithdrawal(toWithdrawalRecord(row));
    } catch (err) {
      console.error(`[Recovery] Withdrawal ${row.id}:`, (err as Error)?.message ?? err);
    }
  }
}

async function recoverOneWithdrawal(record: WithdrawalRecord): Promise<void> {
  const payoutSettings = getConfiguredV2Settings();
  if (!record.tx_hash) {
    // Older code wrote tx_hash only after ~2 minutes of polling (and an old
    // replica can still do so during a deploy overlap), so only pipeline-2
    // rows prove "never broadcast".
    if ((record.pipeline_version ?? 0) < 2) {
      logWithdrawalForReview(
        record.id,
        `legacy pending row without tx_hash (${record.discord_id}, ${record.amount_sats} ${record.token} → ` +
        `${record.to_address}); check the treasury's txs to that address before refunding`,
      );
      return;
    }
    if (payoutSettings) {
      // A ref HotPayout shows as paid was paid by someone: never refund it.
      const paid = await isRefPaid(payoutSettings, payoutRef(record.id)).catch(() => null);
      if (paid !== false) {
        logWithdrawalForReview(
          record.id,
          paid
            ? "HotPayout shows this withdrawal's ref as paid but the bot recorded no transaction; not refunded"
            : "could not read HotPayout.paid(ref); refund deferred",
        );
        if (paid) await freezeCustody(`HotPayout shows withdrawal ${record.id}'s ref as paid, but the bot never broadcast it.`, withdrawalKey(record.id));
        return;
      }
    }
    const final = await finalizeWithdrawal(record, { outcome: "refund", reason: "never_broadcast" });
    console.log(`[Recovery] Withdrawal ${record.id}: no tx hash (never broadcast) → ${final.state}`);
    return;
  }

  const txHash = record.tx_hash;
  const isPayout = record.signer_address != null || record.payout_ref != null;
  const signedAt = Date.parse(record.signed_at ?? record.created_at);
  let observe: () => Promise<WithdrawalObservation>;
  if (isPayout) {
    if (!payoutSettings) {
      logWithdrawalForReview(record.id, "HotPayout withdrawal but custody v2 is not configured; cannot verify it");
      return;
    }
    const settings = payoutSettings;
    const signer = record.signer_address ?? settings.operator;
    const expected = expectedPayoutForRow(settings, record);
    observe = async () => {
      const observation = await observeWithdrawalTx(txHash, record.nonce, signedAt, signer);
      observation.payout = await gatherPayoutProof(settings, { ref: payoutRef(record.id), expected, observation, ownTxHash: txHash });
      return observation;
    };
  } else {
    const signer = getLegacyTreasuryAddress();
    if (!signer) {
      logWithdrawalForReview(record.id, "treasury withdrawal and TREASURY_PRIVATE_KEY is not set; cannot observe its nonce");
      return;
    }
    observe = () => observeWithdrawalTx(txHash, record.nonce, signedAt, signer);
  }

  let observation = await observe();
  let verdict = explainWithdrawalOutcome(observation);
  if (verdict.reason === "dropped") {
    // Same re-check the live poller does before trusting a drop.
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    observation = await observe();
    verdict = explainWithdrawalOutcome(observation);
  }

  if (verdict.outcome === "pending") {
    // A frozen custody sends nothing, not even a stored signed payout.
    if (!(isPayout && isCustodyFrozen())) await rebroadcastIfLost(record, observation);
    const ageMs = Date.now() - signedAt;
    if (isPayoutAnomaly(verdict)) {
      logWithdrawalForReview(record.id, `tx ${txHash}: no HotPayout Paid log matches the signed call; never refunded or completed automatically`);
      await freezeCustody(`Withdrawal ${record.id} (tx ${txHash}): HotPayout shows no Paid log matching the call the bot signed.`, withdrawalKey(record.id));
    } else if (ageMs >= WITHDRAWAL_REVIEW_AFTER_MS) {
      logWithdrawalForReview(
        record.id,
        `pending ${Math.round(ageMs / 60_000)} min (${verdict.reason}); tx ${record.tx_hash}, ` +
        `nonce ${observation.txNonce ?? "unknown"}, treasury mined nonce ${observation.minedNonce ?? "unknown"}`,
      );
    }
    return;
  }

  const final = await finalizeWithdrawal(record, {
    outcome: verdict.outcome,
    reason: verdict.reason,
    txHash,
    actualGasSats: receiptGasSats(observation.receipt, null),
  });
  console.log(`[Recovery] Withdrawal ${record.id}: ${verdict.reason} → ${final.state}${final.recorded === false ? " (not recorded yet)" : ""}`);
}

/** Re-send the exact stored signed tx (same hash, so idempotent) when the node has lost it. */
async function rebroadcastIfLost(record: WithdrawalRecord, observation: WithdrawalObservation): Promise<void> {
  if (!record.raw_tx || !record.tx_hash || observation.receipt !== null || observation.txMined) return;
  if (ethers.keccak256(record.raw_tx).toLowerCase() !== record.tx_hash.toLowerCase()) {
    logWithdrawalForReview(record.id, "stored raw_tx does not hash to tx_hash; not rebroadcasting");
    return;
  }
  try {
    if (await rawRpcCall("eth_getTransactionByHash", [record.tx_hash]) != null) return;
    await rawRpcCall("eth_sendRawTransaction", [record.raw_tx]);
    console.log(`[Recovery] Withdrawal ${record.id}: node had lost ${record.tx_hash}; rebroadcast the signed tx`);
  } catch (error) {
    const message = String((error as Error)?.message ?? error);
    if (!/already known|known transaction|nonce too low/i.test(message)) {
      console.warn(`[Recovery] Withdrawal ${record.id}: rebroadcast failed: ${message.slice(0, 300)}`);
    }
  }
}

function describeNativeWithdrawalError(error: unknown): string {
  const err = error as { code?: string; message?: string; reason?: string };
  const message = err.reason ?? err.message ?? String(error);
  if (err.code === "INSUFFICIENT_FUNDS" || /insufficient funds/i.test(message)) {
    return "Treasury has insufficient SATS to cover this withdrawal";
  }
  return message;
}

export type SatsBackingSnapshot = {
  treasurySats: number;
  /** User balances plus user SATS held in flight (see inFlight). */
  userLiabilities: number;
  poolLiabilities: number;
  /** Debited from users but in no balance: pending withdrawals, drop remainders, arcade escrow, swap escrow. */
  inFlight: InFlightSatsLiabilities;
  reserveSats: number;
  excessSats: number;
};

const LIABILITY_PAGE_SIZE = 1000;

/** Read a whole (normally tiny) in-flight set; PostgREST caps responses at 1000 rows. */
async function selectAllPages<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += LIABILITY_PAGE_SIZE) {
    const { data, error } = await page(from, from + LIABILITY_PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if ((data?.length ?? 0) < LIABILITY_PAGE_SIZE) return rows;
  }
}

async function getInFlightSatsLiabilities(): Promise<InFlightSatsLiabilities> {
  const [withdrawals, drops, arcadeEscrow, swaps] = await Promise.all([
    selectAllPages((from, to) => supabase
      .from("withdrawals")
      .select("amount_sats, token, gas_reserved_sats")
      .eq("status", "pending")
      .order("id")
      .range(from, to)),
    selectAllPages((from, to) => supabase
      .from("drops")
      .select("per_claim_sats, max_claims, claims_count, token")
      .eq("status", "active")
      .eq("token", "SATS")
      .order("id")
      .range(from, to)),
    selectAllPages((from, to) => supabase
      .from("arcade_escrow")
      .select("amount_sats")
      .eq("status", "funded")
      .order("id")
      .range(from, to)),
    selectAllPages((from, to) => supabase
      .from("swaps")
      .select("from_token, from_amount, gas_reserved_sats, gas_refunded_sats, gas_settled")
      .in("status", ["reserved", "submitted", "needs_review"])
      .order("id")
      .range(from, to)),
  ]);
  return sumInFlightSatsLiabilities({ withdrawals, drops, arcadeEscrow, swaps });
}

async function loadSatsBacking(): Promise<SatsBackingSnapshot & { treasuryWei: bigint }> {
  const [treasuryWei, snapshot, inFlight] = await Promise.all([
    // Vault + HotPayout in custody v2, the treasury hot wallet otherwise.
    getHoldingsUnits("SATS"),
    getProtocolOperationalSnapshot(),
    getInFlightSatsLiabilities(),
  ]);
  const treasurySats = tokenUnitsToSats(treasuryWei);
  const userLiabilities = snapshot.userSatsLiability + inFlight.total;
  const poolLiabilities = snapshot.poolSatsLiability;
  return {
    treasuryWei,
    treasurySats,
    userLiabilities,
    poolLiabilities,
    inFlight,
    reserveSats: config.evm.protocolGasReserveMinSats,
    excessSats: treasurySats - userLiabilities - poolLiabilities,
  };
}

export async function getSatsBackingSnapshot(): Promise<SatsBackingSnapshot> {
  const { treasuryWei: _treasuryWei, ...snapshot } = await loadSatsBacking();
  return snapshot;
}

export type SatsExitCheck =
  | { ok: true; backing: SatsBackingSnapshot }
  | { ok: false; reason: "underbacked"; shortfallSats: number; backing: SatsBackingSnapshot }
  | { ok: false; reason: "unavailable"; error: string };

/**
 * Gate for native SATS leaving the treasury (withdrawals, on-chain SATS
 * swaps): the treasury must cover all liabilities plus the reserve. Fails
 * closed when backing cannot be measured.
 */
export async function checkSatsExitSolvency(): Promise<SatsExitCheck> {
  let backing: Awaited<ReturnType<typeof loadSatsBacking>>;
  try {
    backing = await loadSatsBacking();
  } catch (error) {
    const message = (error as Error)?.message ?? String(error);
    console.warn("[Solvency] Could not measure SATS backing; blocking SATS exits:", message);
    return { ok: false, reason: "unavailable", error: message };
  }
  const liabilityWei = satsToTokenUnits(backing.userLiabilities + backing.poolLiabilities);
  const reserveWei = satsToTokenUnits(backing.reserveSats);
  if (satsExitAllowed(backing.treasuryWei, liabilityWei, reserveWei)) return { ok: true, backing };
  const shortfallSats = tokenUnitsToSats(satsBackingShortfallWei(backing.treasuryWei, liabilityWei, reserveWei));
  console.warn(
    `[Solvency] Blocking SATS exit: treasury ${backing.treasurySats} sats, liabilities ` +
    `${backing.userLiabilities + backing.poolLiabilities} sats (in flight ${backing.inFlight.total}), ` +
    `reserve ${backing.reserveSats} sats, short ${shortfallSats} sats`,
  );
  return { ok: false, reason: "underbacked", shortfallSats, backing };
}

export async function canMintSats(amountSats: number): Promise<{ ok: true } | { ok: false; shortfallSats: number }> {
  const backing = await loadSatsBacking();
  const liabilityWei = satsToTokenUnits(backing.userLiabilities + backing.poolLiabilities);
  const mintWei = satsToTokenUnits(amountSats);
  const reserveWei = satsToTokenUnits(config.evm.protocolGasReserveMinSats);
  if (satsMintCovered(backing.treasuryWei, liabilityWei, mintWei, reserveWei)) return { ok: true };
  return { ok: false, shortfallSats: tokenUnitsToSats(liabilityWei + mintWei + reserveWei - backing.treasuryWei) };
}

export async function warnIfSatsUnderbacked(): Promise<void> {
  try {
    const backing = await getSatsBackingSnapshot();
    if (backing.excessSats < backing.reserveSats) {
      const inFlight = backing.inFlight;
      console.warn(
        `[Solvency] SATS backing shortfall: treasury ${backing.treasurySats} sats, ` +
        `liabilities ${backing.userLiabilities + backing.poolLiabilities} sats ` +
        `(in flight: withdrawals ${inFlight.pendingWithdrawals}, drops ${inFlight.dropRemainders}, ` +
        `arcade ${inFlight.arcadeEscrow}, swaps ${inFlight.swapEscrow}), ` +
        `excess ${backing.excessSats} sats, reserve ${backing.reserveSats} sats`,
      );
    }
  } catch (error) {
    console.warn("[Solvency] Failed to check SATS backing:", (error as Error).message);
  }
}

/** Native holdings in sats (vault + HotPayout in custody v2, the treasury otherwise). */
export async function getTreasuryBalanceSats(): Promise<number> {
  return tokenUnitsToSats(await getHoldingsUnits("SATS"));
}

/** Holdings per token (vault + HotPayout in custody v2, the treasury otherwise). */
export async function getTreasuryBalances(): Promise<Record<TokenSymbol, number>> {
  const entries = await Promise.all(TOKEN_SYMBOLS.map(async (token) => {
    const units = await getHoldingsUnits(token);
    return [token, tokenUnitsToAmount(units, token)] as const;
  }));
  return Object.fromEntries(entries) as Record<TokenSymbol, number>;
}
