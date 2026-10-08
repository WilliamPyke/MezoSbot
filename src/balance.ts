import { supabase } from "./db.js";
import { roundSats } from "./format.js";
import { TOKEN_SYMBOLS, formatTokenAmount, roundTokenAmount, type TokenSymbol } from "./tokens.js";
import { parseMusd } from "./imgnai/musd.js";
import {
  CREDIT_NOT_ATTEMPTED_CODE,
  isDefiniteDbFailure,
  summarizeCredits,
  type CreditOutcome,
} from "./depositPolicy.js";

export async function getOrCreateUser(discordId: string) {
  // Use upsert with onConflict to avoid duplicate inserts, select to return the row
  const { data, error } = await supabase
    .from("users")
    .upsert({ discord_id: discordId }, { onConflict: "discord_id", ignoreDuplicates: true })
    .select("*")
    .single();

  if (error) {
    // If upsert failed, fall back to select (row may already exist)
    const { data: existing } = await supabase
      .from("users")
      .select("*")
      .eq("discord_id", discordId)
      .single();
    return existing as { discord_id: string; wallet_address: string | null; balance_sats: number };
  }

  return data as { discord_id: string; wallet_address: string | null; balance_sats: number };
}

export async function getBalance(discordId: string, token: TokenSymbol = "SATS"): Promise<number> {
  if (token !== "SATS") {
    const { data } = await supabase
      .from("user_token_balances")
      .select("balance")
      .eq("discord_id", discordId)
      .eq("token", token)
      .maybeSingle();
    return Number(data?.balance ?? 0);
  }
  const { data } = await supabase
    .from("users")
    .select("balance_sats")
    .eq("discord_id", discordId)
    .single();

  return data?.balance_sats ?? 0;
}

/** Exact MUSD balance used by payment paths. Requires the atomic-balance migration. */
export async function getMusdBalanceAtomic(discordId: string): Promise<bigint> {
  const { data, error } = await supabase
    .from("user_token_balances")
    .select("balance_atomic, balance")
    .eq("discord_id", discordId)
    .eq("token", "MUSD")
    .maybeSingle();
  if (error) throw error;
  if (data?.balance_atomic != null) return BigInt(String(data.balance_atomic));
  return parseMusd(String(data?.balance ?? "0"));
}

export async function getBalances(discordId: string): Promise<Record<TokenSymbol, number>> {
  const sats = await getBalance(discordId, "SATS");
  const { data } = await supabase
    .from("user_token_balances")
    .select("token, balance")
    .eq("discord_id", discordId);
  const balances = { SATS: sats, MUSD: 0, MEZO: 0, MUSDC: 0 } satisfies Record<TokenSymbol, number>;
  for (const row of data ?? []) {
    if ((TOKEN_SYMBOLS as readonly string[]).includes(row.token) && row.token !== "SATS") {
      balances[row.token as TokenSymbol] = Number(row.balance ?? 0);
    }
  }
  return balances;
}

/**
 * Credit a balance. Throws when the RPC fails so callers never assume a credit
 * landed; use isDefiniteDbFailure(error) to tell "did not apply" from "may have".
 */
export async function addBalance(discordId: string, amountSats: number, token: TokenSymbol = "SATS"): Promise<void> {
  // add_balance silently updates zero rows for a missing user, so the row must exist first.
  if (!(await getOrCreateUser(discordId))) {
    throw Object.assign(new Error(`User ${discordId} could not be loaded for a balance credit`), {
      code: CREDIT_NOT_ATTEMPTED_CODE,
    });
  }
  const rounded = token === "SATS" ? roundSats(amountSats) : roundTokenAmount(amountSats, token);
  const { error } = token === "SATS"
    ? await supabase.rpc("add_balance", { p_discord_id: discordId, p_amount: rounded })
    : await supabase.rpc("add_token_balance", { p_discord_id: discordId, p_token: token, p_amount: rounded });
  if (error) throw error;
}

export type CreditResult = { discordId: string; amount: number; outcome: CreditOutcome; error?: string };

/** Credit each recipient independently. Never throws; see CreditOutcome. */
export async function creditRecipients(
  credits: ReadonlyArray<{ discordId: string; amount: number }>,
  token: TokenSymbol,
): Promise<CreditResult[]> {
  return Promise.all(credits.map(async ({ discordId, amount }): Promise<CreditResult> => {
    try {
      await addBalance(discordId, amount, token);
      return { discordId, amount, outcome: "credited" };
    } catch (error) {
      const message = (error as Error)?.message ?? String(error);
      return { discordId, amount, outcome: isDefiniteDbFailure(error) ? "failed" : "unconfirmed", error: message };
    }
  }));
}

/**
 * After one upfront debit paid for several credits, give the sender back the
 * shares that provably failed. Unconfirmed shares may have landed, so they are
 * logged for manual repair rather than refunded. Returns the amount refunded.
 */
export async function refundUndeliveredCredits(
  senderId: string,
  results: readonly CreditResult[],
  token: TokenSymbol,
  context: string,
): Promise<{ refunded: number; refundConfirmed: boolean }> {
  const { failed, unconfirmed, failedTotal } = summarizeCredits(results);
  for (const result of unconfirmed) {
    console.error(
      `[${context}] MANUAL REPAIR: credit of ${result.amount} ${token} from ${senderId} to ${result.discordId} ` +
      `is unconfirmed (${result.error}); check the recipient's balance before refunding the sender`,
    );
  }
  const refund = token === "SATS" ? roundSats(failedTotal) : roundTokenAmount(failedTotal, token);
  if (refund <= 0) return { refunded: 0, refundConfirmed: true };
  try {
    await addBalance(senderId, refund, token);
    return { refunded: refund, refundConfirmed: true };
  } catch (error) {
    console.error(
      `[${context}] MANUAL REPAIR: refund of ${refund} ${token} to ${senderId} for undelivered credits to ` +
      `${failed.map((result) => result.discordId).join(", ")} ${isDefiniteDbFailure(error) ? "failed" : "is unconfirmed"}: ` +
      `${(error as Error)?.message ?? error}`,
    );
    return { refunded: 0, refundConfirmed: false };
  }
}

/** User-facing note about shares that did not land, or null when every credit did. */
export function describeUndeliveredCredits(
  results: readonly CreditResult[],
  settlement: { refunded: number; refundConfirmed: boolean },
  token: TokenSymbol,
): string | null {
  const { failed, unconfirmed } = summarizeCredits(results);
  const lines: string[] = [];
  if (failed.length > 0) {
    lines.push(settlement.refundConfirmed
      ? `${failed.length} recipient(s) could not be credited; ${formatTokenAmount(settlement.refunded, token)} was refunded to you.`
      : `${failed.length} recipient(s) could not be credited and the refund did not go through; an admin has been alerted.`);
  }
  if (unconfirmed.length > 0) {
    lines.push(`${unconfirmed.length} credit(s) could not be confirmed; an admin has been alerted to reconcile them. Please don't resend.`);
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

export async function subtractBalance(discordId: string, amountSats: number, token: TokenSymbol = "SATS"): Promise<boolean> {
  const rounded = token === "SATS" ? roundSats(amountSats) : roundTokenAmount(amountSats, token);
  if (rounded <= 0) return false;
  const { data, error } = token === "SATS"
    ? await supabase.rpc("subtract_balance_if_sufficient", { p_discord_id: discordId, p_amount: rounded })
    : await supabase.rpc("subtract_token_balance_if_sufficient", {
      p_discord_id: discordId, p_token: token, p_amount: rounded,
    });
  if (error) throw error;
  return data === true;
}

export async function reserveWithdrawalBalances(
  discordId: string,
  amount: number,
  token: Exclude<TokenSymbol, "SATS">,
  gasSats: number,
): Promise<"ok" | "insufficient_token" | "insufficient_sats"> {
  const { data, error } = await supabase.rpc("reserve_token_withdrawal", {
    p_discord_id: discordId,
    p_token: token,
    p_token_amount: roundTokenAmount(amount, token),
    p_gas_sats: roundSats(gasSats),
  });
  if (error) throw error;
  if (data === "ok" || data === "insufficient_token" || data === "insufficient_sats") return data;
  throw new Error(`Unexpected withdrawal reservation result: ${String(data)}`);
}

export async function subtractBalances(
  debits: Array<{ discordId: string; amountSats: number }>,
): Promise<void> {
  const payload = debits
    .map((debit) => ({
      discord_id: debit.discordId,
      amount: roundSats(debit.amountSats),
    }))
    .filter((debit) => debit.discord_id && debit.amount > 0);

  if (payload.length === 0) return;

  const { error } = await supabase.rpc("subtract_balances_batch", {
    p_debits: payload,
  });

  if (!error) return;

  console.warn("Batch balance debit failed; falling back to per-user debits:", error.message);
  await Promise.all(
    payload.map((debit) => subtractBalance(debit.discord_id, debit.amount).catch(() => false)),
  );
}

export async function linkWallet(discordId: string, walletAddress: string): Promise<{ ok: boolean; error?: string }> {
  const normalized = walletAddress.toLowerCase().trim();
  if (!/^0x[a-f0-9]{40}$/.test(normalized)) return { ok: false, error: "Invalid EVM address" };

  try {
    await getOrCreateUser(discordId);

    // Check if wallet is already linked to someone else
    const { data: existing } = await supabase
      .from("links")
      .select("discord_id")
      .eq("wallet_address", normalized)
      .single();

    if (existing && existing.discord_id !== discordId) {
      return { ok: false, error: "Wallet already linked to another user" };
    }
    if (existing) return { ok: true }; // Already linked to this user

    await supabase
      .from("links")
      .upsert({ discord_id: discordId, wallet_address: normalized }, { onConflict: "discord_id,wallet_address" });

    await supabase
      .from("users")
      .update({ wallet_address: normalized })
      .eq("discord_id", discordId);

    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function getWalletForUser(discordId: string): Promise<string | null> {
  const { data } = await supabase
    .from("links")
    .select("wallet_address")
    .eq("discord_id", discordId)
    .single();

  return data?.wallet_address ?? null;
}

export async function getDiscordForWallet(walletAddress: string): Promise<string | null> {
  const normalized = walletAddress.toLowerCase();
  const { data } = await supabase
    .from("links")
    .select("discord_id")
    .eq("wallet_address", normalized)
    .single();

  return data?.discord_id ?? null;
}
