import { supabase } from "./db.js";
import { roundSats } from "./format.js";
import { TOKEN_SYMBOLS, roundTokenAmount, type TokenSymbol } from "./tokens.js";

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

export async function addBalance(discordId: string, amountSats: number, token: TokenSymbol = "SATS"): Promise<void> {
  await getOrCreateUser(discordId);
  const rounded = token === "SATS" ? roundSats(amountSats) : roundTokenAmount(amountSats, token);
  if (token === "SATS") {
    await supabase.rpc("add_balance", { p_discord_id: discordId, p_amount: rounded });
    return;
  }
  const { error } = await supabase.rpc("add_token_balance", {
    p_discord_id: discordId, p_token: token, p_amount: rounded,
  });
  if (error) throw error;
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
