import { ethers } from "ethers";
import { TOKEN_SYMBOLS, formatTokenAmount, getTokenConfig, tokenDecimalToUnits, tokenUnitsToAmount, type TokenSymbol } from "../tokens.js";
import { DEPOSIT_FACTORY_ABI, HOT_PAYOUT_ABI, NATIVE_TOKEN, PAYOUT_ACTIONS, type PayoutAction } from "./abi.js";
import { sameAddress, type RpcLog } from "./policy.js";

/**
 * Pure half of the vault-action watcher (src/custody/adminWatch.ts): decoding
 * HotPayout / DepositFactory admin events, matching a queued action against
 * an admin's /custody expect approval, and describing it for DMs.
 *
 * HotPayout queues everything that loosens control (recovery, higher caps,
 * new operator, guardian or vault) for DELAY before it can apply. The bot
 * cancels, through the guardian, every queued action no admin approved
 * beforehand; a new guardian can only be cancelled by the vault, so for that
 * one admins get an urgent DM with the exact call instead.
 */

const PAYOUT = new ethers.Interface(HOT_PAYOUT_ABI);
const FACTORY = new ethers.Interface(DEPOSIT_FACTORY_ABI);

const PAYOUT_EVENTS = [
  "ActionQueued",
  "ActionCancelled",
  "ActionApplied",
  "QueueDropped",
  "CapRaisesDropped",
  "Paused",
  "Unpaused",
  "TokenAllowed",
  "CapsSet",
  "VaultSet",
  "OperatorSet",
  "GuardianSet",
  "Recovered",
] as const;
const FACTORY_EVENTS = ["Rescued", "TokenAllowed"] as const;

export const ADMIN_PAYOUT_TOPICS = PAYOUT_EVENTS.map((name) => PAYOUT.getEvent(name)!.topicHash.toLowerCase());
export const ADMIN_FACTORY_TOPICS = FACTORY_EVENTS.map((name) => FACTORY.getEvent(name)!.topicHash.toLowerCase());

/** How long an approval from /custody expect stays usable. */
export const EXPECTATION_TTL_MS = 24 * 60 * 60_000;

export type QueuedAction = {
  id: string;
  action: PayoutAction;
  /** New vault/operator/guardian, or the token (address(0) for BTC) for caps and recover. */
  subject: string;
  /** perTx for caps, amount for recover, otherwise 0. */
  value1: bigint;
  /** daily for caps, otherwise 0. */
  value2: bigint;
  /** Unix seconds. */
  eta: number;
};

export type AdminEvent =
  | { kind: "queued"; queued: QueuedAction }
  | { kind: "cancelled"; id: string; action: PayoutAction; by: string }
  | { kind: "applied"; id: string; action: PayoutAction }
  | { kind: "unpaused"; by: string }
  | { kind: "notice"; text: string };

export type DecodedAdminLog = AdminEvent & { txHash: string; logIndex: number; blockNumber: number };

function quantity(value: string | number | null | undefined): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) return null;
  const parsed = Number(BigInt(value));
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function checksum(address: string): string {
  try {
    return ethers.getAddress(address);
  } catch {
    return address;
  }
}

function actionName(index: bigint | number): PayoutAction | null {
  return PAYOUT_ACTIONS[Number(index)] ?? null;
}

export function tokenSymbolForAddress(address: string): TokenSymbol | null {
  if (sameAddress(address, NATIVE_TOKEN)) return "SATS";
  for (const symbol of TOKEN_SYMBOLS) {
    if (symbol === "SATS") continue;
    const contract = getTokenConfig(symbol).contractAddress;
    if (contract && sameAddress(contract, address)) return symbol;
  }
  return null;
}

/** Base units of `token` as "1,234 sats" / "15 MUSD", or the raw number for an unknown token. */
export function describeTokenAmount(token: string, units: bigint): string {
  const symbol = tokenSymbolForAddress(token);
  if (!symbol) return `${units} base units of token ${checksum(token)}`;
  return formatTokenAmount(tokenUnitsToAmount(units, symbol), symbol);
}

function tokenName(token: string): string {
  const symbol = tokenSymbolForAddress(token);
  if (symbol === "SATS") return "BTC";
  return symbol ?? `token ${checksum(token)}`;
}

/** One line describing a queued action, e.g. "move 1,200 sats from HotPayout to the vault". */
export function describeQueued(q: Pick<QueuedAction, "action" | "subject" | "value1" | "value2">): string {
  switch (q.action) {
    case "vault":
      return `hand HotPayout's vault (admin) role to ${checksum(q.subject)}`;
    case "operator":
      return `make ${checksum(q.subject)} the payout operator`;
    case "guardian":
      return `make ${checksum(q.subject)} the payout guardian`;
    case "caps":
      return `raise ${tokenName(q.subject)} payout caps to ${describeTokenAmount(q.subject, q.value1)} per withdrawal / ` +
        `${describeTokenAmount(q.subject, q.value2)} per day`;
    case "recover":
      return `move ${describeTokenAmount(q.subject, q.value1)} from HotPayout to the vault`;
  }
}

/** Decodes one admin event log of `payout` or `factory`; null for anything else or a removed log. */
export function decodeAdminLog(log: RpcLog, payout: string, factory: string): DecodedAdminLog | null {
  if (log.removed) return null;
  const txHash = (log.transactionHash ?? "").toLowerCase();
  const logIndex = quantity(log.logIndex);
  const blockNumber = quantity(log.blockNumber);
  if (!/^0x[0-9a-f]{64}$/.test(txHash) || logIndex == null || blockNumber == null) return null;
  const at = { txHash, logIndex, blockNumber };
  const source = sameAddress(log.address ?? "", payout) ? PAYOUT : sameAddress(log.address ?? "", factory) ? FACTORY : null;
  if (!source) return null;
  let parsed: ethers.LogDescription | null;
  try {
    parsed = source.parseLog({ topics: log.topics ?? [], data: log.data ?? "0x" });
  } catch {
    return null;
  }
  if (!parsed) return null;
  const a = parsed.args;
  if (source === FACTORY) {
    if (parsed.name === "Rescued") {
      return {
        ...at,
        kind: "notice",
        text: `DepositFactory rescued ${describeTokenAmount(a.token, a.amount)} from deposit address salt ${a.salt} to ${checksum(a.to)}.`,
      };
    }
    if (parsed.name === "TokenAllowed") {
      return { ...at, kind: "notice", text: `DepositFactory now sweeps ${tokenName(a.token)}.` };
    }
    return null;
  }
  switch (parsed.name) {
    case "ActionQueued": {
      const action = actionName(a.action);
      if (!action) return null;
      return {
        ...at,
        kind: "queued",
        queued: {
          id: String(a.id).toLowerCase(),
          action,
          subject: String(a.subject).toLowerCase(),
          value1: BigInt(a.value1),
          value2: BigInt(a.value2),
          eta: Number(a.eta),
        },
      };
    }
    case "ActionCancelled": {
      const action = actionName(a.action);
      return action ? { ...at, kind: "cancelled", id: String(a.id).toLowerCase(), action, by: String(a.by).toLowerCase() } : null;
    }
    case "ActionApplied": {
      const action = actionName(a.action);
      return action ? { ...at, kind: "applied", id: String(a.id).toLowerCase(), action } : null;
    }
    case "QueueDropped":
      return { ...at, kind: "notice", text: `HotPayout's vault changed: every vault action queued before it was dropped.` };
    case "CapRaisesDropped":
      return { ...at, kind: "notice", text: `HotPayout dropped every ${tokenName(a.token)} cap raise queued before a cap cut.` };
    case "Unpaused":
      return { ...at, kind: "unpaused", by: String(a.account).toLowerCase() };
    case "Paused":
      return { ...at, kind: "notice", text: `HotPayout was paused by ${checksum(a.account)}.` };
    case "TokenAllowed":
      return { ...at, kind: "notice", text: `HotPayout ${a.allowed ? "allowlisted" : "disallowed"} ${tokenName(a.token)}.` };
    case "CapsSet":
      return {
        ...at,
        kind: "notice",
        text: `HotPayout ${tokenName(a.token)} caps are now ${describeTokenAmount(a.token, a.perTxCap)} per withdrawal / ` +
          `${describeTokenAmount(a.token, a.dailyCap)} per day.`,
      };
    case "VaultSet":
      return { ...at, kind: "notice", text: `HotPayout's vault (admin) is now ${checksum(a.vault)}.` };
    case "OperatorSet":
      return { ...at, kind: "notice", text: `HotPayout's operator is now ${checksum(a.operator)}.` };
    case "GuardianSet":
      return { ...at, kind: "notice", text: `HotPayout's guardian is now ${checksum(a.guardian)}.` };
    case "Recovered":
      return { ...at, kind: "notice", text: `HotPayout sent ${describeTokenAmount(a.token, a.amount)} to the vault.` };
    default:
      return null;
  }
}

/** An admin's /custody expect approval as stored in custody_expected_actions. */
export type Expectation = {
  id: number;
  action: PayoutAction;
  subject: string;
  value1: string;
  value2: string;
  expires_at: string;
  used_by: string | null;
};

/**
 * The unexpired approval for exactly this action that is unused, or already
 * used by this same event (`eventKey`, tx:logIndex, so a crash between claiming
 * and recording it does not lose the approval), or null.
 */
export function matchExpectation(
  q: QueuedAction,
  expectations: readonly Expectation[],
  nowMs: number,
  eventKey?: string,
): Expectation | null {
  return expectations.find((e) =>
    (e.used_by == null || (eventKey != null && e.used_by === eventKey)) &&
    e.action === q.action &&
    sameAddress(e.subject, q.subject) &&
    BigInt(e.value1) === q.value1 &&
    BigInt(e.value2) === q.value2 &&
    Date.parse(e.expires_at) > nowMs
  ) ?? null;
}

export type QueuedDecision = "approved" | "cancel" | "vault-must-cancel";

/** Approved actions are left alone; others are cancelled by the guardian, or by the vault for a new guardian. */
export function decideQueued(q: Pick<QueuedAction, "action">, approved: boolean): QueuedDecision {
  if (approved) return "approved";
  return q.action === "guardian" ? "vault-must-cancel" : "cancel";
}

/** HotPayout.cancel(...) calldata for a queued action. */
export function cancelCalldata(q: Pick<QueuedAction, "action" | "subject" | "value1" | "value2">): string {
  return PAYOUT.encodeFunctionData("cancel", [PAYOUT_ACTIONS.indexOf(q.action), q.subject, q.value1, q.value2]);
}

/** The cancel call as text, for an admin to send from the vault wallet. */
export function cancelCallText(q: Pick<QueuedAction, "action" | "subject" | "value1" | "value2">): string {
  return `cancel(${PAYOUT_ACTIONS.indexOf(q.action)}, ${checksum(q.subject)}, ${q.value1}, ${q.value2})`;
}

/**
 * Turns /custody expect input into the exact (subject, value1, value2) HotPayout
 * will emit. Roles take an address. caps and recover take a token (SATS, MUSD,
 * MUSDC, MEZO or an address) and amounts in that token's units (sats for SATS).
 */
export function parseExpectation(
  action: PayoutAction,
  subject: string,
  amount: string | null,
  daily: string | null,
): { subject: string; value1: bigint; value2: bigint } | { error: string } {
  const trimmed = subject.trim();
  if (action === "vault" || action === "operator" || action === "guardian") {
    if (!ethers.isAddress(trimmed)) return { error: `${trimmed} is not an address.` };
    return { subject: trimmed.toLowerCase(), value1: 0n, value2: 0n };
  }
  const upper = trimmed.toUpperCase();
  const symbol = (TOKEN_SYMBOLS as readonly string[]).includes(upper) ? (upper as TokenSymbol) : tokenSymbolForAddress(trimmed);
  let token: string;
  if (symbol === "SATS") token = NATIVE_TOKEN;
  else if (symbol) {
    const contract = getTokenConfig(symbol).contractAddress;
    if (!contract) return { error: `${symbol} has no configured contract.` };
    token = contract.toLowerCase();
  } else if (ethers.isAddress(trimmed)) token = trimmed.toLowerCase();
  else return { error: `${trimmed} is not a token symbol (SATS, MUSD, MUSDC, MEZO) or an address.` };

  const units = (raw: string | null, label: string): bigint | { error: string } => {
    if (!raw?.trim()) return { error: `${label} is required for ${action}.` };
    try {
      // Sats to wei (1 sat = 10^10 wei); whole tokens to their base units; raw base units otherwise.
      const value = symbol === "SATS"
        ? ethers.parseUnits(raw.trim(), 10)
        : symbol
          ? tokenDecimalToUnits(raw, symbol)
          : BigInt(raw.trim());
      return value > 0n ? value : { error: `${label} must be above 0.` };
    } catch {
      return { error: `${label} ${raw} is not a valid amount.` };
    }
  };
  const value1 = units(amount, action === "caps" ? "amount (per-withdrawal cap)" : "amount");
  if (typeof value1 !== "bigint") return value1;
  if (action === "recover") return { subject: token, value1, value2: 0n };
  const value2 = units(daily, "daily");
  if (typeof value2 !== "bigint") return value2;
  if (value1 > value2) return { error: "The per-withdrawal cap cannot be above the daily cap." };
  return { subject: token, value1, value2 };
}
