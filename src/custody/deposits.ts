import { ethers } from "ethers";
import { config, satsToTokenUnits } from "../config.js";
import { supabase } from "../db.js";
import { getDepositNativeBalance, getDepositTokenBalance, getProvider, mapWithConcurrency } from "../evm.js";
import {
  TOKEN_SYMBOLS,
  assertTokenConfigured,
  getTokenConfig,
  tokenDecimalToUnits,
  tokenUnitsToAmount,
  type TokenSymbol,
} from "../tokens.js";
import { verifyWalletFromDeposit } from "../walletVerification.js";
import { DEPOSIT_FACTORY_ABI, NATIVE_TOKEN } from "./abi.js";
import { depositSalt, predictForwarder } from "./forwarder.js";
import {
  RESCAN_BLOCKS,
  SWEPT_TOPIC,
  chunkRanges,
  isDeepRescanPass,
  nextLogRange,
  rescanRange,
  parseSweptLog,
  sameAddress,
  sortByChainPosition,
  type SweptEvent,
  type V2Settings,
} from "./policy.js";
import { ethCall, getBlockNumber, getLogs, getReceipt, nodeHasBlock } from "./rpc.js";
import { sendCustodyTx } from "./signing.js";
import { getSweepGasWallet, getV2Settings, isCustodyFrozen, onCustodyV2 } from "./state.js";
import { readNumberCursor, writeCursor } from "./store.js";
import { alertAdmins } from "./watchdog.js";

/**
 * Custody v2 deposits. Each user's address is a keyless CREATE2 forwarder
 * that can only sweep to the vault. The poller watches forwarder balances and
 * asks the factory to sweep them (gas from SWEEP_GAS_PRIVATE_KEY); balances
 * are credited ONLY from the factory's Swept events, so a sweep by anyone,
 * including a third party, credits the right user exactly once.
 */

const FACTORY = new ethers.Interface(DEPOSIT_FACTORY_ABI);

export type DepositCallback = (discordId: string, amount: number, gasSats: number, txHash: string, token: TokenSymbol) => void;

export function forwarderAddress(settings: V2Settings, discordId: string): string {
  return predictForwarder(settings.factory, settings.implementation, depositSalt(discordId));
}

type ForwarderRow = {
  discord_id: string;
  address: string;
  salt: string;
  last_checked_balance: string;
};

/** Enabled v2 rows the poller watches. */
const watched = new Map<string, ForwarderRow>();
/** discordId → deposits enabled, for every address registered by this process. */
const registered = new Map<string, boolean>();
const registrations = new Map<string, Promise<string>>();
let watchedLoadedAt = 0;

/**
 * Issue (or re-issue) a user's v2 deposit address. An existing v1 address is
 * kept in legacy_address and never shown again. Refuses to replace a
 * different v2 address (a redeployed factory needs an explicit migration).
 */
export async function registerForwarderAddress(
  settings: V2Settings,
  discordId: string,
  enableDeposits: boolean,
): Promise<string> {
  const address = forwarderAddress(settings, discordId);
  const known = registered.get(discordId);
  if (known === true || (known === false && !enableDeposits)) return address;

  const pending = registrations.get(discordId);
  if (pending) {
    await pending;
    return registerForwarderAddress(settings, discordId, enableDeposits);
  }

  const registration = (async () => {
    const salt = depositSalt(discordId).toLowerCase();
    const { data, error } = await supabase.rpc("register_forwarder_address_v1", {
      p_discord_id: discordId,
      p_address: address.toLowerCase(),
      p_salt: salt,
      p_enable: enableDeposits,
    });
    if (error) throw new Error(`deposit address registration failed: ${error.message}`);
    const result = (data ?? {}) as { status?: string; deposits_enabled?: boolean; last_checked_balance?: string };
    if (result.status !== "ok") {
      console.error(`[Deposits] Address registration for ${discordId} refused: ${result.status ?? JSON.stringify(data)}`);
      throw new Error("This deposit address cannot be issued right now. An admin has been alerted.");
    }
    const enabled = result.deposits_enabled === true;
    registered.set(discordId, enabled);
    if (enabled) {
      watched.set(discordId, {
        discord_id: discordId,
        address: address.toLowerCase(),
        salt,
        last_checked_balance: result.last_checked_balance ?? "0",
      });
    }
    return address;
  })().finally(() => {
    registrations.delete(discordId);
  });
  registrations.set(discordId, registration);
  return registration;
}

const PAGE_SIZE = 1000;

async function refreshWatched(settings: V2Settings, force: boolean): Promise<void> {
  if (!force && watchedLoadedAt > 0 && Date.now() - watchedLoadedAt < config.deposits.addressRefreshMs) return;
  const rows: ForwarderRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("deposit_addresses")
      .select("discord_id, address, salt, last_checked_balance")
      .eq("address_version", 2)
      .eq("deposits_enabled", true)
      .order("discord_id")
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`deposit address refresh failed: ${error.message}`);
    rows.push(...((data ?? []) as ForwarderRow[]));
    if ((data?.length ?? 0) < PAGE_SIZE) break;
  }
  watched.clear();
  for (const row of rows) {
    const expected = forwarderAddress(settings, row.discord_id).toLowerCase();
    if (!sameAddress(row.address, expected) || row.salt?.toLowerCase() !== depositSalt(row.discord_id).toLowerCase()) {
      warnOnce(`mismatch-${row.discord_id}`, `[Deposits] ${row.discord_id}: stored v2 address does not match this factory; not polled`);
      continue;
    }
    watched.set(row.discord_id, {
      discord_id: row.discord_id,
      address: expected,
      salt: row.salt.toLowerCase(),
      last_checked_balance: row.last_checked_balance ?? "0",
    });
    registered.set(row.discord_id, true);
  }
  watchedLoadedAt = Date.now();
}

const warnedAt = new Map<string, number>();

function warnOnce(key: string, message: string): void {
  const last = warnedAt.get(key) ?? 0;
  if (Date.now() - last < 15 * 60_000) return;
  warnedAt.set(key, Date.now());
  console.warn(message);
}

/* ─────────── Sweeps ─────────── */

/** ERC-20s the bot sweeps: configured here and allowlisted by the factory. */
let sweepTokens: { tokens: Array<Exclude<TokenSymbol, "SATS">>; loadedAt: number } | null = null;

async function getSweepTokens(settings: V2Settings): Promise<Array<Exclude<TokenSymbol, "SATS">>> {
  if (sweepTokens && Date.now() - sweepTokens.loadedAt < 60 * 60_000) return sweepTokens.tokens;
  const tokens: Array<Exclude<TokenSymbol, "SATS">> = [];
  for (const token of TOKEN_SYMBOLS) {
    if (token === "SATS") continue;
    let address: string;
    try {
      address = assertTokenConfigured(token).contractAddress!;
    } catch {
      continue;
    }
    const raw = await ethCall(settings.factory, FACTORY.encodeFunctionData("allowedToken", [address]));
    if (FACTORY.decodeFunctionResult("allowedToken", raw)[0]) tokens.push(token);
    else warnOnce(`not-allowed-${token}`, `[Deposits] DepositFactory does not allowlist ${token}; ${token} deposits are not swept`);
  }
  sweepTokens = { tokens, loadedAt: Date.now() };
  return tokens;
}

const SWEEP_PENDING_MS = 10 * 60_000;
const inFlightSweeps = new Map<string, { txHash: string; sentAt: number }>();

function sweepCall(salt: string, token: string): string {
  return token === NATIVE_TOKEN
    ? FACTORY.encodeFunctionData("sweepNative", [salt])
    : FACTORY.encodeFunctionData("sweepToken", [salt, token]);
}

/** Ask the factory to sweep one asset of one forwarder. Returns the tx hash, or null when skipped. */
async function requestSweep(
  settings: V2Settings,
  row: ForwarderRow,
  token: TokenSymbol,
): Promise<string | null> {
  if (isCustodyFrozen()) return null;
  const tokenAddress = token === "SATS" ? NATIVE_TOKEN : assertTokenConfigured(token).contractAddress!.toLowerCase();
  const key = `${row.salt}:${tokenAddress}`;
  const pending = inFlightSweeps.get(key);
  if (pending) {
    const receipt = await getReceipt(pending.txHash).catch(() => undefined);
    if (receipt === undefined) return null;
    if (receipt === null && Date.now() - pending.sentAt < SWEEP_PENDING_MS) return null;
    inFlightSweeps.delete(key);
    // Mined: re-read the balance on the next poll before sweeping again.
    if (receipt) return null;
  }
  const wallet = getSweepGasWallet();
  if (!wallet) return null;
  const { txHash } = await sendCustodyTx({
    wallet,
    to: settings.factory,
    data: sweepCall(row.salt, tokenAddress),
    purpose: token === "SATS" ? "sweep_native" : "sweep_token",
    ref: row.salt,
  });
  inFlightSweeps.set(key, { txHash, sentAt: Date.now() });
  console.log(`[Deposits] Sweeping ${token} for ${row.discord_id}: ${txHash}`);
  return txHash;
}

/** Admin /sweep: sweep every non-empty asset of one user's forwarder now (no minimum). */
export async function sweepForwarderNow(
  discordId: string,
  tokens: TokenSymbol[],
): Promise<Array<{ token: TokenSymbol; amount: number; txHash: string | null; error?: string }>> {
  const settings = getV2Settings();
  if (!settings) throw new Error("custody v2 is not active");
  const row: ForwarderRow = {
    discord_id: discordId,
    address: forwarderAddress(settings, discordId).toLowerCase(),
    salt: depositSalt(discordId).toLowerCase(),
    last_checked_balance: "0",
  };
  const allowed = new Set<TokenSymbol>(["SATS", ...await getSweepTokens(settings)]);
  const results: Array<{ token: TokenSymbol; amount: number; txHash: string | null; error?: string }> = [];
  for (const token of tokens) {
    if (!allowed.has(token)) continue;
    const balance = token === "SATS"
      ? await getDepositNativeBalance(row.address)
      : await getDepositTokenBalance(row.address, token);
    if (balance === 0n) continue;
    const amount = tokenUnitsToAmount(balance, token);
    try {
      results.push({ token, amount, txHash: await requestSweep(settings, row, token) });
    } catch (error) {
      results.push({ token, amount, txHash: null, error: (error as Error).message });
    }
  }
  return results;
}

/* ─────────── Balance poller ─────────── */

let polling = false;

async function pollOnce(settings: V2Settings): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    await refreshWatched(settings, watchedLoadedAt === 0);
    const rows = Array.from(watched.values());
    if (rows.length === 0) return;
    const tokens = await getSweepTokens(settings);
    const minNative = satsToTokenUnits(Math.max(0, config.custody.minNativeDepositSats));
    const sweep = (row: ForwarderRow, token: TokenSymbol) => requestSweep(settings, row, token).catch((error) => {
      warnOnce(`sweep-${token}`, `[Deposits] ${token} sweep for ${row.discord_id} not sent: ${String((error as Error).message).slice(0, 300)}`);
    });
    const observed: Array<{ discord_id: string; last_checked_balance: string }> = [];
    let failures = 0;
    let firstError = "";

    const results = await mapWithConcurrency(rows, Math.max(1, config.deposits.balanceConcurrency), async (row) => {
      const isAdmin = config.discord.adminIds.includes(row.discord_id);
      const native = await getDepositNativeBalance(row.address);
      const previous = BigInt(row.last_checked_balance || "0");
      if (native > previous) {
        // Verification looks for the challenge transfer itself, so it runs on
        // any increase, before the funds are swept.
        const verified = await verifyWalletFromDeposit(row.discord_id, row.address, getProvider()).catch((error) => {
          console.warn(`[WalletVerify] Deposit verification check failed for ${row.discord_id}:`, (error as Error)?.message ?? error);
          return false;
        });
        if (verified) console.log(`[WalletVerify] Wallet verified from a deposit by ${row.discord_id}`);
      }
      if (native !== previous) {
        row.last_checked_balance = native.toString();
        observed.push({ discord_id: row.discord_id, last_checked_balance: row.last_checked_balance });
      }
      if (native > 0n && (isAdmin || native >= minNative)) await sweep(row, "SATS");

      for (const token of tokens) {
        const balance = await getDepositTokenBalance(row.address, token);
        if (balance === 0n) continue;
        const minimum = isAdmin ? 0n : tokenDecimalToUnits(config.deposits.minimums[token], token);
        if (balance >= minimum) await sweep(row, token);
      }
    });
    for (const result of results) {
      if (result.status === "rejected") {
        failures += 1;
        firstError ||= String((result.reason as Error)?.message ?? result.reason).replace(/\s+/g, " ").slice(0, 300);
      }
    }
    if (observed.length > 0) {
      // last_checked_balance is only an observation marker in v2 (crediting
      // comes from Swept events); it decides when to re-run verification.
      const { error } = await supabase.rpc("update_deposit_address_balances", { p_updates: observed });
      if (error) warnOnce("observed", `[Deposits] Could not store observed forwarder balances: ${error.message}`);
    }
    if (failures > 0) warnOnce("poll", `[Deposits] ${failures} forwarder check(s) failed this poll; first error: ${firstError}`);
  } finally {
    polling = false;
  }
}

/* ─────────── Swept log scanner ─────────── */

const SCAN_INTERVAL_MS = 15_000;
const MAX_CHUNKS_PER_PASS = 25;

function sweptCursor(settings: V2Settings): string {
  return `swept:${settings.factory}`;
}

function tokenForAddress(address: string): TokenSymbol | null {
  if (address === NATIVE_TOKEN) return "SATS";
  for (const token of TOKEN_SYMBOLS) {
    if (token === "SATS") continue;
    if (sameAddress(getTokenConfig(token).contractAddress, address)) return token;
  }
  return null;
}

type CreditResult = {
  status?: string;
  discord_id?: string;
  token?: TokenSymbol;
  amount?: number;
  deposit_ref?: string;
  already_recorded?: boolean;
};

/** Credit one Swept event (idempotent on tx hash + log index). Throws when the database call fails. */
async function creditSwept(settings: V2Settings, event: SweptEvent, onDeposit?: DepositCallback): Promise<void> {
  const token = tokenForAddress(event.token);
  const { data, error } = await supabase.rpc("credit_forwarder_deposit_v1", {
    p_tx_hash: event.txHash,
    p_log_index: event.logIndex,
    p_block_number: event.blockNumber,
    p_salt: event.salt,
    p_token_address: event.token,
    p_token_symbol: token,
    p_token_decimals: token ? getTokenConfig(token).decimals : null,
    p_amount_atomic: event.amount.toString(),
    p_vault: event.vault,
    p_expected_vault: settings.vault,
  });
  if (error) throw new Error(`credit_forwarder_deposit_v1 ${event.txHash}:${event.logIndex}: ${error.message}`);
  const result = (data ?? {}) as CreditResult;
  const where = `${event.txHash}:${event.logIndex} (block ${event.blockNumber}, salt ${event.salt}, token ${event.token}, amount ${event.amount})`;
  switch (result.status) {
    case "credited":
      console.log(`[Deposits] Credited ${result.amount} ${result.token} to ${result.discord_id} from ${where}`);
      onDeposit?.(String(result.discord_id), Number(result.amount), 0, String(result.deposit_ref), result.token ?? "SATS");
      return;
    case "duplicate":
      return;
    case "unknown_salt":
    case "wrong_vault":
    case "unknown_token":
    case "conflicting_event":
      if (!result.already_recorded) {
        const message = `Swept event ${where} was not credited (${result.status}); it is in custody_sweep_reviews.`;
        console.error(`[Deposits] REVIEW: ${message}`);
        await alertAdmins(`🔎 Deposit held for review: ${message}`);
      }
      return;
    default:
      throw new Error(`credit_forwarder_deposit_v1 returned ${JSON.stringify(data)} for ${where}`);
  }
}

let scanning = false;

async function creditRange(settings: V2Settings, from: number, to: number, onDeposit?: DepositCallback): Promise<void> {
  const logs = await getLogs({ address: settings.factory, topics: [SWEPT_TOPIC], fromBlock: from, toBlock: to });
  const events: SweptEvent[] = [];
  for (const log of logs) {
    const event = parseSweptLog(log, settings.factory);
    if (event) events.push(event);
    else console.error(`[Deposits] Ignoring unreadable factory log ${log.transactionHash ?? "?"}:${String(log.logIndex ?? "?")}`);
  }
  for (const event of sortByChainPosition(events)) await creditSwept(settings, event, onDeposit);
}

let sweptPasses = 0;

/**
 * Read Swept logs from the stored cursor up to latest − DEPOSIT_CONFIRMATIONS
 * in bounded chunks. A chunk is read only once the node serves its last
 * block, and the cursor advances only after every event in it was credited
 * or routed to review, so a failure re-reads the chunk. A short trailing
 * window is re-read every pass, and a deep one (CUSTODY_DEEP_RESCAN_BLOCKS)
 * every CUSTODY_DEEP_RESCAN_PASSES passes; crediting is idempotent.
 */
export async function scanSweptLogs(settings: V2Settings, onDeposit?: DepositCallback): Promise<void> {
  if (scanning) return;
  scanning = true;
  try {
    const cursor = sweptCursor(settings);
    let last = (await readNumberCursor(cursor)) ?? settings.startBlock - 1;
    sweptPasses += 1;
    const deep = isDeepRescanPass(sweptPasses, config.custody.deepRescanPasses);
    const rescan = rescanRange(last, settings.startBlock, deep ? config.custody.deepRescanBlocks : RESCAN_BLOCKS);
    if (rescan) {
      for (const chunk of chunkRanges(rescan.from, rescan.to, config.custody.logChunkBlocks)) {
        if (!await nodeHasBlock(chunk.to)) break;
        await creditRange(settings, chunk.from, chunk.to, onDeposit);
      }
    }
    const latest = await getBlockNumber();
    for (let i = 0; i < MAX_CHUNKS_PER_PASS; i++) {
      const range = nextLogRange(last, latest, config.custody.depositConfirmations, config.custody.logChunkBlocks);
      if (!range) return;
      // A lagging or load-balanced node may not have the range yet: wait.
      if (!await nodeHasBlock(range.to)) return;
      await creditRange(settings, range.from, range.to, onDeposit);
      await writeCursor(cursor, range.to);
      last = range.to;
    }
  } finally {
    scanning = false;
  }
}

/** Start the v2 poller and Swept scanner once custody v2 is active. */
export function startForwarderDeposits(onDeposit?: DepositCallback): void {
  onCustodyV2(() => {
    const settings = getV2Settings();
    if (!settings) return;
    const poll = () => pollOnce(settings).catch((error) => warnOnce("poll-error", `[Deposits] Poll failed: ${(error as Error).message}`));
    const scan = () => scanSweptLogs(settings, onDeposit).catch((error) => {
      warnOnce("scan-error", `[Deposits] Swept scan failed (will retry): ${(error as Error).message}`);
    });
    setInterval(poll, Math.max(5_000, config.deposits.pollMs));
    setTimeout(poll, Math.max(1_000, config.deposits.initialPollDelayMs));
    setInterval(scan, SCAN_INTERVAL_MS);
    setTimeout(scan, 5_000);
    console.log(`[Deposits] Custody v2 deposits: forwarder poller every ${config.deposits.pollMs}ms, Swept scanner every ${SCAN_INTERVAL_MS}ms`);
  });
}
