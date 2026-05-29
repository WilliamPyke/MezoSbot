import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
} from "discord.js";
import { formatSats } from "../format.js";
import { SAT, biomeAt } from "../satscape/engine.js";
import { chargeBuyIn } from "../satscape/game.js";
import { getPlayer, startRun } from "../satscape/db.js";
import { buildSatscapePlayUrl } from "../satscape/web_tokens.js";

export const data = {
  name: "satscape",
  description: "Grid RPG - explore the wilds, fight monsters, and loot sats",
  options: [
    {
      name: "join",
      type: 1 as const,
      description: `Start a run (costs a ${SAT.BUYIN_SATS}-sat buy-in that seeds the prize pool)`,
    },
    {
      name: "map",
      type: 1 as const,
      description: "Show your live browser map and controls",
    },
    {
      name: "shop",
      type: 1 as const,
      description: "Open the town item shop (must be in town)",
    },
    {
      name: "quests",
      type: 1 as const,
      description: "Open the town keeper's quest board (must be in town)",
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

  if (sub === "shop" || sub === "quests") {
    const player = await getPlayer(discordId);
    if (biomeAt(player!.x_coord, player!.y_coord) !== "town") {
      return interaction.editReply({ content: `${sub === "shop" ? "The item shop" : "The quest board"} is only available in a town.` });
    }
    return interaction.editReply(buildPlayReply(discordId, sub));
  }

  return interaction.editReply(buildPlayReply(discordId, sub === "join" ? "join" : "map"));
}

function buildPlayReply(discordId: string, target: "join" | "map" | "shop" | "quests") {
  const url = buildSatscapePlayUrl(discordId) + (target === "shop" || target === "quests" ? `#${target}` : "");
  const embed = new EmbedBuilder()
    .setColor(0x22c55e)
    .setTitle(target === "join" ? "Welcome to SatScape" : "SatScape is ready")
    .setDescription(
      target === "join"
        ? "Your HP is now a capped at-risk slice of your sats. Open the browser map for instant movement, combat, shops, quests, and HP refills."
        : "Open your browser map to keep playing without Discord edit latency.",
    );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setURL(url)
      .setLabel("Play SatScape in your browser"),
  );
  return { embeds: [embed], components: [row] };
}
