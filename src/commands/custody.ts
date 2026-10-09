import { AttachmentBuilder, MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { config } from "../config.js";
import { getCustodyMode, getFreezeState, isCustodyFrozen } from "../custody/state.js";
import { clearCustodyFreeze } from "../custody/watchdog.js";
import type { Anomaly } from "../custody/watchdogCore.js";
import { buildCustodyEmbed } from "./treasury.js";

export const data = {
  name: "custody",
  description: "Admin: custody mode, wallets and watchdog freeze",
  default_member_permissions: "0",
  options: [
    { name: "status", type: 1 as const, description: "Custody mode, reasons, balances, payout limits and gas wallets" },
    {
      name: "unfreeze",
      type: 1 as const,
      description: "Clear a watchdog freeze after investigating it",
      options: [
        { name: "note", type: 3 as const, description: "What was investigated and fixed (logged)", required: true },
        {
          name: "confirm",
          type: 3 as const,
          description: "Confirmation code for anomalies the freeze did not record (shown by a first unfreeze)",
          required: false,
        },
      ],
    },
  ],
};

const REPLY_LIMIT = 1900;

function describeAnomaly(anomaly: Anomaly): string {
  const parts: string[] = [anomaly.kind];
  if (anomaly.withdrawalId != null) parts.push(`withdrawal ${anomaly.withdrawalId}`);
  if (anomaly.ref) parts.push(`ref ${anomaly.ref}`);
  if (anomaly.txHash) parts.push(`tx ${anomaly.txHash}`);
  if (anomaly.block != null) parts.push(`block ${anomaly.block}`);
  return `• ${anomaly.key}: ${parts.join(", ")}\n  ${anomaly.description}`;
}

/** Header in the message; the details too when they fit, otherwise all of them in an attached text file. */
function longReply(interaction: ChatInputCommandInteraction, header: string, details: string[]) {
  const full = [header, ...details].join("\n");
  if (full.length <= REPLY_LIMIT) return interaction.editReply({ content: full });
  return interaction.editReply({
    content: `${header.slice(0, REPLY_LIMIT - 60)}\nThe full list is attached.`,
    files: [new AttachmentBuilder(Buffer.from(full, "utf8"), { name: "custody-unfreeze.txt" })],
  });
}

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!config.discord.adminIds.includes(interaction.user.id)) {
    return interaction.reply({ content: "❌ Admin only.", flags: MessageFlags.Ephemeral });
  }
  const subcommand = interaction.options.getSubcommand(true);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (subcommand === "status") {
    try {
      return interaction.editReply({ embeds: [await buildCustodyEmbed(true)] });
    } catch (error) {
      return interaction.editReply({ content: `❌ Could not read custody status: ${(error as Error).message}` });
    }
  }

  if (subcommand === "unfreeze") {
    if (getCustodyMode() !== "v2") {
      return interaction.editReply({ content: "Custody v2 is not active; there is no watchdog freeze to clear." });
    }
    const frozen = getFreezeState();
    if (!frozen) {
      return interaction.editReply({
        content: isCustodyFrozen()
          ? "Custody signing is blocked because the freeze flag could not be read from the database yet; check Supabase."
          : "Custody is not frozen.",
      });
    }
    const note = interaction.options.getString("note", true).slice(0, 500);
    const confirm = interaction.options.getString("confirm")?.trim() || null;
    try {
      const result = await clearCustodyFreeze(interaction.user.id, note, confirm);
      if (result.status === "confirm") {
        return longReply(interaction, [
          `⚠️ Custody stays frozen. The checks up to the chain head found ${result.newAnomalies.length} anomal${result.newAnomalies.length === 1 ? "y" : "ies"} ` +
            "the freeze did not record (no admin was shown them):",
          confirm ? `(The code \`${confirm}\` does not match this set.)` : "",
          `Review every one, then run \`/custody unfreeze\` again with \`confirm:${result.code}\` to accept exactly this set; ` +
            "if it changes meanwhile you get a new list and code.",
        ].filter(Boolean).join("\n"), result.newAnomalies.map(describeAnomaly));
      }
      if (result.status === "changed") {
        return longReply(interaction, "⚠️ Custody stays frozen: new anomalies were recorded while the checks ran. " +
          "They were DM'd to admins; review them and run `/custody unfreeze` again.", result.addedKeys.map((key) => `• ${key}`));
      }
      const shown = new Map(result.acknowledged.map((anomaly) => [anomaly.key, anomaly]));
      return longReply(interaction, [
        `✅ Custody freeze cleared (was: ${frozen.reason}).`,
        ...result.lines,
        result.recordedKeys.length > 0
          ? `Acknowledged (held for manual review; they never freeze custody again): ${result.recordedKeys.join(", ")}`
          : "No anomaly to acknowledge.",
      ].join("\n"), result.recordedKeys.flatMap((key) => {
        const anomaly = shown.get(key);
        return anomaly ? [describeAnomaly(anomaly)] : [];
      }));
    } catch (error) {
      return interaction.editReply({ content: `❌ Could not clear the freeze (custody stays frozen): ${(error as Error).message}` });
    }
  }

  return interaction.editReply({ content: "Unknown custody command." });
}
