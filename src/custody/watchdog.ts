import { ethers } from "ethers";
import { config, tokenUnitsToSats } from "../config.js";
import { supabase } from "../db.js";
import { getNativeBalance } from "../evm.js";
import { HOT_PAYOUT_ABI } from "./abi.js";
import { PAID_TOPIC, type V2Settings } from "./policy.js";
import { readPaidRefs } from "./payout.js";
import { ethCall, getBlockNumber, getLogs, getNonce, getReceipt, nodeHasBlock } from "./rpc.js";
import { sendCustodyTx } from "./signing.js";
import {
  getFreezeState,
  getGuardianWallet,
  getV2Settings,
  onCustodyV2,
  refreshFreezeFlag,
  setFreezeState,
} from "./state.js";
import { deleteFreezeFlag, readNumberCursor, writeCursor, writeFreezeFlag } from "./store.js";
import {
  createWatchdogCore,
  custodySigners,
  type PaidRow,
  type RefundCandidate,
  type UnfreezeResult,
  type WatchdogIO,
} from "./watchdogCore.js";

/**
 * Custody watchdog. Every CUSTODY_WATCHDOG_MS it checks that each custody key
 * (operator, sweep gas, guardian) only spent nonces the bot recorded in
 * custody_signed_txs, that every HotPayout Paid event matches a withdrawal
 * row's signed call in its own transaction, and that refunded HotPayout
 * withdrawals stay unpaid (src/custody/watchdogCore.ts). Any mismatch freezes
 * custody: all v2 signing stops (in this process and, through bot_settings,
 * in every process), admins are DM'd, and the guardian pauses HotPayout when
 * its key is configured.
 */

const PAYOUT = new ethers.Interface(HOT_PAYOUT_ABI);
const LOW_GAS_ALERT_INTERVAL_MS = 6 * 60 * 60_000;
const QUERY_CHUNK = 100;
/** The refunded-row re-check runs after the nonce and Paid checks, within this budget per pass. */
const REFUND_CHECK_BUDGET_MS = 10_000;

type Notify = (message: string) => Promise<void>;
let notifyAdmins: Notify = async () => {};

/** DM every ADMIN_IDS user (no-op until the bot wires the notifier at startup). Never throws. */
export async function alertAdmins(message: string): Promise<void> {
  await notifyAdmins(message).catch(() => {});
}

function checksum(address: string): string {
  return ethers.getAddress(address);
}

/* ─────────── Acknowledged anomalies ─────────── */

async function acknowledgedKeys(keys: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < keys.length; i += QUERY_CHUNK) {
    const { data, error } = await supabase
      .from("custody_acknowledgements")
      .select("key")
      .in("key", keys.slice(i, i + QUERY_CHUNK));
    if (error) throw new Error(`acknowledgement lookup failed: ${error.message}`);
    for (const row of data ?? []) found.add(String(row.key));
  }
  return found;
}

/* ─────────── Freeze ─────────── */

async function pausePayout(settings: V2Settings): Promise<string> {
  const guardian = getGuardianWallet();
  if (!guardian) return "No guardian key is configured: pause HotPayout from the vault.";
  try {
    const { txHash } = await sendCustodyTx({
      wallet: guardian,
      to: settings.payout,
      data: PAYOUT.encodeFunctionData("pause"),
      purpose: "pause",
      ref: null,
      bypassFreeze: true,
    });
    return `The guardian sent HotPayout.pause() (${txHash}).`;
  } catch (error) {
    return `The guardian could not pause HotPayout (${(error as Error).message}): pause it from the vault.`;
  }
}

/**
 * Freeze custody. Blocks signing immediately in this process, persists the
 * flag so every process (and the next boot) stays frozen until an admin
 * clears it, alerts admins, and pauses HotPayout through the guardian.
 * `keys` name the anomalies (e.g. withdrawal:42). One an admin acknowledged
 * when clearing an earlier freeze is logged but never freezes again. Every
 * key is DM'd to admins and recorded on the flag; /custody unfreeze accepts
 * the recorded keys and asks for a confirmation code for anything else.
 */
export async function freezeCustody(reason: string, keys: string | string[] = []): Promise<void> {
  const named = [...new Set(typeof keys === "string" ? [keys] : keys)];
  let fresh = named;
  if (named.length > 0) {
    const acknowledged = await acknowledgedKeys(named).catch(() => new Set<string>());
    fresh = named.filter((key) => !acknowledged.has(key));
    if (fresh.length === 0) {
      console.warn(`[Watchdog] Acknowledged anomaly ${named.join(", ")} (held for manual review, no freeze): ${reason}`);
      return;
    }
  }
  const current = getFreezeState();
  if (current) {
    console.error(`[Watchdog] Custody already frozen; further anomaly: ${reason}`);
    const added = fresh.filter((key) => !current.keys.includes(key));
    if (added.length > 0) {
      setFreezeState({ ...current, keys: [...current.keys, ...added], persisted: false });
      await persistPendingFreeze();
      await notifyAdmins(
        `🚨 **Another custody anomaly while frozen** (${added.join(", ")}): ${reason}\n` +
        "`/custody unfreeze` lists what it accepts.",
      ).catch(() => {});
    }
    return;
  }
  const at = new Date().toISOString();
  setFreezeState({ reason, at, keys: fresh, persisted: false });
  console.error(`[Watchdog] CUSTODY FROZEN: ${reason}`);
  try {
    await writeFreezeFlag({ reason, at, keys: fresh });
    markPersisted(fresh);
  } catch (error) {
    console.error(`[Watchdog] Could not persist the freeze flag (retrying every pass): ${(error as Error).message}`);
  }
  const settings = getV2Settings();
  const pause = settings ? await pausePayout(settings) : "";
  await notifyAdmins(
    `🚨 **MezoSBOT custody frozen**${fresh.length > 0 ? ` (${fresh.join(", ")})` : ""}. ${reason}\n` +
    `All custody signing (withdrawals, sweeps) is blocked. ${pause}\n` +
    "Investigate, rotate any exposed key, then run `/custody unfreeze`.",
  ).catch(() => {});
}

/** Mark the freeze persisted unless another anomaly was added while `written` was being written. */
function markPersisted(written: string[]): void {
  const latest = getFreezeState();
  if (latest && latest.keys.every((key) => written.includes(key))) setFreezeState({ ...latest, persisted: true });
}

async function persistPendingFreeze(): Promise<void> {
  const state = getFreezeState();
  if (!state || state.persisted) return;
  try {
    await writeFreezeFlag({ reason: state.reason, at: state.at, keys: state.keys });
    markPersisted(state.keys);
  } catch {
    // retried next pass; this process stays frozen meanwhile
  }
}

/* ─────────── Production IO ─────────── */

const productionIO: WatchdogIO = {
  getNonce: (address) => getNonce(address, "latest"),
  getReceiptExists: async (txHash) => {
    try {
      return (await getReceipt(txHash)) != null;
    } catch {
      return null;
    }
  },
  getBlockNumber,
  nodeHasBlock,
  getPaidLogs: (settings, from, to) =>
    getLogs({ address: settings.payout, topics: [PAID_TOPIC], fromBlock: from, toBlock: to }),
  readPaidRefs,
  readCursor: readNumberCursor,
  writeCursor,
  signedTxs: async (signer, fromNonce, toNonce) => {
    const { data, error } = await supabase
      .from("custody_signed_txs")
      .select("nonce, tx_hash")
      .eq("signer", signer)
      .gte("nonce", fromNonce)
      .lt("nonce", toNonce);
    if (error) throw new Error(`signed transaction lookup failed: ${error.message}`);
    return (data ?? []).map((row) => ({ nonce: Number(row.nonce), txHash: String(row.tx_hash) }));
  },
  withdrawalsForRefs: async (refs) => {
    const byRef = new Map<string, PaidRow>();
    for (let i = 0; i < refs.length; i += QUERY_CHUNK) {
      const { data, error } = await supabase
        .from("withdrawals")
        .select("id, payout_ref, raw_tx, status, tx_hash")
        .in("payout_ref", refs.slice(i, i + QUERY_CHUNK));
      if (error) throw new Error(`withdrawal lookup failed: ${error.message}`);
      for (const row of (data ?? []) as PaidRow[]) byRef.set(String(row.payout_ref).toLowerCase(), { ...row, id: Number(row.id) });
    }
    return byRef;
  },
  refundCandidates: async (limit) => {
    const { data, error } = await supabase.rpc("custody_refund_candidates_v1", { p_limit: limit });
    if (error) throw new Error(`refunded withdrawal lookup failed: ${error.message}`);
    return ((data ?? []) as Array<Record<string, unknown>>).map((row): RefundCandidate => {
      const firstFalseAt = row.first_false_at == null ? NaN : Date.parse(String(row.first_false_at));
      return {
        id: Number(row.withdrawal_id),
        payoutRef: String(row.payout_ref),
        falseReads: Number(row.false_reads) || 0,
        firstFalseAt: Number.isFinite(firstFalseAt) ? firstFalseAt : null,
      };
    });
  },
  recordRefundChecks: async (records) => {
    if (records.length === 0) return;
    const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());
    const { error } = await supabase.from("custody_refund_checks").upsert(
      records.map((record) => ({
        withdrawal_id: record.id,
        payout_ref: record.payoutRef,
        false_reads: record.falseReads,
        first_false_at: iso(record.firstFalseAt),
        last_read_at: iso(record.lastReadAt),
        verified_at: record.verified ? iso(record.lastReadAt) : null,
      })),
      { onConflict: "withdrawal_id" },
    );
    if (error) throw new Error(`could not record refund checks: ${error.message}`);
  },
  acknowledge: async (entries, actorId, note) => {
    const { error } = await supabase.from("custody_acknowledgements").upsert(
      entries.map((entry) => ({ key: entry.key, reason: entry.reason, actor_id: actorId, note })),
      { onConflict: "key", ignoreDuplicates: true },
    );
    if (error) throw new Error(`could not record acknowledgements: ${error.message}`);
  },
  isFrozen: () => getFreezeState() != null,
  freeze: freezeCustody,
};

const core = createWatchdogCore(productionIO, {
  get confirmations() {
    return config.custody.depositConfirmations;
  },
  get logChunkBlocks() {
    return config.custody.logChunkBlocks;
  },
  get deepRescanPasses() {
    return config.custody.deepRescanPasses;
  },
  get deepRescanBlocks() {
    return config.custody.deepRescanBlocks;
  },
  refundCheckBudgetMs: REFUND_CHECK_BUDGET_MS,
});

export type ClearFreezeResult = UnfreezeResult | { status: "changed"; addedKeys: string[] };

/**
 * Admin-only. Re-runs every check up to the head (acceptCurrentState): the
 * anomalies recorded on the freeze (DM'd to admins) are accepted; anything
 * new comes back with a confirmation code and custody stays frozen until the
 * admin repeats the command with that code. On acceptance the flag is
 * removed. HotPayout stays paused until the vault unpauses it.
 */
export async function clearCustodyFreeze(actorId: string, note: string, confirmCode?: string | null): Promise<ClearFreezeResult> {
  const settings = getV2Settings();
  if (!settings) throw new Error("custody v2 is not active");
  const result = await core.acceptCurrentState(settings, actorId, note, getFreezeState()?.keys ?? [], confirmCode);
  if (result.status !== "accepted") return result;

  // An anomaly recorded while the checks ran was not part of what was accepted.
  await refreshFreezeFlag();
  const accepted = new Set(result.recordedKeys);
  const addedKeys = (getFreezeState()?.keys ?? []).filter((key) => !accepted.has(key));
  if (addedKeys.length > 0) return { status: "changed", addedKeys };

  try {
    const raw = await ethCall(settings.payout, PAYOUT.encodeFunctionData("paused"));
    if (PAYOUT.decodeFunctionResult("paused", raw)[0]) {
      result.lines.push("HotPayout is still paused on-chain; withdrawals resume after the vault calls unpause().");
    }
  } catch {
    result.lines.push("Could not read HotPayout.paused().");
  }
  await deleteFreezeFlag();
  setFreezeState(null);
  console.warn(`[Watchdog] Custody freeze cleared by ${actorId} (acknowledged: ${result.recordedKeys.join(", ") || "none"}): ${note}`);
  return result;
}

/* ─────────── Gas ─────────── */

const lowGasAlertedAt = new Map<string, number>();

async function checkGas(settings: V2Settings): Promise<void> {
  const threshold = config.custody.lowGasSats;
  for (const signer of custodySigners(settings)) {
    const sats = tokenUnitsToSats(await getNativeBalance(signer.address));
    if (sats >= threshold) {
      lowGasAlertedAt.delete(signer.address);
      continue;
    }
    if (Date.now() - (lowGasAlertedAt.get(signer.address) ?? 0) < LOW_GAS_ALERT_INTERVAL_MS) continue;
    lowGasAlertedAt.set(signer.address, Date.now());
    const message = `⛽ The ${signer.role} wallet ${checksum(signer.address)} has ${sats} sats of gas ` +
      `(alert threshold ${threshold}). Top it up from the vault.`;
    console.warn(`[Watchdog] ${message}`);
    await notifyAdmins(message).catch(() => {});
  }
}

let running = false;

export async function runWatchdogOnce(): Promise<void> {
  const settings = getV2Settings();
  if (!settings || running) return;
  running = true;
  try {
    await refreshFreezeFlag();
    await persistPendingFreeze();
    await core.pass(settings);
    await checkGas(settings);
  } finally {
    running = false;
  }
}

/** Start the watchdog once custody v2 is active. `notify` DMs every ADMIN_IDS user. */
export function startCustodyWatchdog(notify: Notify): void {
  notifyAdmins = notify;
  onCustodyV2(() => {
    const run = () => {
      runWatchdogOnce().catch((error) => console.error("[Watchdog] Pass failed:", (error as Error)?.message ?? error));
    };
    const interval = Math.max(10_000, config.custody.watchdogMs);
    setInterval(run, interval);
    setTimeout(run, 3_000);
    console.log(`[Watchdog] Custody watchdog every ${interval}ms`);
  });
}
