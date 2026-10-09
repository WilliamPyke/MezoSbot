import { ethers } from "ethers";
import { DEPOSIT_FACTORY_ABI, HOT_PAYOUT_ABI, NATIVE_TOKEN } from "./abi.js";
import { isCompromisedAddress } from "./compromised.js";
import { depositSalt, predictForwarder } from "./forwarder.js";
import type { WithdrawalOutcome, WithdrawalOutcomeReason } from "../depositPolicy.js";

/**
 * Pure custody v2 rules. Nothing here reads config, the database or the chain,
 * so every decision is covered by tests/custody.test.ts.
 */

export type CustodyMode = "v2" | "legacy" | "paused";

/* ─────────── Mode decision ─────────── */

/** Raw custody settings as read from the environment. */
export type CustodyEnv = {
  treasuryPrivateKey: string;
  vaultAddress: string;
  depositFactoryAddress: string;
  forwarderImplementation: string;
  depositFactoryStartBlock: string;
  hotPayoutAddress: string;
  payoutOperatorPrivateKey: string;
  payoutGuardianPrivateKey: string;
  sweepGasPrivateKey: string;
  /** Other keys on this server that a custody role key must never share. */
  escrowSettlerPrivateKey: string;
  imgnaiPayerPrivateKey: string;
  /** Legacy (v1) sweep gas sponsor key; never a v2 role. */
  sweepGasSponsorPrivateKey: string;
};

/** Validated v2 settings. Addresses are lowercase. */
export type V2Settings = {
  vault: string;
  factory: string;
  implementation: string;
  payout: string;
  startBlock: number;
  operatorKey: string;
  operator: string;
  sweepGasKey: string;
  sweepGas: string;
  guardianKey: string | null;
  guardian: string | null;
};

export type CustodyConfigCheck =
  | { mode: "v2"; settings: V2Settings; reasons: string[] }
  | { mode: "legacy"; treasury: string; reasons: string[] }
  | { mode: "paused"; reasons: string[] };

const V2_REQUIRED: ReadonlyArray<readonly [keyof CustodyEnv, string]> = [
  ["vaultAddress", "VAULT_ADDRESS"],
  ["depositFactoryAddress", "DEPOSIT_FACTORY_ADDRESS"],
  ["forwarderImplementation", "DEPOSIT_FORWARDER_IMPLEMENTATION"],
  ["hotPayoutAddress", "HOT_PAYOUT_ADDRESS"],
  ["payoutOperatorPrivateKey", "PAYOUT_OPERATOR_PRIVATE_KEY"],
  ["sweepGasPrivateKey", "SWEEP_GAS_PRIVATE_KEY"],
  ["depositFactoryStartBlock", "DEPOSIT_FACTORY_START_BLOCK"],
];

/** Address of a private key, lowercase; null when the key is invalid. Never echoes the key. */
export function keyAddress(key: string): string | null {
  try {
    return new ethers.Wallet(key.trim()).address.toLowerCase();
  } catch {
    return null;
  }
}

/** Lowercase address, or null unless it is a plain non-zero 0x address. */
export function normalizeAddress(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) return null;
  const lower = trimmed.toLowerCase();
  return lower === NATIVE_TOKEN ? null : lower;
}

export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/** The v1 sweep gas sponsor the legacy code derives from TREASURY_PRIVATE_KEY (src/evm.ts initEVM). */
export function derivedV1SweepSponsorAddress(treasuryPrivateKey: string): string | null {
  const key = treasuryPrivateKey.trim();
  if (!key || !keyAddress(key)) return null;
  return keyAddress(ethers.keccak256(ethers.toUtf8Bytes(`mezosbot-sweep-gas-sponsor-v1:${key}`)));
}

function v2Requested(env: CustodyEnv): boolean {
  return V2_REQUIRED.some(([field]) => env[field].trim() !== "") || env.payoutGuardianPrivateKey.trim() !== "";
}

/**
 * Addresses treated as compromised at runtime, beyond the static list: when
 * TREASURY_PRIVATE_KEY is compromised, or set at all under custody v2, the
 * treasury, the v1 sweep sponsor derived from it, and SWEEP_GAS_SPONSOR_PRIVATE_KEY's
 * address. They are refused as withdrawal destinations and as role keys.
 */
export function retiredKeyAddresses(
  env: CustodyEnv,
  isCompromised: (address: string) => boolean = isCompromisedAddress,
): string[] {
  const treasury = env.treasuryPrivateKey.trim() ? keyAddress(env.treasuryPrivateKey) : null;
  const v2 = v2Requested(env);
  if (!v2 && !(treasury && isCompromised(treasury))) return [];
  const sponsor = env.sweepGasSponsorPrivateKey.trim() ? keyAddress(env.sweepGasSponsorPrivateKey) : null;
  return [treasury, treasury ? derivedV1SweepSponsorAddress(env.treasuryPrivateKey) : null, sponsor]
    .filter((address): address is string => !!address);
}

function checkLegacy(env: CustodyEnv, isCompromised: (address: string) => boolean): CustodyConfigCheck {
  const key = env.treasuryPrivateKey.trim();
  if (!key) {
    return { mode: "paused", reasons: ["custody v2 is not configured and TREASURY_PRIVATE_KEY is not set"] };
  }
  const treasury = keyAddress(key);
  if (!treasury) return { mode: "paused", reasons: ["TREASURY_PRIVATE_KEY is not a valid private key"] };
  if (isCompromised(treasury)) {
    return {
      mode: "paused",
      reasons: [`TREASURY_PRIVATE_KEY belongs to compromised address ${ethers.getAddress(treasury)}; configure custody v2`],
    };
  }
  return { mode: "legacy", treasury, reasons: [] };
}

/**
 * Static half of the mode decision. Any custody v2 variable switches the bot
 * to v2 rules: then every required v2 variable must be valid, no key may be
 * shared between roles or with another key on this server, the vault must not
 * be a server key, and nothing may be a known-compromised address. Anything
 * short of that is "paused". Without v2 variables a valid, uncompromised
 * TREASURY_PRIVATE_KEY keeps the legacy (dev/testnet) behaviour.
 */
export function checkCustodyConfig(
  env: CustodyEnv,
  isCompromised: (address: string) => boolean = isCompromisedAddress,
): CustodyConfigCheck {
  if (!v2Requested(env)) return checkLegacy(env, isCompromised);

  const reasons: string[] = [];
  for (const [field, name] of V2_REQUIRED) {
    if (!env[field].trim()) reasons.push(`${name} is not set`);
  }
  const address = (field: keyof CustodyEnv, name: string): string | null => {
    const raw = env[field].trim();
    if (!raw) return null;
    const value = normalizeAddress(raw);
    if (!value) reasons.push(`${name} is not a valid address`);
    return value;
  };
  const key = (field: keyof CustodyEnv, name: string): string | null => {
    const raw = env[field].trim();
    if (!raw) return null;
    const value = keyAddress(raw);
    if (!value) reasons.push(`${name} is not a valid private key`);
    return value;
  };

  const vault = address("vaultAddress", "VAULT_ADDRESS");
  const factory = address("depositFactoryAddress", "DEPOSIT_FACTORY_ADDRESS");
  const implementation = address("forwarderImplementation", "DEPOSIT_FORWARDER_IMPLEMENTATION");
  const payout = address("hotPayoutAddress", "HOT_PAYOUT_ADDRESS");
  const operator = key("payoutOperatorPrivateKey", "PAYOUT_OPERATOR_PRIVATE_KEY");
  const sweepGas = key("sweepGasPrivateKey", "SWEEP_GAS_PRIVATE_KEY");
  const guardian = key("payoutGuardianPrivateKey", "PAYOUT_GUARDIAN_PRIVATE_KEY");
  const treasury = env.treasuryPrivateKey.trim() ? keyAddress(env.treasuryPrivateKey) : null;
  const escrowSettler = env.escrowSettlerPrivateKey.trim() ? keyAddress(env.escrowSettlerPrivateKey) : null;
  const imgnaiPayer = env.imgnaiPayerPrivateKey.trim() ? keyAddress(env.imgnaiPayerPrivateKey) : null;
  const sweepSponsor = env.sweepGasSponsorPrivateKey.trim() ? keyAddress(env.sweepGasSponsorPrivateKey) : null;
  const derivedSponsor = derivedV1SweepSponsorAddress(env.treasuryPrivateKey);

  const startRaw = env.depositFactoryStartBlock.trim();
  if (startRaw && !/^\d+$/.test(startRaw)) reasons.push("DEPOSIT_FACTORY_START_BLOCK is not a block number");

  const named: Array<[string, string | null]> = [
    ["VAULT_ADDRESS", vault],
    ["DEPOSIT_FACTORY_ADDRESS", factory],
    ["DEPOSIT_FORWARDER_IMPLEMENTATION", implementation],
    ["HOT_PAYOUT_ADDRESS", payout],
    ["PAYOUT_OPERATOR_PRIVATE_KEY", operator],
    ["SWEEP_GAS_PRIVATE_KEY", sweepGas],
    ["PAYOUT_GUARDIAN_PRIVATE_KEY", guardian],
  ];
  for (const [name, value] of [...named, ["IMGNAI_PAYER_PRIVATE_KEY", imgnaiPayer] as [string, string | null]]) {
    if (value && isCompromised(value)) reasons.push(`${name} is a known-compromised address`);
  }

  const contracts: Array<[string, string | null]> = named.slice(0, 4);
  for (let i = 0; i < contracts.length; i++) {
    for (let j = i + 1; j < contracts.length; j++) {
      if (sameAddress(contracts[i][1], contracts[j][1])) {
        reasons.push(`${contracts[i][0]} and ${contracts[j][0]} must be different addresses`);
      }
    }
  }

  const roles: Array<[string, string | null]> = [
    ["PAYOUT_OPERATOR_PRIVATE_KEY", operator],
    ["SWEEP_GAS_PRIVATE_KEY", sweepGas],
    ["PAYOUT_GUARDIAN_PRIVATE_KEY", guardian],
  ];
  const otherKeys: Array<[string, string | null]> = [
    ["TREASURY_PRIVATE_KEY", treasury],
    ["ESCROW_SETTLER_PRIVATE_KEY", escrowSettler],
    ["IMGNAI_PAYER_PRIVATE_KEY", imgnaiPayer],
    ["SWEEP_GAS_SPONSOR_PRIVATE_KEY", sweepSponsor],
    ["the v1 sweep sponsor derived from TREASURY_PRIVATE_KEY", derivedSponsor],
  ];
  // Retired v1 keys: the imgnAI payer must not be one of them either.
  for (const [name, value] of otherKeys.slice(3).concat([otherKeys[0]])) {
    if (sameAddress(imgnaiPayer, value)) reasons.push(`IMGNAI_PAYER_PRIVATE_KEY must not reuse ${name}`);
  }
  for (let i = 0; i < roles.length; i++) {
    for (let j = i + 1; j < roles.length; j++) {
      if (sameAddress(roles[i][1], roles[j][1])) reasons.push(`${roles[i][0]} and ${roles[j][0]} must be different keys`);
    }
    for (const [other, value] of otherKeys) {
      if (sameAddress(roles[i][1], value)) reasons.push(`${roles[i][0]} must not reuse ${other}`);
    }
  }
  for (const [name, value] of [...roles, ...otherKeys]) {
    if (sameAddress(vault, value)) reasons.push(`VAULT_ADDRESS must be a cold wallet, not the address of ${name}`);
  }
  for (const [name, value] of roles) {
    for (const [contract, contractAddress] of contracts.slice(1)) {
      if (sameAddress(value, contractAddress)) reasons.push(`${name} must not be the address in ${contract}`);
    }
  }

  if (reasons.length > 0 || !vault || !factory || !implementation || !payout || !operator || !sweepGas || !startRaw) {
    return { mode: "paused", reasons: reasons.length > 0 ? reasons : ["custody v2 settings are incomplete"] };
  }
  return {
    mode: "v2",
    reasons: [],
    settings: {
      vault,
      factory,
      implementation,
      payout,
      startBlock: Number(startRaw),
      operatorKey: env.payoutOperatorPrivateKey.trim(),
      operator,
      sweepGasKey: env.sweepGasPrivateKey.trim(),
      sweepGas,
      guardianKey: guardian ? env.payoutGuardianPrivateKey.trim() : null,
      guardian,
    },
  };
}

/** What the boot check reads from chain. Addresses in any casing; code "0x" when absent. */
export type V2ChainState = {
  chainId: number;
  factoryCode: string;
  implementationCode: string;
  payoutCode: string;
  factoryVault: string;
  factoryImplementation: string;
  /** factory.predict(depositSalt(PROBE_DISCORD_ID)). */
  factoryPredict: string;
  payoutVault: string;
  payoutOperator: string;
  payoutGuardian: string;
};

/** Discord id whose salt is used to prove predict() matches src/custody/forwarder.ts. */
export const PROBE_DISCORD_ID = "0";

/**
 * On-chain half of the mode decision: the configured contracts exist, are
 * wired to the configured vault and keys, and the factory derives deposit
 * addresses exactly as the bot does. Returns the problems found.
 */
export function checkV2Chain(settings: V2Settings, state: V2ChainState, expectedChainId: number): string[] {
  const reasons: string[] = [];
  if (state.chainId !== expectedChainId) reasons.push(`RPC chain id ${state.chainId} is not CHAIN_ID ${expectedChainId}`);
  const code: Array<[string, string, string]> = [
    ["DEPOSIT_FACTORY_ADDRESS", settings.factory, state.factoryCode],
    ["DEPOSIT_FORWARDER_IMPLEMENTATION", settings.implementation, state.implementationCode],
    ["HOT_PAYOUT_ADDRESS", settings.payout, state.payoutCode],
  ];
  for (const [name, address, bytecode] of code) {
    if (!bytecode || bytecode === "0x") reasons.push(`${name} ${address} has no contract code`);
  }
  const expect = (label: string, actual: string, expected: string, expectedName: string) => {
    if (!sameAddress(actual, expected)) reasons.push(`${label} is ${actual || "unreadable"}, expected ${expectedName} ${expected}`);
  };
  expect("DepositFactory.vault()", state.factoryVault, settings.vault, "VAULT_ADDRESS");
  expect("DepositFactory.implementation()", state.factoryImplementation, settings.implementation, "DEPOSIT_FORWARDER_IMPLEMENTATION");
  expect("HotPayout.vault()", state.payoutVault, settings.vault, "VAULT_ADDRESS");
  expect("HotPayout.operator()", state.payoutOperator, settings.operator, "the PAYOUT_OPERATOR_PRIVATE_KEY address");
  if (settings.guardian) {
    expect("HotPayout.guardian()", state.payoutGuardian, settings.guardian, "the PAYOUT_GUARDIAN_PRIVATE_KEY address");
  }
  const salt = depositSalt(PROBE_DISCORD_ID);
  if (!sameAddress(state.factoryPredict, predictForwarder(settings.factory, settings.implementation, salt))) {
    reasons.push("DepositFactory.predict() does not match the bot's deposit address derivation");
  }
  return reasons;
}

/* ─────────── Logs ─────────── */

const FACTORY_INTERFACE = new ethers.Interface(DEPOSIT_FACTORY_ABI);
const PAYOUT_INTERFACE = new ethers.Interface(HOT_PAYOUT_ABI);

export const SWEPT_TOPIC = FACTORY_INTERFACE.getEvent("Swept")!.topicHash.toLowerCase();
export const PAID_TOPIC = PAYOUT_INTERFACE.getEvent("Paid")!.topicHash.toLowerCase();

/** eth_getLogs / receipt log as returned by JSON-RPC. */
export type RpcLog = {
  address?: string;
  topics?: string[];
  data?: string;
  blockNumber?: string | number | null;
  transactionHash?: string | null;
  logIndex?: string | number | null;
  removed?: boolean;
};

function quantity(value: string | number | null | undefined): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) return null;
  const parsed = Number(BigInt(value));
  return Number.isSafeInteger(parsed) ? parsed : null;
}

type LogPosition = { txHash: string; logIndex: number; blockNumber: number };

function position(log: RpcLog): LogPosition | null {
  const txHash = log.transactionHash ?? "";
  const logIndex = quantity(log.logIndex);
  const blockNumber = quantity(log.blockNumber);
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash) || logIndex == null || blockNumber == null) return null;
  return { txHash: txHash.toLowerCase(), logIndex, blockNumber };
}

function parseEvent(log: RpcLog, emitter: string, topic: string, iface: ethers.Interface, name: string) {
  if (log.removed || !sameAddress(log.address, emitter)) return null;
  const topics = log.topics ?? [];
  if (topics.length !== 4 || topics[0]?.toLowerCase() !== topic) return null;
  const at = position(log);
  if (!at) return null;
  try {
    const parsed = iface.parseLog({ topics, data: log.data ?? "0x" });
    return parsed?.name === name ? { parsed, at } : null;
  } catch {
    return null;
  }
}

export type SweptEvent = LogPosition & { salt: string; token: string; vault: string; amount: bigint };

/** A DepositFactory Swept log emitted by `factory`, or null. */
export function parseSweptLog(log: RpcLog, factory: string): SweptEvent | null {
  const event = parseEvent(log, factory, SWEPT_TOPIC, FACTORY_INTERFACE, "Swept");
  if (!event) return null;
  const { parsed, at } = event;
  return {
    ...at,
    salt: String(parsed.args.salt).toLowerCase(),
    token: String(parsed.args.token).toLowerCase(),
    vault: String(parsed.args.vault).toLowerCase(),
    amount: BigInt(parsed.args.amount),
  };
}

export type PaidEvent = LogPosition & { ref: string; token: string; to: string; amount: bigint };

/** A HotPayout Paid log emitted by `payout`, or null. */
export function parsePaidLog(log: RpcLog, payout: string): PaidEvent | null {
  const event = parseEvent(log, payout, PAID_TOPIC, PAYOUT_INTERFACE, "Paid");
  if (!event) return null;
  const { parsed, at } = event;
  return {
    ...at,
    ref: String(parsed.args.ref).toLowerCase(),
    token: String(parsed.args.token).toLowerCase(),
    to: String(parsed.args.to).toLowerCase(),
    amount: BigInt(parsed.args.amount),
  };
}

export function sortByChainPosition<T extends LogPosition>(events: T[]): T[] {
  return [...events].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
}

/** The exact payment a withdrawal row signed: what a Paid log must show to prove it. */
export type PayoutExpectation = { ref: string; token: string; to: string; amount: bigint };

export function paidEventMatches(event: PaidEvent, expected: PayoutExpectation): boolean {
  return event.ref === expected.ref.toLowerCase()
    && event.token === expected.token.toLowerCase()
    && event.to === expected.to.toLowerCase()
    && event.amount === expected.amount;
}

/** The Paid log in `logs` (from `payout`) proving `expected`, or null. */
export function findMatchingPaid(logs: readonly RpcLog[], payout: string, expected: PayoutExpectation): PaidEvent | null {
  for (const log of logs) {
    const event = parsePaidLog(log, payout);
    if (event && paidEventMatches(event, expected)) return event;
  }
  return null;
}

/**
 * Next block range for a log cursor that stores the last fully processed
 * block. Stops `confirmations` blocks behind the head; null when caught up.
 */
export function nextLogRange(
  lastProcessed: number,
  latest: number,
  confirmations: number,
  chunkBlocks: number,
): { from: number; to: number } | null {
  const safeHead = latest - Math.max(0, Math.floor(confirmations));
  const from = lastProcessed + 1;
  if (from > safeHead) return null;
  return { from, to: Math.min(safeHead, from + Math.max(1, Math.floor(chunkBlocks)) - 1) };
}

/** Blocks re-read behind each log cursor every pass. */
export const RESCAN_BLOCKS = 32;

/** Trailing window re-read each pass (idempotent), in case a node served incomplete logs earlier. */
export function rescanRange(lastProcessed: number, startBlock: number, windowBlocks: number): { from: number; to: number } | null {
  if (lastProcessed < startBlock || windowBlocks <= 0) return null;
  return { from: Math.max(startBlock, lastProcessed - Math.floor(windowBlocks) + 1), to: lastProcessed };
}

/** [from, to] split into consecutive chunks of at most `chunkBlocks` blocks. */
export function chunkRanges(from: number, to: number, chunkBlocks: number): Array<{ from: number; to: number }> {
  const size = Math.max(1, Math.floor(chunkBlocks));
  const ranges: Array<{ from: number; to: number }> = [];
  for (let start = from; start <= to; start += size) ranges.push({ from: start, to: Math.min(to, start + size - 1) });
  return ranges;
}

/** Whether scanner pass number `pass` (1-based) is a deep-rescan pass. */
export function isDeepRescanPass(pass: number, everyPasses: number): boolean {
  return everyPasses > 0 && pass > 0 && pass % Math.floor(everyPasses) === 0;
}

/* ─────────── HotPayout calls ─────────── */

export function encodePayoutCall(expected: PayoutExpectation): string {
  return expected.token.toLowerCase() === NATIVE_TOKEN
    ? PAYOUT_INTERFACE.encodeFunctionData("payNative", [expected.ref, expected.to, expected.amount])
    : PAYOUT_INTERFACE.encodeFunctionData("payToken", [expected.ref, expected.token, expected.to, expected.amount]);
}

export function decodePayoutCall(data: string): PayoutExpectation | null {
  try {
    const parsed = PAYOUT_INTERFACE.parseTransaction({ data });
    if (parsed?.name === "payNative") {
      return {
        ref: String(parsed.args.ref).toLowerCase(),
        token: NATIVE_TOKEN,
        to: String(parsed.args.to).toLowerCase(),
        amount: BigInt(parsed.args.amount),
      };
    }
    if (parsed?.name === "payToken") {
      return {
        ref: String(parsed.args.ref).toLowerCase(),
        token: String(parsed.args.token).toLowerCase(),
        to: String(parsed.args.to).toLowerCase(),
        amount: BigInt(parsed.args.amount),
      };
    }
  } catch {
    // not a payout call
  }
  return null;
}

/** The payment a stored signed withdrawal tx makes, if it is a call to `payout`. */
export function decodePayoutRawTx(rawTx: string | null | undefined, payout: string): PayoutExpectation | null {
  if (!rawTx) return null;
  try {
    const tx = ethers.Transaction.from(rawTx);
    if (!sameAddress(tx.to, payout) || tx.value !== 0n) return null;
    return decodePayoutCall(tx.data);
  } catch {
    return null;
  }
}

export type PayoutRevert = { error: string | null; message: string };

const REVERT_MESSAGES: Record<string, string> = {
  EnforcedPause: "On-chain withdrawals are paused right now.",
  DailyCapExceeded: "The on-chain daily withdrawal limit has been reached. Please try again later.",
  PerTxCapExceeded: "This amount is above the per-withdrawal limit.",
  InsufficientFloat: "The withdrawal wallet is being refilled. Please try again later.",
  BadRecipient: "That address cannot receive withdrawals.",
  TokenNotAllowed: "Withdrawals of this token are not enabled.",
  CapsNotSet: "Withdrawals of this token are not enabled.",
  ZeroAmount: "Amount too small.",
  AlreadyPaid: "This withdrawal reference was already paid.",
  PayFailed: "The destination address rejected the payment.",
  NotOperator: "Withdrawals are temporarily unavailable.",
  InvalidRef: "Withdrawals are temporarily unavailable.",
};

/** User-facing reason for a HotPayout revert (eth_call / estimateGas error data). */
export function describePayoutRevert(data: unknown): PayoutRevert {
  if (typeof data === "string" && /^0x[0-9a-fA-F]{8}/.test(data)) {
    try {
      const parsed = PAYOUT_INTERFACE.parseError(data);
      if (parsed) return { error: parsed.name, message: REVERT_MESSAGES[parsed.name] ?? "The payout contract rejected this withdrawal." };
    } catch {
      // unknown selector
    }
  }
  return { error: null, message: "The payout contract rejected this withdrawal." };
}

const FACTORY_REVERT_MESSAGES: Record<string, string> = {
  TokenNotAllowed: "the DepositFactory does not allowlist this token",
  InvalidToken: "the DepositFactory rejects this token address",
  OnlyVault: "only the vault may call this DepositFactory function",
};

/** Name and operator-facing text of a DepositFactory or HotPayout revert, for logs. */
export function describeCustodyRevert(data: unknown): string {
  if (typeof data === "string" && /^0x[0-9a-fA-F]{8}/.test(data)) {
    for (const [iface, messages] of [[FACTORY_INTERFACE, FACTORY_REVERT_MESSAGES], [PAYOUT_INTERFACE, REVERT_MESSAGES]] as const) {
      try {
        const parsed = iface.parseError(data);
        if (parsed) return `${parsed.name}: ${messages[parsed.name] ?? "reverted"}`;
      } catch {
        // not this contract's error
      }
    }
  }
  return "reverted without a known custody error";
}

/**
 * Why a withdrawal destination is refused, or null. Deposit forwarders,
 * retired deposit addresses, the custody contracts and roles, and
 * known-compromised addresses never receive withdrawals.
 */
export function withdrawalDestinationProblem(
  to: string,
  blocked: ReadonlyArray<{ label: string; address: string | null | undefined }>,
  isDepositAddress: boolean,
  isCompromised: (address: string) => boolean = isCompromisedAddress,
): string | null {
  if (isCompromised(to)) return "That address is not safe to withdraw to. Withdraw to a wallet you control.";
  if (isDepositAddress) {
    return "That is a MezoSBOT deposit address. Withdraw to a wallet you control; deposit addresses only forward to the bot's vault.";
  }
  const hit = blocked.find((entry) => sameAddress(entry.address, to));
  return hit ? `That is the MezoSBOT ${hit.label}. Withdraw to a wallet you control.` : null;
}

/** Largest amount HotPayout would pay right now under its caps and float. */
export function payoutCapacity(state: {
  paused: boolean;
  allowed: boolean;
  perTxCap: bigint;
  remainingDaily: bigint;
  float: bigint;
}): bigint {
  if (state.paused || !state.allowed) return 0n;
  let max = state.perTxCap;
  if (state.remainingDaily < max) max = state.remainingDaily;
  if (state.float < max) max = state.float;
  return max > 0n ? max : 0n;
}

/* ─────────── Withdrawal proof ─────────── */

/** Evidence about a HotPayout withdrawal beyond its own receipt. */
export type PayoutProof = {
  /** Our status-1 receipt carries a Paid log matching the signed call; null without a receipt. */
  receiptMatch: boolean | null;
  /** HotPayout.paid(ref); null when not read or unreadable. */
  paidOnChain: boolean | null;
  /**
   * Search of Paid logs for this ref (only when paid(ref) is true). "match"
   * only when the matching log is in the row's own transaction; "foreign"
   * when it matches but sits in any other transaction.
   */
  paidLog: "match" | "foreign" | "mismatch" | "not_found" | null;
};

/**
 * Apply HotPayout evidence to a receipt/nonce verdict. paid(ref) alone proves
 * nothing about who was paid: refs are deterministic, so a holder of the
 * operator key could pay a real ref to another address. Completion therefore
 * needs a Paid log for the ref whose token, recipient and amount match the
 * call the bot signed. A refund needs paid(ref) to read false. A successful
 * receipt without that log, or a paid ref whose Paid log differs or cannot be
 * found, is "payout_unproven": never refunded, never completed, and treated
 * as a custody anomaly (isPayoutAnomaly).
 */
export function applyPayoutProof(
  base: { outcome: WithdrawalOutcome; reason: WithdrawalOutcomeReason },
  proof: PayoutProof,
): { outcome: WithdrawalOutcome; reason: WithdrawalOutcomeReason } {
  if (base.outcome === "completed") {
    return proof.receiptMatch === true ? base : { outcome: "pending", reason: "payout_unproven" };
  }
  if (proof.paidOnChain === true) {
    if (proof.paidLog === "match") return { outcome: "completed", reason: "paid_on_chain" };
    // An unreadable log search is retried; a differing or missing Paid log is not.
    return proof.paidLog == null
      ? { outcome: "pending", reason: "lookup_failed" }
      : { outcome: "pending", reason: "payout_unproven" };
  }
  if (base.outcome === "refund") {
    return proof.paidOnChain === false ? base : { outcome: "pending", reason: "lookup_failed" };
  }
  return base;
}

/** A verdict that means HotPayout paid something other than what the bot signed. Freezes custody. */
export function isPayoutAnomaly(verdict: { reason: WithdrawalOutcomeReason }): boolean {
  return verdict.reason === "payout_unproven";
}

/* ─────────── Watchdog ─────────── */

/** Nonces in [fromNonce, latestNonce) with no record of the bot signing them. */
export function findUnrecordedNonces(
  fromNonce: number,
  latestNonce: number,
  recorded: Iterable<number>,
  limit = 50,
): number[] {
  const known = new Set(recorded);
  const missing: number[] = [];
  for (let nonce = Math.max(0, fromNonce); nonce < latestNonce && missing.length < limit; nonce++) {
    if (!known.has(nonce)) missing.push(nonce);
  }
  return missing;
}

export type PaidEventCheck = "ok" | "unknown_ref" | "mismatch" | "foreign_tx" | "not_pending";

/**
 * A Paid event is ours only if a withdrawal row carries its ref, that row's
 * stored signed call pays exactly this token, recipient and amount, the event
 * is in the row's own recorded transaction, and the row is pending or
 * completed. A Paid for a refunded row, or in any other transaction, is not.
 */
export function classifyPaidEvent(
  event: PaidEvent,
  row: { raw_tx: string | null; status?: string | null; tx_hash?: string | null } | null,
  payout: string,
): PaidEventCheck {
  if (!row) return "unknown_ref";
  if (row.status !== "pending" && row.status !== "completed") return "not_pending";
  const signed = decodePayoutRawTx(row.raw_tx, payout);
  if (!signed || !paidEventMatches(event, signed)) return "mismatch";
  if (!row.tx_hash || row.tx_hash.toLowerCase() !== event.txHash) return "foreign_tx";
  return "ok";
}

export type NonceCheck = {
  /** Mined nonces with no record of the bot signing anything at them. */
  unrecorded: number[];
  /** Mined nonces where none of the recorded transactions has a receipt: another transaction used the nonce. */
  displaced: number[];
  /** Mined nonces whose receipts could not be read this pass. */
  unknown: number[];
};

/**
 * Every nonce a custody key has spent in [fromNonce, latestNonce) must have
 * been recorded by the bot, and one of the transactions recorded for it must
 * have a receipt. `receipts` maps a lowercase hash to true (receipt), false
 * (none) or null (lookup failed).
 */
export function checkSignedNonces(
  fromNonce: number,
  latestNonce: number,
  records: ReadonlyArray<{ nonce: number; txHash: string }>,
  receipts: ReadonlyMap<string, boolean | null>,
): NonceCheck {
  const byNonce = new Map<number, string[]>();
  for (const record of records) {
    const hashes = byNonce.get(record.nonce) ?? [];
    hashes.push(record.txHash.toLowerCase());
    byNonce.set(record.nonce, hashes);
  }
  const result: NonceCheck = { unrecorded: [], displaced: [], unknown: [] };
  for (let nonce = Math.max(0, fromNonce); nonce < latestNonce; nonce++) {
    const hashes = byNonce.get(nonce);
    if (!hashes?.length) {
      result.unrecorded.push(nonce);
      continue;
    }
    const states = hashes.map((hash) => receipts.get(hash));
    if (states.includes(true)) continue;
    if (states.some((state) => state == null)) result.unknown.push(nonce);
    else result.displaced.push(nonce);
  }
  return result;
}

/**
 * Short code for an exact set of anomaly keys. /custody unfreeze accepts
 * anomalies an admin was not shown only with the code of that same set, so a
 * set that changed in between needs a new confirmation.
 */
export function anomalySetCode(keys: Iterable<string>): string {
  const sorted = [...new Set(keys)].sort();
  return ethers.keccak256(ethers.toUtf8Bytes(sorted.join("\n"))).slice(2, 10).toUpperCase();
}

/** A refunded HotPayout row is verified unpaid after this many false reads, spanning at least an hour. */
export const REFUND_VERIFY_READS = 3;
export const REFUND_VERIFY_SPAN_MS = 60 * 60_000;

export type RefundCheckState = { falseReads: number; firstFalseAt: number | null };

/**
 * Next state of a refunded row after one paid(ref) read. "paid" is a double
 * payment; "failed" leaves the state as it was; "unpaid" counts the read and
 * says whether the row is now verified (no further reads; a later Paid for
 * the ref is still caught by the Paid scan).
 */
export function refundCheckOutcome(
  previous: RefundCheckState,
  paid: boolean | null,
  nowMs: number,
): { kind: "paid" } | { kind: "failed" } | { kind: "unpaid"; state: RefundCheckState; verified: boolean } {
  if (paid === true) return { kind: "paid" };
  if (paid !== false) return { kind: "failed" };
  const state = { falseReads: previous.falseReads + 1, firstFalseAt: previous.firstFalseAt ?? nowMs };
  const verified = state.falseReads >= REFUND_VERIFY_READS && nowMs - state.firstFalseAt >= REFUND_VERIFY_SPAN_MS;
  return { kind: "unpaid", state, verified };
}

/* ─────────── Limits ─────────── */

export const DAY_MS = 24 * 60 * 60 * 1000;

function timeMs(value: unknown): number {
  const parsed = typeof value === "string" || typeof value === "number" ? Date.parse(String(value)) : NaN;
  return Number.isFinite(parsed) ? parsed : NaN;
}

/** SATS a user withdrew (or has in flight) during the 24h before `nowMs`. Refunded rows do not count. */
export function sumRecentSatsWithdrawals(
  rows: ReadonlyArray<{ amount_sats: unknown; token?: unknown; status?: unknown; created_at: unknown }>,
  nowMs: number,
): number {
  let total = 0;
  for (const row of rows) {
    if (row.token != null && row.token !== "SATS") continue;
    if (row.status !== "pending" && row.status !== "completed") continue;
    const at = timeMs(row.created_at);
    if (!(at > nowMs - DAY_MS)) continue;
    const amount = Number(row.amount_sats);
    if (Number.isFinite(amount) && amount > 0) total += amount;
  }
  return total;
}

/** Per-user rolling 24h soft cap. A cap of 0 or less disables it. */
export function checkUserDailyCap(
  usedSats: number,
  amountSats: number,
  capSats: number,
): { ok: boolean; remainingSats: number } {
  if (!(capSats > 0)) return { ok: true, remainingSats: Number.POSITIVE_INFINITY };
  const remainingSats = Math.max(0, capSats - usedSats);
  return { ok: amountSats <= remainingSats + 1e-9, remainingSats };
}

/** MUSD the x402 payer topped up in the 24h before `nowMs`. Failures that never signed a payment do not count. */
export function sumRecentTopUps(
  rows: ReadonlyArray<{ amount_musd_atomic: unknown; status?: unknown; response?: unknown; created_at: unknown }>,
  nowMs: number,
): bigint {
  let total = 0n;
  for (const row of rows) {
    const at = timeMs(row.created_at);
    if (!(at > nowMs - DAY_MS)) continue;
    const response = row.response as { payment_signed?: unknown } | null | undefined;
    if (row.status === "failed" && response?.payment_signed === false) continue;
    try {
      const amount = BigInt(String(row.amount_musd_atomic ?? "0").split(".")[0]);
      if (amount > 0n) total += amount;
    } catch {
      // unreadable amount: ignore the row
    }
  }
  return total;
}

export function checkTopUpAllowance(input: {
  amount: bigint;
  maxPerTopUp: bigint;
  dailyMax: bigint;
  usedToday: bigint;
}): { ok: true } | { ok: false; reason: string } {
  if (input.amount <= 0n) return { ok: false, reason: "top-up amount must be positive" };
  if (input.amount > input.maxPerTopUp) {
    return { ok: false, reason: `top-up of ${ethers.formatUnits(input.amount, 18)} MUSD exceeds IMGNAI_X402_MAX_TOPUP_MUSD` };
  }
  if (input.usedToday + input.amount > input.dailyMax) {
    return {
      ok: false,
      reason: `top-up would exceed IMGNAI_X402_DAILY_MAX_MUSD (${ethers.formatUnits(input.usedToday, 18)} MUSD used in the last 24h)`,
    };
  }
  return { ok: true };
}

/**
 * Screens an x402 payment requirement before anything is signed: the right
 * network and asset, and never more than the top-up the bot asked for.
 * Returns the reason to refuse, or null.
 */
export function checkX402Requirement(
  requirement: { network?: unknown; asset?: unknown; amount?: unknown; extra?: unknown; payTo?: unknown },
  allowed: { network: string; asset: string; maxAmount: bigint; payTo?: string | null },
): string | null {
  if (requirement.network !== allowed.network) return `network ${String(requirement.network)} is not ${allowed.network}`;
  if (allowed.payTo && !sameAddress(typeof requirement.payTo === "string" ? requirement.payTo : null, allowed.payTo)) {
    return `payTo ${String(requirement.payTo)} is not the expected ${allowed.payTo}`;
  }
  // Only the EIP-3009 exact-amount authorization: never Permit2, whose client
  // path can sign token permits or a raw approve transaction.
  const method = (requirement.extra as { assetTransferMethod?: unknown } | null | undefined)?.assetTransferMethod;
  if (method != null && method !== "eip3009") return `asset transfer method ${String(method)} is not allowed`;
  if (!sameAddress(typeof requirement.asset === "string" ? requirement.asset : null, allowed.asset)) {
    return `asset ${String(requirement.asset)} is not MUSD`;
  }
  if (typeof requirement.amount !== "string" || !/^\d+$/.test(requirement.amount)) return "amount is not an integer";
  if (BigInt(requirement.amount) > allowed.maxAmount) {
    return `amount ${requirement.amount} exceeds the requested top-up ${allowed.maxAmount}`;
  }
  return null;
}

/**
 * The only typed data the x402 payer signs: an EIP-3009
 * TransferWithAuthorization of MUSD on Mezo, from the payer, for no more than
 * the top-up in progress. Returns the reason to refuse, or null.
 */
export function checkX402Authorization(
  typed: { domain?: Record<string, unknown>; primaryType?: unknown; message?: Record<string, unknown> },
  allowed: { chainId: number; asset: string; from: string; maxAmount: bigint | null; payTo?: string | null },
): string | null {
  if (allowed.maxAmount == null) return "no imgnAI top-up is in progress";
  if (typed.primaryType !== "TransferWithAuthorization") return `refusing to sign ${String(typed.primaryType)}`;
  if (Number(typed.domain?.chainId) !== allowed.chainId) return `chain ${String(typed.domain?.chainId)} is not ${allowed.chainId}`;
  if (!sameAddress(String(typed.domain?.verifyingContract ?? ""), allowed.asset)) return "token is not MUSD";
  if (!sameAddress(String(typed.message?.from ?? ""), allowed.from)) return "authorization is not from the payer";
  if (allowed.payTo && !sameAddress(String(typed.message?.to ?? ""), allowed.payTo)) {
    return `authorization pays ${String(typed.message?.to)}, not the expected ${allowed.payTo}`;
  }
  let value: bigint;
  try {
    value = BigInt(typed.message?.value as string | number | bigint);
  } catch {
    return "authorization value is unreadable";
  }
  if (value <= 0n || value > allowed.maxAmount) return `value ${value} is outside the requested top-up ${allowed.maxAmount}`;
  return null;
}

/* ─────────── Units ─────────── */

/**
 * Wei to sats with the same rounding as credit_forwarder_deposit_v1: 1 sat is
 * 10^10 wei, so the decimal is exact and is parsed once to a double.
 */
export function weiToSats(wei: bigint): number {
  const negative = wei < 0n;
  const abs = negative ? -wei : wei;
  const whole = abs / 10_000_000_000n;
  const fraction = (abs % 10_000_000_000n).toString().padStart(10, "0");
  const value = Number(`${whole}.${fraction}`);
  return negative ? -value : value;
}
