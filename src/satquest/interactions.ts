import { type ButtonInteraction, type Interaction } from "discord.js";
import { loadView } from "./db.js";
import { attack, eat, flee, move, type ActionResult } from "./game.js";
import { buildComponents, buildMapEmbed, parseSqCid, SQ_PREFIX } from "./render.js";
import type { Direction } from "./types.js";

export function isSatquestInteraction(interaction: Interaction): boolean {
  return interaction.isButton() && interaction.customId.startsWith(`${SQ_PREFIX}:`);
}

const DIRECTIONS = new Set(["up", "down", "left", "right"]);

export async function handleSatquestInteraction(interaction: Interaction): Promise<void> {
  if (!interaction.isButton()) return;
  const parsed = parseSqCid(interaction.customId);
  if (!parsed) return;
  const { action } = parsed;

  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
  } catch (err) {
    if ((err as { code?: number })?.code === 10062) return; // token expired
    console.warn(`[SatQuest] defer failed for ${action}:`, (err as Error)?.message ?? err);
    return;
  }

  const discordId = interaction.user.id;
  let result: ActionResult;
  if (DIRECTIONS.has(action)) result = await move(discordId, action as Direction);
  else if (action === "attack") result = await attack(discordId);
  else if (action === "flee") result = await flee(discordId);
  else if (action === "eat") result = await eat(discordId);
  else return;

  await rerender(interaction as ButtonInteraction, result.note);
}

/** Re-fetch the player's frame and update the ephemeral game message. */
async function rerender(interaction: ButtonInteraction, note: string): Promise<void> {
  const view = await loadView(interaction.user.id);
  if (!view) {
    await interaction.editReply({ content: "Your run ended. Use `/satquest join` to play again.", embeds: [], components: [] });
    return;
  }
  await interaction.editReply({
    content: note || undefined,
    embeds: [buildMapEmbed(view)],
    components: buildComponents(view),
  });
}
