import { randomUUID } from "node:crypto";
import { ethers } from "ethers";
import { config, satsToTokenUnits, tokenUnitsToSats } from "./config.js";
import { supabase } from "./db.js";
import { addBalance } from "./balance.js";
import { recordLedgerEntry } from "./ledger.js";
import { verifyWalletFromDeposit } from "./walletVerification.js";
import { meetsPublicDepositMinimum, nextSweepTime, pollableDepositRows, preservesGasReserve } from "./depositPolicy.js";
import { TOKEN_SYMBOLS, assertTokenConfigured, tokenAmountToUnits, tokenDecimalToUnits, tokenUnitsToAmount, type TokenSymbol } from "./tokens.js";

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
];
const ERC20_INTERFACE = new ethers.Interface(ERC20_ABI);

let provider: ethers.JsonRpcProvider;
let wallet: ethers.Wallet;
let sweepGasSponsorWallet: ethers.Wallet;
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
      });

      const text = await res.text();
      if (!res.ok) {
        throw new Error(`RPC HTTP ${res.status}: ${text.slice(0, 200)}`);
      }

      const data: unknown = text ? JSON.parse(text) : null;
      const item = Array.isArray(data) ? data[0] : data;
      const rpc = item as { error?: { message?: string }; result?: unknown };
      if (rpc.error) {
        const rpcError = new Error(rpc.error.message ?? JSON.stringify(rpc.error)) as RpcError;
        rpcError.rpcError = true;
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

export function getTreasuryAddress(): string {
  return wallet.address;
}

export function getSweepGasSponsorAddress(): string {
  return sweepGasSponsorWallet.address;
}

export function initEVM() {
  const network = { chainId: config.evm.chainId, name: "mezo" };
  provider = new ethers.JsonRpcProvider(config.evm.rpcUrl, network, {
    staticNetwork: true,
    batchMaxCount: 1,
  });
  wallet = new ethers.Wallet(config.evm.treasuryPrivateKey, provider);
  sweepGasSponsorWallet = new ethers.Wallet(
    config.evm.sweepGasSponsorPrivateKey || config.evm.treasuryPrivateKey,
    provider,
  );
  if (!config.depositAdminOnly && !config.evm.sweepGasSponsorPrivateKey) {
    console.warn("[Deposits] Public deposits are enabled without SWEEP_GAS_SPONSOR_PRIVATE_KEY; sweeps will use treasury excess only");
  }

  provider.on("error", () => {});

  return { provider, wallet };
}

/**
 * Derive a unique deposit wallet for a Discord user.
 * Deterministic: same user always gets the same address.
 */
export function getUserDepositWallet(discordId: string): ethers.Wallet {
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
};

type RpcError = Error & { rpcError?: boolean };

const depositAddressCache = new Map<string, DepositAddressRow>();
const depositRegistrationPromises = new Map<string, Promise<string>>();
const sweepPromises = new Map<string, Promise<string | null>>();
let depositAddressCacheLoadedAt = 0;
let depositAddressCacheRefresh: Promise<void> | null = null;
const depositTokenBalanceCache = new Map<string, bigint>();
const depositTokenSweepAfterCache = new Map<string, number | null>();
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

async function mapWithConcurrency<T, R>(
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
    address: row.address.toLowerCase(),
    last_checked_balance: row.last_checked_balance ?? "0",
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
    if (config.depositAdminOnly && config.discord.adminIds.length === 0) {
      depositAddressCache.clear();
      depositAddressCacheLoadedAt = Date.now();
      return;
    }

    let query = supabase
      .from("deposit_addresses")
      .select("discord_id, address, last_checked_balance");
    if (config.depositAdminOnly) query = query.in("discord_id", config.discord.adminIds);
    const { data, error } = await query;

    if (error) {
      console.error("Failed to refresh deposit address cache:", error.message);
      return;
    }

    depositAddressCache.clear();
    for (const row of (data ?? []) as DepositAddressRow[]) {
      const normalized = normalizeDepositRow(row);
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
    if (config.depositAdminOnly && config.discord.adminIds.length === 0) {
      depositTokenBalanceCache.clear();
      depositTokenSweepAfterCache.clear();
      depositTokenCacheLoadedAt = Date.now();
      return;
    }

    let query = supabase
      .from("deposit_token_balances")
      .select("discord_id, token, last_checked_balance, sweep_after");
    if (config.depositAdminOnly) query = query.in("discord_id", config.discord.adminIds);
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

/** Register a user's deposit address for polling */
export async function registerDepositAddress(discordId: string): Promise<string> {
  const address = getUserDepositAddress(discordId);
  const normalizedAddress = address.toLowerCase();
  const cached = depositAddressCache.get(discordId);

  if (cached?.address === normalizedAddress) return address;

  const pending = depositRegistrationPromises.get(discordId);
  if (pending) return pending;

  const registration = (async () => {
    const { data, error } = await supabase
      .from("deposit_addresses")
      .upsert(
        { discord_id: discordId, address: normalizedAddress },
        { onConflict: "discord_id", ignoreDuplicates: true }
      )
      .select("discord_id, address, last_checked_balance")
      .maybeSingle();

    if (error) throw error;

    let row = data as DepositAddressRow | null;

    if (!row) {
      const { data: existing, error: existingError } = await supabase
        .from("deposit_addresses")
        .select("discord_id, address, last_checked_balance")
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
    from: wallet.address,
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
  const contract = new ethers.Contract(cfg.contractAddress!, ERC20_ABI, provider);
  return BigInt(await contract.balanceOf(address));
}

async function getDepositNativeBalance(address: string): Promise<bigint> {
  const raw = await rawRpcCall(
    "eth_getBalance",
    [address, "latest"],
    { rateLimited: true },
  ) as string;
  return BigInt(raw ?? "0x0");
}

async function getDepositTokenBalance(
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
): Promise<string | null> {
  const cfg = assertTokenConfigured(token);
  const userWallet = getUserDepositWallet(discordId);
  const contract = new ethers.Contract(cfg.contractAddress!, ERC20_ABI, userWallet);
  const liveBalance = BigInt(await contract.balanceOf(userWallet.address));
  const tokenBalance = creditedUnits == null ? liveBalance : (liveBalance < creditedUnits ? liveBalance : creditedUnits);
  if (tokenBalance <= 0n) return null;

  const gasPrice = await getGasPrice();
  const estimated = BigInt(await contract.transfer.estimateGas(wallet.address, tokenBalance));
  const gasLimit = addGasLimitBuffer(estimated);
  const requiredGas = gasLimit * gasPrice;
  const nativeBalance = await getNativeBalance(userWallet.address);
  if (nativeBalance < requiredGas) {
    const funding = requiredGas - nativeBalance;
    const sponsorBalance = await getNativeBalance(sweepGasSponsorWallet.address);
    const minimumReserve = satsToTokenUnits(config.evm.protocolGasReserveMinSats);
    let protectedBacking = 0n;
    if (sweepGasSponsorWallet.address === wallet.address) {
      const liabilities = await getProtocolOperationalSnapshot();
      protectedBacking = satsToTokenUnits(liabilities.userSatsLiability + liabilities.poolSatsLiability);
    }
    const sponsorTxGas = NATIVE_TRANSFER_GAS_LIMIT * gasPrice;
    if (!preservesGasReserve(sponsorBalance, funding + sponsorTxGas, protectedBacking, minimumReserve)) {
      lastSweepGasError = "Sweep gas sponsor is below its protected reserve";
      throw new Error(lastSweepGasError);
    }

    const operationId = randomUUID();
    const { error: gasOperationError } = await supabase.from("protocol_gas_operations").insert({
      id: operationId,
      operation_type: "erc20_sweep_funding",
      discord_id: discordId,
      token,
      sponsor_address: sweepGasSponsorWallet.address,
      recipient_address: userWallet.address,
      amount_wei: funding.toString(),
      status: "pending",
    });
    if (gasOperationError) throw gasOperationError;
    try {
      const hash = await sendRawNativeTransfer(sweepGasSponsorWallet, userWallet.address, funding, NATIVE_TRANSFER_GAS_LIMIT, gasPrice);
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
  const tx = await contract.transfer(wallet.address, tokenBalance, { gasLimit, gasPrice });
  for (let i = 0; i < 40; i++) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const receipt = await rawRpcCall("eth_getTransactionReceipt", [tx.hash]) as { status: string } | null;
    if (!receipt) continue;
    if (parseInt(receipt.status, 16) !== 1) throw new Error(`${token} sweep reverted`);
    return tx.hash as string;
  }
  throw new Error(`${token} sweep confirmation timed out`);
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
  return tokenUnitsToSats(await provider.getBalance(sweepGasSponsorWallet.address));
}

export function getLastSweepGasError(): string | null {
  return lastSweepGasError;
}

/**
 * Sweep funds from a user's deposit address to the treasury.
 * Gas price is pinned on the tx, so cost = exactly gasLimit * gasPrice.
 * value = balance - gasCost → wallet is drained to 0 with no dust.
 */
export async function sweepToTreasury(discordId: string): Promise<string | null> {
  const pending = sweepPromises.get(discordId);
  if (pending) return pending;

  const sweep = sweepToTreasuryUnlocked(discordId).finally(() => {
    sweepPromises.delete(discordId);
  });
  sweepPromises.set(discordId, sweep);
  return sweep;
}

async function sweepToTreasuryUnlocked(discordId: string): Promise<string | null> {
  const userWallet = getUserDepositWallet(discordId);
  const balance = await getNativeBalance(userWallet.address);
  if (balance === 0n) return null;

  const gasPrice = await getGasPrice();
  const gasLimit = 21000n;
  const gasCost = gasLimit * gasPrice;

  // No buffer needed: we pin gasPrice on the tx, so actual cost is
  // exactly gasLimit * gasPrice.  value + gasCost = balance → 0 dust.
  const sendAmount = balance - gasCost;
  if (sendAmount <= 0n) {
    console.log(
      `Sweep skipped for ${discordId}: balance ${balance} wei < gas ${gasCost} wei`
    );
    return null;
  }

  return sendRawNativeTransfer(userWallet, wallet.address, sendAmount, gasLimit, gasPrice);
}

/**
 * Fund gas from treasury to a user's deposit wallet, wait for it to arrive,
 * then sweep the deposit wallet to treasury.
 * Used by the admin /sweep command for wallets where balance < gas cost.
 */
export async function fundGasAndSweep(discordId: string): Promise<string | null> {
  const userWallet = getUserDepositWallet(discordId);
  const balance = await getNativeBalance(userWallet.address);
  if (balance === 0n) return null;

  const gasPrice = await getGasPrice();
  const gasLimit = 21000n;
  const gasCost = gasLimit * gasPrice;

  // Send exactly enough gas for the sweep tx
  const gasFunding = gasCost;

  console.log(`Funding gas for ${discordId}: sending ${gasFunding} wei from treasury`);
  const fundHash = await sendRawNativeTransfer(wallet, userWallet.address, gasFunding, gasLimit, gasPrice);
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
  return sweepToTreasury(discordId);
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
      const rows = pollableDepositRows(
        Array.from(depositAddressCache.values()),
        config.depositAdminOnly,
        config.discord.adminIds,
      );

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
              console.log(`Wallet verification deposit locked for ${row.discord_id}`);
            } else if (netDeposit > 0n) {
              const netSats = tokenUnitsToSats(netDeposit);
              const gasSats = tokenUnitsToSats(gasCost);

              if (netSats > 0) {
                const txId = `auto-${Date.now()}-${row.discord_id}`;
                await supabase.from("deposits").insert({
                  discord_id: row.discord_id,
                  tx_hash: txId,
                  amount_sats: netSats,
                  block_number: 0,
                });
                await addBalance(row.discord_id, netSats);
                onDeposit?.(row.discord_id, netSats, gasSats, txId, "SATS");
              }
            } else {
              console.log(
                `Deposit too small to cover gas for ${row.discord_id}: ${diff} wei < gas ${gasCost} wei`
              );
            }

            // Sweep immediately after crediting a new deposit.
            sweepToTreasury(row.discord_id).catch((err) => {
              console.error(
                `Sweep failed for ${row.discord_id}:`,
                (err as Error)?.message ?? err
              );
            });
          }

          if (bal !== prev) {
            updates.push({ row, balance: bal.toString() });
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
  txHash?: string;
  error?: string;
  gasSats?: number;
  sentSats?: number;
  /** true if tx was mined and succeeded on-chain */
  confirmed?: boolean;
}

/** Withdraw sats from treasury to an address (native send).
 *  Gas fee is deducted from the send amount so the treasury stays solvent.
 *  Waits for on-chain confirmation before returning success. */
export async function withdraw(
  toAddress: string,
  amountSats: number,
  token: TokenSymbol = "SATS",
): Promise<WithdrawResult> {
  const normalized = toAddress.toLowerCase().trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(normalized)) return { error: "Invalid address" };

  if (token !== "SATS") {
    const cfg = assertTokenConfigured(token);
    const units = tokenAmountToUnits(amountSats, token);
    if (units <= 0n) return { error: "Amount too small" };
    try {
      const contract = new ethers.Contract(cfg.contractAddress!, ERC20_ABI, wallet);
      const treasuryBalance = BigInt(await contract.balanceOf(wallet.address));
      if (treasuryBalance < units) return { error: `Treasury has insufficient ${token}` };
      const gasPrice = await getGasPrice();
      const estimatedGas = BigInt(await contract.transfer.estimateGas(normalized, units));
      const gasLimit = addGasLimitBuffer(estimatedGas);
      const gasCost = gasLimit * gasPrice;
      const treasuryNative = await getNativeBalance(wallet.address);
      const liabilities = await getProtocolOperationalSnapshot();
      const protectedSats = liabilities.userSatsLiability + liabilities.poolSatsLiability + config.evm.protocolGasReserveMinSats;
      const protectedUnits = satsToTokenUnits(protectedSats);
      if (!preservesGasReserve(treasuryNative, gasCost, 0n, protectedUnits)) {
        return { error: `Protocol gas reserve is too low for a ${token} withdrawal` };
      }
      const tx = await contract.transfer(normalized, units, { gasLimit, gasPrice });
      for (let i = 0; i < 40; i++) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const receipt = await rawRpcCall("eth_getTransactionReceipt", [tx.hash]) as { status: string } | null;
        if (!receipt) continue;
        if (parseInt(receipt.status, 16) !== 1) {
          return { txHash: tx.hash, confirmed: false, error: "Transaction reverted on-chain" };
        }
        return { txHash: tx.hash, sentSats: amountSats, confirmed: true };
      }
      return { txHash: tx.hash, confirmed: false, error: "Receipt timeout: transaction not confirmed after 2 minutes" };
    } catch (error) {
      return { error: (error as Error).message };
    }
  }

  const value = satsToTokenUnits(amountSats);
  if (value <= 0n) return { error: "Amount too small" };

  const gasPrice = await getGasPrice();
  let gasLimit: bigint;
  try {
    gasLimit = await estimateNativeTransferGas(normalized, value);
  } catch (e: unknown) {
    const err = e as { message?: string; reason?: string };
    return { error: `Unable to estimate withdrawal gas: ${err?.reason ?? err?.message ?? String(e)}` };
  }

  let gasCost = gasLimit * gasPrice;
  // 50% buffer on withdrawals — treasury keeps the surplus
  let chargedGas = gasCost + gasCost / 2n;
  let gasSats = tokenUnitsToSats(chargedGas);

  let sendValue = value - chargedGas;
  if (sendValue <= 0n) {
    return { error: `Amount too small to cover network gas (~${gasSats} sats)` };
  }

  try {
    const refinedGasLimit = await estimateNativeTransferGas(normalized, sendValue);
    if (refinedGasLimit > gasLimit) {
      gasLimit = refinedGasLimit;
      gasCost = gasLimit * gasPrice;
      chargedGas = gasCost + gasCost / 2n;
      gasSats = tokenUnitsToSats(chargedGas);
      sendValue = value - chargedGas;

      if (sendValue <= 0n) {
        return { error: `Amount too small to cover network gas (~${gasSats} sats)` };
      }
    }
  } catch (e: unknown) {
    const err = e as { message?: string; reason?: string };
    return { error: `Unable to estimate withdrawal gas: ${err?.reason ?? err?.message ?? String(e)}` };
  }

  const sentSats = tokenUnitsToSats(sendValue);

  // Send the transaction
  let tx;
  try {
    tx = await wallet.sendTransaction({
      to: normalized,
      value: sendValue,
      gasLimit,
      gasPrice,
    });
  } catch (e: unknown) {
    const err = e as { message?: string; reason?: string };
    return { error: err?.reason ?? err?.message ?? String(e) };
  }

  // Poll for confirmation manually — tx.wait() is unreliable on Mezo RPC
  // (same pattern used in fundGasAndSweep above)
  const POLL_INTERVAL_MS = 3_000;
  const POLL_ATTEMPTS = 40; // ~2 minutes total

  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    try {
      const receipt = await rawRpcCall("eth_getTransactionReceipt", [tx.hash]) as { status: string } | null;
      if (receipt !== null) {
        const status = parseInt(receipt.status, 16);
        if (status === 0) {
          return { txHash: tx.hash, gasSats, sentSats, confirmed: false, error: "Transaction reverted on-chain" };
        }
        return { txHash: tx.hash, gasSats, sentSats, confirmed: true };
      }
    } catch (err: unknown) {
      // Log first error per tx so we can diagnose RPC issues in Render logs
      if (i === 0) console.warn(`[Withdraw] Poll error for ${tx.hash}:`, (err as Error)?.message ?? err);
    }
  }

  console.warn(`[Withdraw] Receipt timeout for ${tx.hash} after ${POLL_ATTEMPTS} attempts`);
  return { txHash: tx.hash, gasSats, sentSats, confirmed: false, error: "Receipt timeout: transaction not confirmed after 2 minutes" };
}

/**
 * On startup, resolve any withdrawals left in "pending" state from a
 * previous session (e.g. bot killed mid-poll, or before the BAD_DATA fix).
 * Records older than 5 minutes are considered stuck — Mezo confirms in seconds.
 */
export async function recoverPendingWithdrawals(): Promise<void> {
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data: stale } = await supabase
    .from("withdrawals")
    .select("*")
    .eq("status", "pending")
    .lt("created_at", fiveMinutesAgo);

  if (!stale || stale.length === 0) return;
  console.log(`[Recovery] Found ${stale.length} stale pending withdrawal(s) to resolve`);

  for (const w of stale) {
    const withdrawalToken = (w.token ?? "SATS") as TokenSymbol;
    if (!w.tx_hash) {
      // sendTransaction never got a hash — safe to refund
      await addBalance(w.discord_id, w.amount_sats, withdrawalToken);
      recordLedgerEntry(null, {
        type: "withdrawal_refund",
        amountSats: w.amount_sats,
        token: withdrawalToken,
        senderId: "treasury",
        receiverId: w.discord_id,
        referenceType: "withdrawals",
        referenceId: String(w.id),
        metadata: { reason: "recovery_no_tx_hash" },
      });
      await supabase.from("withdrawals").update({ status: "failed" }).eq("id", w.id);
      console.log(`[Recovery] Withdrawal ${w.id}: no tx_hash → refunded ${w.amount_sats} sats`);
      continue;
    }

    try {
      const receipt = await rawRpcCall("eth_getTransactionReceipt", [w.tx_hash]) as { status: string } | null;
      if (receipt !== null) {
        const status = parseInt(receipt.status, 16);
        if (status === 1) {
          await supabase.from("withdrawals").update({ status: "completed" }).eq("id", w.id);
          console.log(`[Recovery] Withdrawal ${w.id}: tx confirmed on-chain → marked completed (no refund)`);
        } else {
          await addBalance(w.discord_id, w.amount_sats, withdrawalToken);
          recordLedgerEntry(null, {
            type: "withdrawal_refund",
            amountSats: w.amount_sats,
            token: withdrawalToken,
            senderId: "treasury",
            receiverId: w.discord_id,
            referenceType: "withdrawals",
            referenceId: String(w.id),
            metadata: { reason: "recovery_tx_reverted" },
          });
          await supabase.from("withdrawals").update({ status: "failed" }).eq("id", w.id);
          console.log(`[Recovery] Withdrawal ${w.id}: tx reverted → refunded ${w.amount_sats} sats`);
        }
      } else {
        // No receipt — check if tx is mined without a receipt
        const tx = await rawRpcCall("eth_getTransactionByHash", [w.tx_hash]) as { blockNumber?: string | null } | null;
        if (tx?.blockNumber != null) {
          // Tx is in a block but receipt unavailable — treat as confirmed
          await supabase.from("withdrawals").update({ status: "completed" }).eq("id", w.id);
          console.log(`[Recovery] Withdrawal ${w.id}: tx in block (no receipt) → marked completed`);
        } else if (tx !== null) {
          // Tx exists on-chain but blockNumber is null = still in mempool.
          // Mezo confirms in seconds so this is unusual, but don't refund —
          // leave pending and let the next recovery pass resolve it.
          console.log(`[Recovery] Withdrawal ${w.id}: tx ${w.tx_hash} still in mempool — leaving pending`);
        } else {
          // tx === null: this node has no record of it.
          // Could be RPC lag at startup, so retry once before refunding.
          await new Promise((r) => setTimeout(r, 4000));
          const txRetry = await rawRpcCall("eth_getTransactionByHash", [w.tx_hash]) as { blockNumber?: string | null } | null;
          if (txRetry?.blockNumber != null) {
            await supabase.from("withdrawals").update({ status: "completed" }).eq("id", w.id);
            console.log(`[Recovery] Withdrawal ${w.id}: tx found in block on retry → marked completed`);
          } else if (txRetry !== null) {
            console.log(`[Recovery] Withdrawal ${w.id}: tx in mempool on retry — leaving pending`);
          } else {
            // Still null after retry — tx genuinely dropped
            await addBalance(w.discord_id, w.amount_sats, withdrawalToken);
            recordLedgerEntry(null, {
              type: "withdrawal_refund",
              amountSats: w.amount_sats,
              token: withdrawalToken,
              senderId: "treasury",
              receiverId: w.discord_id,
              referenceType: "withdrawals",
              referenceId: String(w.id),
              metadata: { reason: "recovery_tx_dropped" },
            });
            await supabase.from("withdrawals").update({ status: "failed" }).eq("id", w.id);
            console.log(`[Recovery] Withdrawal ${w.id}: tx not found after retry → refunded ${w.amount_sats} sats`);
          }
        }
      }
    } catch (err) {
      console.error(`[Recovery] Withdrawal ${w.id}: RPC error —`, (err as Error)?.message ?? err);
    }
  }
}

/** Get treasury native balance in sats */
export async function getTreasuryBalanceSats(): Promise<number> {
  const bal = await provider.getBalance(wallet.address);
  return tokenUnitsToSats(bal);
}

export async function getTreasuryBalances(): Promise<Record<TokenSymbol, number>> {
  const entries = await Promise.all(TOKEN_SYMBOLS.map(async (token) => {
    const units = await getTokenBalance(wallet.address, token);
    return [token, tokenUnitsToAmount(units, token)] as const;
  }));
  return Object.fromEntries(entries) as Record<TokenSymbol, number>;
}
