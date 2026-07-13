import { EmbedBuilder, type Client } from "discord.js";
import { formatTokenAmount, type TokenSymbol } from "./tokens.js";

export type TransferNotificationKind = "tip" | "rain" | "distribute" | "drop" | "quest";

const TITLES: Record<TransferNotificationKind, string> = {
  tip: "⚡ You Received a Tip!",
  rain: "🌧️ You Were Rained On!",
  distribute: "📤 You Received a Distribution!",
  drop: "🎁 You Claimed a Drop!",
  quest: "Quest Reward Earned",
};

const LABELS: Record<TransferNotificationKind, string> = {
  tip: "Tip",
  rain: "Rain",
  distribute: "Distribution",
  drop: "Drop Claim",
  quest: "Event Quest",
};

const COLORS: Record<TransferNotificationKind, number> = {
  tip: 0x00cc6a,
  rain: 0x3498db,
  distribute: 0x9b59b6,
  drop: 0xf0b232,
  quest: 0x00cc6a,
};

type SendTransferReceivedDmParams = {
  client: Client;
  recipientId: string;
  senderId: string;
  amountSats: number;
  token?: TokenSymbol;
  kind: TransferNotificationKind;
  customMessage?: string;
};

export async function sendTransferReceivedDm({
  client,
  recipientId,
  senderId,
  amountSats,
  token = "SATS",
  kind,
  customMessage,
}: SendTransferReceivedDmParams): Promise<void> {
  const embed = new EmbedBuilder()
    .setColor(COLORS[kind])
    .setTitle(TITLES[kind])
    .addFields(
      { name: "From", value: `<@${senderId}>`, inline: true },
      { name: "Type", value: LABELS[kind], inline: true },
      { name: "Amount", value: `**${formatTokenAmount(amountSats, token)}**`, inline: true },
    )
    .setFooter({ text: "Use /balance to check your total" })
    .setTimestamp();

  if (customMessage) {
    embed.addFields({ name: "Message", value: customMessage });
  }

  try {
    const recipient = await client.users.fetch(recipientId);
    await recipient.send({ embeds: [embed] });
  } catch {
    // Intentionally ignore DM failures so successful transfers are never blocked.
  }
}
