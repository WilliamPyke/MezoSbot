import { config } from "../config.js";

/**
 * SatScape admin / "god" mode.
 *
 * God mode runs on a *separate* profile that shares nothing with the player's real
 * run: we namespace the discord_id with a `god:` prefix, so every per-player table
 * (sat_players / sat_inventories / sat_combat_sessions / sat_explored / quests / rep)
 * is naturally isolated — switching modes never carries items, position, or sats
 * across. Money is short-circuited for these ids (see economy.ts / db.getSatBalance),
 * so a god profile spends nothing and never loses HP.
 *
 * Only Discord ids in SATSCAPE_ADMIN_IDS may enter god mode; the web layer validates
 * this on every god-flagged request, so spoofing the client header does nothing.
 */

const GOD_PREFIX = "god:";

/** Sandbox balance reported for god profiles — effectively infinite HP, no real sats. */
export const GOD_SANDBOX_BALANCE = 1_000_000_000;

/** True if `discordId` is a god/admin sandbox profile id. */
export function isGodProfile(discordId: string): boolean {
  return discordId.startsWith(GOD_PREFIX);
}

/** The god-profile id for a real Discord id (idempotent). */
export function godProfileId(realId: string): string {
  return isGodProfile(realId) ? realId : GOD_PREFIX + realId;
}

/** The underlying real Discord id for any profile id (strips the god prefix if present). */
export function realIdFromProfile(profileId: string): string {
  return isGodProfile(profileId) ? profileId.slice(GOD_PREFIX.length) : profileId;
}

/** Whether this real Discord id is permitted to use god mode. */
export function isSatscapeAdmin(realId: string): boolean {
  return config.satscape.adminIds.includes(realIdFromProfile(realId));
}
