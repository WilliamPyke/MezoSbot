import { supabase } from "../db.js";
import { isGodProfile } from "./admin.js";

/**
 * SatQuest economy = a closed loop over the real `users.balance_sats` ledger.
 * HP *is* the player's withdrawable balance; nothing here mints sats.
 *
 * God/admin sandbox profiles (see admin.ts) are exempt: they never spend and never
 * earn real sats, so all debits/payouts here no-op for them.
 */

/** Drain up to `dmg` sats from the player into the prize pool. Returns sats actually taken. */
export async function takeDamage(discordId: string, dmg: number): Promise<number> {
  if (dmg <= 0 || isGodProfile(discordId)) return 0;
  const { data, error } = await supabase.rpc("satquest_take_damage", {
    p_discord_id: discordId,
    p_dmg: Math.floor(dmg),
  });
  if (error) {
    console.warn("[SatQuest] takeDamage failed:", error.message);
    return 0;
  }
  return (data as number) ?? 0;
}

/** Pay up to `requested` sats from the pool to the player. Returns sats actually granted. */
export async function payoutFromPool(discordId: string, requested: number): Promise<number> {
  if (requested <= 0 || isGodProfile(discordId)) return 0;
  const { data, error } = await supabase.rpc("satquest_pool_payout", {
    p_discord_id: discordId,
    p_requested: Math.floor(requested),
  });
  if (error) {
    console.warn("[SatQuest] payoutFromPool failed:", error.message);
    return 0;
  }
  return (data as number) ?? 0;
}

/** Seed the prize pool (used by the buy-in). */
export async function addToPool(amount: number): Promise<void> {
  if (amount <= 0) return;
  const { error } = await supabase.rpc("satquest_pool_add", { p_amount: Math.floor(amount) });
  if (error) console.warn("[SatQuest] addToPool failed:", error.message);
}
