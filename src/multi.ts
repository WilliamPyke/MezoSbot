import { config } from "./config.js";
import { supabase } from "./db.js";

export const MULTI_2X_ROLE_ID = process.env.MULTI_2X_ROLE_ID?.trim() || "1517551671318675646";

export type SatsMultiplier = 1 | 2;

export function getSatsMultiplier(roleIds: Iterable<string> | null | undefined): SatsMultiplier {
  if (!roleIds) return 1;
  for (const roleId of roleIds) {
    if (roleId === MULTI_2X_ROLE_ID) return 2;
  }
  return 1;
}

export function isBotAdmin(discordId: string): boolean {
  return config.discord.adminIds.includes(discordId);
}

export async function getMultiDropEnabled(creatorId: string): Promise<boolean> {
  if (isBotAdmin(creatorId)) return true;

  const { data, error } = await supabase
    .from("multi_drop_preferences")
    .select("enabled")
    .eq("creator_id", creatorId)
    .maybeSingle();

  if (error) {
    console.warn(`[Multi] Failed to read drop preference for ${creatorId}:`, error.message);
    return false;
  }

  return data?.enabled === true;
}

export async function setMultiDropEnabled(creatorId: string, enabled: boolean): Promise<void> {
  const { error } = await supabase
    .from("multi_drop_preferences")
    .upsert(
      {
        creator_id: creatorId,
        enabled,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "creator_id" },
    );

  if (error) throw error;
}
