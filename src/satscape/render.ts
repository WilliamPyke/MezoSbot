import { createCanvas } from "@napi-rs/canvas";
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import { formatSats } from "../format.js";
import { biomeAt, SAT, viewportBounds } from "./engine.js";
import type { Biome, ViewModel } from "./types.js";

/* ─────────── custom-id helpers (mirrors arcade/ui.ts) ─────────── */
export const SQ_PREFIX = "satscape";
export const sqCid = (action: string, ...parts: (string | number)[]): string =>
  [SQ_PREFIX, action, ...parts].join(":");
export function parseSqCid(customId: string): { action: string; parts: string[] } | null {
  const [prefix, action, ...parts] = customId.split(":");
  if (prefix !== SQ_PREFIX) return null;
  return { action, parts };
}

export const MAP_FILE = "satscape-map.png";

const BIOME_COLOR: Record<Biome, string> = {
  town: "#1e3a8a",
  jungle: "#166534",
  desert: "#ca8a04",
  winter: "#cbd5e1",
  india: "#be185d",
};
const BIOME_LABEL: Record<Biome, string> = {
  town: "Town (safe)",
  jungle: "Jungle",
  desert: "Desert",
  winter: "Winter",
  india: "India",
};

const TILE = 26;
const LEGEND_H = 24;

/** Render the 16×16 viewport to a PNG attachment. */
export function buildMapImage(view: ViewModel): AttachmentBuilder {
  const { player, entities, others, combat } = view;
  const w = SAT.VIEW_W * TILE;
  const h = SAT.VIEW_H * TILE + LEGEND_H;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  const b = viewportBounds(player.x_coord, player.y_coord);

  // terrain
  for (let row = 0; row < SAT.VIEW_H; row++) {
    for (let col = 0; col < SAT.VIEW_W; col++) {
      const tx = b.minX + col;
      const ty = b.minY + row;
      const px = col * TILE;
      const py = row * TILE;
      ctx.fillStyle = BIOME_COLOR[biomeAt(tx, ty)];
      ctx.fillRect(px, py, TILE, TILE);
      // subtle deterministic shading so regions aren't flat
      const jitter = Math.abs(Math.sin(tx * 1.3 + ty * 2.7)) * 0.12;
      ctx.fillStyle = `rgba(0,0,0,${jitter.toFixed(3)})`;
      ctx.fillRect(px, py, TILE, TILE);
      ctx.strokeStyle = "rgba(2,6,23,0.35)";
      ctx.lineWidth = 1;
      ctx.strokeRect(px + 0.5, py + 0.5, TILE, TILE);
    }
  }

  const toPx = (x: number, y: number) => [(x - b.minX) * TILE, (y - b.minY) * TILE] as const;

  // entities
  for (const e of entities) {
    const [px, py] = toPx(e.x, e.y);
    const cx = px + TILE / 2;
    const cy = py + TILE / 2;
    if (e.type === "chest") {
      ctx.fillStyle = "#b45309";
      ctx.fillRect(cx - 7, cy - 5, 14, 11);
      ctx.fillStyle = "#fbbf24";
      ctx.fillRect(cx - 7, cy - 1, 14, 2);
    } else {
      ctx.fillStyle = "#ef4444";
      ctx.beginPath();
      ctx.moveTo(cx, cy - 7);
      ctx.lineTo(cx + 7, cy + 6);
      ctx.lineTo(cx - 7, cy + 6);
      ctx.closePath();
      ctx.fill();
    }
  }

  // other players
  ctx.font = "9px sans-serif";
  for (const o of others) {
    const [px, py] = toPx(o.x, o.y);
    const cx = px + TILE / 2;
    const cy = py + TILE / 2;
    ctx.fillStyle = o.state === "combat" ? "#f97316" : "#38bdf8";
    ctx.beginPath();
    ctx.arc(cx, cy, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#0f172a";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    const label = o.name.slice(0, 10);
    ctx.fillStyle = "rgba(2,6,23,0.7)";
    const tw = ctx.measureText(label).width + 4;
    ctx.fillRect(cx - tw / 2, py - 11, tw, 11);
    ctx.fillStyle = "#e2e8f0";
    ctx.textAlign = "center";
    ctx.fillText(label, cx, py - 2);
    ctx.textAlign = "left";
  }

  // self (always centred)
  {
    const [px, py] = toPx(player.x_coord, player.y_coord);
    const cx = px + TILE / 2;
    const cy = py + TILE / 2;
    ctx.fillStyle = combat ? "#fde047" : "#ffffff";
    ctx.beginPath();
    ctx.arc(cx, cy, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#0f172a";
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.fillStyle = "#0f172a";
    ctx.font = "bold 11px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("★", cx, cy + 4);
    ctx.textAlign = "left";
  }

  // legend strip
  const biome = biomeAt(player.x_coord, player.y_coord);
  ctx.fillStyle = "#0f172a";
  ctx.fillRect(0, SAT.VIEW_H * TILE, w, LEGEND_H);
  ctx.fillStyle = "#e2e8f0";
  ctx.font = "12px sans-serif";
  ctx.fillText(`${BIOME_LABEL[biome]}  ·  (${player.x_coord}, ${player.y_coord})`, 8, SAT.VIEW_H * TILE + 16);

  return new AttachmentBuilder(canvas.toBuffer("image/png"), { name: MAP_FILE });
}

function bar(value: number, max: number, width = 12): string {
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const filled = Math.round(ratio * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

export function buildMapEmbed(view: ViewModel): EmbedBuilder {
  const { player, hp, others, combat } = view;
  const biome = biomeAt(player.x_coord, player.y_coord);
  const maxRef = Math.max(player.display_max_hp, hp, 1);

  const embed = new EmbedBuilder()
    .setColor(combat ? 0xf43f5e : biome === "town" ? 0x1d4ed8 : 0x15803d)
    .setTitle(combat ? "⚔️ SatScape — Combat" : "🗺️ SatScape")
    .setImage(`attachment://${MAP_FILE}`)
    .addFields(
      { name: "HP (your sats)", value: `${bar(hp, maxRef)}\n${formatSats(hp)}`, inline: true },
      { name: "Stamina", value: `${bar(player.hunger, 100)}\n${player.hunger}%`, inline: true },
      { name: "Location", value: `${BIOME_LABEL[biome]} \`(${player.x_coord}, ${player.y_coord})\``, inline: true },
    );

  if (combat) {
    embed.addFields({
      name: `👹 ${combat.monster_name}`,
      value: `${bar(combat.monster_current_hp, combat.monster_max_hp)}\n${combat.monster_current_hp}/${combat.monster_max_hp} HP · ⚔️ ${combat.monster_attack} atk`,
      inline: false,
    });
  } else if (others.length > 0) {
    embed.setFooter({ text: `👥 ${others.length} adventurer${others.length === 1 ? "" : "s"} nearby` });
  }

  return embed;
}

export function buildComponents(
  view: ViewModel,
  opts: { autoExploring?: boolean } = {},
): ActionRowBuilder<ButtonBuilder>[] {
  if (view.combat) {
    return [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(sqCid("attack")).setLabel("Attack").setEmoji("⚔️").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(sqCid("flee")).setLabel("Flee").setEmoji("🏃").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(sqCid("eat")).setLabel("Eat Bread").setEmoji("🍞").setStyle(ButtonStyle.Success),
      ),
    ];
  }
  const auto = opts.autoExploring
    ? new ButtonBuilder().setCustomId(sqCid("autostop")).setLabel("Stop").setEmoji("⏹️").setStyle(ButtonStyle.Danger)
    : new ButtonBuilder().setCustomId(sqCid("auto")).setLabel("Auto-Explore").setEmoji("🤖").setStyle(ButtonStyle.Secondary);
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
      new ButtonBuilder().setCustomId(sqCid("eat")).setLabel("Eat").setEmoji("🍞").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(sqCid("travel")).setLabel("Travel").setEmoji("🧭").setStyle(ButtonStyle.Primary),
      auto,
    ),
  ];
}
