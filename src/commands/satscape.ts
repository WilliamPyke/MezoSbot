import { EmbedBuilder, MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { formatSats } from "../format.js";
import { SAT } from "../satscape/engine.js";
import { chargeBuyIn } from "../satscape/game.js";
import { getPlayer, startRun } from "../satscape/db.js";
import { render } from "../satscape/session.js";

export const data = {
  name: "satscape",
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
      description: "Show your live map and controls",
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
          .setDescription(`SatScape costs a **${formatSats(SAT.BUYIN_SATS)}** buy-in to start. Top up and try again.`);
        return interaction.editReply({ embeds: [embed] });
      }
      await startRun(discordId);
    }
  } else if (!(await getPlayer(discordId))?.active) {
    return interaction.editReply({ content: "Use `/satscape join` to start a run." });
  }

  await render(
    discordId,
    interaction,
    sub === "join"
      ? "🗺️ Welcome to SatScape! Your HP **is** your sats balance. Head past the town walls to find chests and monsters."
      : undefined,
  );
}
