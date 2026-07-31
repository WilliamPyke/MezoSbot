import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "./config.js";

export const supabase: SupabaseClient = createClient(
  config.supabase.url,
  config.supabase.serviceRoleKey,
  {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    realtime: {
      params: {
        eventsPerSecond: 1,
      },
    },
  }
);

// Type exports for convenience
export type UserRow = { discord_id: string; wallet_address: string | null; balance_sats: number; created_at: string; updated_at: string; username: string | null; display_name: string | null; avatar_url: string | null };
export type LinkRow = { id: number; discord_id: string; wallet_address: string; linked_at: string };
export type DepositRow = { id: number; discord_id: string; tx_hash: string; amount_sats: number; block_number: number; created_at: string };
export type WithdrawalRow = { id: number; discord_id: string; tx_hash: string | null; amount_sats: number; to_address: string; status: string; created_at: string };
export type DropRow = { id: number; channel_id: string; creator_id: string; total_sats: number; per_claim_sats: number; max_claims: number; claims_count: number; status: string; created_at: string; eligible_role_id: string | null };
export type DropClaimRow = { id: number; drop_id: number; claimant_id: string; amount_sats: number; claimed_at: string };
export type EventQuestRow = { id: number; guild_id: string; channel_id: string; message_id: string | null; creator_id: string; scheduled_event_id: string; event_name: string; event_channel_id: string; reward_sats: number; min_minutes: number; max_rewards: number | null; rewards_count: number; status: string; scheduled_start_at: string | null; scheduled_end_at: string | null; created_at: string; completed_at: string | null };
export type EventQuestAttendanceRow = { id: number; quest_id: number; user_id: string; joined_at: string | null; accumulated_seconds: number; last_seen_at: string | null; reward_sats: number | null; rewarded_at: string | null; created_at: string };
export type DepositAddressRow = { discord_id: string; address: string; last_checked_balance: string };
export type WalletVerificationChallengeRow = { id: number; discord_id: string; deposit_address: string; challenge_sats: number; status: string; tx_hash: string | null; wallet_address: string | null; created_at: string; expires_at: string; verified_at: string | null };
export type VerifiedWalletRow = { id: number; discord_id: string; wallet_address: string; chain_id: number; verification_tx_hash: string; verified_at: string; created_at: string };
export type QuestRow = { id: number; guild_id: string; channel_id: string; message_id: string | null; creator_id: string; title: string; description: string | null; status: string; reward_mode: string; token: "SATS" | "MUSD" | "MEZO" | "MUSDC"; max_reward_sats: number; starts_at: string | null; ends_at: string | null; metadata: Record<string, unknown>; created_at: string; updated_at: string; completed_at: string | null };
export type QuestTaskRow = { id: number; quest_id: number; task_key: string; type: string; title: string; description: string | null; config: Record<string, unknown>; sort_order: number; status: string; created_at: string };
export type QuestRewardTierRow = { id: number; quest_id: number; completed_task_count: number; reward_sats: number; created_at: string };
export type QuestTaskCompletionRow = { id: number; quest_id: number; task_id: number; user_id: string; proof: Record<string, unknown>; completed_at: string };
export type QuestUserRewardRow = { quest_id: number; user_id: string; completed_task_count: number; total_reward_sats: number; paid_sats: number; last_paid_at: string | null; updated_at: string };
export type GameSaveRow = { rom_name: string; save_data: string; updated_at: string };
export type RainBannedTermRow = { id: number; guild_id: string; term: string; created_by: string | null; created_at: string };
export type DeveloperRelayRouteRow = { guild_id: string; discord_id: string; developer_channel_id: string; private_thread_id: string; enabled: boolean; created_by: string | null; created_at: string; updated_at: string };
