import { ethers } from "ethers";
import { config, satsToTokenUnits } from "./config.js";
import { supabase, type VerifiedWalletRow } from "./db.js";

type PendingChallenge = {
  id: number;
  discord_id: string;
  deposit_address: string;
  challenge_sats: number;
  created_at: string;
  expires_at: string;
};

type IncomingTransfer = {
  hash: string;
  from: string;
  to: string;
  value: bigint;
};

function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

function challengeExpiresAt(): string {
  const hours = Number.isFinite(config.walletVerification.challengeHours)
    ? Math.max(1, config.walletVerification.challengeHours)
    : 24;
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

export async function createWalletVerificationChallenge(
  discordId: string,
  depositAddress: string,
): Promise<PendingChallenge> {
  const normalizedDepositAddress = normalizeAddress(depositAddress);
  const nowIso = new Date().toISOString();

  const { data: existing, error: existingError } = await supabase
    .from("wallet_verification_challenges")
    .select("id, discord_id, deposit_address, challenge_sats, created_at, expires_at")
    .eq("discord_id", discordId)
    .eq("deposit_address", normalizedDepositAddress)
    .eq("status", "pending")
    .gte("expires_at", nowIso)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existingError) throw existingError;
  if (existing) return existing as PendingChallenge;

  const { data, error } = await supabase
    .from("wallet_verification_challenges")
    .insert({
      discord_id: discordId,
      deposit_address: normalizedDepositAddress,
      challenge_sats: config.walletVerification.challengeSats,
      expires_at: challengeExpiresAt(),
    })
    .select("id, discord_id, deposit_address, challenge_sats, created_at, expires_at")
    .single();

  if (error) throw error;
  return data as PendingChallenge;
}

export async function getVerifiedWallets(discordId: string): Promise<VerifiedWalletRow[]> {
  const { data, error } = await supabase
    .from("verified_wallets")
    .select("*")
    .eq("discord_id", discordId)
    .order("verified_at", { ascending: false });

  if (error) throw error;
  return (data ?? []) as VerifiedWalletRow[];
}

export async function getPendingWalletVerification(discordId: string): Promise<PendingChallenge | null> {
  const { data, error } = await supabase
    .from("wallet_verification_challenges")
    .select("id, discord_id, deposit_address, challenge_sats, created_at, expires_at")
    .eq("discord_id", discordId)
    .eq("status", "pending")
    .gte("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return (data ?? null) as PendingChallenge | null;
}

async function findRecentIncomingTransfer(
  provider: ethers.JsonRpcProvider,
  toAddress: string,
  minValue: bigint,
  createdAtIso: string,
): Promise<IncomingTransfer | null> {
  const latestBlock = await provider.getBlockNumber();
  const scanBlocks = Number.isFinite(config.walletVerification.scanBlocks)
    ? Math.max(1, Math.floor(config.walletVerification.scanBlocks))
    : 300;
  const earliestBlock = Math.max(0, latestBlock - scanBlocks);
  const createdAtMs = Date.parse(createdAtIso);
  const normalizedTo = normalizeAddress(toAddress);

  for (let blockNumber = latestBlock; blockNumber >= earliestBlock; blockNumber -= 1) {
    const block = await provider.getBlock(blockNumber, true);
    if (!block) continue;
    if (Number.isFinite(createdAtMs) && block.timestamp * 1000 < createdAtMs - 60_000) {
      break;
    }

    for (const tx of block.prefetchedTransactions) {
      if (!tx.to || normalizeAddress(tx.to) !== normalizedTo) continue;
      if (tx.value < minValue) continue;
      return {
        hash: tx.hash,
        from: normalizeAddress(tx.from),
        to: normalizedTo,
        value: tx.value,
      };
    }
  }

  return null;
}

export async function verifyWalletFromDeposit(
  discordId: string,
  depositAddress: string,
  provider: ethers.JsonRpcProvider,
): Promise<boolean> {
  const pending = await getPendingWalletVerification(discordId);
  if (!pending) return false;
  if (normalizeAddress(pending.deposit_address) !== normalizeAddress(depositAddress)) return false;

  const transfer = await findRecentIncomingTransfer(
    provider,
    pending.deposit_address,
    satsToTokenUnits(pending.challenge_sats),
    pending.created_at,
  );
  if (!transfer) return false;

  const { data: existingWallet, error: existingWalletError } = await supabase
    .from("verified_wallets")
    .select("discord_id")
    .eq("wallet_address", transfer.from)
    .maybeSingle();

  if (existingWalletError) {
    console.warn(`[WalletVerify] Failed to check wallet ${transfer.from}:`, existingWalletError.message);
    return false;
  }
  if (existingWallet && existingWallet.discord_id !== discordId) {
    console.warn(`[WalletVerify] Wallet ${transfer.from} is already verified by another Discord user`);
    return false;
  }

  const { error: insertError } = await supabase
    .from("verified_wallets")
    .upsert(
      {
        discord_id: discordId,
        wallet_address: transfer.from,
        chain_id: config.evm.chainId,
        verification_tx_hash: transfer.hash,
      },
      { onConflict: "wallet_address", ignoreDuplicates: true },
    );

  if (insertError) {
    console.warn(`[WalletVerify] Failed to verify wallet ${transfer.from}:`, insertError.message);
    return false;
  }

  const { error: updateError } = await supabase
    .from("wallet_verification_challenges")
    .update({
      status: "verified",
      tx_hash: transfer.hash,
      wallet_address: transfer.from,
      verified_at: new Date().toISOString(),
    })
    .eq("id", pending.id)
    .eq("status", "pending");

  if (updateError) {
    console.warn(`[WalletVerify] Failed to update challenge ${pending.id}:`, updateError.message);
  }

  return true;
}

export function formatShortAddress(address: string): string {
  const normalized = ethers.getAddress(address);
  return `${normalized.slice(0, 6)}...${normalized.slice(-4)}`;
}
