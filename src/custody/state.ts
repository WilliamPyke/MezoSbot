import { ethers } from "ethers";
import { config } from "../config.js";
import { DEPOSIT_FACTORY_ABI, HOT_PAYOUT_ABI } from "./abi.js";
import { CUSTODY_PAUSED_MESSAGE } from "./compromised.js";
import { depositSalt } from "./forwarder.js";
import { isCompromisedAddress } from "./compromised.js";
import {
  PROBE_DISCORD_ID,
  checkCustodyConfig,
  checkV2Chain,
  retiredKeyAddresses,
  type CustodyConfigCheck,
  type CustodyEnv,
  type CustodyMode,
  type V2ChainState,
  type V2Settings,
} from "./policy.js";
import { ethCall, getChainId, getCode, isRevertError } from "./rpc.js";
import { readFreezeFlag } from "./store.js";

/**
 * Process-wide custody state: the mode (decided once at boot, see
 * checkCustodyConfig/checkV2Chain), the v2 role wallets, and the watchdog
 * freeze that blocks every v2 signature.
 */

const custodyEnv: CustodyEnv = {
  treasuryPrivateKey: config.evm.treasuryPrivateKey,
  vaultAddress: config.custody.vaultAddress,
  depositFactoryAddress: config.custody.depositFactoryAddress,
  forwarderImplementation: config.custody.forwarderImplementation,
  depositFactoryStartBlock: config.custody.depositFactoryStartBlock,
  hotPayoutAddress: config.custody.hotPayoutAddress,
  payoutOperatorPrivateKey: config.custody.payoutOperatorPrivateKey,
  payoutGuardianPrivateKey: config.custody.payoutGuardianPrivateKey,
  sweepGasPrivateKey: config.custody.sweepGasPrivateKey,
  escrowSettlerPrivateKey: config.web.escrowSettlerPrivateKey,
  imgnaiPayerPrivateKey: config.imgnai.payerPrivateKey,
  sweepGasSponsorPrivateKey: config.evm.sweepGasSponsorPrivateKey,
};

/** Retired v1 key addresses (treasury, derived sponsor, v1 sponsor key), see retiredKeyAddresses. */
const retired = new Set(retiredKeyAddresses(custodyEnv));

/** Known-compromised addresses plus the retired v1 keys of this deployment. */
export function isRuntimeCompromised(address: string | null | undefined): boolean {
  return isCompromisedAddress(address) || (!!address && retired.has(address.trim().toLowerCase()));
}

const configCheck: CustodyConfigCheck = checkCustodyConfig(custodyEnv, isRuntimeCompromised);

const V2_PENDING_REASON = "custody v2 on-chain checks have not passed yet";

let mode: CustodyMode = configCheck.mode === "v2" ? "paused" : configCheck.mode;
let reasons: string[] = configCheck.mode === "v2" ? [V2_PENDING_REASON] : configCheck.reasons;
let active: V2Settings | null = null;
let chainPaused: boolean | null = null;

export type FreezeState = { reason: string; at: string; persisted: boolean; keys: string[] };
let frozen: FreezeState | null = null;
/** Signing stays blocked until the persisted freeze flag has been read once. */
let freezeFlagKnown = false;

const activationListeners: Array<() => void> = [];
let retryTimer: ReturnType<typeof setTimeout> | null = null;

export function getCustodyMode(): CustodyMode {
  return mode;
}

/** Why the bot is in its current mode (empty when nothing is wrong). */
export function getCustodyReasons(): string[] {
  return [...reasons];
}

/** v2 settings once the on-chain checks have passed; null otherwise. */
export function getV2Settings(): V2Settings | null {
  return active;
}

/**
 * Statically valid v2 settings even while paused (for read-only recovery
 * checks such as HotPayout.paid(ref)); null when v2 is not configured.
 */
export function getConfiguredV2Settings(): V2Settings | null {
  return configCheck.mode === "v2" ? configCheck.settings : null;
}

/** HotPayout.paused() as read at boot; null when unknown. */
export function getBootPayoutPaused(): boolean | null {
  return chainPaused;
}

function wallet(key: string | null | undefined): ethers.Wallet | null {
  return key ? new ethers.Wallet(key) : null;
}

let wallets: { operator: ethers.Wallet; sweepGas: ethers.Wallet; guardian: ethers.Wallet | null } | null = null;

function roleWallets() {
  if (!active) return null;
  wallets ??= {
    operator: new ethers.Wallet(active.operatorKey),
    sweepGas: new ethers.Wallet(active.sweepGasKey),
    guardian: wallet(active.guardianKey),
  };
  return wallets;
}

export function getOperatorWallet(): ethers.Wallet | null {
  return roleWallets()?.operator ?? null;
}

export function getSweepGasWallet(): ethers.Wallet | null {
  return roleWallets()?.sweepGas ?? null;
}

export function getGuardianWallet(): ethers.Wallet | null {
  return roleWallets()?.guardian ?? null;
}

/* ─────────── Freeze ─────────── */

export function getFreezeState(): FreezeState | null {
  return frozen ? { ...frozen } : null;
}

export function isCustodyFrozen(): boolean {
  return frozen != null || !freezeFlagKnown;
}

/**
 * For signers outside the v2 roles (imgnAI payer): a freeze blocks them too.
 * Outside v2 the flag is not loaded, so only an in-process freeze counts.
 */
export function custodySigningFrozen(): boolean {
  return mode === "v2" ? isCustodyFrozen() : frozen != null;
}

export function setFreezeState(state: FreezeState | null): void {
  frozen = state ? { ...state } : null;
}

export function markFreezeFlagKnown(): void {
  freezeFlagKnown = true;
}

export class CustodySigningBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustodySigningBlockedError";
  }
}

/** Every v2 signature (operator, sweep gas, guardian) goes through this gate. */
export function assertCanSign(): void {
  if (mode !== "v2") throw new CustodySigningBlockedError(`custody v2 is not active (${mode})`);
  if (frozen) throw new CustodySigningBlockedError(`custody is frozen: ${frozen.reason}`);
  if (!freezeFlagKnown) throw new CustodySigningBlockedError("custody freeze flag has not been read yet");
}

/* ─────────── User-facing gates ─────────── */

export const CUSTODY_FROZEN_MESSAGE =
  "On-chain withdrawals are temporarily paused while the team runs a security check. " +
  "Balances in the bot are unaffected.";

/** Reason deposit addresses cannot be issued right now, or null. */
export function depositsBlockedMessage(): string | null {
  return mode === "paused" ? CUSTODY_PAUSED_MESSAGE : null;
}

/** Reason on-chain withdrawals cannot run right now, or null. */
export function withdrawalsBlockedMessage(): string | null {
  if (mode === "paused") return CUSTODY_PAUSED_MESSAGE;
  if (mode === "v2" && isCustodyFrozen()) return CUSTODY_FROZEN_MESSAGE;
  return null;
}

/* ─────────── Boot ─────────── */

const FACTORY = new ethers.Interface(DEPOSIT_FACTORY_ABI);
const PAYOUT = new ethers.Interface(HOT_PAYOUT_ABI);

/**
 * "" when the call reverts or returns nothing decodable (a genuine mismatch:
 * wrong or missing contract). Transport failures and other JSON-RPC errors
 * (rate limits, node errors) throw, and the boot check is retried.
 */
async function readAddress(to: string, iface: ethers.Interface, fn: string, args: unknown[] = []): Promise<string> {
  try {
    const raw = await ethCall(to, iface.encodeFunctionData(fn, args));
    return String(iface.decodeFunctionResult(fn, raw)[0]).toLowerCase();
  } catch (error) {
    if (isRevertError(error) || ethers.isError(error, "BAD_DATA")) return "";
    throw error;
  }
}

async function readChainState(settings: V2Settings): Promise<V2ChainState> {
  const [chainId, factoryCode, implementationCode, payoutCode] = await Promise.all([
    getChainId(),
    getCode(settings.factory),
    getCode(settings.implementation),
    getCode(settings.payout),
  ]);
  const [factoryVault, factoryImplementation, factoryPredict, payoutVault, payoutOperator, payoutGuardian] = await Promise.all([
    readAddress(settings.factory, FACTORY, "vault"),
    readAddress(settings.factory, FACTORY, "implementation"),
    readAddress(settings.factory, FACTORY, "predict", [depositSalt(PROBE_DISCORD_ID)]),
    readAddress(settings.payout, PAYOUT, "vault"),
    readAddress(settings.payout, PAYOUT, "operator"),
    readAddress(settings.payout, PAYOUT, "guardian"),
  ]);
  return {
    chainId,
    factoryCode,
    implementationCode,
    payoutCode,
    factoryVault,
    factoryImplementation,
    factoryPredict,
    payoutVault,
    payoutOperator,
    payoutGuardian,
  };
}

async function readPaused(settings: V2Settings): Promise<boolean | null> {
  try {
    const raw = await ethCall(settings.payout, PAYOUT.encodeFunctionData("paused"));
    return Boolean(PAYOUT.decodeFunctionResult("paused", raw)[0]);
  } catch {
    return null;
  }
}

/**
 * Sync the in-process freeze with bot_settings. A flag present anywhere
 * freezes this process; a missing flag clears a freeze that had been
 * persisted (an admin cleared it, possibly from another replica) but keeps
 * one whose write has not landed yet.
 */
async function loadFreezeFlag(logState: boolean): Promise<void> {
  try {
    const flag = await readFreezeFlag();
    if (flag) {
      // Keep anomaly keys this process recorded but could not persist yet.
      const stored = flag.keys ?? [];
      const pending = frozen && !frozen.persisted ? frozen.keys.filter((key) => !stored.includes(key)) : [];
      setFreezeState({ reason: flag.reason, at: flag.at, keys: [...stored, ...pending], persisted: pending.length === 0 });
    } else if (!frozen?.persisted) setFreezeState(frozen);
    else setFreezeState(null);
    if (!flag && frozen == null && logState && !freezeFlagKnown) console.log("[Custody] No custody freeze is set.");
    markFreezeFlagKnown();
    if (flag && logState) {
      console.error(`[Custody] Custody is FROZEN since ${flag.at || "an earlier run"}: ${flag.reason}. An admin must run /custody unfreeze.`);
    }
  } catch (error) {
    if (logState || !freezeFlagKnown) {
      console.error(`[Custody] Could not read the freeze flag${freezeFlagKnown ? "" : "; v2 signing stays blocked until it is readable"}: ${(error as Error).message}`);
    }
  }
}

function activate(settings: V2Settings): void {
  active = settings;
  mode = "v2";
  reasons = [];
  console.log(
    `[Custody] Mode v2: vault ${ethers.getAddress(settings.vault)}, factory ${ethers.getAddress(settings.factory)}, ` +
    `HotPayout ${ethers.getAddress(settings.payout)}, operator ${ethers.getAddress(settings.operator)}, ` +
    `sweep gas ${ethers.getAddress(settings.sweepGas)}${settings.guardian ? `, guardian ${ethers.getAddress(settings.guardian)}` : ""}`,
  );
  for (const listener of activationListeners.splice(0)) {
    try {
      listener();
    } catch (error) {
      console.error("[Custody] Activation listener failed:", (error as Error).message);
    }
  }
}

const CHAIN_CHECK_RETRY_MS = 60_000;

async function runChainCheck(settings: V2Settings): Promise<void> {
  let state: V2ChainState;
  try {
    state = await readChainState(settings);
  } catch (error) {
    // RPC unreachable or erroring: stay paused, retry. Mismatches below never retry.
    reasons = [`custody v2 on-chain checks could not run (${(error as Error).message}); retrying every minute`];
    console.error(`[Custody] PAUSED: ${reasons[0]}`);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      runChainCheck(settings).catch(() => {});
    }, CHAIN_CHECK_RETRY_MS);
    retryTimer.unref?.();
    return;
  }
  const problems = checkV2Chain(settings, state, config.evm.chainId);
  if (problems.length > 0) {
    reasons = problems;
    console.error(
      "[Custody] PAUSED: custody v2 on-chain checks FAILED. Deposits and withdrawals stay off until the " +
      `configuration is fixed and the bot restarts:\n  - ${problems.join("\n  - ")}`,
    );
    return;
  }
  chainPaused = await readPaused(settings);
  if (chainPaused) console.warn("[Custody] HotPayout is paused on-chain; withdrawals will be refused until the vault unpauses it.");
  await loadFreezeFlag(true);
  activate(settings);
}

/**
 * Decide the custody mode. Never throws: a failed v2 check leaves the bot in
 * "paused" (safe mode) with the reasons logged and shown in /treasury. The
 * bot calls it in the background; the mode stays "paused" until it decides.
 */
export async function initCustody(): Promise<void> {
  if (configCheck.mode !== "v2") {
    if (configCheck.mode === "paused") {
      console.error(`[Custody] PAUSED: ${configCheck.reasons.join("; ")}. Deposits, sweeps and withdrawals are off.`);
    } else {
      console.log(`[Custody] Mode legacy: treasury hot wallet ${ethers.getAddress(configCheck.treasury)}`);
    }
    return;
  }
  try {
    await runChainCheck(configCheck.settings);
  } catch (error) {
    reasons = [`custody v2 boot check failed: ${(error as Error).message}`];
    console.error(`[Custody] PAUSED: ${reasons[0]}`);
  }
}

/** Run `fn` once custody v2 is active (now, or after a delayed boot check passes). */
export function onCustodyV2(fn: () => void): void {
  if (mode === "v2") fn();
  else if (configCheck.mode === "v2") activationListeners.push(fn);
}

/** Re-read the persisted freeze flag (the watchdog calls this every pass). */
export async function refreshFreezeFlag(): Promise<void> {
  await loadFreezeFlag(false);
}
