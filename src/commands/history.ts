import { EmbedBuilder, MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { supabase } from "../db.js";
import { formatSats } from "../format.js";
import { config } from "../config.js";
import { formatTokenAmount, parseToken } from "../tokens.js";

export const data = {
  name: "history",
  description: "View your recent deposit and withdrawal history",
};

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const userId = interaction.user.id;
  const explorer = config.evm.explorerUrl;

  const { data: deposits } = await supabase
    .from("deposits")
    .select("tx_hash, amount_sats, token, created_at")
    .eq("discord_id", userId)
    .order("created_at", { ascending: false })
    .limit(5);

  const { data: withdrawals } = await supabase
    .from("withdrawals")
    .select("tx_hash, amount_sats, token, to_address, status, created_at")
    .eq("discord_id", userId)
    .order("created_at", { ascending: false })
    .limit(5);

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("📜 Transaction History")
    .setTimestamp();

  // Deposits field
  if (deposits && deposits.length > 0) {
    const lines = deposits.map((d) => {
      const ts = Math.floor(new Date(d.created_at).getTime() / 1000);
      const link = d.tx_hash.startsWith("0x")
        ? `[\`${d.tx_hash.slice(0, 10)}...\`](${explorer}/tx/${d.tx_hash})`
        : `\`${d.tx_hash.slice(0, 16)}...\``;
      return `📥 **${formatTokenAmount(d.amount_sats, parseToken(d.token))}** — ${link} <t:${ts}:R>`;
    });
    embed.addFields({ name: "Deposits", value: lines.join("\n") });
  } else {
    embed.addFields({ name: "Deposits", value: "_None yet_" });
  }

  // Withdrawals field
  if (withdrawals && withdrawals.length > 0) {
    const lines = withdrawals.map((w) => {
      const ts = Math.floor(new Date(w.created_at).getTime() / 1000);
      const addr = `\`${w.to_address.slice(0, 10)}...\``;
      const icon = w.status === "pending" ? "⏳" : "✅";
      return `📤 ${icon} **${formatTokenAmount(w.amount_sats, parseToken(w.token))}** → ${addr} <t:${ts}:R>`;
    });
    embed.addFields({ name: "Withdrawals", value: lines.join("\n") });
  } else {
    embed.addFields({ name: "Withdrawals", value: "_None yet_" });
  }

  await interaction.editReply({ embeds: [embed] });
}
