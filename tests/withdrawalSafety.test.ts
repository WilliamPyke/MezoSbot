import assert from "node:assert/strict";
import test from "node:test";
import {
  CREDIT_NOT_ATTEMPTED_CODE,
  WITHDRAWAL_DROP_MIN_AGE_MS,
  classifyWithdrawalOutcome,
  explainWithdrawalOutcome,
  isDefiniteDbFailure,
  parseReceiptStatus,
  pollWithdrawalOutcome,
  satsExitAllowed,
  settledState,
  sumInFlightSatsLiabilities,
  summarizeCredits,
  type WithdrawalObservation,
} from "../src/depositPolicy.js";

const OLD = WITHDRAWAL_DROP_MIN_AGE_MS + 1;

function observation(overrides: Partial<WithdrawalObservation> = {}): WithdrawalObservation {
  return { broadcast: true, receipt: null, txMined: false, txNonce: 7, minedNonce: 7, signedAgeMs: OLD, ...overrides };
}

const noSleep = async () => {};

test("never-broadcast withdrawals are refunded", () => {
  assert.deepEqual(explainWithdrawalOutcome(observation({ broadcast: false })), {
    outcome: "refund",
    reason: "never_broadcast",
  });
});

test("a successful receipt completes and a reverted receipt refunds", () => {
  assert.equal(classifyWithdrawalOutcome(observation({ receipt: { status: "0x1" } })), "completed");
  assert.deepEqual(explainWithdrawalOutcome(observation({ receipt: { status: "0x0" } })), {
    outcome: "refund",
    reason: "reverted",
  });
});

test("a receipt with a missing or malformed status stays pending, never success", () => {
  for (const status of [undefined, null, "", "0x", "pending", "1", "0x2", Number.NaN, 2, {}]) {
    assert.equal(classifyWithdrawalOutcome(observation({ receipt: { status } })), "pending", String(status));
  }
  assert.equal(parseReceiptStatus("0x01"), 1);
  assert.equal(parseReceiptStatus(0), 0);
  assert.equal(parseReceiptStatus(1n), 1);
  assert.equal(parseReceiptStatus("0xzz"), null);
});

test("a failed receipt lookup is unknown, not a failure", () => {
  assert.deepEqual(explainWithdrawalOutcome(observation({ receipt: undefined, minedNonce: 99 })), {
    outcome: "pending",
    reason: "lookup_failed",
  });
});

test("dropped: the mined nonce moved past the tx with no receipt for our hash", () => {
  assert.deepEqual(explainWithdrawalOutcome(observation({ txNonce: 7, minedNonce: 8 })), {
    outcome: "refund",
    reason: "dropped",
  });
  // Nonce not yet mined (still in the mempool or not seen) → keep waiting.
  assert.equal(classifyWithdrawalOutcome(observation({ txNonce: 7, minedNonce: 7 })), "pending");
  // Too young to trust a consumed nonce over a lagging receipt index.
  assert.equal(
    classifyWithdrawalOutcome(observation({ minedNonce: 8, signedAgeMs: WITHDRAWAL_DROP_MIN_AGE_MS - 1 })),
    "pending",
  );
  // Mined (blockNumber) but the receipt is not served yet → pending, not completed.
  assert.deepEqual(explainWithdrawalOutcome(observation({ minedNonce: 8, txMined: true })), {
    outcome: "pending",
    reason: "mined_without_receipt",
  });
});

test("unknown nonces never prove a drop", () => {
  assert.equal(classifyWithdrawalOutcome(observation({ txNonce: null, minedNonce: 50 })), "pending");
  assert.equal(classifyWithdrawalOutcome(observation({ txNonce: 7, minedNonce: null })), "pending");
});

test("restart mid-poll: a pending row with a hash is never refunded while its nonce is unmined", () => {
  for (const signedAgeMs of [0, 5 * 60_000, 60 * 60_000, 7 * 24 * 60 * 60_000]) {
    assert.equal(classifyWithdrawalOutcome(observation({ txNonce: 12, minedNonce: 12, signedAgeMs })), "pending");
    assert.equal(classifyWithdrawalOutcome(observation({ txNonce: 12, minedNonce: 3, signedAgeMs })), "pending");
    assert.equal(classifyWithdrawalOutcome(observation({ receipt: undefined, signedAgeMs })), "pending");
  }
});

test("receipt timeout: polling out of attempts leaves the withdrawal pending", async () => {
  let calls = 0;
  const result = await pollWithdrawalOutcome({
    attempts: 40,
    intervalMs: 3_000,
    sleep: noSleep,
    observe: async () => {
      calls += 1;
      return observation({ receipt: null, txNonce: 7, minedNonce: 7 });
    },
  });
  assert.equal(calls, 40);
  assert.equal(result.outcome, "pending");
  assert.equal(result.reason, "awaiting_receipt");
});

test("RPC errors on every poll leave the withdrawal pending", async () => {
  const thrown = await pollWithdrawalOutcome({
    attempts: 5,
    intervalMs: 1,
    sleep: noSleep,
    observe: async () => {
      throw new Error("RPC HTTP 502");
    },
  });
  assert.equal(thrown.outcome, "pending");

  const unknown = await pollWithdrawalOutcome({
    attempts: 5,
    intervalMs: 1,
    sleep: noSleep,
    observe: async () => observation({ receipt: undefined, minedNonce: null }),
  });
  assert.equal(unknown.outcome, "pending");
});

test("polling stops at the first receipt", async () => {
  const sequence = [observation(), observation(), observation({ receipt: { status: "0x1", gasUsed: "0x5208" } })];
  const result = await pollWithdrawalOutcome({
    attempts: 10,
    intervalMs: 1,
    sleep: noSleep,
    observe: async () => sequence.shift() ?? observation(),
  });
  assert.equal(result.outcome, "completed");
  assert.equal(result.observation?.receipt?.gasUsed, "0x5208");

  const reverted = await pollWithdrawalOutcome({
    attempts: 10,
    intervalMs: 1,
    sleep: noSleep,
    observe: async () => observation({ receipt: { status: "0x0" } }),
  });
  assert.deepEqual([reverted.outcome, reverted.reason], ["refund", "reverted"]);
});

test("a drop verdict is re-observed before it is trusted", async () => {
  const confirmed = [observation({ minedNonce: 8 }), observation({ minedNonce: 9 })];
  const dropped = await pollWithdrawalOutcome({
    attempts: 3,
    intervalMs: 1,
    sleep: noSleep,
    observe: async () => confirmed.shift() ?? observation({ minedNonce: 9 }),
  });
  assert.deepEqual([dropped.outcome, dropped.reason], ["refund", "dropped"]);

  // Lagging receipt index: the re-check finds the receipt after all.
  const lagging = [observation({ minedNonce: 8 }), observation({ minedNonce: 8, receipt: { status: "0x1" } })];
  const landed = await pollWithdrawalOutcome({
    attempts: 3,
    intervalMs: 1,
    sleep: noSleep,
    observe: async () => lagging.shift() ?? observation(),
  });
  assert.equal(landed.outcome, "completed");

  // Re-check fails → unknown → keep waiting, never refund.
  let call = 0;
  const flaky = await pollWithdrawalOutcome({
    attempts: 1,
    intervalMs: 1,
    sleep: noSleep,
    observe: async () => {
      call += 1;
      if (call === 1) return observation({ minedNonce: 8 });
      throw new Error("timeout");
    },
  });
  assert.equal(flaky.outcome, "pending");
});

test("SATS exits are blocked while the treasury is under-backed", () => {
  const reserve = 1_000n;
  assert.equal(satsExitAllowed(468_532n, 467_532n, reserve), true);
  assert.equal(satsExitAllowed(468_531n, 467_532n, reserve), false);
  assert.equal(satsExitAllowed(227_597n, 275_758n, reserve), false);
});

test("in-flight SATS liabilities count debited funds outside user balances", () => {
  const inFlight = sumInFlightSatsLiabilities({
    withdrawals: [
      { amount_sats: 500, token: "SATS" },
      { amount_sats: 200, token: null },
      // An ERC-20 withdrawal holds its SATS gas reservation, not its token amount.
      { amount_sats: 9, token: "MUSD", gas_reserved_sats: 4 },
      { amount_sats: 9, token: "MEZO", gas_reserved_sats: null },
    ],
    drops: [
      { per_claim_sats: 10, max_claims: 5, claims_count: 2, token: "SATS" },
      { per_claim_sats: 10, max_claims: 5, claims_count: 6, token: "SATS" },
      { per_claim_sats: 3, max_claims: 4, claims_count: 0, token: "MEZO" },
    ],
    arcadeEscrow: [{ amount_sats: 40 }, { amount_sats: "60" }],
    swaps: [
      { from_token: "SATS", from_amount: 1_000, gas_reserved_sats: 30, gas_refunded_sats: 10, gas_settled: false },
      { from_token: "MUSD", from_amount: 5, gas_reserved_sats: 20, gas_refunded_sats: 0, gas_settled: true },
      { from_token: "MUSD", from_amount: 5, gas_reserved_sats: 15, gas_refunded_sats: 0, gas_settled: false },
    ],
  });
  assert.deepEqual(inFlight, {
    pendingWithdrawals: 704,
    dropRemainders: 30,
    arcadeEscrow: 100,
    swapEscrow: 1_035,
    total: 1_869,
  });

  // Balances alone look covered; counting what is in flight shows the gap.
  const userBalances = 10_000n;
  const treasury = 11_500n;
  assert.equal(satsExitAllowed(treasury, userBalances, 1_000n), true);
  assert.equal(satsExitAllowed(treasury, userBalances + BigInt(inFlight.total), 1_000n), false);
});

test("only server-side rejections count as definite database failures", () => {
  // PostgREST / Postgres answered: the statement's transaction rolled back.
  for (const code of ["PGRST202", "PGRST116", "P0001", "23505", "42883", "57014", "40001", "XX000", CREDIT_NOT_ATTEMPTED_CODE]) {
    assert.equal(isDefiniteDbFailure({ code, message: "x" }), true, code);
  }
  // postgrest-js fetch failures carry code "", gateway pages carry no code,
  // and connection exceptions can surface after a commit: all ambiguous.
  for (const error of [
    { code: "", message: "TypeError: fetch failed" },
    { message: "<html>504 Gateway Time-out</html>" },
    { code: "08006", message: "connection failure" },
    { code: "ECONNRESET" },
    { code: "EPIPE" },
    { code: 504 },
    new Error("socket hang up"),
    null,
    undefined,
  ]) {
    assert.equal(isDefiniteDbFailure(error), false, JSON.stringify(error));
  }
});

test("credit summaries separate delivered, failed and unconfirmed shares", () => {
  const summary = summarizeCredits([
    { discordId: "a", amount: 10, outcome: "credited" as const },
    { discordId: "b", amount: 10, outcome: "failed" as const },
    { discordId: "c", amount: 15, outcome: "unconfirmed" as const },
    { discordId: "d", amount: 5, outcome: "credited" as const },
  ]);
  assert.deepEqual(summary.credited.map((r) => r.discordId), ["a", "d"]);
  assert.deepEqual(summary.failed.map((r) => r.discordId), ["b"]);
  assert.deepEqual(summary.unconfirmed.map((r) => r.discordId), ["c"]);
  assert.equal(summary.creditedTotal, 15);
  // Only provably failed shares are refundable to the sender.
  assert.equal(summary.failedTotal, 10);
  assert.equal(summary.unconfirmedTotal, 15);
});

test("a row settled by another worker is reported by its real status", () => {
  assert.equal(settledState({ state: "already_final", currentStatus: "completed" }), "completed");
  assert.equal(settledState({ state: "already_final", currentStatus: "failed" }), "refunded");
  assert.equal(settledState({ state: "already_final", currentStatus: null }), "pending");
  assert.equal(settledState({ state: "refund_pending" }), "refund_pending");
  assert.equal(settledState({ state: "completed" }), "completed");
});
