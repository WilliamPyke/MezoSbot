import { ethers } from "ethers";
import {
  RESCAN_BLOCKS,
  anomalySetCode,
  checkSignedNonces,
  chunkRanges,
  classifyPaidEvent,
  isDeepRescanPass,
  nextLogRange,
  parsePaidLog,
  refundCheckOutcome,
  rescanRange,
  sortByChainPosition,
  type PaidEvent,
  type PaidEventCheck,
  type RpcLog,
  type V2Settings,
} from "./policy.js";

/**
 * The watchdog's checks, written against an injected IO so the full
 * freeze → unfreeze → next pass cycle is unit-tested (tests/custody.test.ts).
 * src/custody/watchdog.ts wires the production IO (Supabase, JSON-RPC).
 */

export type PaidRow = { id: number; payout_ref: string; raw_tx: string | null; status: string | null; tx_hash: string | null };

/** A refunded HotPayout row not yet verified unpaid (or acknowledged), oldest read first. */
export type RefundCandidate = { id: number; payoutRef: string; falseReads: number; firstFalseAt: number | null };

export type RefundCheckRecord = {
  id: number;
  payoutRef: string;
  falseReads: number;
  firstFalseAt: number | null;
  lastReadAt: number;
  verified: boolean;
};

export type WatchdogIO = {
  getNonce(address: string): Promise<number>;
  /** true: a receipt exists; false: none; null: lookup failed. */
  getReceiptExists(txHash: string): Promise<boolean | null>;
  getBlockNumber(): Promise<number>;
  nodeHasBlock(block: number): Promise<boolean>;
  getPaidLogs(settings: V2Settings, from: number, to: number): Promise<RpcLog[]>;
  /** paid(ref) per ref (batched); null where the read failed. */
  readPaidRefs(settings: V2Settings, refs: string[]): Promise<Map<string, boolean | null>>;
  readCursor(name: string): Promise<number | null>;
  writeCursor(name: string, value: number): Promise<void>;
  signedTxs(signer: string, fromNonce: number, toNonce: number): Promise<Array<{ nonce: number; txHash: string }>>;
  withdrawalsForRefs(refs: string[]): Promise<Map<string, PaidRow>>;
  refundCandidates(limit: number): Promise<RefundCandidate[]>;
  recordRefundChecks(records: RefundCheckRecord[]): Promise<void>;
  acknowledge(entries: Array<{ key: string; reason: string }>, actorId: string, note: string): Promise<void>;
  isFrozen(): boolean;
  /** Freeze custody; keys an admin already acknowledged never freeze again. */
  freeze(reason: string, keys?: string[]): Promise<void>;
};

export type WatchdogOptions = {
  confirmations: number;
  logChunkBlocks: number;
  deepRescanPasses: number;
  deepRescanBlocks: number;
  /** Wall-clock budget of the refunded-row re-check per pass; it always runs last. */
  refundCheckBudgetMs?: number;
  now?: () => number;
};

export const MAX_NONCES_PER_PASS = 500;
const MAX_PAID_CHUNKS_PER_PASS = 25;
/** A displaced nonce is only an intrusion once receipts had time to index. */
const DISPLACED_GRACE_MS = 2 * 60_000;
const REFUND_BATCH = 25;
const REFUND_CANDIDATES_PER_PASS = 500;
const REFUND_CANDIDATES_ON_UNFREEZE = 10_000;
const DEFAULT_REFUND_BUDGET_MS = 10_000;

export type Signer = { role: string; address: string };

export function custodySigners(settings: V2Settings): Signer[] {
  return [
    { role: "operator", address: settings.operator },
    { role: "sweep gas", address: settings.sweepGas },
    ...(settings.guardian ? [{ role: "guardian", address: settings.guardian }] : []),
  ];
}

export const nonceCursorName = (address: string) => `nonce_checked:${address}`;
export const paidCursorName = (settings: V2Settings) => `paid:${settings.payout}`;
/** Paid events at or below this block were accepted by an admin unfreeze. */
export const paidFloorName = (settings: V2Settings) => `paid_floor:${settings.payout}`;
/** Anomaly keys: what an admin is shown and acknowledges when clearing a freeze. */
export const withdrawalKey = (id: number | string) => `withdrawal:${id}`;
export const paidEventKey = (event: { txHash: string; logIndex: number }) => `paid:${event.txHash}:${event.logIndex}`;
export const nonceKey = (signer: string, nonce: number) => `nonce:${signer}:${nonce}`;

/** One anomaly found on chain, as shown to the admin who clears a freeze. */
export type Anomaly = {
  key: string;
  kind: "paid_event" | "refunded_paid" | "nonce_unrecorded" | "nonce_displaced";
  description: string;
  withdrawalId?: number;
  ref?: string;
  txHash?: string;
  block?: number;
};

export type UnfreezeResult =
  | { status: "accepted"; acknowledged: Anomaly[]; recordedKeys: string[]; lines: string[] }
  | { status: "confirm"; newAnomalies: Anomaly[]; code: string };

function checksum(address: string): string {
  return ethers.getAddress(address);
}

const OUT_OF_BUDGET = Symbol("out of budget");

/** `work`, or OUT_OF_BUDGET after `remainingMs` (the work keeps running; its result is ignored). */
async function withinBudget<T>(work: Promise<T>, remainingMs: number): Promise<T | typeof OUT_OF_BUDGET> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<typeof OUT_OF_BUDGET>((resolve) => {
    timer = setTimeout(() => resolve(OUT_OF_BUDGET), Math.max(0, remainingMs));
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

function describePaid(event: PaidEvent): string {
  return `${event.amount} of token ${event.token} to ${event.to} (ref ${event.ref}, tx ${event.txHash})`;
}

const PAID_FREEZE_REASONS: Record<Exclude<PaidEventCheck, "ok">, string> = {
  unknown_ref: "with a ref that matches no withdrawal",
  mismatch: "which differs from the withdrawal the bot signed",
  foreign_tx: "in a transaction other than the one the bot recorded for that withdrawal",
  not_pending: "for a withdrawal that was already refunded or is not in flight",
};

export function createWatchdogCore(io: WatchdogIO, options: WatchdogOptions) {
  const now = options.now ?? Date.now;
  const displacedSince = new Map<string, number>();
  let paidPasses = 0;

  async function receiptStates(hashes: string[]): Promise<Map<string, boolean | null>> {
    const states = new Map<string, boolean | null>();
    for (const hash of hashes) states.set(hash, await io.getReceiptExists(hash).catch(() => null));
    return states;
  }

  /* ─────────── Anomaly finders (read-only) ─────────── */

  /** Nonce anomalies of one signer in [from, upTo); `displaced` lists nonces whose recorded txs have no receipt. */
  async function nonceAnomalies(signer: Signer, from: number, upTo: number) {
    const records = await io.signedTxs(signer.address, from, upTo);
    const receipts = await receiptStates([...new Set(records.map((record) => record.txHash.toLowerCase()))]);
    return { records, result: checkSignedNonces(from, upTo, records, receipts) };
  }

  /** Anomalous Paid events in [from, to] above `floor`. */
  async function paidAnomalies(settings: V2Settings, from: number, to: number, floor: number): Promise<Anomaly[]> {
    const logs = await io.getPaidLogs(settings, from, to);
    const events = sortByChainPosition(
      logs.map((log) => parsePaidLog(log, settings.payout)).filter((event): event is PaidEvent => event != null),
    ).filter((event) => event.blockNumber > floor);
    if (events.length === 0) return [];
    const byRef = await io.withdrawalsForRefs([...new Set(events.map((event) => event.ref))]);
    const anomalies: Anomaly[] = [];
    for (const event of events) {
      const row = byRef.get(event.ref) ?? null;
      const check = classifyPaidEvent(event, row, settings.payout);
      if (check === "ok") continue;
      anomalies.push({
        key: paidEventKey(event),
        kind: "paid_event",
        description: `HotPayout paid ${describePaid(event)} ${PAID_FREEZE_REASONS[check]}.`,
        withdrawalId: row?.id,
        ref: event.ref,
        txHash: event.txHash,
        block: event.blockNumber,
      });
    }
    return anomalies;
  }

  /* ─────────── Pass checks ─────────── */

  /**
   * Every nonce each custody key has spent must be one the bot recorded, and a
   * transaction recorded for it must have a receipt. The check starts at
   * nonce 0: custody keys are generated fresh.
   */
  async function checkNonces(settings: V2Settings): Promise<void> {
    for (const signer of custodySigners(settings)) {
      const latest = await io.getNonce(signer.address);
      const cursor = nonceCursorName(signer.address);
      const stored = await io.readCursor(cursor);
      const checked = stored ?? 0;
      if (latest <= checked) {
        if (stored == null) await io.writeCursor(cursor, 0);
        continue;
      }
      const upTo = Math.min(latest, checked + MAX_NONCES_PER_PASS);
      const { records, result } = await nonceAnomalies(signer, checked, upTo);
      const who = `The ${signer.role} key ${checksum(signer.address)}`;

      if (result.unrecorded.length > 0) {
        const first = result.unrecorded[0];
        const beforeCustody = stored == null && !records.some((record) => record.nonce < first);
        await io.freeze(beforeCustody
          ? `${who} was used before custody started (nonce ${result.unrecorded.join(", ")} has no record). Custody keys must be fresh.`
          : `${who} spent nonce(s) ${result.unrecorded.join(", ")} that the bot never signed.`,
        result.unrecorded.map((nonce) => nonceKey(signer.address, nonce)));
      }

      const at = now();
      for (const nonce of result.displaced) {
        const key = `${signer.address}:${nonce}`;
        const since = displacedSince.get(key) ?? at;
        displacedSince.set(key, since);
        if (at - since >= DISPLACED_GRACE_MS) {
          await io.freeze(
            `${who}: nonce ${nonce} was consumed by a transaction the bot did not sign (no recorded transaction has a receipt).`,
            [nonceKey(signer.address, nonce)],
          );
        }
      }
      if (io.isFrozen()) return;
      // Advance only past nonces that are fully proven (or acknowledged).
      const pending = [...result.displaced, ...result.unknown];
      const next = pending.length > 0 ? Math.min(...pending) : upTo;
      for (let nonce = checked; nonce < next; nonce++) displacedSince.delete(`${signer.address}:${nonce}`);
      if (next > checked || stored == null) await io.writeCursor(cursor, next);
    }
  }

  /**
   * Freeze on every unacknowledged anomaly in [from, to] (all of them, so the
   * freeze records each one admins are shown). Returns false once frozen.
   */
  async function checkPaidRange(settings: V2Settings, from: number, to: number, floor: number): Promise<boolean> {
    for (const anomaly of await paidAnomalies(settings, from, to, floor)) {
      await io.freeze(anomaly.description, [anomaly.key]);
    }
    return !io.isFrozen();
  }

  /** Re-check [from, to] in chunks, stopping at the first chunk the node does not serve yet. */
  async function recheckPaidWindow(settings: V2Settings, window: { from: number; to: number }, floor: number): Promise<boolean> {
    for (const chunk of chunkRanges(window.from, window.to, options.logChunkBlocks)) {
      if (!await io.nodeHasBlock(chunk.to)) return true;
      if (!await checkPaidRange(settings, chunk.from, chunk.to, floor)) return false;
    }
    return true;
  }

  async function checkPaidEvents(settings: V2Settings, forceDeep: boolean): Promise<void> {
    const cursor = paidCursorName(settings);
    let last = (await io.readCursor(cursor)) ?? settings.startBlock - 1;
    const floor = (await io.readCursor(paidFloorName(settings))) ?? -1;
    // A short trailing window every pass; a deep one every CUSTODY_DEEP_RESCAN_PASSES passes.
    paidPasses += 1;
    const deep = forceDeep || isDeepRescanPass(paidPasses, options.deepRescanPasses);
    const rescan = rescanRange(last, settings.startBlock, deep ? options.deepRescanBlocks : RESCAN_BLOCKS);
    if (rescan && !await recheckPaidWindow(settings, rescan, floor)) return;
    const latest = await io.getBlockNumber();
    for (let i = 0; i < MAX_PAID_CHUNKS_PER_PASS; i++) {
      const range = nextLogRange(last, latest, options.confirmations, options.logChunkBlocks);
      if (!range) return;
      // A node that lags or is load-balanced may not have the range yet: wait.
      if (!await io.nodeHasBlock(range.to)) return;
      if (!await checkPaidRange(settings, range.from, range.to, floor)) return;
      await io.writeCursor(cursor, range.to);
      last = range.to;
    }
  }

  /**
   * A refunded HotPayout withdrawal must stay unpaid. paid(ref) is re-read
   * (25 per Multicall3 batch) until it has read false 3 times over at least an
   * hour; the row is then verified and never re-read (a later Paid for its
   * ref is caught by the Paid scan as not_pending). Runs last in a pass, with
   * its own time budget, so it never delays the nonce and Paid checks.
   */
  async function checkRefundedRefs(settings: V2Settings): Promise<void> {
    const budget = options.refundCheckBudgetMs ?? DEFAULT_REFUND_BUDGET_MS;
    const deadline = now() + budget;
    const candidates = await withinBudget(io.refundCandidates(REFUND_CANDIDATES_PER_PASS), deadline - now());
    if (candidates === OUT_OF_BUDGET) {
      console.warn(`[Watchdog] Refund re-check: listing refunded rows exceeded its ${budget}ms budget; retried next pass`);
      return;
    }
    let read = 0;
    let failed = 0;
    for (let i = 0; i < candidates.length && !io.isFrozen(); i += REFUND_BATCH) {
      const batch = candidates.slice(i, i + REFUND_BATCH);
      const paid = now() < deadline
        ? await withinBudget(io.readPaidRefs(settings, batch.map((row) => row.payoutRef)), deadline - now())
        : OUT_OF_BUDGET;
      if (paid === OUT_OF_BUDGET) {
        console.warn(`[Watchdog] Refund re-check stopped at its ${budget}ms budget; ${candidates.length - i} row(s) wait for the next pass`);
        break;
      }
      const readAt = now();
      const records: RefundCheckRecord[] = [];
      const doublePaid: RefundCandidate[] = [];
      for (const row of batch) {
        const outcome = refundCheckOutcome(row, paid.get(row.payoutRef) ?? null, readAt);
        if (outcome.kind === "paid") {
          doublePaid.push(row);
          continue;
        }
        if (outcome.kind === "failed") failed += 1;
        else read += 1;
        const state = outcome.kind === "unpaid" ? outcome.state : row;
        records.push({
          id: row.id,
          payoutRef: row.payoutRef,
          falseReads: state.falseReads,
          firstFalseAt: state.firstFalseAt,
          lastReadAt: readAt,
          verified: outcome.kind === "unpaid" && outcome.verified,
        });
      }
      await io.recordRefundChecks(records);
      for (const row of doublePaid) {
        await io.freeze(
          `Withdrawal ${row.id} was refunded, but HotPayout shows its ref ${row.payoutRef} as paid (double payment).`,
          [withdrawalKey(row.id)],
        );
      }
    }
    if (failed > 0) {
      console.warn(`[Watchdog] Refund re-check: ${failed} paid(ref) read(s) failed (${read} succeeded); those rows are read again next pass`);
    }
  }

  /**
   * Everything anomalous on chain right now, up to the head, without
   * advancing any cursor: nonces past each checkpoint, Paid events past the
   * Paid cursor (and its trailing window) above the accepted floor, and
   * refunded rows whose ref reads as paid. Throws when something could not be
   * read: an unfreeze must never accept what it could not see.
   */
  async function discoverAnomalies(settings: V2Settings) {
    const anomalies: Anomaly[] = [];
    const nonces = new Map<string, number>();
    for (const signer of custodySigners(settings)) {
      const latest = await io.getNonce(signer.address);
      nonces.set(signer.address, latest);
      const from = (await io.readCursor(nonceCursorName(signer.address))) ?? 0;
      for (let start = from; start < latest; start += MAX_NONCES_PER_PASS) {
        const upTo = Math.min(latest, start + MAX_NONCES_PER_PASS);
        const { result } = await nonceAnomalies(signer, start, upTo);
        if (result.unknown.length > 0) throw new Error(`could not read receipts for ${signer.role} nonce(s) ${result.unknown.join(", ")}`);
        const who = `The ${signer.role} key ${checksum(signer.address)}`;
        for (const nonce of result.unrecorded) {
          anomalies.push({ key: nonceKey(signer.address, nonce), kind: "nonce_unrecorded", description: `${who} spent nonce ${nonce} that the bot never signed.` });
        }
        for (const nonce of result.displaced) {
          anomalies.push({
            key: nonceKey(signer.address, nonce),
            kind: "nonce_displaced",
            description: `${who}: nonce ${nonce} was consumed by a transaction the bot did not sign.`,
          });
        }
      }
    }

    const head = await io.getBlockNumber();
    if (!await io.nodeHasBlock(head)) throw new Error(`the RPC node does not serve block ${head} yet`);
    const last = (await io.readCursor(paidCursorName(settings))) ?? settings.startBlock - 1;
    const floor = (await io.readCursor(paidFloorName(settings))) ?? -1;
    const from = Math.max(settings.startBlock, last - RESCAN_BLOCKS + 1, floor + 1);
    for (const chunk of chunkRanges(from, head, options.logChunkBlocks)) {
      anomalies.push(...await paidAnomalies(settings, chunk.from, chunk.to, floor));
    }

    const candidates = await io.refundCandidates(REFUND_CANDIDATES_ON_UNFREEZE);
    if (candidates.length >= REFUND_CANDIDATES_ON_UNFREEZE) {
      throw new Error(`${candidates.length}+ unverified refunded withdrawals are more than one unfreeze can check`);
    }
    const paid = await io.readPaidRefs(settings, candidates.map((row) => row.payoutRef));
    const unreadable = candidates.filter((row) => paid.get(row.payoutRef) == null);
    if (unreadable.length > 0) throw new Error(`could not read paid(ref) for ${unreadable.length} refunded withdrawal(s)`);
    for (const row of candidates) {
      if (paid.get(row.payoutRef) !== true) continue;
      anomalies.push({
        key: withdrawalKey(row.id),
        kind: "refunded_paid",
        description: `Withdrawal ${row.id} was refunded, but HotPayout shows its ref as paid (double payment).`,
        withdrawalId: row.id,
        ref: row.payoutRef,
      });
    }
    const unique = new Map(anomalies.map((anomaly) => [anomaly.key, anomaly]));
    return { anomalies: [...unique.values()], head, nonces };
  }

  return {
    /** One watchdog pass: nonces, then Paid events, then (budgeted) refunded rows; skipped while frozen. */
    async pass(settings: V2Settings, opts: { forceDeepRescan?: boolean } = {}): Promise<void> {
      if (!io.isFrozen()) await checkNonces(settings);
      if (!io.isFrozen()) await checkPaidEvents(settings, opts.forceDeepRescan === true);
      if (!io.isFrozen()) await checkRefundedRefs(settings);
    },

    /**
     * Admin unfreeze. First re-runs every check up to the head. Anomalies the
     * freeze already recorded (and admins were shown) are accepted; anything
     * new is only accepted with the confirmation code of exactly that set,
     * otherwise the set and its code are returned and nothing changes. On
     * acceptance nonce checkpoints move to the observed nonces, Paid events up
     * to the observed head are accepted by every scan, and the anomalies are
     * recorded as acknowledged (held for manual review, never re-freezing).
     */
    async acceptCurrentState(
      settings: V2Settings,
      actorId: string,
      note: string,
      recordedKeys: string[],
      confirmCode?: string | null,
    ): Promise<UnfreezeResult> {
      const recorded = new Set(recordedKeys);
      const { anomalies, head, nonces } = await discoverAnomalies(settings);
      const newAnomalies = anomalies.filter((anomaly) => !recorded.has(anomaly.key));
      if (newAnomalies.length > 0) {
        const code = anomalySetCode(newAnomalies.map((anomaly) => anomaly.key));
        if ((confirmCode ?? "").trim().toUpperCase() !== code) return { status: "confirm", newAnomalies, code };
      }

      const lines: string[] = [];
      for (const signer of custodySigners(settings)) {
        const nonce = nonces.get(signer.address) ?? 0;
        await io.writeCursor(nonceCursorName(signer.address), nonce);
        lines.push(`${signer.role} ${checksum(signer.address)}: nonces accepted up to ${nonce}`);
      }
      displacedSince.clear();
      await io.writeCursor(paidCursorName(settings), Math.max(settings.startBlock - 1, head - Math.max(0, options.confirmations)));
      await io.writeCursor(paidFloorName(settings), head);
      lines.push(`Paid events accepted up to block ${head}`);

      const entries = new Map<string, string>();
      for (const key of recordedKeys) entries.set(key, "anomaly behind the cleared freeze");
      for (const anomaly of anomalies) entries.set(anomaly.key, anomaly.description);
      if (entries.size > 0) {
        await io.acknowledge([...entries].map(([key, reason]) => ({ key, reason })), actorId, note);
      }
      return { status: "accepted", acknowledged: anomalies, recordedKeys: [...entries.keys()], lines };
    },
  };
}
