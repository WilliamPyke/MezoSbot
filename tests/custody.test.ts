import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { DEPOSIT_FACTORY_ABI, HOT_PAYOUT_ABI, NATIVE_TOKEN } from "../src/custody/abi.js";
import { isCompromisedAddress } from "../src/custody/compromised.js";
import { cloneInitCode, depositSalt, predictForwarder, withdrawalRef } from "../src/custody/forwarder.js";
import {
  PAID_TOPIC,
  PROBE_DISCORD_ID,
  REFUND_VERIFY_SPAN_MS,
  SWEPT_TOPIC,
  anomalySetCode,
  applyPayoutProof,
  checkCustodyConfig,
  checkTopUpAllowance,
  checkUserDailyCap,
  checkV2Chain,
  checkX402Requirement,
  classifyPaidEvent,
  decodePayoutRawTx,
  describeCustodyRevert,
  describePayoutRevert,
  encodePayoutCall,
  findMatchingPaid,
  findUnrecordedNonces,
  isPayoutAnomaly,
  checkSignedNonces,
  checkX402Authorization,
  chunkRanges,
  isDeepRescanPass,
  derivedV1SweepSponsorAddress,
  rescanRange,
  retiredKeyAddresses,
  RESCAN_BLOCKS,
  nextLogRange,
  paidEventMatches,
  parsePaidLog,
  parseSweptLog,
  payoutCapacity,
  refundCheckOutcome,
  sortByChainPosition,
  sumRecentSatsWithdrawals,
  sumRecentTopUps,
  weiToSats,
  withdrawalDestinationProblem,
  type CustodyEnv,
  type PayoutExpectation,
  type RpcLog,
  type V2ChainState,
  type V2Settings,
} from "../src/custody/policy.js";
import { explainWithdrawalOutcome, type WithdrawalOutcomeReason } from "../src/depositPolicy.js";
import {
  createWatchdogCore,
  nonceCursorName,
  nonceKey,
  paidEventKey,
  paidFloorName,
  withdrawalKey,
  type PaidRow,
  type RefundCandidate,
  type RefundCheckRecord,
  type WatchdogIO,
} from "../src/custody/watchdogCore.js";
import { hmacSecret } from "../src/secrets.js";

test("the drained treasury address is recognised in any casing", () => {
  assert.equal(isCompromisedAddress("0xE05206Bd0b57f0D3382AEd6577391669c75Ce40A"), true);
  assert.equal(isCompromisedAddress(" 0xe05206bd0b57f0d3382aed6577391669c75ce40a "), true);
  assert.equal(isCompromisedAddress("0x0000000000000000000000000000000000000001"), false);
  assert.equal(isCompromisedAddress(""), false);
  assert.equal(isCompromisedAddress(null), false);
});

test("hmacSecret never returns a wallet key or a public default", () => {
  const previous = process.env.TREASURY_PRIVATE_KEY;
  const key = "0x" + "11".repeat(32);
  process.env.TREASURY_PRIVATE_KEY = key;
  try {
    assert.equal(hmacSecret("TEST_CONFIGURED", "dedicated-secret"), "dedicated-secret");

    const unset = hmacSecret("TEST_UNSET", "");
    assert.match(unset, /^[0-9a-f]{64}$/);
    assert.equal(hmacSecret("TEST_UNSET", ""), unset, "stable within a process");

    for (const reused of [key, key.slice(2), key.toUpperCase().replace("0X", "0x")]) {
      const secret = hmacSecret("TEST_REUSED", reused);
      assert.notEqual(secret.toLowerCase().replace(/^0x/, ""), key.slice(2));
    }
  } finally {
    if (previous === undefined) delete process.env.TREASURY_PRIVATE_KEY;
    else process.env.TREASURY_PRIVATE_KEY = previous;
  }
});

test("deposit salts are per-user, versioned and secret-free", () => {
  const a = depositSalt("111");
  assert.equal(a, ethers.keccak256(ethers.toUtf8Bytes("mezosbot-deposit-v2:111")));
  assert.notEqual(a, depositSalt("112"));
});

test("forwarder prediction matches the CREATE2 formula for EIP-1167 clones", () => {
  const factory = "0x00000000000000000000000000000000000000F1";
  const implementation = "0x00000000000000000000000000000000000000A1";
  const salt = depositSalt("123");
  const initCode = cloneInitCode(implementation);
  assert.equal(ethers.dataLength(initCode), 55);
  const expected = ethers.getAddress(
    "0x" + ethers.keccak256(ethers.concat(["0xff", factory, salt, ethers.keccak256(initCode)])).slice(26),
  );
  assert.equal(predictForwarder(factory, implementation, salt), expected);
});

test("withdrawal refs are unique per withdrawal id", () => {
  assert.notEqual(withdrawalRef(1), withdrawalRef(2));
  assert.equal(withdrawalRef(7), withdrawalRef(7n));
});

/* ─────────── Custody v2 pure rules ─────────── */

const KEYS = {
  treasury: "0x" + "01".repeat(32),
  operator: "0x" + "02".repeat(32),
  sweepGas: "0x" + "03".repeat(32),
  guardian: "0x" + "04".repeat(32),
  escrow: "0x" + "05".repeat(32),
  imgnai: "0x" + "06".repeat(32),
};
const addressOf = (key: string) => new ethers.Wallet(key).address.toLowerCase();
const VAULT = "0x" + "a1".repeat(20);
const FACTORY = "0x" + "f1".repeat(20);
const IMPLEMENTATION = "0x" + "e1".repeat(20);
const PAYOUT = "0x" + "b1".repeat(20);
const COMPROMISED = "0xE05206Bd0b57f0D3382AEd6577391669c75Ce40A";

function custodyEnv(overrides: Partial<CustodyEnv> = {}): CustodyEnv {
  return {
    treasuryPrivateKey: "",
    vaultAddress: VAULT,
    depositFactoryAddress: FACTORY,
    forwarderImplementation: IMPLEMENTATION,
    depositFactoryStartBlock: "1234",
    hotPayoutAddress: PAYOUT,
    payoutOperatorPrivateKey: KEYS.operator,
    payoutGuardianPrivateKey: KEYS.guardian,
    sweepGasPrivateKey: KEYS.sweepGas,
    escrowSettlerPrivateKey: KEYS.escrow,
    imgnaiPayerPrivateKey: KEYS.imgnai,
    sweepGasSponsorPrivateKey: "",
    ...overrides,
  };
}

const NO_V2: Partial<CustodyEnv> = {
  vaultAddress: "",
  depositFactoryAddress: "",
  forwarderImplementation: "",
  depositFactoryStartBlock: "",
  hotPayoutAddress: "",
  payoutOperatorPrivateKey: "",
  payoutGuardianPrivateKey: "",
  sweepGasPrivateKey: "",
};

test("mode: a complete, distinct v2 configuration is v2 with validated settings", () => {
  const check = checkCustodyConfig(custodyEnv());
  assert.equal(check.mode, "v2", check.reasons.join("; "));
  assert.ok(check.mode === "v2");
  assert.equal(check.settings.operator, addressOf(KEYS.operator));
  assert.equal(check.settings.sweepGas, addressOf(KEYS.sweepGas));
  assert.equal(check.settings.guardian, addressOf(KEYS.guardian));
  assert.equal(check.settings.vault, VAULT);
  assert.equal(check.settings.startBlock, 1234);
  // The guardian key is optional.
  const noGuardian = checkCustodyConfig(custodyEnv({ payoutGuardianPrivateKey: "" }));
  assert.ok(noGuardian.mode === "v2" && noGuardian.settings.guardian === null);
  // A compromised legacy treasury key does not block v2: v2 never signs with it.
  assert.equal(checkCustodyConfig(custodyEnv({ treasuryPrivateKey: KEYS.treasury })).mode, "v2");
});

test("mode: without v2 settings an uncompromised treasury key is legacy, otherwise paused", () => {
  const legacy = checkCustodyConfig(custodyEnv({ ...NO_V2, treasuryPrivateKey: KEYS.treasury }));
  assert.ok(legacy.mode === "legacy");
  assert.equal(legacy.treasury, addressOf(KEYS.treasury));

  const none = checkCustodyConfig(custodyEnv({ ...NO_V2 }));
  assert.equal(none.mode, "paused");
  assert.match(none.reasons[0], /TREASURY_PRIVATE_KEY is not set/);

  assert.deepEqual(checkCustodyConfig(custodyEnv({ ...NO_V2, treasuryPrivateKey: "0x1234" })).reasons, [
    "TREASURY_PRIVATE_KEY is not a valid private key",
  ]);
});

test("mode: a compromised treasury key never runs legacy, and compromised role keys pause v2", () => {
  const flagged = (bad: string) => (address: string) => address.toLowerCase() === addressOf(bad);
  const legacy = checkCustodyConfig(custodyEnv({ ...NO_V2, treasuryPrivateKey: KEYS.treasury }), flagged(KEYS.treasury));
  assert.equal(legacy.mode, "paused");
  assert.match(legacy.reasons[0], /TREASURY_PRIVATE_KEY belongs to compromised address/);
  const operator = checkCustodyConfig(custodyEnv(), flagged(KEYS.operator));
  assert.equal(operator.mode, "paused");
  assert.ok(operator.reasons.includes("PAYOUT_OPERATOR_PRIVATE_KEY is a known-compromised address"));
});

test("mode: any partial v2 configuration is paused and names what is missing", () => {
  const check = checkCustodyConfig(custodyEnv({ hotPayoutAddress: "", depositFactoryStartBlock: "" }));
  assert.equal(check.mode, "paused");
  assert.ok(check.reasons.includes("HOT_PAYOUT_ADDRESS is not set"));
  assert.ok(check.reasons.includes("DEPOSIT_FACTORY_START_BLOCK is not set"));
  // Only a guardian key set still counts as asking for v2.
  assert.equal(checkCustodyConfig(custodyEnv({ ...NO_V2, payoutGuardianPrivateKey: KEYS.guardian, treasuryPrivateKey: KEYS.treasury })).mode, "paused");
});

test("mode: invalid values pause without echoing secrets", () => {
  const check = checkCustodyConfig(custodyEnv({
    vaultAddress: "vault",
    payoutOperatorPrivateKey: "0xdeadbeef",
    depositFactoryStartBlock: "-5",
  }));
  assert.equal(check.mode, "paused");
  assert.ok(check.reasons.includes("VAULT_ADDRESS is not a valid address"));
  assert.ok(check.reasons.includes("PAYOUT_OPERATOR_PRIVATE_KEY is not a valid private key"));
  assert.ok(check.reasons.includes("DEPOSIT_FACTORY_START_BLOCK is not a block number"));
  assert.ok(check.reasons.every((reason) => !reason.includes("deadbeef")));
  assert.equal(checkCustodyConfig(custodyEnv({ vaultAddress: ethers.ZeroAddress })).mode, "paused");
});

test("mode: role keys must be distinct from each other and from other server keys", () => {
  const shared = checkCustodyConfig(custodyEnv({ sweepGasPrivateKey: KEYS.operator }));
  assert.equal(shared.mode, "paused");
  assert.ok(shared.reasons.includes("PAYOUT_OPERATOR_PRIVATE_KEY and SWEEP_GAS_PRIVATE_KEY must be different keys"));

  const guardian = checkCustodyConfig(custodyEnv({ payoutGuardianPrivateKey: KEYS.sweepGas }));
  assert.ok(guardian.reasons.includes("SWEEP_GAS_PRIVATE_KEY and PAYOUT_GUARDIAN_PRIVATE_KEY must be different keys"));

  const escrow = checkCustodyConfig(custodyEnv({ escrowSettlerPrivateKey: KEYS.operator }));
  assert.ok(escrow.reasons.includes("PAYOUT_OPERATOR_PRIVATE_KEY must not reuse ESCROW_SETTLER_PRIVATE_KEY"));

  const imgnai = checkCustodyConfig(custodyEnv({ imgnaiPayerPrivateKey: KEYS.sweepGas }));
  assert.ok(imgnai.reasons.includes("SWEEP_GAS_PRIVATE_KEY must not reuse IMGNAI_PAYER_PRIVATE_KEY"));

  const treasury = checkCustodyConfig(custodyEnv({ treasuryPrivateKey: KEYS.guardian }));
  assert.ok(treasury.reasons.includes("PAYOUT_GUARDIAN_PRIVATE_KEY must not reuse TREASURY_PRIVATE_KEY"));
});

test("mode: the vault must be cold, distinct and uncompromised", () => {
  const hot = checkCustodyConfig(custodyEnv({ vaultAddress: addressOf(KEYS.operator) }));
  assert.ok(hot.reasons.includes("VAULT_ADDRESS must be a cold wallet, not the address of PAYOUT_OPERATOR_PRIVATE_KEY"));
  const payer = checkCustodyConfig(custodyEnv({ vaultAddress: addressOf(KEYS.imgnai) }));
  assert.ok(payer.reasons.includes("VAULT_ADDRESS must be a cold wallet, not the address of IMGNAI_PAYER_PRIVATE_KEY"));
  const compromised = checkCustodyConfig(custodyEnv({ vaultAddress: COMPROMISED }));
  assert.ok(compromised.reasons.includes("VAULT_ADDRESS is a known-compromised address"));
  const sameAsPayout = checkCustodyConfig(custodyEnv({ vaultAddress: PAYOUT }));
  assert.ok(sameAsPayout.reasons.includes("VAULT_ADDRESS and HOT_PAYOUT_ADDRESS must be different addresses"));
});

function goodChain(settings: V2Settings): V2ChainState {
  return {
    chainId: 31612,
    factoryCode: "0x6001",
    implementationCode: "0x6002",
    payoutCode: "0x6003",
    factoryVault: settings.vault.toUpperCase().replace("0X", "0x"),
    factoryImplementation: settings.implementation,
    factoryPredict: predictForwarder(settings.factory, settings.implementation, depositSalt(PROBE_DISCORD_ID)),
    payoutVault: settings.vault,
    payoutOperator: ethers.getAddress(settings.operator),
    payoutGuardian: settings.guardian ?? "",
  };
}

function v2Settings(): V2Settings {
  const check = checkCustodyConfig(custodyEnv());
  assert.ok(check.mode === "v2");
  return check.settings;
}

test("boot chain check: matching contracts pass in any address casing", () => {
  const settings = v2Settings();
  assert.deepEqual(checkV2Chain(settings, goodChain(settings), 31612), []);
});

test("boot chain check: every mismatch is reported", () => {
  const settings = v2Settings();
  const state = {
    ...goodChain(settings),
    chainId: 1,
    payoutCode: "0x",
    factoryVault: "0x" + "99".repeat(20),
    factoryImplementation: "",
    factoryPredict: "0x" + "98".repeat(20),
    payoutOperator: addressOf(KEYS.sweepGas),
    payoutGuardian: addressOf(KEYS.operator),
  };
  const reasons = checkV2Chain(settings, state, 31612);
  assert.equal(reasons.length, 7, reasons.join("\n"));
  assert.ok(reasons.some((r) => r.startsWith("RPC chain id 1")));
  assert.ok(reasons.some((r) => r.startsWith("HOT_PAYOUT_ADDRESS") && r.endsWith("has no contract code")));
  assert.ok(reasons.some((r) => r.startsWith("DepositFactory.vault()")));
  assert.ok(reasons.some((r) => r.startsWith("DepositFactory.implementation() is unreadable")));
  assert.ok(reasons.some((r) => r.startsWith("HotPayout.operator()")));
  assert.ok(reasons.some((r) => r.startsWith("HotPayout.guardian()")));
  assert.ok(reasons.some((r) => r.includes("predict() does not match")));
  // Without a guardian key the on-chain guardian is not compared.
  const noGuardian = { ...settings, guardian: null, guardianKey: null };
  assert.deepEqual(checkV2Chain(noGuardian, { ...goodChain(settings), payoutGuardian: "0x" + "77".repeat(20) }, 31612), []);
});

const FACTORY_IFACE = new ethers.Interface(DEPOSIT_FACTORY_ABI);
const PAYOUT_IFACE = new ethers.Interface(HOT_PAYOUT_ABI);
const hash = (n: number) => "0x" + n.toString(16).padStart(64, "0");

function sweptLog(fields: { salt: string; token: string; amount: bigint; vault: string }, at: { block: number; index: number; tx?: string }, emitter = FACTORY): RpcLog {
  const encoded = FACTORY_IFACE.encodeEventLog("Swept", [fields.salt, fields.token, fields.amount, fields.vault]);
  return {
    address: emitter,
    topics: encoded.topics,
    data: encoded.data,
    blockNumber: `0x${at.block.toString(16)}`,
    logIndex: `0x${at.index.toString(16)}`,
    transactionHash: at.tx ?? hash(at.block * 100 + at.index),
  };
}

function paidLog(fields: PayoutExpectation, at: { block: number; index: number }, emitter = PAYOUT): RpcLog {
  const encoded = PAYOUT_IFACE.encodeEventLog("Paid", [fields.ref, fields.token, fields.to, fields.amount]);
  return {
    address: emitter,
    topics: encoded.topics,
    data: encoded.data,
    blockNumber: `0x${at.block.toString(16)}`,
    logIndex: `0x${at.index.toString(16)}`,
    transactionHash: hash(at.block * 100 + at.index),
  };
}

test("Swept logs: parsed from the configured factory only", () => {
  const salt = depositSalt("42");
  const log = sweptLog({ salt, token: NATIVE_TOKEN, amount: 5n * 10n ** 13n, vault: VAULT }, { block: 10, index: 3 });
  const event = parseSweptLog(log, FACTORY.toUpperCase().replace("0X", "0x"));
  assert.ok(event);
  assert.equal(event.salt, salt.toLowerCase());
  assert.equal(event.token, NATIVE_TOKEN);
  assert.equal(event.vault, VAULT);
  assert.equal(event.amount, 5n * 10n ** 13n);
  assert.equal(event.blockNumber, 10);
  assert.equal(event.logIndex, 3);
  assert.equal(SWEPT_TOPIC, log.topics![0].toLowerCase());

  assert.equal(parseSweptLog({ ...log, address: "0x" + "12".repeat(20) }, FACTORY), null, "other emitter");
  assert.equal(parseSweptLog({ ...log, removed: true }, FACTORY), null, "removed (reorged) log");
  assert.equal(parseSweptLog({ ...log, topics: [PAID_TOPIC, ...log.topics!.slice(1)] }, FACTORY), null, "other event");
  assert.equal(parseSweptLog({ ...log, transactionHash: null }, FACTORY), null, "no position");
  assert.equal(parseSweptLog({ ...log, data: "0x" }, FACTORY), null, "malformed data");
});

test("Swept events are processed in chain order", () => {
  const salt = depositSalt("1");
  const events = [
    sweptLog({ salt, token: NATIVE_TOKEN, amount: 1n, vault: VAULT }, { block: 12, index: 0 }),
    sweptLog({ salt, token: NATIVE_TOKEN, amount: 2n, vault: VAULT }, { block: 11, index: 5 }),
    sweptLog({ salt, token: NATIVE_TOKEN, amount: 3n, vault: VAULT }, { block: 11, index: 2 }),
  ].map((log) => parseSweptLog(log, FACTORY)!);
  assert.deepEqual(sortByChainPosition(events).map((e) => e.amount), [3n, 2n, 1n]);
});

test("log cursor: bounded chunks that stop DEPOSIT_CONFIRMATIONS behind the head", () => {
  assert.deepEqual(nextLogRange(99, 1000, 2, 100), { from: 100, to: 199 });
  assert.deepEqual(nextLogRange(950, 1000, 2, 100), { from: 951, to: 998 });
  assert.equal(nextLogRange(998, 1000, 2, 100), null, "caught up to the safe head");
  assert.equal(nextLogRange(1000, 1000, 0, 100), null);
  assert.deepEqual(nextLogRange(1000, 1001, 0, 100), { from: 1001, to: 1001 });
  assert.deepEqual(nextLogRange(0, 10, 0, 0), { from: 1, to: 1 }, "chunk is at least one block");
  // A fresh cursor starts at the start block (stored as start - 1).
  assert.deepEqual(nextLogRange(1233, 5000, 2, 2000), { from: 1234, to: 3233 });
  // Walking the cursor covers every block exactly once.
  let cursor = 9;
  const seen: number[] = [];
  for (let range = nextLogRange(cursor, 57, 3, 7); range; range = nextLogRange(cursor, 57, 3, 7)) {
    for (let block = range.from; block <= range.to; block++) seen.push(block);
    cursor = range.to;
  }
  assert.deepEqual(seen, Array.from({ length: 45 }, (_, i) => 10 + i));
});

test("Paid logs: a completion needs ref, token, recipient and amount to match", () => {
  const expected: PayoutExpectation = {
    ref: withdrawalRef(7),
    token: NATIVE_TOKEN,
    to: "0x" + "c1".repeat(20),
    amount: 123n,
  };
  const good = paidLog(expected, { block: 5, index: 1 });
  const event = parsePaidLog(good, PAYOUT)!;
  assert.ok(paidEventMatches(event, expected));
  assert.ok(findMatchingPaid([good], PAYOUT, expected));
  assert.equal(findMatchingPaid([good], "0x" + "b2".repeat(20), expected), null, "wrong emitter");
  for (const change of [
    { amount: 124n },
    { to: "0x" + "c2".repeat(20) },
    { token: "0x" + "d1".repeat(20) },
    { ref: withdrawalRef(8) },
  ]) {
    const other = paidLog({ ...expected, ...change }, { block: 5, index: 1 });
    assert.equal(findMatchingPaid([other], PAYOUT, expected), null, JSON.stringify(change, (_k, v) => typeof v === "bigint" ? String(v) : v));
  }
  // A receipt with unrelated logs plus the right one still matches.
  const swept = sweptLog({ salt: depositSalt("x"), token: NATIVE_TOKEN, amount: 1n, vault: VAULT }, { block: 5, index: 0 });
  assert.ok(findMatchingPaid([swept, good], PAYOUT, expected));
});

const base = (outcome: "completed" | "refund" | "pending", reason: WithdrawalOutcomeReason) => ({ outcome, reason });

test("payout proof: status 1 completes only with the matching Paid log", () => {
  assert.deepEqual(applyPayoutProof(base("completed", "confirmed"), { receiptMatch: true, paidOnChain: null, paidLog: null }),
    { outcome: "completed", reason: "confirmed" });
  assert.deepEqual(applyPayoutProof(base("completed", "confirmed"), { receiptMatch: false, paidOnChain: null, paidLog: null }),
    { outcome: "pending", reason: "payout_unproven" });
});

test("payout proof: refunds need paid(ref) to read false", () => {
  for (const reason of ["reverted", "dropped", "never_broadcast"] as const) {
    assert.deepEqual(applyPayoutProof(base("refund", reason), { receiptMatch: null, paidOnChain: false, paidLog: null }),
      { outcome: "refund", reason });
    assert.deepEqual(applyPayoutProof(base("refund", reason), { receiptMatch: null, paidOnChain: null, paidLog: null }),
      { outcome: "pending", reason: "lookup_failed" });
    assert.deepEqual(applyPayoutProof(base("refund", reason), { receiptMatch: null, paidOnChain: true, paidLog: "not_found" }),
      { outcome: "pending", reason: "payout_unproven" });
  }
});

test("payout proof: a paid ref completes from its Paid log even when our hash dropped", () => {
  assert.deepEqual(applyPayoutProof(base("refund", "dropped"), { receiptMatch: null, paidOnChain: true, paidLog: "match" }),
    { outcome: "completed", reason: "paid_on_chain" });
  assert.deepEqual(applyPayoutProof(base("pending", "awaiting_receipt"), { receiptMatch: null, paidOnChain: true, paidLog: "match" }),
    { outcome: "completed", reason: "paid_on_chain" });
  assert.deepEqual(applyPayoutProof(base("pending", "awaiting_receipt"), { receiptMatch: null, paidOnChain: true, paidLog: "mismatch" }),
    { outcome: "pending", reason: "payout_unproven" });
  assert.deepEqual(applyPayoutProof(base("pending", "awaiting_receipt"), { receiptMatch: null, paidOnChain: false, paidLog: null }),
    { outcome: "pending", reason: "awaiting_receipt" });
});

test("withdrawal verdict applies payout proof when present", () => {
  const observation = {
    broadcast: true, receipt: { status: "0x1" }, txMined: true, txNonce: 1, minedNonce: 2, signedAgeMs: 10 * 60_000,
  };
  assert.equal(explainWithdrawalOutcome(observation).outcome, "completed", "treasury rows keep today's rule");
  assert.deepEqual(explainWithdrawalOutcome({ ...observation, payout: { receiptMatch: false, paidOnChain: null, paidLog: null } }),
    { outcome: "pending", reason: "payout_unproven" });
  const dropped = { broadcast: true, receipt: null, txMined: false, txNonce: 1, minedNonce: 2, signedAgeMs: 10 * 60_000 };
  assert.equal(explainWithdrawalOutcome(dropped).outcome, "refund");
  assert.equal(explainWithdrawalOutcome({ ...dropped, payout: { receiptMatch: null, paidOnChain: true, paidLog: "match" } }).outcome, "completed");
});

test("payout calls round-trip through the stored signed transaction", async () => {
  const operator = new ethers.Wallet(KEYS.operator);
  const native: PayoutExpectation = { ref: withdrawalRef(9).toLowerCase(), token: NATIVE_TOKEN, to: "0x" + "c3".repeat(20), amount: 10n ** 15n };
  const token: PayoutExpectation = { ref: withdrawalRef(10).toLowerCase(), token: "0x" + "d4".repeat(20), to: "0x" + "c4".repeat(20), amount: 42n };
  for (const expected of [native, token]) {
    const raw = await operator.signTransaction({ to: PAYOUT, data: encodePayoutCall(expected), gasLimit: 100000n, gasPrice: 1n, nonce: 3, chainId: 31612, type: 0 });
    assert.deepEqual(decodePayoutRawTx(raw, PAYOUT), expected);
    assert.equal(decodePayoutRawTx(raw, "0x" + "b9".repeat(20)), null, "signed to another contract");
  }
  const transfer = await operator.signTransaction({ to: PAYOUT, value: 1n, gasLimit: 21000n, gasPrice: 1n, nonce: 4, chainId: 31612, type: 0 });
  assert.equal(decodePayoutRawTx(transfer, PAYOUT), null, "not a payout call");
  assert.equal(decodePayoutRawTx(null, PAYOUT), null);
});

test("watchdog: Paid events must match a pending/completed row's signed call in its own tx", async () => {
  const operator = new ethers.Wallet(KEYS.operator);
  const expected: PayoutExpectation = { ref: withdrawalRef(11).toLowerCase(), token: NATIVE_TOKEN, to: "0x" + "c5".repeat(20), amount: 500n };
  const raw = await operator.signTransaction({ to: PAYOUT, data: encodePayoutCall(expected), gasLimit: 100000n, gasPrice: 1n, nonce: 0, chainId: 31612, type: 0 });
  const event = parsePaidLog(paidLog(expected, { block: 9, index: 0 }), PAYOUT)!;
  const row = { raw_tx: raw, status: "pending", tx_hash: event.txHash.toUpperCase().replace("0X", "0x") };
  assert.equal(classifyPaidEvent(event, row, PAYOUT), "ok");
  assert.equal(classifyPaidEvent(event, { ...row, status: "completed" }, PAYOUT), "ok", "its own completion");
  assert.equal(classifyPaidEvent(event, null, PAYOUT), "unknown_ref");
  assert.equal(classifyPaidEvent(event, { ...row, raw_tx: null }, PAYOUT), "mismatch");
  const other = parsePaidLog(paidLog({ ...expected, to: "0x" + "c6".repeat(20) }, { block: 9, index: 1 }), PAYOUT)!;
  assert.equal(classifyPaidEvent(other, row, PAYOUT), "mismatch");
});

test("watchdog: a refunded row that is later paid, or a Paid in a foreign tx, freezes", async () => {
  const operator = new ethers.Wallet(KEYS.operator);
  const expected: PayoutExpectation = { ref: withdrawalRef(12).toLowerCase(), token: NATIVE_TOKEN, to: "0x" + "c9".repeat(20), amount: 700n };
  const raw = await operator.signTransaction({ to: PAYOUT, data: encodePayoutCall(expected), gasLimit: 100000n, gasPrice: 1n, nonce: 1, chainId: 31612, type: 0 });
  const event = parsePaidLog(paidLog(expected, { block: 40, index: 0 }), PAYOUT)!;
  // Refunded ('failed') and then paid anyway: a double payout.
  assert.equal(classifyPaidEvent(event, { raw_tx: raw, status: "failed", tx_hash: event.txHash }, PAYOUT), "not_pending");
  // The exact signed call, but mined in a transaction other than the recorded one.
  assert.equal(classifyPaidEvent(event, { raw_tx: raw, status: "pending", tx_hash: hash(999) }, PAYOUT), "foreign_tx");
  assert.equal(classifyPaidEvent(event, { raw_tx: raw, status: "pending", tx_hash: null }, PAYOUT), "foreign_tx");
  // The withdrawal path treats a matching Paid outside the row's own tx as unproven.
  const verdict = applyPayoutProof(base("refund", "dropped"), { receiptMatch: null, paidOnChain: true, paidLog: "foreign" });
  assert.deepEqual(verdict, { outcome: "pending", reason: "payout_unproven" });
  assert.equal(isPayoutAnomaly(verdict), true);
});

test("watchdog nonces: recorded, mined and owned by the bot, from nonce 0", () => {
  const h = (n: number) => hash(5000 + n);
  const records = [
    { nonce: 0, txHash: h(0) },
    { nonce: 1, txHash: h(1) },
    { nonce: 1, txHash: h(11) }, // re-signed nonce: history kept
    { nonce: 2, txHash: h(2) },
  ];
  const mined = new Map<string, boolean | null>([[h(0), true], [h(1), false], [h(11), true], [h(2), true]]);
  assert.deepEqual(checkSignedNonces(0, 3, records, mined), { unrecorded: [], displaced: [], unknown: [] });
  // Another transaction took nonce 2: our recorded tx has no receipt.
  const displaced = new Map(mined).set(h(2), false);
  assert.deepEqual(checkSignedNonces(0, 3, records, displaced).displaced, [2]);
  // An unreadable receipt is not a verdict yet.
  const unknown = new Map(mined).set(h(2), null);
  assert.deepEqual(checkSignedNonces(0, 3, records, unknown).unknown, [2]);
  // A key used before custody started: nonce 0 was never recorded.
  assert.deepEqual(checkSignedNonces(0, 4, records.slice(1), mined).unrecorded, [0, 3]);
  assert.deepEqual(checkSignedNonces(3, 3, [], new Map()), { unrecorded: [], displaced: [], unknown: [] });
});

test("log scanners re-read a short trailing window", () => {
  assert.deepEqual(rescanRange(100, 0, 32), { from: 69, to: 100 });
  assert.deepEqual(rescanRange(10, 5, 32), { from: 5, to: 10 });
  assert.equal(rescanRange(4, 5, 32), null, "nothing processed yet");
  assert.equal(RESCAN_BLOCKS > 0, true);
});

test("retired v1 keys: the derived sponsor and SWEEP_GAS_SPONSOR_PRIVATE_KEY are compromised under v2", () => {
  const sponsorKey = "0x" + "07".repeat(32);
  const derived = derivedV1SweepSponsorAddress(KEYS.treasury)!;
  assert.equal(derived, addressOf(ethers.keccak256(ethers.toUtf8Bytes(`mezosbot-sweep-gas-sponsor-v1:${KEYS.treasury}`))));
  // v2 with the old key still set: treasury, derived sponsor and the sponsor key are all retired.
  assert.deepEqual(
    retiredKeyAddresses(custodyEnv({ treasuryPrivateKey: KEYS.treasury, sweepGasSponsorPrivateKey: sponsorKey })).sort(),
    [addressOf(KEYS.treasury), derived, addressOf(sponsorKey)].sort(),
  );
  // Legacy with a healthy key: nothing retired. Legacy with a compromised key: retired.
  const legacy = custodyEnv({ ...NO_V2, treasuryPrivateKey: KEYS.treasury, sweepGasSponsorPrivateKey: sponsorKey });
  assert.deepEqual(retiredKeyAddresses(legacy), []);
  assert.equal(retiredKeyAddresses(legacy, (a) => a === addressOf(KEYS.treasury)).length, 3);
  // A role key may not be one of them.
  const reuse = checkCustodyConfig(custodyEnv({ treasuryPrivateKey: KEYS.treasury, sweepGasSponsorPrivateKey: KEYS.sweepGas }));
  assert.ok(reuse.reasons.includes("SWEEP_GAS_PRIVATE_KEY must not reuse SWEEP_GAS_SPONSOR_PRIVATE_KEY"), reuse.reasons.join("; "));
  const derivedKey = ethers.keccak256(ethers.toUtf8Bytes(`mezosbot-sweep-gas-sponsor-v1:${KEYS.treasury}`));
  const derivedRole = checkCustodyConfig(custodyEnv({ treasuryPrivateKey: KEYS.treasury, payoutOperatorPrivateKey: derivedKey }));
  assert.ok(derivedRole.reasons.includes("PAYOUT_OPERATOR_PRIVATE_KEY must not reuse the v1 sweep sponsor derived from TREASURY_PRIVATE_KEY"));
});

test("mode: a compromised or retired imgnAI payer key pauses v2", () => {
  const compromised = checkCustodyConfig(custodyEnv(), (a) => a === addressOf(KEYS.imgnai));
  assert.ok(compromised.reasons.includes("IMGNAI_PAYER_PRIVATE_KEY is a known-compromised address"));
  const reusedTreasury = checkCustodyConfig(custodyEnv({ treasuryPrivateKey: KEYS.imgnai }));
  assert.ok(reusedTreasury.reasons.includes("IMGNAI_PAYER_PRIVATE_KEY must not reuse TREASURY_PRIVATE_KEY"));
});

test("imgnAI x402: only an exact MUSD TransferWithAuthorization within the top-up is signed", () => {
  const MUSD = "0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186";
  const payerAddress = addressOf(KEYS.imgnai);
  const allowed = { chainId: 31612, asset: MUSD, from: payerAddress, maxAmount: 10n ** 18n };
  const typed = {
    domain: { name: "Mezo USD", version: "1", chainId: 31612, verifyingContract: MUSD },
    primaryType: "TransferWithAuthorization",
    message: { from: ethers.getAddress(payerAddress), to: "0x" + "12".repeat(20), value: 10n ** 18n, validAfter: 0n, validBefore: 1n, nonce: "0x" + "00".repeat(32) },
  };
  assert.equal(checkX402Authorization(typed, allowed), null);
  assert.match(checkX402Authorization({ ...typed, primaryType: "Permit" }, allowed)!, /Permit/);
  assert.match(checkX402Authorization({ ...typed, primaryType: "PermitWitnessTransferFrom" }, allowed)!, /refusing/);
  assert.match(checkX402Authorization({ ...typed, message: { ...typed.message, value: 10n ** 18n + 1n } }, allowed)!, /outside/);
  assert.match(checkX402Authorization({ ...typed, domain: { ...typed.domain, verifyingContract: "0x" + "33".repeat(20) } }, allowed)!, /MUSD/);
  assert.match(checkX402Authorization({ ...typed, domain: { ...typed.domain, chainId: 8453 } }, allowed)!, /chain/);
  assert.match(checkX402Authorization({ ...typed, message: { ...typed.message, from: "0x" + "44".repeat(20) } }, allowed)!, /payer/);
  assert.match(checkX402Authorization(typed, { ...allowed, maxAmount: null })!, /no imgnAI top-up/);
  // The requirement screen refuses Permit2 before anything is signed.
  const req = { network: "eip155:31612", asset: MUSD, amount: "1", extra: { assetTransferMethod: "permit2" } };
  assert.match(checkX402Requirement(req, { network: "eip155:31612", asset: MUSD, maxAmount: 1n })!, /permit2/);
  assert.equal(checkX402Requirement({ ...req, extra: { assetTransferMethod: "eip3009" } }, { network: "eip155:31612", asset: MUSD, maxAmount: 1n }), null);
});

test("watchdog: any consumed nonce without a record is reported", () => {
  assert.deepEqual(findUnrecordedNonces(5, 5, []), []);
  assert.deepEqual(findUnrecordedNonces(5, 8, [5, 6, 7]), []);
  assert.deepEqual(findUnrecordedNonces(5, 9, [5, 7]), [6, 8]);
  assert.deepEqual(findUnrecordedNonces(0, 3, [0, 1, 2, 3, 4]), [], "records ahead of the chain are fine");
  assert.deepEqual(findUnrecordedNonces(0, 1000, [], 3), [0, 1, 2], "bounded");
});

test("per-user daily cap counts pending and completed SATS withdrawals of the last 24h", () => {
  const now = Date.parse("2026-10-10T12:00:00Z");
  const hoursAgo = (h: number) => new Date(now - h * 3_600_000).toISOString();
  const rows = [
    { amount_sats: 50_000, token: "SATS", status: "completed", created_at: hoursAgo(1) },
    { amount_sats: 30_000, token: "SATS", status: "pending", created_at: hoursAgo(5) },
    { amount_sats: 90_000, token: "SATS", status: "failed", created_at: hoursAgo(2) },
    { amount_sats: 70_000, token: "SATS", status: "completed", created_at: hoursAgo(25) },
    { amount_sats: 10, token: "MUSD", status: "completed", created_at: hoursAgo(1) },
    { amount_sats: 5_000, token: null, status: "completed", created_at: hoursAgo(23.9) },
  ];
  const used = sumRecentSatsWithdrawals(rows, now);
  assert.equal(used, 85_000);
  assert.deepEqual(checkUserDailyCap(used, 115_000, 200_000), { ok: true, remainingSats: 115_000 });
  assert.deepEqual(checkUserDailyCap(used, 115_001, 200_000), { ok: false, remainingSats: 115_000 });
  assert.equal(checkUserDailyCap(500_000, 1_000_000, 0).ok, true, "0 disables the cap");
  assert.equal(checkUserDailyCap(250_000, 1, 200_000).remainingSats, 0);
});

test("imgnAI: per top-up and rolling 24h caps", () => {
  const now = Date.parse("2026-10-10T12:00:00Z");
  const musd = (v: string) => ethers.parseUnits(v, 18);
  const hoursAgo = (h: number) => new Date(now - h * 3_600_000).toISOString();
  const rows = [
    { amount_musd_atomic: musd("4").toString(), status: "completed", response: {}, created_at: hoursAgo(1) },
    { amount_musd_atomic: musd("3").toString(), status: "pending", response: {}, created_at: hoursAgo(2) },
    { amount_musd_atomic: musd("2").toString(), status: "failed", response: { payment_signed: true }, created_at: hoursAgo(3) },
    { amount_musd_atomic: musd("9").toString(), status: "failed", response: { payment_signed: false }, created_at: hoursAgo(3) },
    { amount_musd_atomic: musd("8").toString(), status: "completed", response: {}, created_at: hoursAgo(30) },
  ];
  const used = sumRecentTopUps(rows, now);
  assert.equal(used, musd("9"), "failed-before-signing and old rows do not count");
  const limits = { maxPerTopUp: musd("5"), dailyMax: musd("20"), usedToday: used };
  assert.deepEqual(checkTopUpAllowance({ ...limits, amount: musd("5") }), { ok: true });
  assert.equal(checkTopUpAllowance({ ...limits, amount: musd("5.000000000000000001") }).ok, false);
  assert.equal(checkTopUpAllowance({ ...limits, amount: musd("5"), usedToday: musd("15.5") }).ok, false);
  assert.equal(checkTopUpAllowance({ ...limits, amount: 0n }).ok, false);
});

test("imgnAI: x402 requirements are screened before signing", () => {
  const MUSD = "0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186";
  const allowed = { network: "eip155:31612", asset: MUSD, maxAmount: 10n ** 18n };
  const req = { network: "eip155:31612", asset: MUSD.toLowerCase(), amount: (10n ** 18n).toString() };
  assert.equal(checkX402Requirement(req, allowed), null);
  assert.match(checkX402Requirement({ ...req, network: "eip155:8453" }, allowed)!, /network/);
  assert.match(checkX402Requirement({ ...req, asset: "0x" + "11".repeat(20) }, allowed)!, /asset/);
  assert.match(checkX402Requirement({ ...req, amount: (10n ** 18n + 1n).toString() }, allowed)!, /exceeds/);
  assert.match(checkX402Requirement({ ...req, amount: "1e18" }, allowed)!, /integer/);
  assert.match(checkX402Requirement({ network: "base", asset: MUSD, amount: "1" }, allowed)!, /network/, "x402 v1 shapes are refused");
});

test("HotPayout reverts map to clear user messages", () => {
  const data = (name: string) => PAYOUT_IFACE.encodeErrorResult(name, []);
  assert.equal(describePayoutRevert(data("DailyCapExceeded")).error, "DailyCapExceeded");
  assert.match(describePayoutRevert(data("DailyCapExceeded")).message, /daily withdrawal limit/);
  assert.match(describePayoutRevert(data("EnforcedPause")).message, /paused/);
  assert.match(describePayoutRevert(data("BadRecipient")).message, /cannot receive/);
  assert.equal(describePayoutRevert(data("AlreadyPaid")).error, "AlreadyPaid");
  assert.equal(describePayoutRevert("0x12345678").error, null);
  assert.equal(describePayoutRevert(undefined).error, null);
});

test("payout capacity is the smallest of per-tx cap, remaining daily and float", () => {
  const state = { paused: false, allowed: true, perTxCap: 100n, remainingDaily: 70n, float: 90n };
  assert.equal(payoutCapacity(state), 70n);
  assert.equal(payoutCapacity({ ...state, float: 20n }), 20n);
  assert.equal(payoutCapacity({ ...state, paused: true }), 0n);
  assert.equal(payoutCapacity({ ...state, allowed: false }), 0n);
});

test("wei to sats matches the SQL rounding (10^10 wei per sat, 10 decimals)", () => {
  assert.equal(weiToSats(10_000_000_000n), 1);
  assert.equal(weiToSats(1n), 0.0000000001);
  assert.equal(weiToSats(15_000_000_000n), 1.5);
  assert.equal(weiToSats(123456789012345678n), Number("12345678.9012345678"));
  assert.equal(weiToSats(0n), 0);
});

test("payout anomaly: a paid ref whose Paid log differs is never completed or refunded, and freezes custody", () => {
  const ours: PayoutExpectation = { ref: withdrawalRef(21).toLowerCase(), token: NATIVE_TOKEN, to: "0x" + "c7".repeat(20), amount: 1_000n };
  // Someone holding the operator key paid our (deterministic) ref to themselves.
  const attacker = paidLog({ ...ours, to: "0x" + "ad".repeat(20) }, { block: 30, index: 0 });
  assert.equal(findMatchingPaid([attacker], PAYOUT, ours), null, "a Paid log for the ref is not enough");
  assert.equal(classifyPaidEvent(parsePaidLog(attacker, PAYOUT)!, null, PAYOUT), "unknown_ref");

  // Our own tx then reverts (AlreadyPaid): paid(ref) is true, the log search finds a mismatch.
  for (const paidLog of ["mismatch", "not_found"] as const) {
    const verdict = applyPayoutProof(base("refund", "reverted"), { receiptMatch: null, paidOnChain: true, paidLog });
    assert.deepEqual(verdict, { outcome: "pending", reason: "payout_unproven" }, paidLog);
    assert.equal(isPayoutAnomaly(verdict), true);
  }
  // A status-1 receipt whose Paid log differs from the signed call.
  const unproven = applyPayoutProof(base("completed", "confirmed"), { receiptMatch: false, paidOnChain: null, paidLog: null });
  assert.equal(isPayoutAnomaly(unproven), true);
  // An unreadable search is retried, not treated as an anomaly.
  const unknown = applyPayoutProof(base("refund", "reverted"), { receiptMatch: null, paidOnChain: true, paidLog: null });
  assert.deepEqual(unknown, { outcome: "pending", reason: "lookup_failed" });
  assert.equal(isPayoutAnomaly(unknown), false);
  // Ordinary outcomes are not anomalies.
  assert.equal(isPayoutAnomaly(applyPayoutProof(base("refund", "dropped"), { receiptMatch: null, paidOnChain: false, paidLog: null })), false);
  assert.equal(isPayoutAnomaly(applyPayoutProof(base("completed", "confirmed"), { receiptMatch: true, paidOnChain: null, paidLog: null })), false);
});

test("withdrawal destinations: deposit, custody and compromised addresses are refused", () => {
  const blocked = [
    { label: "vault", address: VAULT },
    { label: "withdrawal contract", address: PAYOUT },
    { label: "payout guardian wallet", address: null },
  ];
  const user = "0x" + "c8".repeat(20);
  assert.equal(withdrawalDestinationProblem(user, blocked, false), null);
  assert.match(withdrawalDestinationProblem(user, blocked, true)!, /deposit address/);
  assert.match(withdrawalDestinationProblem(VAULT.toUpperCase().replace("0X", "0x"), blocked, false)!, /vault/);
  assert.match(withdrawalDestinationProblem(PAYOUT, blocked, false)!, /withdrawal contract/);
  assert.match(withdrawalDestinationProblem(COMPROMISED, blocked, false)!, /not safe/);
});

test("custody reverts decode from both contracts for operator logs", () => {
  assert.match(describeCustodyRevert(FACTORY_IFACE.encodeErrorResult("TokenNotAllowed", [])), /^TokenNotAllowed: .*allowlist/);
  assert.match(describeCustodyRevert(PAYOUT_IFACE.encodeErrorResult("NotOperator", [])), /^NotOperator/);
  assert.match(describeCustodyRevert(PAYOUT_IFACE.encodeErrorResult("InsufficientFloat", [])), /^InsufficientFloat/);
  assert.equal(describeCustodyRevert("0x"), "reverted without a known custody error");
});

test("imgnAI x402: a pinned payTo must match in the requirement and the signed authorization", () => {
  const MUSD = "0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186";
  const payTo = "0x" + "5a".repeat(20);
  const req = { network: "eip155:31612", asset: MUSD, amount: "1", payTo: payTo.toUpperCase().replace("0X", "0x") };
  assert.equal(checkX402Requirement(req, { network: "eip155:31612", asset: MUSD, maxAmount: 1n, payTo }), null);
  assert.match(checkX402Requirement({ ...req, payTo: "0x" + "5b".repeat(20) }, { network: "eip155:31612", asset: MUSD, maxAmount: 1n, payTo })!, /payTo/);
  assert.equal(checkX402Requirement({ ...req, payTo: "0x" + "5b".repeat(20) }, { network: "eip155:31612", asset: MUSD, maxAmount: 1n, payTo: null }), null,
    "no pin yet: the first top-up records it");
  const typed = {
    domain: { chainId: 31612, verifyingContract: MUSD },
    primaryType: "TransferWithAuthorization",
    message: { from: addressOf(KEYS.imgnai), to: payTo, value: 1n },
  };
  const allowed = { chainId: 31612, asset: MUSD, from: addressOf(KEYS.imgnai), maxAmount: 1n, payTo };
  assert.equal(checkX402Authorization(typed, allowed), null);
  assert.match(checkX402Authorization({ ...typed, message: { ...typed.message, to: "0x" + "5c".repeat(20) } }, allowed)!, /not the expected/);
});

test("deep rescans: chunked ranges and cadence", () => {
  assert.deepEqual(chunkRanges(10, 15, 4), [{ from: 10, to: 13 }, { from: 14, to: 15 }]);
  assert.deepEqual(chunkRanges(10, 10, 2000), [{ from: 10, to: 10 }]);
  assert.deepEqual(chunkRanges(11, 10, 5), []);
  assert.deepEqual(chunkRanges(0, 4999, 2000).map((r) => r.to - r.from + 1), [2000, 2000, 1000]);
  assert.equal(isDeepRescanPass(60, 60), true);
  assert.equal(isDeepRescanPass(59, 60), false);
  assert.equal(isDeepRescanPass(120, 60), true);
  assert.equal(isDeepRescanPass(60, 0), false, "0 disables");
  // A deep pass re-reads the last N blocks behind the cursor.
  assert.deepEqual(rescanRange(10_000, 1_000, 5_000), { from: 5_001, to: 10_000 });
});

/** The watchdog core against an in-memory chain and database; freeze and unfreeze mirror watchdog.ts. */
function fakeWatchdog(options: { refundCheckBudgetMs?: number; now?: () => number } = {}) {
  const settings = v2Settings();
  const chain = {
    head: 2000,
    nonces: new Map<string, number>(),
    receipts: new Set<string>(),
    logs: [] as RpcLog[],
    paid: new Set<string>(),
    unreadable: new Set<string>(),
    paidReads: [] as string[][],
    beforeRead: null as (() => void) | null,
    hangReads: false,
  };
  const db = {
    cursors: new Map<string, number>(),
    signed: [] as Array<{ signer: string; nonce: number; txHash: string }>,
    withdrawals: new Map<string, PaidRow>(),
    refunded: [] as Array<{ id: number; payoutRef: string }>,
    refundChecks: new Map<number, RefundCheckRecord>(),
    acks: new Set<string>(),
  };
  const state = { frozen: false, reasons: [] as string[], keys: [] as string[] };
  const calls: string[] = [];
  const io: WatchdogIO = {
    getNonce: async (address) => {
      calls.push("nonce");
      return chain.nonces.get(address) ?? 0;
    },
    getReceiptExists: async (txHash) => chain.receipts.has(txHash),
    getBlockNumber: async () => chain.head,
    nodeHasBlock: async (block) => block <= chain.head,
    getPaidLogs: async (_settings, from, to) => {
      calls.push("paid");
      return chain.logs.filter((log) => {
        const block = Number(BigInt(String(log.blockNumber)));
        return block >= from && block <= to;
      });
    },
    readPaidRefs: async (_settings, refs) => {
      calls.push("refund");
      chain.paidReads.push(refs);
      chain.beforeRead?.();
      if (chain.hangReads) return new Promise<Map<string, boolean | null>>(() => {});
      return new Map(refs.map((ref) => [ref, chain.unreadable.has(ref) ? null : chain.paid.has(ref)]));
    },
    readCursor: async (name) => db.cursors.get(name) ?? null,
    writeCursor: async (name, value) => {
      db.cursors.set(name, value);
    },
    signedTxs: async (signer, from, to) =>
      db.signed.filter((tx) => tx.signer === signer && tx.nonce >= from && tx.nonce < to),
    withdrawalsForRefs: async (refs) => new Map(refs.filter((ref) => db.withdrawals.has(ref)).map((ref) => [ref, db.withdrawals.get(ref)!])),
    // Mirrors custody_refund_candidates_v1: unverified, unacknowledged, unread first, then least recently read.
    refundCandidates: async (limit) => db.refunded
      .filter((row) => !db.refundChecks.get(row.id)?.verified && !db.acks.has(withdrawalKey(row.id)))
      .sort((a, b) =>
        (db.refundChecks.get(a.id)?.lastReadAt ?? -1) - (db.refundChecks.get(b.id)?.lastReadAt ?? -1) || a.id - b.id)
      .slice(0, limit)
      .map((row): RefundCandidate => ({
        id: row.id,
        payoutRef: row.payoutRef,
        falseReads: db.refundChecks.get(row.id)?.falseReads ?? 0,
        firstFalseAt: db.refundChecks.get(row.id)?.firstFalseAt ?? null,
      })),
    recordRefundChecks: async (records) => {
      for (const record of records) db.refundChecks.set(record.id, record);
    },
    acknowledge: async (entries) => {
      for (const entry of entries) db.acks.add(entry.key);
    },
    isFrozen: () => state.frozen,
    // Mirrors freezeCustody: acknowledged keys never freeze; keys found while frozen are recorded.
    freeze: async (reason, keys = []) => {
      const fresh = keys.filter((key) => !db.acks.has(key));
      if (keys.length > 0 && fresh.length === 0) return;
      state.keys.push(...fresh.filter((key) => !state.keys.includes(key)));
      if (state.frozen) return;
      state.frozen = true;
      state.reasons.push(reason);
    },
  };
  const core = createWatchdogCore(io, {
    confirmations: 2,
    logChunkBlocks: 100,
    deepRescanPasses: 1000,
    deepRescanBlocks: 5000,
    ...options,
  });
  // Mirrors clearCustodyFreeze.
  const unfreeze = async (confirm?: string) => {
    const result = await core.acceptCurrentState(settings, "admin", "checked", state.keys, confirm);
    if (result.status === "accepted") {
      state.frozen = false;
      state.keys = [];
    }
    return result;
  };
  const strayPaid = (id: number, block: number) => paidLog(
    { ref: withdrawalRef(id).toLowerCase(), token: NATIVE_TOKEN, to: "0x" + "e1".repeat(20), amount: 1n },
    { block, index: 0 },
  );
  return { settings, chain, db, state, calls, core, unfreeze, strayPaid };
}

const refOf = (id: number) => withdrawalRef(id).toLowerCase();
const keyOfPaid = (log: RpcLog) => paidEventKey(parsePaidLog(log, PAYOUT)!);

test("watchdog: /custody unfreeze sticks through rescans, and a new anomaly re-freezes", async () => {
  const { settings, chain, db, state, core, unfreeze, strayPaid } = fakeWatchdog();

  // Clean history: nothing to freeze.
  await core.pass(settings);
  assert.equal(state.frozen, false);

  // A Paid event matching no withdrawal freezes; the refunded row whose ref reads as paid is not reached.
  chain.logs.push(strayPaid(900, 2005));
  db.refunded.push({ id: 77, payoutRef: refOf(77) });
  chain.paid.add(refOf(77));
  chain.head = 2010;
  await core.pass(settings);
  assert.equal(state.frozen, true);
  assert.match(state.reasons[0], /matches no withdrawal/);
  // Activity while frozen is not inspected by passes.
  chain.logs.push(strayPaid(902, 2008));

  // The unfreeze checks find the double-paid refund and the later Paid, which nobody was shown: code needed.
  const shown = await unfreeze();
  assert.equal(shown.status, "confirm");
  assert.equal(state.frozen, true);
  const accepted = await unfreeze(shown.code);
  assert.equal(accepted.status, "accepted");
  assert.ok(db.acks.has(withdrawalKey(77)), "the double-paid refund is acknowledged");
  assert.equal(db.cursors.get(paidFloorName(settings)), 2010);

  // The next passes, including a forced deep rescan and the refunded-ref check, stay unfrozen.
  await core.pass(settings, { forceDeepRescan: true });
  assert.equal(state.frozen, false, state.reasons.join("; "));
  chain.head = 2050;
  await core.pass(settings);
  await core.pass(settings, { forceDeepRescan: true });
  assert.equal(state.frozen, false, state.reasons.join("; "));
  assert.equal(state.reasons.length, 1);

  // A new Paid anomaly after the accepted floor re-freezes; it was recorded, so unfreezing needs no code.
  chain.logs.push(strayPaid(901, 2060));
  chain.head = 2070;
  await core.pass(settings);
  assert.equal(state.frozen, true);
  assert.equal(state.reasons.length, 2);
  assert.equal((await unfreeze()).status, "accepted");

  // A newly double-paid refund re-freezes; the acknowledged one does not.
  await core.pass(settings, { forceDeepRescan: true });
  assert.equal(state.frozen, false, state.reasons.join("; "));
  db.refunded.push({ id: 78, payoutRef: refOf(78) });
  chain.paid.add(refOf(78));
  await core.pass(settings);
  assert.equal(state.frozen, true);
  assert.match(state.reasons[2], /Withdrawal 78 was refunded/);
  assert.deepEqual(state.keys, [withdrawalKey(78)]);
  assert.equal((await unfreeze()).status, "accepted");

  // And a custody key spending a nonce the bot never signed still freezes after an unfreeze.
  await core.pass(settings, { forceDeepRescan: true });
  assert.equal(state.frozen, false, state.reasons.join("; "));
  chain.nonces.set(settings.operator, 1);
  await core.pass(settings);
  assert.equal(state.frozen, true);
  assert.match(state.reasons[3], /spent nonce\(s\) 0 that the bot never signed/);
  assert.deepEqual(state.keys, [nonceKey(settings.operator, 0)]);
  assert.equal((await unfreeze()).status, "accepted");
  await core.pass(settings);
  assert.equal(state.frozen, false, state.reasons.join("; "));
});

test("watchdog: /custody unfreeze accepts recorded anomalies, and new ones only with the code of that exact set", async () => {
  const { settings, chain, db, state, core, unfreeze, strayPaid } = fakeWatchdog();
  await core.pass(settings);

  // Path 1: every anomaly found was recorded on the freeze (and DM'd): accepted at once, listed by id.
  const first = strayPaid(910, 2005);
  chain.logs.push(first);
  chain.head = 2010;
  await core.pass(settings);
  assert.deepEqual(state.keys, [keyOfPaid(first)]);
  const clean = await unfreeze();
  assert.equal(clean.status, "accepted");
  assert.deepEqual(clean.recordedKeys, [keyOfPaid(first)]);
  assert.deepEqual(
    clean.acknowledged.map((anomaly) => [anomaly.key, anomaly.kind, anomaly.ref, anomaly.txHash, anomaly.block]),
    [[keyOfPaid(first), "paid_event", refOf(910), String(first.transactionHash), 2005]],
  );
  assert.ok(db.acks.has(keyOfPaid(first)));

  // Path 2: anomalies the freeze did not record.
  const second = strayPaid(911, 2020);
  chain.logs.push(second);
  chain.head = 2030;
  await core.pass(settings);
  assert.deepEqual(state.keys, [keyOfPaid(second)]);
  const unseen = strayPaid(912, 2025);
  chain.logs.push(unseen);
  db.refunded.push({ id: 79, payoutRef: refOf(79) });
  db.withdrawals.set(refOf(79), { id: 79, payout_ref: refOf(79), raw_tx: null, status: "failed", tx_hash: null });
  chain.paid.add(refOf(79));
  chain.nonces.set(settings.operator, 1);
  const cursors = new Map(db.cursors);
  const acks = new Set(db.acks);

  const shown = await unfreeze();
  assert.equal(shown.status, "confirm");
  if (shown.status !== "confirm") return;
  assert.deepEqual(shown.newAnomalies.map((anomaly) => anomaly.kind).sort(), ["nonce_unrecorded", "paid_event", "refunded_paid"]);
  const paid = shown.newAnomalies.find((anomaly) => anomaly.kind === "paid_event")!;
  assert.deepEqual([paid.key, paid.ref, paid.txHash, paid.block], [keyOfPaid(unseen), refOf(912), String(unseen.transactionHash), 2025]);
  const refund = shown.newAnomalies.find((anomaly) => anomaly.kind === "refunded_paid")!;
  assert.deepEqual([refund.key, refund.withdrawalId, refund.ref], [withdrawalKey(79), 79, refOf(79)]);
  assert.equal(shown.newAnomalies.find((anomaly) => anomaly.kind === "nonce_unrecorded")!.key, nonceKey(settings.operator, 0));
  assert.equal(shown.code, anomalySetCode(shown.newAnomalies.map((anomaly) => anomaly.key)));
  assert.equal(state.frozen, true);
  assert.deepEqual(db.cursors, cursors, "nothing is accepted without the code");
  assert.deepEqual(db.acks, acks);

  // A wrong code shows the same set again.
  const wrong = await unfreeze("DEADBEEF");
  assert.equal(wrong.status, "confirm");
  assert.equal(wrong.status === "confirm" && wrong.code, shown.code);

  // The set changes before the admin confirms: the old code no longer accepts anything.
  const later = strayPaid(913, 2028);
  chain.logs.push(later);
  chain.head = 2032;
  const changed = await unfreeze(shown.code);
  assert.equal(changed.status, "confirm");
  if (changed.status !== "confirm") return;
  assert.notEqual(changed.code, shown.code);
  assert.equal(changed.newAnomalies.length, 4);
  assert.deepEqual(db.cursors, cursors);
  assert.equal(state.frozen, true);

  // The code of exactly the shown set accepts it (any case, padded); every key is acknowledged.
  const done = await unfreeze(` ${changed.code.toLowerCase()} `);
  assert.equal(done.status, "accepted");
  if (done.status !== "accepted") return;
  assert.deepEqual(new Set(done.recordedKeys), new Set([keyOfPaid(second), ...changed.newAnomalies.map((anomaly) => anomaly.key)]));
  for (const key of done.recordedKeys) assert.ok(db.acks.has(key), key);
  assert.equal(db.cursors.get(paidFloorName(settings)), 2032);
  assert.equal(db.cursors.get(nonceCursorName(settings.operator)), 1);
  await core.pass(settings, { forceDeepRescan: true });
  assert.equal(state.frozen, false, state.reasons.join("; "));

  // What cannot be read is never accepted.
  state.frozen = true;
  db.refunded.push({ id: 80, payoutRef: refOf(80) });
  chain.unreadable.add(refOf(80));
  const before = new Map(db.cursors);
  await assert.rejects(unfreeze(), /could not read paid\(ref\)/);
  assert.equal(state.frozen, true);
  assert.deepEqual(db.cursors, before);
});

test("watchdog: refunded rows are re-read in batches after the nonce and Paid checks, until verified", async () => {
  let clock = 1_000_000;
  const { settings, chain, db, state, calls, core } = fakeWatchdog({ now: () => clock });
  for (let id = 100; id < 160; id++) db.refunded.push({ id, payoutRef: refOf(id) });

  await core.pass(settings);
  const firstRead = calls.indexOf("refund");
  assert.ok(firstRead > calls.lastIndexOf("nonce") && firstRead > calls.lastIndexOf("paid"), calls.join(","));
  assert.deepEqual(chain.paidReads.map((refs) => refs.length), [25, 25, 10]);

  // Three false reads within the hour do not verify a row.
  clock += 10 * 60_000;
  await core.pass(settings);
  clock += 10 * 60_000;
  await core.pass(settings);
  assert.equal(db.refundChecks.get(100)!.falseReads, 3);
  assert.equal([...db.refundChecks.values()].filter((row) => row.verified).length, 0);

  // A read an hour after the first false one verifies it; verified rows are never read again.
  clock += 40 * 60_000;
  await core.pass(settings);
  assert.equal(db.refundChecks.size, 60);
  assert.ok([...db.refundChecks.values()].every((row) => row.verified && row.falseReads === 4));
  chain.paidReads.length = 0;
  await core.pass(settings);
  assert.equal(chain.paidReads.length, 0);

  // A verified row paid later is caught by the Paid scan.
  db.withdrawals.set(refOf(100), { id: 100, payout_ref: refOf(100), raw_tx: null, status: "failed", tx_hash: null });
  chain.logs.push(paidLog({ ref: refOf(100), token: NATIVE_TOKEN, to: "0x" + "e2".repeat(20), amount: 1n }, { block: 2005, index: 0 }));
  chain.head = 2010;
  await core.pass(settings);
  assert.equal(state.frozen, true);
  assert.match(state.reasons[0], /already refunded/);
  assert.equal(chain.paidReads.length, 0);
});

test("watchdog: refund re-check failures are counted and logged, a paid ref freezes, and the budget bounds it", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const warned = () => warn.mock.calls.map((call) => String(call.arguments[0]));

  const a = fakeWatchdog();
  a.db.refunded.push({ id: 200, payoutRef: refOf(200) }, { id: 201, payoutRef: refOf(201) }, { id: 202, payoutRef: refOf(202) });
  a.chain.unreadable.add(refOf(200));
  a.chain.paid.add(refOf(201));
  await a.core.pass(a.settings);
  assert.equal(a.state.frozen, true);
  assert.match(a.state.reasons[0], /Withdrawal 201 was refunded/);
  assert.deepEqual(a.state.keys, [withdrawalKey(201)]);
  assert.equal(a.db.refundChecks.get(200)!.falseReads, 0, "a failed read is not a false read");
  assert.equal(a.db.refundChecks.get(202)!.falseReads, 1);
  assert.ok(warned().some((line) => /1 paid\(ref\) read\(s\) failed \(1 succeeded\)/.test(line)), warned().join("\n"));

  // Out of budget: the pass stops between batches; unread rows go first next pass.
  let clock = 0;
  const b = fakeWatchdog({ now: () => clock, refundCheckBudgetMs: 10_000 });
  for (let id = 300; id < 360; id++) b.db.refunded.push({ id, payoutRef: refOf(id) });
  b.chain.beforeRead = () => {
    clock += 6_000;
  };
  await b.core.pass(b.settings);
  assert.deepEqual(b.chain.paidReads.map((refs) => refs.length), [25, 25]);
  assert.ok(warned().some((line) => /stopped at its 10000ms budget; 10 row\(s\)/.test(line)), warned().join("\n"));
  await b.core.pass(b.settings);
  assert.deepEqual(b.chain.paidReads[2].slice(0, 10), Array.from({ length: 10 }, (_, i) => refOf(350 + i)));

  // A read that never answers cannot hold the pass beyond its budget.
  const c = fakeWatchdog({ refundCheckBudgetMs: 50 });
  c.db.refunded.push({ id: 400, payoutRef: refOf(400) });
  c.chain.hangReads = true;
  const started = Date.now();
  await c.core.pass(c.settings);
  assert.ok(Date.now() - started < 2_000);
  assert.ok(c.calls.includes("nonce") && c.calls.includes("paid"));
  assert.equal(c.db.refundChecks.size, 0);
  assert.ok(warned().some((line) => /stopped at its 50ms budget/.test(line)), warned().join("\n"));
});

test("unfreeze confirmation codes and refund verification rules", () => {
  const code = anomalySetCode(["withdrawal:2", "paid:0xab:1"]);
  assert.match(code, /^[0-9A-F]{8}$/);
  assert.equal(code, anomalySetCode(["paid:0xab:1", "withdrawal:2", "withdrawal:2"]), "order and repeats do not matter");
  assert.notEqual(code, anomalySetCode(["withdrawal:2"]));
  assert.notEqual(code, anomalySetCode(["withdrawal:2", "paid:0xab:1", "withdrawal:3"]));

  const fresh = { falseReads: 0, firstFalseAt: null };
  assert.deepEqual(refundCheckOutcome(fresh, true, 0), { kind: "paid" });
  assert.deepEqual(refundCheckOutcome(fresh, null, 0), { kind: "failed" });
  const one = refundCheckOutcome(fresh, false, 1000);
  assert.deepEqual(one, { kind: "unpaid", state: { falseReads: 1, firstFalseAt: 1000 }, verified: false });
  const third = { falseReads: 2, firstFalseAt: 1000 };
  assert.deepEqual(refundCheckOutcome(third, false, 1000 + REFUND_VERIFY_SPAN_MS - 1),
    { kind: "unpaid", state: { falseReads: 3, firstFalseAt: 1000 }, verified: false }, "three reads within the hour");
  assert.deepEqual(refundCheckOutcome(third, false, 1000 + REFUND_VERIFY_SPAN_MS),
    { kind: "unpaid", state: { falseReads: 3, firstFalseAt: 1000 }, verified: true });
  assert.deepEqual(refundCheckOutcome({ falseReads: 1, firstFalseAt: 0 }, false, 2 * REFUND_VERIFY_SPAN_MS),
    { kind: "unpaid", state: { falseReads: 2, firstFalseAt: 0 }, verified: false }, "an hour alone is not enough");
});
