import type { ChatInputCommandInteraction } from "discord.js";
import { config } from "./config.js";
import { hasAllowedDepositRole } from "./depositPolicy.js";

export function getInteractionRoleIds(interaction: ChatInputCommandInteraction): string[] {
  const member = interaction.member;
  if (!member) return [];
  const roles = member.roles;
  if (Array.isArray(roles)) return roles;
  return [...roles.cache.keys()];
}

export function canUseDeposits(userId: string, roleIds: Iterable<string>): boolean {
  if (config.discord.adminIds.includes(userId)) return true;
  if (config.depositAdminOnly) return false;

  return hasAllowedDepositRole(roleIds, config.deposits.allowedRoleIds);
}

export function canInteractionUseDeposits(interaction: ChatInputCommandInteraction): boolean {
  return canUseDeposits(interaction.user.id, getInteractionRoleIds(interaction));
}
