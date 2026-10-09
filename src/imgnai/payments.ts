import { randomBytes, randomUUID } from "node:crypto";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../config.js";
import { supabase } from "../db.js";
import {
  getLastSweepGasError,
  getProtocolOperationalSnapshot,
  getSweepGasSponsorAddress,
  getSweepGasSponsorBalanceSats,
  getTokenBalance,
  getTreasuryBalanceSats,
} from "../evm.js";
import { hasSufficientMusdBacking, musdToDecimal, musdToNumber, parseMusd } from "./musd.js";
import { getHoldingsUnits, isHoldingAccount, legacyUnsweptCounts } from "../custody/holdings.js";
import {
  DAY_MS,
  checkTopUpAllowance,
  checkX402Authorization,
  checkX402Requirement,
  sumRecentTopUps,
} from "../custody/policy.js";
import { custodySigningFrozen, isRuntimeCompromised } from "../custody/state.js";
import { alertAdmins } from "../custody/watchdog.js";

const MEZO_NETWORK = "eip155:31612" as const;
const MEZO_CHAIN_ID = 31612;

export const IMGNAI_PAUSED_MESSAGE =
  "Image generation is paused until the new imgnAI payer wallet is configured. Your balance is unaffected.";
const IMGNAI_FROZEN_MESSAGE =
  "Image generation is paused while the team runs a security check. Your balance is unaffected.";

/**
 * The x402 payer: IMGNAI_PAYER_PRIVATE_KEY only (never the treasury key).
 * Unset, invalid or compromised means imgnAI signs nothing at all.
 */
function loadPayer(): ReturnType<typeof privateKeyToAccount> | null {
  const key = config.imgnai.payerPrivateKey;
  if (!key) {
    console.warn("[imgnAI] IMGNAI_PAYER_PRIVATE_KEY is not set; image generation is paused.");
    return null;
  }
  let loaded: ReturnType<typeof privateKeyToAccount>;
  try {
    loaded = privateKeyToAccount(key as `0x${string}`);
  } catch {
    console.error("[imgnAI] IMGNAI_PAYER_PRIVATE_KEY is not a valid private key; image generation is paused.");
    return null;
  }
  if (isRuntimeCompromised(loaded.address)) {
    console.error("[imgnAI] IMGNAI_PAYER_PRIVATE_KEY belongs to a compromised or retired address; image generation is paused.");
    return null;
  }
  return loaded;
}

const account = loadPayer();

/** Why imgnAI cannot sign right now (SIWX or x402), or null. */
export function imgnaiSigningUnavailableReason(): string | null {
  if (!account) return IMGNAI_PAUSED_MESSAGE;
  if (custodySigningFrozen()) return IMGNAI_FROZEN_MESSAGE;
  return null;
}

/** Every imgnAI signature (SIWX and x402) goes through this gate. */
function payer(): NonNullable<typeof account> {
  const unavailable = imgnaiSigningUnavailableReason();
  if (unavailable || !account) throw new Error(unavailable ?? IMGNAI_PAUSED_MESSAGE);
  return account;
}

/** Wallet that signs x402 payments and owns the Katana balance. */
export function getImgnaiPayerAddress(): string {
  return payer().address;
}

/** Top-up currently being paid (atomic MUSD). Nothing is signed while it is null. */
let activeTopUpAtomic: bigint | null = null;
/** Set once the x402 client has signed a payment for the active top-up. */
let activeTopUpSigned = false;
/** payTo the active top-up must pay (IMGNAI_X402_PAY_TO, else the last completed top-up's), or null. */
let activeExpectedPayTo: string | null = null;
/** payTo the server asked the active top-up to pay, recorded with the operation. */
let activeObservedPayTo: string | null = null;
const payToAlerted = new Set<string>();

async function refusePayTo(problem: string, payTo: string | null): Promise<void> {
  console.error(`[imgnAI] Refused to sign an x402 payment: ${problem}`);
  const key = (payTo ?? "").toLowerCase();
  if (payToAlerted.has(key)) return;
  payToAlerted.add(key);
  await alertAdmins(`⚠️ imgnAI top-up refused: ${problem}. If imgnAI really changed its payment address, set IMGNAI_X402_PAY_TO.`);
}

const paymentClient = new x402Client();
if (account) {
  // The x402 signer can only sign typed data, and only an EIP-3009
  // TransferWithAuthorization of MUSD for the top-up in progress. It has no
  // transaction or message signing, so no approve, Permit2 or permit path.
  registerExactEvmScheme(paymentClient, {
    signer: {
      address: account.address,
      signTypedData: async (typed) => {
        const problem = checkX402Authorization(typed, {
          chainId: MEZO_CHAIN_ID,
          asset: config.evm.tokens.MUSD.contractAddress,
          from: account.address,
          maxAmount: activeTopUpAtomic,
          payTo: activeExpectedPayTo ?? activeObservedPayTo,
        });
        if (problem) {
          console.error(`[imgnAI] Refused to sign x402 typed data: ${problem}`);
          throw new Error(`imgnAI payment refused: ${problem}`);
        }
        return payer().signTypedData(typed as Parameters<typeof account.signTypedData>[0]);
      },
    },
    networks: [MEZO_NETWORK],
  });
}
// Only ever consider Mezo mainnet requirements, then screen the chosen one
// before it is signed: MUSD, and never more than the top-up the bot asked for.
paymentClient.registerPolicy((_version, requirements) => requirements.filter((req) => req.network === MEZO_NETWORK));
paymentClient.onBeforePaymentCreation(async ({ selectedRequirements }) => {
  if (activeTopUpAtomic == null) return { abort: true, reason: "no imgnAI top-up is in progress" };
  activeObservedPayTo = typeof selectedRequirements.payTo === "string" ? selectedRequirements.payTo.toLowerCase() : null;
  const problem = checkX402Requirement(selectedRequirements, {
    network: MEZO_NETWORK,
    asset: config.evm.tokens.MUSD.contractAddress,
    maxAmount: activeTopUpAtomic,
    payTo: activeExpectedPayTo,
  });
  if (!problem) return;
  if (/payTo/.test(problem)) await refusePayTo(problem, activeObservedPayTo);
  else console.error(`[imgnAI] Refused to sign an x402 payment: ${problem}`);
  return { abort: true, reason: problem };
});
paymentClient.onAfterPaymentCreation(async () => {
  activeTopUpSigned = true;
});
const fetchWithPayment = wrapFetchWithPayment(fetch, paymentClient);

/**
 * IMGNAI_X402_MAX_TOPUP_MUSD per top-up and IMGNAI_X402_DAILY_MAX_MUSD per
 * rolling 24h (summed from imgnai_x402_operations), before anything is signed.
 */
async function assertTopUpAllowed(amountAtomic: bigint): Promise<void> {
  // NUMERIC read as text so large atomic amounts parse exactly.
  const { data, error } = await supabase
    .from("imgnai_x402_operations")
    .select("amount_musd_atomic::text, status, response, created_at")
    .eq("operation_type", "topup")
    .gte("created_at", new Date(Date.now() - DAY_MS).toISOString());
  if (error) throw new Error(`Could not check the imgnAI top-up limit: ${error.message}`);
  const check = checkTopUpAllowance({
    amount: amountAtomic,
    maxPerTopUp: parseMusd(config.imgnai.x402MaxTopupMusd),
    dailyMax: parseMusd(config.imgnai.x402DailyMaxMusd),
    usedToday: sumRecentTopUps(data ?? [], Date.now()),
  });
  if (!check.ok) throw new Error(`imgnAI top-up refused: ${check.reason}`);
}

/**
 * The address a top-up may pay: IMGNAI_X402_PAY_TO when set, otherwise the
 * payTo recorded by the last completed top-up (null before the first one).
 */
async function expectedPayTo(): Promise<string | null> {
  if (config.imgnai.x402PayTo) return config.imgnai.x402PayTo.toLowerCase();
  const { data, error } = await supabase
    .from("imgnai_x402_operations")
    .select("pay_to:response->>pay_to")
    .eq("operation_type", "topup")
    .eq("status", "completed")
    .not("response->>pay_to", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Could not read the last imgnAI payment address: ${error.message}`);
  const payTo = (data as { pay_to?: unknown } | null)?.pay_to;
  return typeof payTo === "string" && payTo ? payTo.toLowerCase() : null;
}

let fundingLock: Promise<void> = Promise.resolve();
let lastTopUp: { at: string; amountAtomic: string; error: string | null } | null = null;

function decimalAmount(value: unknown): bigint {
  return parseMusd(String(value ?? "0"));
}

export async function createSignInWithXHeader(): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const signer = payer();
  const address = signer.address;
  const nonce = randomBytes(16).toString("hex");
  const message = [
    "imgnAI X-Sign-In-With-X",
    `Wallet: ${address}`,
    `Network: ${MEZO_NETWORK}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join("\n");
  const signature = await signer.signMessage({ message });
  return Buffer.from(JSON.stringify({
    network: MEZO_NETWORK,
    address,
    message,
    signature,
    issued_at: issuedAt,
  }), "utf8").toString("base64");
}

export async function getKatanaWalletBalance(): Promise<bigint> {
  const proof = await createSignInWithXHeader();
  const response = await fetch(`${config.imgnai.baseUrl}/v1/x402/balance/${payer().address}`, {
    headers: { "X-Sign-In-With-X": proof, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Katana balance returned HTTP ${response.status}`);
  const body = await response.json() as Record<string, unknown>;
  return decimalAmount(body.balance_decimal ?? body.balance_usdc ?? body.balance);
}

async function topUpKatanaBalance(amountAtomic: bigint): Promise<void> {
  if (amountAtomic <= 0n) return;
  const payerAccount = payer();
  await assertTopUpAllowed(amountAtomic);
  const pinnedPayTo = await expectedPayTo();
  const amountDecimal = musdToDecimal(amountAtomic);
  const operationId = randomUUID();
  const idempotencyKey = `katana-topup-${operationId}`;
  // The daily cap counts these rows: without one, nothing is paid.
  const { error: insertError } = await supabase.from("imgnai_x402_operations").insert({
    id: operationId,
    operation_type: "topup",
    idempotency_key: idempotencyKey,
    amount_musd: musdToNumber(amountAtomic),
    amount_musd_atomic: amountAtomic.toString(),
    status: "pending",
    wallet_address: payerAccount.address,
    network: MEZO_NETWORK,
  });
  if (insertError) throw new Error(`imgnAI top-up not started: could not record it (${insertError.message})`);

  activeTopUpAtomic = amountAtomic;
  activeTopUpSigned = false;
  activeExpectedPayTo = pinnedPayTo;
  activeObservedPayTo = null;
  try {
    const response = await fetchWithPayment(`${config.imgnai.baseUrl}/v1/x402/top-up`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ amount_usdc: amountDecimal }),
      signal: AbortSignal.timeout(120_000),
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      const detail = String(body.error ?? body.message ?? `HTTP ${response.status}`);
      throw new Error(`Katana top-up failed: ${detail}`);
    }
    await supabase.from("imgnai_x402_operations").update({
      status: "completed",
      transaction_id: String(body.transaction_id ?? body.tx_hash ?? "") || null,
      asset: String(body.asset ?? "") || null,
      // pay_to pins the payment address for later top-ups (unless IMGNAI_X402_PAY_TO is set).
      response: { ...body, pay_to: activeObservedPayTo },
      updated_at: new Date().toISOString(),
    }).eq("id", operationId);
    lastTopUp = { at: new Date().toISOString(), amountAtomic: amountAtomic.toString(), error: null };
  } catch (error) {
    const message = (error as Error).message;
    await supabase.from("imgnai_x402_operations").update({
      status: "failed",
      error_message: message,
      // A failure before any payment was signed does not count toward the daily cap.
      response: { payment_signed: activeTopUpSigned, pay_to: activeObservedPayTo },
      updated_at: new Date().toISOString(),
    }).eq("id", operationId);
    lastTopUp = { at: new Date().toISOString(), amountAtomic: amountAtomic.toString(), error: message };
    throw error;
  } finally {
    activeTopUpAtomic = null;
    activeExpectedPayTo = null;
  }
}

export async function ensureKatanaBalance(requiredMusdAtomic: bigint): Promise<bigint> {
  let resolvedBalance = 0n;
  const run = fundingLock.then(async () => {
    if (config.evm.chainId !== 31612) throw new Error("imgnAI payments require Mezo mainnet chain 31612");
    const balance = await getKatanaWalletBalance();
    // Holdings are the vault + HotPayout in custody v2, the treasury otherwise.
    const holdingsUnits = await getHoldingsUnits("MUSD");
    const payerUnits = await getTokenBalance(payer().address, "MUSD");
    const payerIsHolding = isHoldingAccount(payer().address);
    const snapshot = await getProtocolOperationalSnapshot();
    // v1 deposit addresses count only in legacy mode with an uncompromised key.
    const unswept = legacyUnsweptCounts() ? snapshot.unsweptMusdAtomic : 0n;
    const totalAssets = holdingsUnits + (payerIsHolding ? 0n : payerUnits) + balance + unswept;
    const totalObligations = snapshot.userMusdAtomic + snapshot.pendingMusdAtomic;
    if (!hasSufficientMusdBacking(totalAssets, totalObligations)) {
      throw new Error("Protocol MUSD assets are below user and pending-generation obligations");
    }
    if (balance >= requiredMusdAtomic) {
      resolvedBalance = balance;
      return;
    }

    const configuredTarget = parseMusd(config.imgnai.x402TargetMusd);
    const target = configuredTarget > requiredMusdAtomic ? configuredTarget : requiredMusdAtomic;
    const amount = target - balance;
    if (payerUnits < amount) {
      throw new Error(`imgnAI payer wallet needs ${musdToDecimal(amount)} MUSD to fund imgnAI`);
    }
    await topUpKatanaBalance(amount);
    resolvedBalance = await getKatanaWalletBalance();
    if (resolvedBalance < requiredMusdAtomic) throw new Error("Katana balance is still insufficient after top-up");
  });
  fundingLock = run.catch(() => {});
  await run;
  return resolvedBalance;
}

export async function katanaWalletFetch(url: string, init: RequestInit): Promise<Response> {
  const proof = await createSignInWithXHeader();
  const headers = new Headers(init.headers);
  headers.set("X-Sign-In-With-X", proof);
  headers.set("Accept", "application/json");
  return fetch(url, { ...init, headers });
}

export async function getImgnaiOperationalStatus(): Promise<{
  treasuryMusd: bigint | null;
  katanaMusd: bigint | null;
  pendingJobs: number;
  lastTopUp: typeof lastTopUp;
  treasurySats: number | null;
  gasSponsorSats: number | null;
  gasSponsorAddress: string;
  gasSponsorIsTreasury: boolean;
  gasReserveMinimumSats: number;
  userSatsLiability: number | null;
  poolSatsLiability: number | null;
  userMusdAtomic: bigint | null;
  /** MUSD at v1 deposit addresses, as recorded. */
  unsweptMusdAtomic: bigint | null;
  /** Whether unsweptMusdAtomic counts as an asset (legacy mode with an uncompromised key only). */
  unsweptCounted: boolean;
  pendingMusdAtomic: bigint | null;
  pendingSweeps: number | null;
  sweepErrors: number | null;
  lastSweepGasError: string | null;
}> {
  const [treasury, katana, pending, treasurySats, gasSponsorSats, snapshot] = await Promise.all([
    getHoldingsUnits("MUSD").catch(() => null),
    getKatanaWalletBalance().catch(() => null),
    supabase.from("imgnai_generation_jobs").select("id", { count: "exact", head: true })
      .in("status", ["reserved", "funding", "submitted", "polling", "delivery_pending", "refund_pending", "inconclusive"]),
    getTreasuryBalanceSats().catch(() => null),
    getSweepGasSponsorBalanceSats().catch(() => null),
    getProtocolOperationalSnapshot().catch(() => null),
  ]);
  let gasSponsorAddress = "";
  try {
    gasSponsorAddress = getSweepGasSponsorAddress();
  } catch {
    // no sweep gas wallet in this mode
  }
  return {
    treasuryMusd: treasury,
    katanaMusd: katana,
    pendingJobs: pending.count ?? 0,
    lastTopUp,
    treasurySats,
    gasSponsorSats,
    gasSponsorAddress,
    gasSponsorIsTreasury: !!gasSponsorAddress && isHoldingAccount(gasSponsorAddress),
    gasReserveMinimumSats: config.evm.protocolGasReserveMinSats,
    userSatsLiability: snapshot?.userSatsLiability ?? null,
    poolSatsLiability: snapshot?.poolSatsLiability ?? null,
    userMusdAtomic: snapshot?.userMusdAtomic ?? null,
    unsweptMusdAtomic: snapshot?.unsweptMusdAtomic ?? null,
    unsweptCounted: legacyUnsweptCounts(),
    pendingMusdAtomic: snapshot?.pendingMusdAtomic ?? null,
    pendingSweeps: snapshot?.pendingSweeps ?? null,
    sweepErrors: snapshot?.sweepErrors ?? null,
    lastSweepGasError: getLastSweepGasError(),
  };
}
