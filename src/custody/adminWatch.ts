import { ethers } from "ethers";
import { config } from "../config.js";
import { supabase } from "../db.js";
import { TOKEN_SYMBOLS, getTokenConfig } from "../tokens.js";
import { HOT_PAYOUT_ABI, NATIVE_TOKEN, PAYOUT_ACTIONS, type PayoutAction } from "./abi.js";
import {
  ADMIN_FACTORY_TOPICS,
  ADMIN_PAYOUT_TOPICS,
  EXPECTATION_TTL_MS,
  cancelCalldata,
  cancelCallText,
  decideQueued,
  decodeAdminLog,
  describeQueued,
  matchExpectation,
  type DecodedAdminLog,
  type Expectation,
  type QueuedAction,
} from "./adminActions.js";
import { chunkRanges, type V2Settings } from "./policy.js";
import { ethCall, getBlockNumber, getLogs, nodeHasBlock } from "./rpc.js";
import { sendCustodyTx } from "./signing.js";
import { getGuardianWallet, isCustodyFrozen } from "./state.js";
import { readNumberCursor, writeCursor } from "./store.js";

/**
 * Watches HotPayout's queued vault actions and other admin changes. Runs in
 * the watchdog pass (src/custody/watchdog.ts):
 *
 * - every ActionQueued is recorded in custody_admin_actions. One matching an
 *   admin's /custody expect approval is left alone; any other is cancelled
 *   through the guardian, except a new guardian, which only the vault can
 *   cancel: admins get an urgent DM with the exact call, repeated every 6 hours
 *   while it stays queued;
 * - every other admin event (pause, unpause, caps, allowlist, roles,
 *   recoveries, factory rescues) is DM'd;
 * - while custody is frozen, HotPayout found unpaused is paused again and
 *   every payout cap set to 0 (raising caps back is queued for 3 days).
 */

const PAYOUT = new ethers.Interface(HOT_PAYOUT_ABI);
const MAX_CHUNKS_PER_PASS = 25;
const REALERT_MS = 6 * 60 * 60_000;
const UNPAUSE_ALERT_MS = 60 * 60_000;
/** Blocks behind the head the scan stops at, and blocks re-read behind the cursor every pass. */
const CONFIRMATIONS = 2;
const TRAILING_BLOCKS = 120;
/** A cancel sent less than this long ago is left to mine before it is retried. */
const CANCEL_RETRY_MS = 5 * 60_000;
const SEEN_LIMIT = 5_000;

/** Events (tx:logIndex) this process already handled, so re-reads do not act or DM twice. */
const seen = new Set<string>();

function markSeen(key: string): void {
  seen.add(key);
  if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value as string);
}

function integerText(value: unknown, name: string): bigint {
  const text = String(value ?? "");
  if (!/^\d+$/.test(text)) throw new Error(`${name} ${text} is not an integer`);
  return BigInt(text);
}

type Notify = (message: string) => Promise<void>;

function cursorName(settings: V2Settings): string {
  return `admin:${settings.payout.toLowerCase()}`;
}

function checksum(address: string): string {
  return ethers.getAddress(address);
}

function when(seconds: number): string {
  return `<t:${seconds}:f> (<t:${seconds}:R>)`;
}

async function readUint(fn: string, args: unknown[], payout: string): Promise<bigint> {
  const raw = await ethCall(payout, PAYOUT.encodeFunctionData(fn, args));
  return BigInt(PAYOUT.decodeFunctionResult(fn, raw)[0]);
}

/** When a queued action can apply, or 0 when it is not queued, was dropped by an epoch change or lapsed. */
export async function pendingEta(payout: string, q: Pick<QueuedAction, "action" | "subject" | "value1" | "value2">): Promise<bigint> {
  return readUint("pendingEta", [PAYOUT_ACTIONS.indexOf(q.action), q.subject, q.value1, q.value2], payout);
}

/** Unexpired approvals for `action` that are unused or already used by this event. */
async function openExpectations(action: PayoutAction, eventKey: string): Promise<Expectation[]> {
  // NUMERIC read as text so large base-unit amounts parse exactly.
  const { data, error } = await supabase
    .from("custody_expected_actions")
    .select("id, action, subject, value1::text, value2::text, expires_at, used_by")
    .eq("action", action)
    .or(`used_by.is.null,used_by.eq."${eventKey}"`)
    .gt("expires_at", new Date().toISOString());
  if (error) throw new Error(`custody_expected_actions: ${error.message}`);
  return (data ?? []).flatMap((row) => {
    try {
      integerText(row.value1, "value1");
      integerText(row.value2, "value2");
      return [{ ...row, value1: String(row.value1), value2: String(row.value2) } as Expectation];
    } catch {
      return [];
    }
  });
}

/** Records an admin's approval for one exact vault action, usable for 24 hours. */
export async function expectAction(input: {
  action: PayoutAction;
  subject: string;
  value1: bigint;
  value2: bigint;
  actorId: string;
  note: string | null;
}): Promise<Date> {
  const expires = new Date(Date.now() + EXPECTATION_TTL_MS);
  const { error } = await supabase.from("custody_expected_actions").insert({
    action: input.action,
    subject: input.subject.toLowerCase(),
    value1: input.value1.toString(),
    value2: input.value2.toString(),
    actor_id: input.actorId,
    note: input.note,
    expires_at: expires.toISOString(),
  });
  if (error) throw new Error(`could not record the approval: ${error.message}`);
  return expires;
}

/** Has the guardian cancel one queued action (never a new guardian: only the vault can). */
export async function guardianCancel(settings: V2Settings, q: Pick<QueuedAction, "id" | "action" | "subject" | "value1" | "value2">): Promise<string> {
  const guardian = getGuardianWallet();
  if (!guardian) throw new Error("no guardian key is configured");
  if (q.action === "guardian") throw new Error("a new guardian can only be cancelled from the vault wallet");
  const { txHash } = await sendCustodyTx({
    wallet: guardian,
    to: settings.payout,
    data: cancelCalldata(q),
    purpose: "cancel",
    ref: q.id,
    bypassFreeze: true,
  });
  return txHash;
}

async function recordQueued(settings: V2Settings, event: DecodedAdminLog & { kind: "queued" }, status: string, expectationId: number | null): Promise<void> {
  const q = event.queued;
  const { error } = await supabase.from("custody_admin_actions").upsert({
    tx_hash: event.txHash,
    log_index: event.logIndex,
    block_number: event.blockNumber,
    payout: settings.payout.toLowerCase(),
    action_id: q.id,
    action: q.action,
    subject: q.subject,
    value1: q.value1.toString(),
    value2: q.value2.toString(),
    eta: new Date(q.eta * 1000).toISOString(),
    status,
    expectation_id: expectationId,
    last_alert_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: "tx_hash,log_index", ignoreDuplicates: true });
  if (error) throw new Error(`custody_admin_actions: ${error.message}`);
}

async function setActionStatus(settings: V2Settings, id: string, status: "cancelled" | "applied"): Promise<void> {
  const { error } = await supabase
    .from("custody_admin_actions")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("payout", settings.payout.toLowerCase())
    .eq("action_id", id)
    .in("status", ["approved", "unapproved", "cancelling"]);
  if (error) throw new Error(`custody_admin_actions: ${error.message}`);
}

async function markCancelSent(txHash: string, logIndex: number, cancelTx: string): Promise<void> {
  const { error } = await supabase
    .from("custody_admin_actions")
    .update({ cancel_tx: cancelTx, cancel_sent_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("tx_hash", txHash)
    .eq("log_index", logIndex);
  if (error) throw new Error(`custody_admin_actions: ${error.message}`);
}

function cancelInFlight(sentAt: unknown): boolean {
  return typeof sentAt === "string" && Date.now() - Date.parse(sentAt) < CANCEL_RETRY_MS;
}

async function handleQueued(settings: V2Settings, event: DecodedAdminLog & { kind: "queued" }, lines: string[]): Promise<void> {
  const q = event.queued;
  const what = describeQueued(q);
  const grace = q.eta + 7 * 24 * 60 * 60;
  const key = `${event.txHash}:${event.logIndex}`;
  const { data: existing, error: lookupError } = await supabase
    .from("custody_admin_actions")
    .select("status, cancel_sent_at")
    .eq("tx_hash", event.txHash)
    .eq("log_index", event.logIndex)
    .maybeSingle();
  if (lookupError) throw new Error(`custody_admin_actions: ${lookupError.message}`);
  if (existing && existing.status !== "cancelling") return;
  if (existing && cancelInFlight(existing.cancel_sent_at)) return;

  if (!existing) {
    // Claim the approval first; a claim this event already made is matched again after a crash.
    const expectation = matchExpectation(q, await openExpectations(q.action, key), Date.now(), key);
    if (expectation) {
      const { data: claimed, error } = await supabase
        .from("custody_expected_actions")
        .update({ used_by: key })
        .eq("id", expectation.id)
        .or(`used_by.is.null,used_by.eq."${key}"`)
        .select("id");
      if (error) throw new Error(`custody_expected_actions: ${error.message}`);
      if ((claimed ?? []).length === 1) {
        await recordQueued(settings, event, "approved", expectation.id);
        lines.push(`✅ Approved vault action queued: ${what}. It can be applied from ${when(q.eta)} until ${when(grace)}. id \`${q.id}\``);
        return;
      }
    }
  }
  const decision = decideQueued(q, false);
  if (decision === "vault-must-cancel") {
    await recordQueued(settings, event, "unapproved", null);
    lines.push(
      `🚨 **Unapproved vault action queued: ${what}** (tx ${event.txHash}). Only the vault wallet can cancel a new guardian: ` +
      `from \`${checksum(settings.vault)}\` call HotPayout \`${cancelCallText(q)}\` before ${when(q.eta)}. ` +
      `If nobody on the team queued it, the vault key is exposed: also queue a vault handover to a fresh wallet before ${when(q.eta)} ` +
      "(approve it with `/custody expect action:vault`, then `proposeVault`, or a signed `proposeVaultWithSig` anyone can submit). " +
      "A handover queued before this guardian could take office cannot be cancelled by it, lands first, and drops everything " +
      "the old key queued.",
    );
    return;
  }
  if (!existing) await recordQueued(settings, event, "cancelling", null);
  if ((await pendingEta(settings.payout, q)) === 0n) return;
  try {
    const txHash = await guardianCancel(settings, q);
    await markCancelSent(event.txHash, event.logIndex, txHash);
    lines.push(
      `🛑 Cancelled an unapproved vault action: ${what} (queued in ${event.txHash}, cancel ${txHash}). ` +
      "If this was you, approve it with `/custody expect` and queue it again. If not, the vault key is exposed: move the vault to a fresh wallet.",
    );
  } catch (error) {
    lines.push(
      `🚨 **Unapproved vault action queued: ${what}** (tx ${event.txHash}) and the guardian could not cancel it ` +
      `(${(error as Error).message}). Cancel it with \`/custody cancel id:${q.id}\` or from the guardian wallet: ` +
      `HotPayout \`${cancelCallText(q)}\` before ${when(q.eta)}.`,
    );
  }
}

async function handleEvent(settings: V2Settings, event: DecodedAdminLog, lines: string[]): Promise<void> {
  switch (event.kind) {
    case "queued":
      await handleQueued(settings, event, lines);
      break;
    case "cancelled":
      await setActionStatus(settings, event.id, "cancelled");
      lines.push(`Vault action (${event.action}) \`${event.id}\` was cancelled by ${checksum(event.by)}.`);
      break;
    case "applied":
      await setActionStatus(settings, event.id, "applied");
      lines.push(`Vault action (${event.action}) \`${event.id}\` was applied in ${event.txHash}.`);
      break;
    case "unpaused":
      lines.push(`HotPayout was unpaused by ${checksum(event.by)}.`);
      break;
    case "notice":
      lines.push(event.text);
      break;
  }
}

/**
 * Scans admin events up to CONFIRMATIONS behind the head, re-reading
 * TRAILING_BLOCKS behind the cursor every pass (a lagging node may have
 * missed some). Each event is acted on once per process; queued actions are
 * also idempotent through custody_admin_actions. An event that fails is
 * retried next pass: the cursor stops before its block.
 */
async function scanAdminEvents(settings: V2Settings, lines: string[]): Promise<void> {
  const cursor = cursorName(settings);
  const last = (await readNumberCursor(cursor)) ?? settings.startBlock - 1;
  const to = (await getBlockNumber()) - CONFIRMATIONS;
  const from = Math.max(settings.startBlock, last + 1 - TRAILING_BLOCKS);
  if (to < from) return;
  const ranges = chunkRanges(from, to, config.custody.logChunkBlocks).slice(0, MAX_CHUNKS_PER_PASS);
  for (const range of ranges) {
    if (!await nodeHasBlock(range.to)) break;
    const [payoutLogs, factoryLogs] = await Promise.all([
      getLogs({ address: settings.payout, topics: [ADMIN_PAYOUT_TOPICS], fromBlock: range.from, toBlock: range.to }),
      getLogs({ address: settings.factory, topics: [ADMIN_FACTORY_TOPICS], fromBlock: range.from, toBlock: range.to }),
    ]);
    const ordered = [...payoutLogs, ...factoryLogs]
      .map((log) => decodeAdminLog(log, settings.payout, settings.factory))
      .filter((event): event is DecodedAdminLog => event != null)
      .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
    // Queued vault handovers first: they are the ones that must never be missed.
    const isHandover = (event: DecodedAdminLog) => event.kind === "queued" && event.queued.action === "vault";
    const events = [...ordered.filter(isHandover), ...ordered.filter((event) => !isHandover(event))];
    let failedBlock: number | null = null;
    for (const event of events) {
      const key = `${event.txHash}:${event.logIndex}`;
      if (seen.has(key)) continue;
      try {
        await handleEvent(settings, event, lines);
        markSeen(key);
      } catch (error) {
        console.warn(`[AdminWatch] ${event.kind} event ${key} failed (retried next pass): ${(error as Error).message}`);
        failedBlock = Math.min(failedBlock ?? event.blockNumber, event.blockNumber);
      }
    }
    if (failedBlock != null) {
      await writeCursor(cursor, Math.max(last, failedBlock - 1));
      return;
    }
    await writeCursor(cursor, Math.max(last, range.to));
  }
}

/**
 * Follows up on unapproved actions still queued: retries the guardian's
 * cancel each pass, and repeats the alert for a new guardian (which only the
 * vault can cancel) every 6 hours. Rows whose action is gone are closed.
 */
async function followUpUnapproved(settings: V2Settings, lines: string[]): Promise<void> {
  // NUMERIC read as text so large base-unit amounts parse exactly.
  const { data, error } = await supabase
    .from("custody_admin_actions")
    .select("tx_hash, log_index, action_id, action, subject, value1::text, value2::text, eta, status, last_alert_at, cancel_sent_at")
    .eq("payout", settings.payout.toLowerCase())
    .in("status", ["unapproved", "cancelling"]);
  if (error) throw new Error(`custody_admin_actions: ${error.message}`);
  for (const row of data ?? []) {
    try {
      await followUpRow(settings, row, lines);
    } catch (rowError) {
      console.warn(`[AdminWatch] Follow-up of ${row.tx_hash}:${row.log_index} failed: ${(rowError as Error).message}`);
    }
  }
}

async function followUpRow(settings: V2Settings, row: Record<string, unknown>, lines: string[]): Promise<void> {
  const q = {
    id: String(row.action_id),
    action: row.action as PayoutAction,
    subject: String(row.subject),
    value1: integerText(row.value1, "value1"),
    value2: integerText(row.value2, "value2"),
  };
  if ((await pendingEta(settings.payout, q)) === 0n) {
    await setActionStatus(settings, q.id, "cancelled");
    return;
  }
  const alertDue = !row.last_alert_at || Date.now() - Date.parse(String(row.last_alert_at)) >= REALERT_MS;
  const eta = Math.floor(Date.parse(String(row.eta)) / 1000);
  if (row.status === "cancelling") {
    if (cancelInFlight(row.cancel_sent_at)) return;
    try {
      const txHash = await guardianCancel(settings, q);
      await markCancelSent(String(row.tx_hash), Number(row.log_index), txHash);
      lines.push(`🛑 Cancelled an unapproved vault action on retry: ${describeQueued(q)} (cancel ${txHash}).`);
      return;
    } catch (cancelError) {
      if (!alertDue) return;
      lines.push(
        `🚨 Still queued and unapproved: ${describeQueued(q)} (tx ${row.tx_hash}); the guardian cannot cancel it ` +
        `(${(cancelError as Error).message}). Use \`/custody cancel id:${q.id}\` or the guardian wallet before ${when(eta)}.`,
      );
    }
  } else {
    if (!alertDue) return;
    lines.push(
      `🚨 Still queued and unapproved: ${describeQueued(q)} (tx ${row.tx_hash}). From the vault wallet call HotPayout ` +
      `\`${cancelCallText(q)}\` before ${when(eta)}.`,
    );
  }
  const { error: updateError } = await supabase
    .from("custody_admin_actions")
    .update({ last_alert_at: new Date().toISOString() })
    .eq("tx_hash", String(row.tx_hash))
    .eq("log_index", Number(row.log_index));
  if (updateError) throw new Error(`custody_admin_actions: ${updateError.message}`);
}

/** Payout tokens to stop: native plus every configured token contract. */
function payoutTokens(): string[] {
  const tokens = [NATIVE_TOKEN];
  for (const symbol of TOKEN_SYMBOLS) {
    if (symbol === "SATS") continue;
    const contract = getTokenConfig(symbol).contractAddress;
    if (contract) tokens.push(contract);
  }
  return tokens;
}

let unpauseAlertedAt = 0;

/**
 * While custody is frozen HotPayout must stay paused. If it is found unpaused
 * (only the vault can unpause), the guardian stops every payout cap and
 * pauses it again; caps can only come back through a queued, approved raise.
 */
async function enforceFrozenPause(settings: V2Settings, lines: string[]): Promise<void> {
  if (!isCustodyFrozen()) return;
  const guardian = getGuardianWallet();
  if (!guardian) return;
  const raw = await ethCall(settings.payout, PAYOUT.encodeFunctionData("paused"));
  if (PAYOUT.decodeFunctionResult("paused", raw)[0]) return;

  const done: string[] = [];
  const failed: string[] = [];
  for (const token of payoutTokens()) {
    if ((await readUint("perTxCap", [token], settings.payout)) === 0n) continue;
    try {
      const { txHash } = await sendCustodyTx({
        wallet: guardian,
        to: settings.payout,
        data: PAYOUT.encodeFunctionData("tightenCaps", [token, 0n, 0n]),
        purpose: "tighten",
        ref: null,
        bypassFreeze: true,
      });
      done.push(`${token === NATIVE_TOKEN ? "BTC" : token} (${txHash})`);
    } catch (error) {
      failed.push(`${token}: ${(error as Error).message}`);
    }
  }
  let paused = "";
  try {
    const { txHash } = await sendCustodyTx({
      wallet: guardian,
      to: settings.payout,
      data: PAYOUT.encodeFunctionData("pause"),
      purpose: "pause",
      ref: null,
      bypassFreeze: true,
      emergencyPause: true,
    });
    paused = ` and paused it again (${txHash})`;
  } catch (error) {
    failed.push(`pause: ${(error as Error).message}`);
  }
  if (Date.now() - unpauseAlertedAt < UNPAUSE_ALERT_MS && failed.length === 0) return;
  unpauseAlertedAt = Date.now();
  lines.push(
    `🚨 **HotPayout was unpaused while custody is frozen.** The guardian set payout caps to 0` +
    `${done.length ? ` for ${done.join(", ")}` : ""}${paused}. Raising caps again is queued for 3 days ` +
    "(`/custody expect action:caps`, then `setCaps` and `applyCaps` from the vault). Run `/custody unfreeze` before unpausing." +
    (failed.length ? ` Failed: ${failed.join("; ")}.` : ""),
  );
}

/** One watcher pass. DMs everything found as one message per ~1,900 characters. */
export async function runAdminWatch(settings: V2Settings, notify: Notify): Promise<void> {
  const lines: string[] = [];
  const steps: Array<[string, () => Promise<void>]> = [
    ["admin events", () => scanAdminEvents(settings, lines)],
    ["unapproved follow-up", () => followUpUnapproved(settings, lines)],
    ["frozen pause", () => enforceFrozenPause(settings, lines)],
  ];
  for (const [name, step] of steps) {
    await step().catch((error) => {
      console.warn(`[AdminWatch] ${name} failed: ${(error as Error).message}`);
    });
  }
  if (lines.length === 0) return;
  for (const line of lines) console.warn(`[AdminWatch] ${line}`);
  let message = "";
  for (const line of lines) {
    if (message && message.length + line.length + 1 > 1900) {
      await notify(message).catch(() => {});
      message = "";
    }
    message = message ? `${message}\n${line}` : line.slice(0, 1900);
  }
  if (message) await notify(message).catch(() => {});
}
