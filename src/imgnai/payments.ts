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
  getTreasuryAddress,
  getTreasuryBalanceSats,
} from "../evm.js";
import { hasSufficientMusdBacking, musdToDecimal, musdToNumber, parseMusd } from "./musd.js";

const MEZO_NETWORK = "eip155:31612" as const;
const account = privateKeyToAccount(config.evm.treasuryPrivateKey as `0x${string}`);
const paymentClient = new x402Client();
registerExactEvmScheme(paymentClient, {
  signer: account,
  networks: [MEZO_NETWORK],
  schemeOptions: { rpcUrl: config.evm.rpcUrl },
});
const fetchWithPayment = wrapFetchWithPayment(fetch, paymentClient);

let fundingLock: Promise<void> = Promise.resolve();
let lastTopUp: { at: string; amountAtomic: string; error: string | null } | null = null;

function decimalAmount(value: unknown): bigint {
  return parseMusd(String(value ?? "0"));
}

export async function createSignInWithXHeader(): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const address = account.address;
  const nonce = randomBytes(16).toString("hex");
  const message = [
    "imgnAI X-Sign-In-With-X",
    `Wallet: ${address}`,
    `Network: ${MEZO_NETWORK}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join("\n");
  const signature = await account.signMessage({ message });
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
  const response = await fetch(`${config.imgnai.baseUrl}/v1/x402/balance/${account.address}`, {
    headers: { "X-Sign-In-With-X": proof, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Katana balance returned HTTP ${response.status}`);
  const body = await response.json() as Record<string, unknown>;
  return decimalAmount(body.balance_decimal ?? body.balance_usdc ?? body.balance);
}

async function topUpKatanaBalance(amountAtomic: bigint): Promise<void> {
  if (amountAtomic <= 0n) return;
  const amountDecimal = musdToDecimal(amountAtomic);
  const operationId = randomUUID();
  const idempotencyKey = `katana-topup-${operationId}`;
  await supabase.from("imgnai_x402_operations").insert({
    id: operationId,
    operation_type: "topup",
    idempotency_key: idempotencyKey,
    amount_musd: musdToNumber(amountAtomic),
    amount_musd_atomic: amountAtomic.toString(),
    status: "pending",
    wallet_address: account.address,
    network: MEZO_NETWORK,
  });

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
      response: body,
      updated_at: new Date().toISOString(),
    }).eq("id", operationId);
    lastTopUp = { at: new Date().toISOString(), amountAtomic: amountAtomic.toString(), error: null };
  } catch (error) {
    const message = (error as Error).message;
    await supabase.from("imgnai_x402_operations").update({
      status: "failed",
      error_message: message,
      updated_at: new Date().toISOString(),
    }).eq("id", operationId);
    lastTopUp = { at: new Date().toISOString(), amountAtomic: amountAtomic.toString(), error: message };
    throw error;
  }
}

export async function ensureKatanaBalance(requiredMusdAtomic: bigint): Promise<bigint> {
  let resolvedBalance = 0n;
  const run = fundingLock.then(async () => {
    if (config.evm.chainId !== 31612) throw new Error("imgnAI payments require Mezo mainnet chain 31612");
    const balance = await getKatanaWalletBalance();
    const treasuryUnits = await getTokenBalance(getTreasuryAddress(), "MUSD");
    const snapshot = await getProtocolOperationalSnapshot();
    const totalAssets = treasuryUnits + balance + snapshot.unsweptMusdAtomic;
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
    if (treasuryUnits < amount) {
      throw new Error(`Treasury needs ${musdToDecimal(amount)} MUSD to fund imgnAI`);
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
  unsweptMusdAtomic: bigint | null;
  pendingMusdAtomic: bigint | null;
  pendingSweeps: number | null;
  sweepErrors: number | null;
  lastSweepGasError: string | null;
}> {
  const [treasury, katana, pending, treasurySats, gasSponsorSats, snapshot] = await Promise.all([
    getTokenBalance(getTreasuryAddress(), "MUSD").catch(() => null),
    getKatanaWalletBalance().catch(() => null),
    supabase.from("imgnai_generation_jobs").select("id", { count: "exact", head: true })
      .in("status", ["reserved", "funding", "submitted", "polling", "delivery_pending", "refund_pending", "inconclusive"]),
    getTreasuryBalanceSats().catch(() => null),
    getSweepGasSponsorBalanceSats().catch(() => null),
    getProtocolOperationalSnapshot().catch(() => null),
  ]);
  const gasSponsorAddress = getSweepGasSponsorAddress();
  return {
    treasuryMusd: treasury,
    katanaMusd: katana,
    pendingJobs: pending.count ?? 0,
    lastTopUp,
    treasurySats,
    gasSponsorSats,
    gasSponsorAddress,
    gasSponsorIsTreasury: gasSponsorAddress.toLowerCase() === getTreasuryAddress().toLowerCase(),
    gasReserveMinimumSats: config.evm.protocolGasReserveMinSats,
    userSatsLiability: snapshot?.userSatsLiability ?? null,
    poolSatsLiability: snapshot?.poolSatsLiability ?? null,
    userMusdAtomic: snapshot?.userMusdAtomic ?? null,
    unsweptMusdAtomic: snapshot?.unsweptMusdAtomic ?? null,
    pendingMusdAtomic: snapshot?.pendingMusdAtomic ?? null,
    pendingSweeps: snapshot?.pendingSweeps ?? null,
    sweepErrors: snapshot?.sweepErrors ?? null,
    lastSweepGasError: getLastSweepGasError(),
  };
}
