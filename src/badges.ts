import type { Client } from "discord.js";
import { supabase } from "./db.js";

export interface BadgeStage {
  stageName: string;
  thresholdSats: number;
  emoji: string;
}

export const TIPPER_STAGES: BadgeStage[] = [
  { stageName: "Generous Tipper", thresholdSats: 25000, emoji: "💸" },
  { stageName: "Big Tipper", thresholdSats: 50000, emoji: "💰" },
  { stageName: "Massive Tipper", thresholdSats: 100000, emoji: "💎" },
  { stageName: "Gigantic Tipper", thresholdSats: 250000, emoji: "🏆" },
  { stageName: "Colossal Tipper", thresholdSats: 500000, emoji: "👑" },
  { stageName: "Legendary Tipper", thresholdSats: 1000000, emoji: "🦄" },
];

export const RAINER_STAGES: BadgeStage[] = [
  { stageName: "Generous Rainer", thresholdSats: 25000, emoji: "🌧️" },
  { stageName: "Big Rainer", thresholdSats: 50000, emoji: "🌦️" },
  { stageName: "Massive Rainer", thresholdSats: 100000, emoji: "⛈️" },
  { stageName: "Gigantic Rainer", thresholdSats: 250000, emoji: "🌪️" },
  { stageName: "Colossal Rainer", thresholdSats: 500000, emoji: "🌊" },
  { stageName: "Legendary Rainer", thresholdSats: 1000000, emoji: "🌌" },
];

/**
 * Ensures that the default badge configurations exist in the database for the given guild.
 */
export async function ensureDefaultBadgesExist(guildId: string): Promise<void> {
  const { count, error } = await supabase
    .from("badge_roles")
    .select("*", { count: "exact", head: true })
    .eq("guild_id", guildId);

  if (error) {
    console.error(`[Badges] Error checking badge roles for guild ${guildId}:`, error);
    return;
  }

  if (count === 0) {
    const defaults = [
      ...TIPPER_STAGES.map((s) => ({
        guild_id: guildId,
        badge_type: "tipper",
        stage_name: s.stageName,
        threshold_sats: s.thresholdSats,
        role_id: null,
      })),
      ...RAINER_STAGES.map((s) => ({
        guild_id: guildId,
        badge_type: "rainer",
        stage_name: s.stageName,
        threshold_sats: s.thresholdSats,
        role_id: null,
      })),
    ];

    const { error: insertError } = await supabase.from("badge_roles").insert(defaults);
    if (insertError) {
      console.error(`[Badges] Error inserting default badge roles for guild ${guildId}:`, insertError);
    } else {
      console.log(`[Badges] Created default badge configurations for guild ${guildId}`);
    }
  }
}

/**
 * Calculates a user's total stats and grants them the appropriate Discord roles based on configuration.
 */
export async function updateUserBadges(client: Client, guildId: string, userId: string): Promise<void> {
  // First ensure default rows exist
  await ensureDefaultBadgesExist(guildId);

  // Fetch totals from views
  const { data: tipData } = await supabase
    .from("user_tip_stats")
    .select("total_tipped_sats")
    .eq("discord_id", userId)
    .single();

  const { data: rainData } = await supabase
    .from("user_rain_stats")
    .select("total_rained_sats")
    .eq("discord_id", userId)
    .single();

  const totalTipped = tipData?.total_tipped_sats ?? 0;
  const totalRained = rainData?.total_rained_sats ?? 0;

  try {
    // Fetch role configurations
    const { data: configs, error: configError } = await supabase
      .from("badge_roles")
      .select("*")
      .eq("guild_id", guildId);

    if (configError || !configs) {
      console.error(`[Badges] Error fetching configurations for guild ${guildId}:`, configError);
      return;
    }

    const guild = await client.guilds.fetch(guildId);
    if (!guild) return;

    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return;

    // 1. Process Tipper Roles
    const tipperConfigs = configs.filter((c) => c.badge_type === "tipper" && c.role_id);
    tipperConfigs.sort((a, b) => a.threshold_sats - b.threshold_sats);
    const eligibleTippers = tipperConfigs.filter((c) => totalTipped >= c.threshold_sats);
    const targetTipperConfig = eligibleTippers.length > 0 ? eligibleTippers[eligibleTippers.length - 1] : null;
    const targetTipperRoleId = targetTipperConfig?.role_id ?? null;
    const tipperRolesToRemove = tipperConfigs
      .map((c) => c.role_id)
      .filter((rid): rid is string => !!rid && rid !== targetTipperRoleId);

    // 2. Process Rainer Roles
    const rainerConfigs = configs.filter((c) => c.badge_type === "rainer" && c.role_id);
    rainerConfigs.sort((a, b) => a.threshold_sats - b.threshold_sats);
    const eligibleRainers = rainerConfigs.filter((c) => totalRained >= c.threshold_sats);
    const targetRainerConfig = eligibleRainers.length > 0 ? eligibleRainers[eligibleRainers.length - 1] : null;
    const targetRainerRoleId = targetRainerConfig?.role_id ?? null;
    const rainerRolesToRemove = rainerConfigs
      .map((c) => c.role_id)
      .filter((rid): rid is string => !!rid && rid !== targetRainerRoleId);

    // Collect roles to add & remove
    const rolesToAdd: string[] = [];
    const rolesToRemove: string[] = [];

    if (targetTipperRoleId && !member.roles.cache.has(targetTipperRoleId)) {
      rolesToAdd.push(targetTipperRoleId);
    }
    if (targetRainerRoleId && !member.roles.cache.has(targetRainerRoleId)) {
      rolesToAdd.push(targetRainerRoleId);
    }

    for (const rid of [...tipperRolesToRemove, ...rainerRolesToRemove]) {
      if (member.roles.cache.has(rid)) {
        rolesToRemove.push(rid);
      }
    }

    // Execute bulk Discord role adjustments
    if (rolesToRemove.length > 0) {
      try {
        await member.roles.remove(rolesToRemove);
        console.log(`[Badges] Removed legacy roles ${rolesToRemove.join(", ")} from user ${userId} in guild ${guildId}`);
      } catch (e) {
        console.warn(`[Badges] Failed to remove roles ${rolesToRemove.join(", ")} from user ${userId}:`, e);
      }
    }

    if (rolesToAdd.length > 0) {
      try {
        await member.roles.add(rolesToAdd);
        console.log(`[Badges] Granted roles ${rolesToAdd.join(", ")} to user ${userId} in guild ${guildId}`);
      } catch (e) {
        console.warn(`[Badges] Failed to add roles ${rolesToAdd.join(", ")} to user ${userId}:`, e);
      }
    }
  } catch (err) {
    console.error(`[Badges] Error updating roles for user ${userId} in guild ${guildId}:`, err);
  }
}
