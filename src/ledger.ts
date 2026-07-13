import { randomUUID } from "crypto";
import { EmbedBuilder, PermissionFlagsBits, type Client, type TextChannel } from "discord.js";
import { getBalance } from "./balance.js";
import { config as appConfig } from "./config.js";
import { supabase } from "./db.js";
import { roundSats } from "./format.js";
import { formatTokenAmount, type TokenSymbol } from "./tokens.js";

const LEDGER_COLOR = 0x00cc6a;
const SETTING_GUILD = "ledger_guild_id";
const SETTING_CHANNEL = "ledger_channel_id";

let boundClient: Client | null = null;

/** Call once when the Discord client is ready (enables ledger posts from background jobs). */
export function bindLedgerClient(client: Client): void {
  boundClient = client;
}

export type LedgerEntryType =
  | "deposit"
  | "withdrawal"
  | "withdrawal_refund"
  | "tip"
  | "rain"
  | "distribute"
  | "drop_create"
  | "drop_claim"
  | "event_quest_reward"
  | "quest_reward"
  | "admin_credit"
  | "admin_debit"
  | "arcade_stake"
  | "arcade_refund"
  | "arcade_payout"
  | "arcade_rake"
  | "gameboy_bid"
  | "image_generation"
  | "image_generation_refund";

const TYPE_LABELS: Record<LedgerEntryType, string> = {
  deposit: "Deposit",
  withdrawal: "Withdrawal",
  withdrawal_refund: "Withdrawal Refund",
  tip: "Tip",
  rain: "Rain",
  distribute: "Distribute",
  drop_create: "Drop Created",
  drop_claim: "Drop Claim",
  event_quest_reward: "Quest Reward",
  quest_reward: "Quest Reward",
  admin_credit: "Admin Credit",
  admin_debit: "Admin Debit",
  arcade_stake: "Arcade Stake",
  arcade_refund: "Arcade Refund",
  arcade_payout: "Arcade Payout",
  arcade_rake: "Platform Fee",
  gameboy_bid: "Game Bid",
  image_generation: "Image Generation",
  image_generation_refund: "Image Generation Refund",
};

export type LedgerPartyId = string | "treasury" | "platform" | null;

export type RecordLedgerParams = {
  type: LedgerEntryType;
  amountSats: number;
  token?: TokenSymbol;
  senderId?: LedgerPartyId;
  receiverId?: LedgerPartyId;
  guildId?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
  metadata?: Record<string, unknown>;
};

export type LedgerChannelConfig = {
  guildId: string;
  channelId: string;
};

export type LedgerEntryRow = {
  transaction_id: string;
  type: LedgerEntryType;
  amount_sats: number;
  token?: TokenSymbol;
  sender_id: string | null;
  receiver_id: string | null;
  sender_balance_sats: number | null;
  receiver_balance_sats: number | null;
  guild_id: string | null;
  reference_type: string | null;
  reference_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

function formatLedgerAmount(amountSats: number, token: TokenSymbol = "SATS"): string {
  if (token !== "SATS") return formatTokenAmount(amountSats, token);
  const rounded = roundSats(amountSats);
  if (rounded === 0) return "0 ⚡";
  const isWhole = Math.abs(rounded - Math.round(rounded)) < 1e-12;
  const num = isWhole && rounded >= 1
    ? Math.round(rounded).toLocaleString()
    : rounded.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 10 });
  return `${num} ⚡`;
}

async function getSetting(key: string): Promise<string | null> {
  const { data } = await supabase.from("bot_settings").select("value").eq("key", key).maybeSingle();
  return data?.value ?? null;
}

async function setSetting(key: string, value: string): Promise<void> {
  const { error } = await supabase
    .from("bot_settings")
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw error;
}

async function deleteSetting(key: string): Promise<void> {
  await supabase.from("bot_settings").delete().eq("key", key);
}

export async function getLedgerChannelConfig(): Promise<LedgerChannelConfig | null> {
  const guildId = await getSetting(SETTING_GUILD);
  const channelId = await getSetting(SETTING_CHANNEL);
  if (guildId && channelId) return { guildId, channelId };

  const envGuild = appConfig.ledger.guildId.trim();
  const envChannel = appConfig.ledger.channelId.trim();
  if (envGuild && envChannel) return { guildId: envGuild, channelId: envChannel };

  return null;
}

export async function setLedgerChannelConfig(guildId: string, channelId: string): Promise<LedgerChannelConfig | null> {
  const previous = await getLedgerChannelConfig();
  await setSetting(SETTING_GUILD, guildId);
  await setSetting(SETTING_CHANNEL, channelId);
  return previous;
}

export async function clearLedgerChannelConfig(): Promise<void> {
  await deleteSetting(SETTING_GUILD);
  await deleteSetting(SETTING_CHANNEL);
}

export async function formatLedgerUserLine(
  client: Client,
  partyId: LedgerPartyId,
): Promise<string> {
  if (partyId === null || partyId === undefined) return "N/A";
  if (partyId === "treasury") return "Treasury";
  if (partyId === "platform") return "Platform";

  try {
    const user = await client.users.fetch(partyId);
    const name = user.globalName ?? user.username;
    return `<@${partyId}> (${partyId}) ${name}`;
  } catch {
    return `<@${partyId}> (${partyId})`;
  }
}

export function buildLedgerEmbed(entry: LedgerEntryRow, senderLine: string, receiverLine: string): EmbedBuilder {
  const label = TYPE_LABELS[entry.type] ?? entry.type;
  const created = new Date(entry.created_at);
  const ts = created.toLocaleString("en-US", {
    month: "numeric",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  return new EmbedBuilder()
    .setColor(LEDGER_COLOR)
    .setTitle(`Transaction: ${label}`)
    .addFields(
      { name: "Amount", value: formatLedgerAmount(entry.amount_sats, entry.token ?? "SATS"), inline: false },
      { name: "Sender", value: senderLine, inline: false },
      {
        name: "Sender Balance",
        value: entry.sender_balance_sats != null
          ? formatLedgerAmount(entry.sender_balance_sats, entry.token ?? "SATS")
          : "N/A",
        inline: false,
      },
      { name: "Receiver", value: receiverLine, inline: false },
      {
        name: "Receiver Balance",
        value: entry.receiver_balance_sats != null
          ? formatLedgerAmount(entry.receiver_balance_sats, entry.token ?? "SATS")
          : "N/A",
        inline: false,
      },
      { name: "Transaction ID", value: entry.transaction_id, inline: false },
    )
    .setFooter({ text: `⚡ Timestamp • ${ts}` });
}

async function balanceForParty(partyId: LedgerPartyId, token: TokenSymbol = "SATS"): Promise<number | null> {
  if (!partyId || partyId === "treasury" || partyId === "platform") return null;
  return getBalance(partyId, token);
}

async function postLedgerEmbed(client: Client, entry: LedgerEntryRow): Promise<void> {
  const config = await getLedgerChannelConfig();
  if (!config) return;

  const channel = await client.channels.fetch(config.channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    console.warn(`[Ledger] Channel ${config.channelId} not found or not text-based`);
    return;
  }

  const textChannel = channel as TextChannel;
  const me = textChannel.guild?.members.me ?? client.user;
  if (!me) return;

  const perms = textChannel.permissionsFor(me);
  if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms?.has(PermissionFlagsBits.SendMessages)) {
    console.warn(`[Ledger] Missing ViewChannel or SendMessages in channel ${config.channelId}`);
    return;
  }

  const senderLine = await formatLedgerUserLine(client, entry.sender_id as LedgerPartyId);
  const receiverLine = await formatLedgerUserLine(client, entry.receiver_id as LedgerPartyId);
  const embed = buildLedgerEmbed(entry, senderLine, receiverLine);

  await textChannel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch((err) => {
    console.warn(`[Ledger] Failed to post embed:`, (err as Error).message);
  });
}

export function recordLedgerEntry(client: Client | null, params: RecordLedgerParams): void {
  const resolved = client ?? boundClient;
  void recordLedgerEntryAsync(resolved, params).catch((err) => {
    console.warn("[Ledger] recordLedgerEntry failed:", (err as Error).message);
  });
}

async function recordLedgerEntryAsync(client: Client | null, params: RecordLedgerParams): Promise<void> {
  const amountSats = roundSats(params.amountSats);
  if (amountSats <= 0) return;

  const transactionId = randomUUID().replace(/-/g, "");
  const senderId = params.senderId ?? null;
  const receiverId = params.receiverId ?? null;
  const token = params.token ?? "SATS";

  const senderBalance = await balanceForParty(senderId, token);
  const receiverBalance = await balanceForParty(receiverId, token);

  const row = {
    transaction_id: transactionId,
    type: params.type,
    amount_sats: amountSats,
    token,
    sender_id: senderId,
    receiver_id: receiverId,
    sender_balance_sats: senderBalance,
    receiver_balance_sats: receiverBalance,
    guild_id: params.guildId ?? null,
    reference_type: params.referenceType ?? null,
    reference_id: params.referenceId ?? null,
    metadata: params.metadata ?? {},
  };

  const { error } = await supabase.from("ledger_entries").insert(row);
  if (error) {
    console.warn("[Ledger] DB insert failed:", error.message);
    return;
  }

  const entry: LedgerEntryRow = {
    ...row,
    created_at: new Date().toISOString(),
  };

  if (client) {
    await postLedgerEmbed(client, entry);
  }
}
