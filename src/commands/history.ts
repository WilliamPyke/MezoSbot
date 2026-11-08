import { EmbedBuilder, MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { supabase } from "../db.js";
import { config } from "../config.js";
import { formatTokenAmount, parseToken } from "../tokens.js";

const PAGE_SIZE = 10;
/** Discord rejects embed field values longer than this. */
const FIELD_LIMIT = 1024;

export const data = {
  name: "history",
  description: "View your deposit and withdrawal history",
  options: [
    {
      name: "type",
      type: 3 as const,
      description: "Which history to show (default: both)",
      required: false,
      choices: [
        { name: "Withdrawals", value: "withdrawals" },
        { name: "Deposits", value: "deposits" },
      ],
    },
    { name: "page", type: 4 as const, description: `Page to show, ${PAGE_SIZE} per page (default: 1, newest)`, required: false, minValue: 1 },
  ],
};

/** Splits lines into embed fields that each stay under Discord's value limit. */
function toFields(title: string, lines: string[]): { name: string; value: string }[] {
  const fields: { name: string; value: string }[] = [];
  let chunk = "";
  for (const line of lines) {
    if (chunk && chunk.length + 1 + line.length > FIELD_LIMIT) {
      fields.push({ name: fields.length ? `${title} (cont.)` : title, value: chunk });
      chunk = "";
    }
    chunk = chunk ? `${chunk}\n${line}` : line;
  }
  fields.push({ name: fields.length ? `${title} (cont.)` : title, value: chunk || "_None yet_" });
  return fields;
}

function pageLabel(name: string, page: number, total: number): string {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return `${name} — page ${page} of ${pages} (${total} total)`;
}

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const userId = interaction.user.id;
  const explorer = config.evm.explorerUrl;
  const type = interaction.options.getString("type");
  const page = interaction.options.getInteger("page") ?? 1;
  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle("📜 Transaction History").setTimestamp();

  if (type !== "withdrawals") {
    const { data: deposits, count, error } = await supabase
      .from("deposits")
      .select("tx_hash, amount_sats, token, created_at", { count: "exact" })
      .eq("discord_id", userId)
      .order("created_at", { ascending: false })
      .range(from, to);
    if (error) throw error;
    const lines = (deposits ?? []).map((d) => {
      const ts = Math.floor(new Date(d.created_at).getTime() / 1000);
      const link = d.tx_hash.startsWith("0x")
        ? `[\`${d.tx_hash.slice(0, 10)}...\`](${explorer}/tx/${d.tx_hash})`
        : `\`${d.tx_hash.slice(0, 16)}...\``;
      return `📥 **${formatTokenAmount(d.amount_sats, parseToken(d.token))}** — ${link} <t:${ts}:R>`;
    });
    embed.addFields(toFields(pageLabel("Deposits", page, count ?? 0), lines));
  }

  if (type !== "deposits") {
    const { data: withdrawals, count, error } = await supabase
      .from("withdrawals")
      .select("tx_hash, amount_sats, token, to_address, status, created_at", { count: "exact" })
      .eq("discord_id", userId)
      .order("created_at", { ascending: false })
      .range(from, to);
    if (error) throw error;
    const lines = (withdrawals ?? []).map((w) => {
      const ts = Math.floor(new Date(w.created_at).getTime() / 1000);
      const addr = `\`${w.to_address.slice(0, 10)}...\``;
      const icon = w.status === "completed" ? "✅" : w.status === "failed" ? "↩️" : "⏳";
      const link = w.tx_hash?.startsWith("0x") ? ` [tx](${explorer}/tx/${w.tx_hash})` : "";
      return `📤 ${icon} **${formatTokenAmount(w.amount_sats, parseToken(w.token))}** → ${addr}${link} <t:${ts}:R>`;
    });
    embed.addFields(toFields(pageLabel("Withdrawals", page, count ?? 0), lines));
  }

  embed.setFooter({ text: "Use /history page:<n> for older entries, or type: to show just one list." });
  await interaction.editReply({ embeds: [embed] });
}
