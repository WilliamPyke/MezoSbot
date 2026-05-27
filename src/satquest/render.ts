import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import { formatSats } from "../format.js";
import { biomeAt, SAT } from "./engine.js";
import type { ViewModel } from "./types.js";

/* ─────────── custom-id helpers (mirrors arcade/ui.ts) ─────────── */
export const SQ_PREFIX = "satquest";
export const sqCid = (action: string, ...parts: (string | number)[]): string =>
  [SQ_PREFIX, action, ...parts].join(":");
export function parseSqCid(customId: string): { action: string; parts: string[] } | null {
  const [prefix, action, ...parts] = customId.split(":");
  if (prefix !== SQ_PREFIX) return null;
  return { action, parts };
}

/* ─────────── tiles ─────────── */
const TILE: Record<string, string> = { town: "🟦", jungle: "🟩", desert: "🟨", winter: "⬜" };
const ENT: Record<string, string> = { chest: "🟫", monster: "🟥" };

function bar(value: number, max: number, width = 10): string {
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const filled = Math.round(ratio * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

export function buildMapEmbed(view: ViewModel): EmbedBuilder {
  const { player, hp, entities, combat } = view;
  const r = SAT.VIEW_RADIUS;
  let grid = "";
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx === 0 && dy === 0) {
        grid += "🧙";
        continue;
      }
      const x = player.x_coord + dx;
      const y = player.y_coord + dy;
      const ent = entities.find((e) => e.x === x && e.y === y);
      grid += ent ? (ENT[ent.entity_type] ?? "⬛") : (TILE[biomeAt(x, y)] ?? "⬛");
    }
    grid += "\n";
  }

  const biome = biomeAt(player.x_coord, player.y_coord);
  const maxRef = Math.max(player.display_max_hp, hp, 1);

  const embed = new EmbedBuilder()
    .setColor(combat ? 0xf43f5e : biome === "town" ? 0x1d4ed8 : 0x15803d)
    .setTitle(combat ? "⚔️ SatQuest — Combat" : "🗺️ SatQuest")
    .setDescription("```\n" + grid + "```")
    .addFields(
      { name: "HP (your sats)", value: `${bar(hp, maxRef)}\n${formatSats(hp)}`, inline: true },
      { name: "Hunger", value: `${bar(player.hunger, 100)}\n${player.hunger}%`, inline: true },
      {
        name: "Location",
        value: `${biome} \`(${player.x_coord}, ${player.y_coord})\``,
        inline: false,
      },
    );

  if (combat) {
    embed.addFields({
      name: `👹 ${combat.monster_name}`,
      value: `${bar(combat.monster_current_hp, combat.monster_max_hp)}\n${combat.monster_current_hp}/${combat.monster_max_hp} HP · ⚔️ ${combat.monster_attack} atk`,
      inline: false,
    });
  }

  return embed;
}

export function buildComponents(view: ViewModel): ActionRowBuilder<ButtonBuilder>[] {
  if (view.combat) {
    return [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(sqCid("attack")).setLabel("Attack").setEmoji("⚔️").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(sqCid("flee")).setLabel("Flee").setEmoji("🏃").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(sqCid("eat")).setLabel("Eat Bread").setEmoji("🍞").setStyle(ButtonStyle.Success),
      ),
    ];
  }
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(sqCid("up")).setEmoji("⬆️").setStyle(ButtonStyle.Primary),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(sqCid("left")).setEmoji("⬅️").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(sqCid("down")).setEmoji("⬇️").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(sqCid("right")).setEmoji("➡️").setStyle(ButtonStyle.Primary),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(sqCid("eat")).setLabel("Eat Bread").setEmoji("🍞").setStyle(ButtonStyle.Success),
    ),
  ];
}
