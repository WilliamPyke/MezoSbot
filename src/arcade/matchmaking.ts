import { supabase } from "../db.js";
import { createMatch, type ArcadeMatchRow } from "./db.js";
import { createSessionDraft, type WebArcadeSessionRow } from "../web/db.js";
import { ensureRuntime } from "./runtime.js";

/**
 * Global matchmaking queue.
 *
 * Two surfaces, never crossed: Discord-vs-Discord (free PvP, internal sats
 * balance) and wallet-vs-wallet (on-chain escrow). Pairing within wallet
 * happens per (chainId, assetAddress, stakeAmountUnits) bucket so both
 * players can join the same escrow session.
 */

export type QueueSurface = "discord" | "wallet";

export type QueueStatus = "waiting" | "paired" | "cancelled" | "expired";

export type ArcadeQueueRow = {
  id: number;
  surface: QueueSurface;
  user_id: string;
  status: QueueStatus;
  duration_seconds: number | null;
  chain_id: number | null;
  asset_address: string | null;
  stake_amount_units: string | null;
  match_id: number | null;
  session_id: string | null;
  paired_with: string | null;
  joined_at: string;
  paired_at: string | null;
  expires_at: string;
};

const QUEUE_TTL_MS = 5 * 60 * 1000; // entries auto-expire after 5 minutes

/* ─────────── Discord ─────────── */

export type DiscordEnqueueResult =
  | { ok: true; status: "paired"; match: ArcadeMatchRow; opponentId: string }
  | { ok: true; status: "waiting"; entry: ArcadeQueueRow }
  | { ok: false; error: string };

export async function enqueueDiscord(input: {
  userId: string;
  durationSeconds: number;
}): Promise<DiscordEnqueueResult> {
  // Try to consume an oldest waiting Discord entry that isn't us.
  const opponent = await claimOldestDiscordWaiting(input.userId);
  if (opponent) {
    const match = await createMatch({
      mode: "free_pvp",
      createdById: opponent.user_id,
      playerAId: opponent.user_id,
      playerBId: input.userId,
      durationSeconds: opponent.duration_seconds ?? input.durationSeconds,
      rakeBps: 0,
    });
    ensureRuntime(match.id, match.seed, [match.player_a_id, match.player_b_id!]);
    await markPaired({ id: opponent.id, matchId: match.id, pairedWith: input.userId });
    // Insert a paired-from-the-start row for the second player so both queue
    // entries record the same outcome (useful for the GET status endpoint).
    await insertPaired({
      surface: "discord",
      userId: input.userId,
      matchId: match.id,
      pairedWith: opponent.user_id,
    });
    return { ok: true, status: "paired", match, opponentId: opponent.user_id };
  }

  const expiresAt = new Date(Date.now() + QUEUE_TTL_MS).toISOString();
  const { data, error } = await supabase
    .from("arcade_queue")
    .insert({
      surface: "discord",
      user_id: input.userId,
      status: "waiting",
      duration_seconds: input.durationSeconds,
      expires_at: expiresAt,
    })
    .select("*")
    .single();

  if (error) {
    // Duplicate waiting row — surface as a soft error so callers can show a
    // friendlier message ("already in queue").
    if (error.code === "23505") return { ok: false, error: "You're already in the matchmaking queue." };
    return { ok: false, error: error.message };
  }

  return { ok: true, status: "waiting", entry: data as ArcadeQueueRow };
}

async function claimOldestDiscordWaiting(excludeUserId: string): Promise<ArcadeQueueRow | null> {
  // Postgres-side atomic claim: update the oldest waiting row not owned by us
  // and not expired, returning it.
  const { data, error } = await supabase.rpc("claim_oldest_discord_queue_entry", {
    p_exclude_user_id: excludeUserId,
  });
  if (error) {
    // Fallback if the RPC isn't installed yet — simple non-atomic best-effort
    // pairing. Two concurrent enqueues could both pair against the same row,
    // but the resulting double-create is harmless (one match orphaned).
    if (error.message.includes("function") || error.code === "42883") {
      return await fallbackClaimOldestDiscord(excludeUserId);
    }
    throw new Error(`Queue claim failed: ${error.message}`);
  }
  if (!data || (Array.isArray(data) && data.length === 0)) return null;
  const row = Array.isArray(data) ? data[0] : data;
  return row as ArcadeQueueRow;
}

async function fallbackClaimOldestDiscord(excludeUserId: string): Promise<ArcadeQueueRow | null> {
  const nowIso = new Date().toISOString();
  const { data: rows } = await supabase
    .from("arcade_queue")
    .select("*")
    .eq("surface", "discord")
    .eq("status", "waiting")
    .neq("user_id", excludeUserId)
    .gte("expires_at", nowIso)
    .order("joined_at", { ascending: true })
    .limit(1);
  const candidate = (rows as ArcadeQueueRow[] | null)?.[0];
  if (!candidate) return null;
  // Best-effort claim — only one update wins.
  const { data: claimed } = await supabase
    .from("arcade_queue")
    .update({ status: "paired", paired_at: new Date().toISOString() })
    .eq("id", candidate.id)
    .eq("status", "waiting")
    .select("*")
    .maybeSingle();
  return (claimed as ArcadeQueueRow | null) ?? null;
}

/* ─────────── Wallet ─────────── */

export type WalletEnqueueResult =
  | { ok: true; status: "paired"; session: WebArcadeSessionRow; opponent: string; role: "creator" | "joiner" }
  | { ok: true; status: "waiting"; entry: ArcadeQueueRow }
  | { ok: false; error: string };

export async function enqueueWallet(input: {
  walletAddress: string;
  chainId: number;
  assetAddress: string;
  stakeAmountUnits: string;
}): Promise<WalletEnqueueResult> {
  const me = input.walletAddress.toLowerCase();
  const opponent = await claimOldestWalletWaiting({
    excludeUserId: me,
    chainId: input.chainId,
    assetAddress: input.assetAddress.toLowerCase(),
    stakeAmountUnits: input.stakeAmountUnits,
  });

  if (opponent) {
    // Older queued player creates the on-chain escrow; newer player joins.
    const session = await createSessionDraft({
      playerA: opponent.user_id,
      invitedPlayer: me,
      assetAddress: input.assetAddress,
      stakeAmountUnits: input.stakeAmountUnits,
      chainId: input.chainId,
    });
    await markPaired({ id: opponent.id, sessionId: session.id, pairedWith: me });
    await insertPaired({
      surface: "wallet",
      userId: me,
      sessionId: session.id,
      pairedWith: opponent.user_id,
    });
    return { ok: true, status: "paired", session, opponent: opponent.user_id, role: "joiner" };
  }

  const expiresAt = new Date(Date.now() + QUEUE_TTL_MS).toISOString();
  const { data, error } = await supabase
    .from("arcade_queue")
    .insert({
      surface: "wallet",
      user_id: me,
      status: "waiting",
      chain_id: input.chainId,
      asset_address: input.assetAddress.toLowerCase(),
      stake_amount_units: input.stakeAmountUnits,
      expires_at: expiresAt,
    })
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505") return { ok: false, error: "You're already in the matchmaking queue." };
    return { ok: false, error: error.message };
  }
  return { ok: true, status: "waiting", entry: data as ArcadeQueueRow };
}

async function claimOldestWalletWaiting(input: {
  excludeUserId: string;
  chainId: number;
  assetAddress: string;
  stakeAmountUnits: string;
}): Promise<ArcadeQueueRow | null> {
  const nowIso = new Date().toISOString();
  const { data: rows } = await supabase
    .from("arcade_queue")
    .select("*")
    .eq("surface", "wallet")
    .eq("status", "waiting")
    .eq("chain_id", input.chainId)
    .eq("asset_address", input.assetAddress)
    .eq("stake_amount_units", input.stakeAmountUnits)
    .neq("user_id", input.excludeUserId)
    .gte("expires_at", nowIso)
    .order("joined_at", { ascending: true })
    .limit(1);
  const candidate = (rows as ArcadeQueueRow[] | null)?.[0];
  if (!candidate) return null;
  const { data: claimed } = await supabase
    .from("arcade_queue")
    .update({ status: "paired", paired_at: new Date().toISOString() })
    .eq("id", candidate.id)
    .eq("status", "waiting")
    .select("*")
    .maybeSingle();
  return (claimed as ArcadeQueueRow | null) ?? null;
}

/* ─────────── Shared ─────────── */

export async function getMyQueueEntry(
  surface: QueueSurface,
  userId: string
): Promise<ArcadeQueueRow | null> {
  // Most recent active or recently-paired entry for this user.
  const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h
  const { data } = await supabase
    .from("arcade_queue")
    .select("*")
    .eq("surface", surface)
    .eq("user_id", normalizeUserId(surface, userId))
    .gte("joined_at", cutoff)
    .order("joined_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as ArcadeQueueRow | null) ?? null;
}

export async function leaveQueue(surface: QueueSurface, userId: string): Promise<boolean> {
  const { data } = await supabase
    .from("arcade_queue")
    .update({ status: "cancelled" })
    .eq("surface", surface)
    .eq("user_id", normalizeUserId(surface, userId))
    .eq("status", "waiting")
    .select("id");
  return Array.isArray(data) && data.length > 0;
}

export async function expireStaleQueueEntries(): Promise<number> {
  const nowIso = new Date().toISOString();
  const { data } = await supabase
    .from("arcade_queue")
    .update({ status: "expired" })
    .eq("status", "waiting")
    .lt("expires_at", nowIso)
    .select("id");
  return Array.isArray(data) ? data.length : 0;
}

function normalizeUserId(surface: QueueSurface, userId: string): string {
  return surface === "wallet" ? userId.toLowerCase() : userId;
}

async function markPaired(input: {
  id: number;
  matchId?: number;
  sessionId?: string;
  pairedWith: string;
}) {
  await supabase
    .from("arcade_queue")
    .update({
      status: "paired",
      match_id: input.matchId ?? null,
      session_id: input.sessionId ?? null,
      paired_with: input.pairedWith,
      paired_at: new Date().toISOString(),
    })
    .eq("id", input.id);
}

async function insertPaired(input: {
  surface: QueueSurface;
  userId: string;
  matchId?: number;
  sessionId?: string;
  pairedWith: string;
}) {
  const expiresAt = new Date(Date.now() + QUEUE_TTL_MS).toISOString();
  await supabase.from("arcade_queue").insert({
    surface: input.surface,
    user_id: input.userId,
    status: "paired",
    match_id: input.matchId ?? null,
    session_id: input.sessionId ?? null,
    paired_with: input.pairedWith,
    paired_at: new Date().toISOString(),
    expires_at: expiresAt,
  });
}
