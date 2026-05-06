import { randomBytes } from "node:crypto";
import { ethers } from "ethers";
import { supabase } from "../db.js";
import { config } from "../config.js";
import { normalizeWalletAddress } from "./auth.js";
import { assetByAddress, chainConfigForId } from "./chains.js";
import type { Move } from "../arcade/types.js";

export type WebSessionStatus =
  | "draft"
  | "created"
  | "active"
  | "submitted"
  | "completed"
  | "refunded"
  | "cancelled"
  | "settlement_failed";

export type WebArcadeSessionRow = {
  id: string;
  seed: string;
  status: WebSessionStatus;
  chain_id: number;
  escrow_contract_address: string;
  asset_symbol: string;
  asset_address: string;
  stake_amount_units: string;
  platform_fee_bps: number;
  player_a_address: string;
  player_b_address: string | null;
  invited_player_address: string | null;
  winner_address: string | null;
  player_a_score: number | null;
  player_b_score: number | null;
  player_a_submitted: boolean;
  player_b_submitted: boolean;
  create_tx_hash: string | null;
  join_tx_hash: string | null;
  settlement_tx_hash: string | null;
  result_hash: string | null;
  join_deadline: string;
  play_deadline: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export async function createSessionDraft(input: {
  playerA: string;
  invitedPlayer?: string | null;
  assetAddress: string;
  stakeAmountUnits: string;
  chainId: number;
}) {
  const chain = chainConfigForId(input.chainId);
  if (!chain.escrowContractAddress) throw new Error(`Escrow contract is not configured for ${chain.chainName}`);
  const asset = assetByAddress(input.assetAddress, chain.chainId);
  if (!asset) throw new Error("Unsupported asset");
  const stake = BigInt(input.stakeAmountUnits);
  if (stake <= 0n) throw new Error("Stake must be positive");

  const now = Date.now();
  const joinDeadline = new Date(now + config.web.joinWindowSeconds * 1000);
  const playDeadline = new Date(joinDeadline.getTime() + config.web.playWindowSeconds * 1000);
  const id = ethers.hexlify(randomBytes(32));
  const seed = randomBytes(16).toString("hex");
  const playerA = normalizeWalletAddress(input.playerA);
  const invited = input.invitedPlayer ? normalizeWalletAddress(input.invitedPlayer) : null;

  const { data, error } = await supabase
    .from("web_arcade_sessions")
    .insert({
      id,
      seed,
      status: "draft",
      chain_id: chain.chainId,
      escrow_contract_address: chain.escrowContractAddress.toLowerCase(),
      asset_symbol: asset.symbol,
      asset_address: asset.address.toLowerCase(),
      stake_amount_units: stake.toString(),
      platform_fee_bps: chain.platformFeeBps,
      player_a_address: playerA,
      invited_player_address: invited,
      join_deadline: joinDeadline.toISOString(),
      play_deadline: playDeadline.toISOString(),
    })
    .select("*")
    .single();
  if (error || !data) throw new Error(`Could not create session draft: ${error?.message}`);
  return data as WebArcadeSessionRow;
}

export async function getWebSession(id: string): Promise<WebArcadeSessionRow | null> {
  const { data, error } = await supabase
    .from("web_arcade_sessions")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Could not fetch session: ${error.message}`);
  return (data as WebArcadeSessionRow | null) ?? null;
}

export async function markCreated(id: string, wallet: string, txHash: string) {
  const { data, error } = await supabase
    .from("web_arcade_sessions")
    .update({ status: "created", create_tx_hash: txHash, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("player_a_address", normalizeWalletAddress(wallet))
    .in("status", ["draft", "created"])
    .select("*")
    .single();
  if (error || !data) throw new Error(`Could not mark session created: ${error?.message}`);
  return data as WebArcadeSessionRow;
}

export async function markJoined(id: string, wallet: string, txHash: string) {
  const normalized = normalizeWalletAddress(wallet);
  const session = await getWebSession(id);
  if (!session) throw new Error("Session not found");
  if (session.player_a_address === normalized) throw new Error("Creator cannot join their own session");
  if (session.invited_player_address && session.invited_player_address !== normalized) {
    throw new Error("This session is reserved for another wallet");
  }

  const { data, error } = await supabase
    .from("web_arcade_sessions")
    .update({
      status: "active",
      player_b_address: normalized,
      join_tx_hash: txHash,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("status", "created")
    .is("player_b_address", null)
    .select("*")
    .single();
  if (error || !data) throw new Error(`Could not mark session joined: ${error?.message}`);
  return data as WebArcadeSessionRow;
}

export async function getSubmission(sessionId: string, wallet: string) {
  const { data, error } = await supabase
    .from("web_arcade_submissions")
    .select("*")
    .eq("session_id", sessionId)
    .eq("wallet_address", normalizeWalletAddress(wallet))
    .maybeSingle();
  if (error) throw new Error(`Could not fetch submission: ${error.message}`);
  return data as
    | {
        session_id: string;
        wallet_address: string;
        move_log: Move[] | null;
        validated_score: number | null;
        submitted: boolean;
      }
    | null;
}

export async function upsertSubmission(input: {
  sessionId: string;
  wallet: string;
  moves: Move[];
  score: number;
  submitted: boolean;
}) {
  const wallet = normalizeWalletAddress(input.wallet);
  const { error } = await supabase.from("web_arcade_submissions").upsert(
    {
      session_id: input.sessionId,
      wallet_address: wallet,
      move_log: input.moves,
      claimed_score: input.score,
      validated_score: input.score,
      valid: true,
      submitted: input.submitted,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "session_id,wallet_address" }
  );
  if (error) throw new Error(`Could not persist submission: ${error.message}`);

  const session = await getWebSession(input.sessionId);
  if (!session) return;
  const isA = session.player_a_address === wallet;
  await supabase
    .from("web_arcade_sessions")
    .update(
      isA
        ? {
            player_a_score: input.score,
            player_a_submitted: input.submitted,
            updated_at: new Date().toISOString(),
          }
        : {
            player_b_score: input.score,
            player_b_submitted: input.submitted,
            updated_at: new Date().toISOString(),
          }
    )
    .eq("id", input.sessionId);
}

export async function completeSession(input: {
  sessionId: string;
  winner: string | null;
  resultHash: string;
  settlementTxHash?: string | null;
  refunded?: boolean;
}) {
  const { data, error } = await supabase
    .from("web_arcade_sessions")
    .update({
      status: input.refunded ? "refunded" : "completed",
      winner_address: input.winner ? normalizeWalletAddress(input.winner) : null,
      result_hash: input.resultHash,
      settlement_tx_hash: input.settlementTxHash ?? null,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.sessionId)
    .select("*")
    .single();
  if (error || !data) throw new Error(`Could not complete session: ${error?.message}`);
  return data as WebArcadeSessionRow;
}

export async function recordSettlementAttempt(input: {
  sessionId: string;
  action: "settle" | "refund";
  resultHash: string;
  txHash?: string | null;
  status: "pending" | "submitted" | "confirmed" | "failed" | "skipped";
  error?: string | null;
}) {
  await supabase.from("web_arcade_settlement_attempts").insert({
    session_id: input.sessionId,
    action: input.action,
    result_hash: input.resultHash,
    tx_hash: input.txHash ?? null,
    status: input.status,
    error: input.error ?? null,
  });
}

export function sessionPlayers(session: WebArcadeSessionRow): string[] {
  return [session.player_a_address, session.player_b_address].filter(Boolean) as string[];
}
