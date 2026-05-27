import { EmbedBuilder, MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { formatSats } from "../format.js";
import { SAT } from "../satquest/engine.js";
import { chargeBuyIn } from "../satquest/game.js";
import { getPlayer, loadView, startRun } from "../satquest/db.js";
import { buildComponents, buildMapEmbed } from "../satquest/render.js";

export const data = {
  name: "satquest",
  description: "Grid RPG — explore the wilds, fight monsters, and loot sats",
  options: [
    {
      name: "join",
      type: 1 as const, // SUB_COMMAND
      description: `Start a run (costs a ${SAT.BUYIN_SATS}-sat buy-in that seeds the prize pool)`,
    },
    {
      name: "map",
      type: 1 as const,
      description: "Show your current viewport and controls",
    },
  ],
};

export async function execute(interaction: ChatInputCommandInteraction) {
  const sub = interaction.options.getSubcommand();
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const discordId = interaction.user.id;

  if (sub === "join") {
    const existing = await getPlayer(discordId);
    if (!existing?.active) {
      const paid = await chargeBuyIn(discordId);
      if (!paid) {
        const embed = new EmbedBuilder()
          .setColor(0xef4444)
          .setTitle("Not enough sats")
          .setDescription(`SatQuest costs a **${formatSats(SAT.BUYIN_SATS)}** buy-in to start. Top up and try again.`);
        return interaction.editReply({ embeds: [embed] });
      }
      await startRun(discordId);
    }
  }

  const view = await loadView(discordId);
  if (!view) {
    return interaction.editReply({ content: "Use `/satquest join` to start a run." });
  }

  await interaction.editReply({
    content:
      sub === "join"
        ? "🗺️ Welcome to SatQuest! Your HP **is** your sats balance. Head out past the town walls to find chests and monsters."
        : undefined,
    embeds: [buildMapEmbed(view)],
    components: buildComponents(view),
  });
}
