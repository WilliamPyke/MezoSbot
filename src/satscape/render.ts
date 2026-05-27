import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import { formatSats } from "../format.js";
import { biomeAt, SAT, viewportBounds } from "./engine.js";
import { estimateTravel, travelCost, type TravelEstimate } from "./game.js";
import { lossFor, winChance } from "./items.js";
import {
  effectivePrice,
  gearScore,
  ITEM_BY_ID,
  nearestTown,
  TERRAIN_COLOR,
  TOWNS,
  townAt,
  type KeeperPersona,
  type Terrain,
  type Town,
} from "./towns.js";
import type { SatPlayerRow, ViewModel } from "./types.js";

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

const TILE = 26;
const LEGEND_H = 24;
const FOG = "#060a14";

function terrainLabel(t: Terrain): string {
  return t === "town" ? "Town" : t.charAt(0).toUpperCase() + t.slice(1);
}

/** Where am I, in words: town name if in a safe zone, else "terrain · near Town". */
function locationLabel(x: number, y: number): string {
  const here = townAt(x, y);
  if (here) return `🏙️ ${here.name}`;
  return `${terrainLabel(biomeAt(x, y))} · near ${nearestTown(x, y).town.name}`;
}

/** Render the 16×16 viewport to a PNG attachment, with fog of war. */
export function buildMapImage(view: ViewModel): AttachmentBuilder {
  const { player, entities, others, combat, explored } = view;
  const w = SAT.VIEW_W * TILE;
  const h = SAT.VIEW_H * TILE + LEGEND_H;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  const b = viewportBounds(player.x_coord, player.y_coord);
  const r2 = SAT.SIGHT * SAT.SIGHT + SAT.SIGHT;
  const inSight = (x: number, y: number) => {
    const dx = x - player.x_coord;
    const dy = y - player.y_coord;
    return dx * dx + dy * dy <= r2;
  };

  for (let row = 0; row < SAT.VIEW_H; row++) {
    for (let col = 0; col < SAT.VIEW_W; col++) {
      const tx = b.minX + col;
      const ty = b.minY + row;
      const px = col * TILE;
      const py = row * TILE;
      const seen = inSight(tx, ty);
      const known = seen || explored.has(`${tx},${ty}`);
      if (!known) {
        ctx.fillStyle = FOG;
        ctx.fillRect(px, py, TILE, TILE);
        continue;
      }
      ctx.fillStyle = TERRAIN_COLOR[biomeAt(tx, ty)];
      ctx.fillRect(px, py, TILE, TILE);
      const jitter = Math.abs(Math.sin(tx * 1.3 + ty * 2.7)) * 0.12;
      ctx.fillStyle = `rgba(0,0,0,${jitter.toFixed(3)})`;
      ctx.fillRect(px, py, TILE, TILE);
      if (!seen) {
        // explored but out of current sight → dim "memory"
        ctx.fillStyle = "rgba(2,6,23,0.5)";
        ctx.fillRect(px, py, TILE, TILE);
      }
      ctx.strokeStyle = "rgba(2,6,23,0.35)";
      ctx.lineWidth = 1;
      ctx.strokeRect(px + 0.5, py + 0.5, TILE, TILE);
    }
  }

  const toPx = (x: number, y: number) => [(x - b.minX) * TILE, (y - b.minY) * TILE] as const;

  // entities — only what's currently in sight
  for (const e of entities) {
    if (!inSight(e.x, e.y)) continue;
    const [px, py] = toPx(e.x, e.y);
    const cx = px + TILE / 2;
    const cy = py + TILE / 2;
    if (e.type === "chest") drawChest(ctx, cx, cy);
    else drawMonster(ctx, cx, cy, nearestTown(e.x, e.y).town.monsterColor, nameVariant(String(e.data.name ?? "")));
  }

  // town keepers standing in their towns (if the centre is in view & known)
  for (const t of TOWNS) {
    if (t.cx < b.minX || t.cx > b.maxX || t.cy < b.minY || t.cy > b.maxY) continue;
    if (!(inSight(t.cx, t.cy) || explored.has(`${t.cx},${t.cy}`))) continue;
    const [px, py] = toPx(t.cx, t.cy);
    drawKeeper(ctx, px + TILE / 2, py + TILE / 2, t.keeper.persona);
  }

  // other players — only what's currently in sight
  ctx.font = "9px sans-serif";
  for (const o of others) {
    if (!inSight(o.x, o.y)) continue;
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

  // self (always centred & visible)
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
  ctx.fillStyle = "#0f172a";
  ctx.fillRect(0, SAT.VIEW_H * TILE, w, LEGEND_H);
  ctx.fillStyle = "#e2e8f0";
  ctx.font = "12px sans-serif";
  // strip emoji (canvas has no colour-emoji font) but keep punctuation like "·"
  const legend = `${locationLabel(player.x_coord, player.y_coord)}  ·  (${player.x_coord}, ${player.y_coord})`.replace(/\p{Extended_Pictographic}/gu, "").trim();
  ctx.fillText(legend, 8, SAT.VIEW_H * TILE + 16);

  return new AttachmentBuilder(canvas.toBuffer("image/png"), { name: MAP_FILE });
}

/* ─────────── sprites (drawn procedurally — no binary art) ─────────── */

const ROBE: Record<KeeperPersona, string> = {
  business: "#1e40af",
  fair: "#15803d",
  greedy: "#b91c1c",
  bargain: "#a16207",
};

function nameVariant(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 3;
}

function drawChest(ctx: SKRSContext2D, cx: number, cy: number): void {
  ctx.fillStyle = "#7c4a1e";
  ctx.fillRect(cx - 8, cy - 4, 16, 10); // body
  ctx.fillStyle = "#a16207";
  ctx.fillRect(cx - 8, cy - 8, 16, 5); // lid
  ctx.fillStyle = "#fbbf24";
  ctx.fillRect(cx - 8, cy - 1, 16, 2); // band
  ctx.fillStyle = "#fde047";
  ctx.fillRect(cx - 2, cy - 2, 4, 5); // lock
}

function drawMonster(ctx: SKRSContext2D, cx: number, cy: number, tint: string, variant: number): void {
  // horns
  ctx.fillStyle = "#0f172a";
  ctx.beginPath();
  ctx.moveTo(cx - 6, cy - 4); ctx.lineTo(cx - 8, cy - 11); ctx.lineTo(cx - 3, cy - 6); ctx.closePath(); ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx + 6, cy - 4); ctx.lineTo(cx + 8, cy - 11); ctx.lineTo(cx + 3, cy - 6); ctx.closePath(); ctx.fill();
  // body
  ctx.fillStyle = tint;
  ctx.beginPath();
  ctx.arc(cx, cy + 1, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#0f172a";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // eyes (1..3 by variant)
  const eyes = variant + 1;
  ctx.fillStyle = "#fde047";
  for (let i = 0; i < eyes; i++) {
    const ex = cx + (i - (eyes - 1) / 2) * 5;
    ctx.beginPath();
    ctx.arc(ex, cy - 1, 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
  // fangs
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.moveTo(cx - 3, cy + 6); ctx.lineTo(cx - 1, cy + 6); ctx.lineTo(cx - 2, cy + 9); ctx.closePath(); ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx + 3, cy + 6); ctx.lineTo(cx + 1, cy + 6); ctx.lineTo(cx + 2, cy + 9); ctx.closePath(); ctx.fill();
}

function drawKeeper(ctx: SKRSContext2D, cx: number, cy: number, persona: KeeperPersona): void {
  // robe (trapezoid body)
  ctx.fillStyle = ROBE[persona];
  ctx.beginPath();
  ctx.moveTo(cx - 6, cy + 9); ctx.lineTo(cx + 6, cy + 9); ctx.lineTo(cx + 4, cy - 1); ctx.lineTo(cx - 4, cy - 1); ctx.closePath();
  ctx.fill();
  // head
  ctx.fillStyle = "#f1c27d";
  ctx.beginPath();
  ctx.arc(cx, cy - 4, 4, 0, Math.PI * 2);
  ctx.fill();
  // merchant cap
  ctx.fillStyle = "#0f172a";
  ctx.fillRect(cx - 5, cy - 8, 10, 3);
  ctx.fillRect(cx - 2, cy - 11, 4, 3);
}

export const KEEPER_FILE = "satscape-keeper.png";

/** A small keeper portrait for the shop embed thumbnail. */
export function buildKeeperPortrait(town: Town): AttachmentBuilder {
  const canvas = createCanvas(96, 96);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#0f172a";
  ctx.fillRect(0, 0, 96, 96);
  // scaled-up keeper
  ctx.save();
  ctx.translate(48, 40);
  ctx.scale(3, 3);
  drawKeeper(ctx, 0, 0, town.keeper.persona);
  ctx.restore();
  ctx.fillStyle = "#e2e8f0";
  ctx.font = "bold 11px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(town.keeper.name.slice(0, 14), 48, 90);
  return new AttachmentBuilder(canvas.toBuffer("image/png"), { name: KEEPER_FILE });
}

function bar(value: number, max: number, width = 12): string {
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const filled = Math.round(ratio * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

export function buildMapEmbed(view: ViewModel): EmbedBuilder {
  const { player, hp, others, combat } = view;
  const here = townAt(player.x_coord, player.y_coord);
  const maxRef = Math.max(player.display_max_hp, hp, 1);

  const embed = new EmbedBuilder()
    .setColor(combat ? 0xf43f5e : here ? 0x1d4ed8 : 0x15803d)
    .setTitle(combat ? "⚔️ SatScape — Combat" : "🗺️ SatScape")
    .setImage(`attachment://${MAP_FILE}`)
    .addFields(
      { name: "HP (your sats)", value: `${bar(hp, maxRef)}\n${formatSats(hp)}`, inline: true },
      { name: "Stamina", value: `${bar(player.hunger, 100)}\n${player.hunger}%`, inline: true },
      { name: "Location", value: `${locationLabel(player.x_coord, player.y_coord)} \`(${player.x_coord}, ${player.y_coord})\``, inline: true },
    );

  if (combat) {
    const chance = Math.round(winChance(gearScore(player), combat.monster_level) * 100);
    embed.addFields({
      name: `👹 ${combat.monster_name} — level ${combat.monster_level}`,
      value: `🎯 Win chance: **${chance}%**\n🏆 Loot: up to ${formatSats(combat.reward_sats)} · 🩸 Defeat: −${lossFor(combat.monster_level)} sats`,
      inline: false,
    });
  } else if (others.length > 0) {
    embed.setFooter({ text: `👥 ${others.length} adventurer${others.length === 1 ? "" : "s"} in sight` });
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
        new ButtonBuilder().setCustomId(sqCid("fight")).setLabel("Fight").setEmoji("⚔️").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(sqCid("flee")).setLabel("Flee").setEmoji("🏃").setStyle(ButtonStyle.Secondary),
      ),
    ];
  }
  const auto = opts.autoExploring
    ? new ButtonBuilder().setCustomId(sqCid("autostop")).setLabel("Stop").setEmoji("⏹️").setStyle(ButtonStyle.Danger)
    : new ButtonBuilder().setCustomId(sqCid("auto")).setLabel("Auto-Explore").setEmoji("🤖").setStyle(ButtonStyle.Secondary);

  const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(sqCid("eat")).setLabel("Eat").setEmoji("🍞").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(sqCid("travel")).setLabel("Travel").setEmoji("🧭").setStyle(ButtonStyle.Primary),
    auto,
  );
  if (townAt(view.player.x_coord, view.player.y_coord)) {
    actionRow.addComponents(
      new ButtonBuilder().setCustomId(sqCid("shop")).setLabel("Shop").setEmoji("🛒").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(sqCid("roads")).setLabel("Roads").setEmoji("🛣️").setStyle(ButtonStyle.Secondary),
    );
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
    actionRow,
  ];
}

/* ─────────── shop view (per town / keeper) ─────────── */

const SLOT_EMOJI = { weapon: "🗡️", armor: "🛡️", accessory: "💍" } as const;

function equippedName(id: string | null): string {
  if (!id) return "—";
  const it = ITEM_BY_ID.get(id);
  return it ? `${it.emoji} ${it.name} (+${it.power})` : "—";
}

export function buildShopEmbed(town: Town, player: SatPlayerRow, hp: number, _ownedIds: string[]): EmbedBuilder {
  const gear = gearScore(player);
  return new EmbedBuilder()
    .setColor(0x1d4ed8)
    .setTitle(`🛒 ${town.name} — ${town.keeper.name}`)
    .setThumbnail(`attachment://${KEEPER_FILE}`)
    .setDescription(
      `*"${town.keeper.blurb}"*\n\n` +
        `Balance: **${formatSats(hp)}**  ·  Gear score: **${gear}**\n` +
        `Win chance: Lv1 **${Math.round(winChance(gear, 1) * 100)}%** · Lv4 **${Math.round(winChance(gear, 4) * 100)}%** · Lv8 **${Math.round(winChance(gear, 8) * 100)}%**`,
    )
    .addFields(
      { name: `${SLOT_EMOJI.weapon} Weapon`, value: equippedName(player.equipped_weapon), inline: true },
      { name: `${SLOT_EMOJI.armor} Armor`, value: equippedName(player.equipped_armor), inline: true },
      { name: `${SLOT_EMOJI.accessory} Accessory`, value: equippedName(player.equipped_accessory), inline: true },
    )
    .setFooter({ text: `${town.name} stocks gear you can't find elsewhere. Buy above, equip below.` });
}

export function buildShopComponents(town: Town, ownedIds: string[]): ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] {
  const owned = new Set(ownedIds);
  const buy = new StringSelectMenuBuilder()
    .setCustomId(sqCid("buy"))
    .setPlaceholder(`Buy from ${town.keeper.name}…`)
    .addOptions(
      town.catalog.map((it) => ({
        label: `${it.name} (+${it.power})${owned.has(it.id) ? " — owned" : ""}`,
        description: `${effectivePrice(it, town.keeper)} sats · ${it.slot}`,
        value: it.id,
        emoji: it.emoji,
      })),
    );

  const rows: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(buy),
  ];

  if (ownedIds.length > 0) {
    const equip = new StringSelectMenuBuilder()
      .setCustomId(sqCid("equip"))
      .setPlaceholder("Equip owned gear…")
      .addOptions(
        ownedIds
          .map((id) => ITEM_BY_ID.get(id))
          .filter((it): it is NonNullable<typeof it> => !!it)
          .map((it) => ({ label: `${it.name} (+${it.power})`, description: `equip as ${it.slot}`, value: it.id, emoji: it.emoji })),
      );
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(equip));
  }

  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(sqCid("shopclose")).setLabel("Back to map").setEmoji("🗺️").setStyle(ButtonStyle.Primary),
    ),
  );
  return rows;
}

/* ─────────── roads / portal network ─────────── */

export function buildPortalEmbed(currentTown: Town, player: SatPlayerRow): EmbedBuilder {
  const lines = TOWNS.filter((t) => t.id !== currentTown.id).map((t) => {
    const est = estimateTravel(player, t.cx, t.cy);
    const cost = travelCost(est, SAT.PORTAL_DISCOUNT);
    return `**${t.name}** — ${est.steps} tiles · ~${formatSats(cost)} (½ price)`;
  });
  return new EmbedBuilder()
    .setColor(0x6d28d9)
    .setTitle(`🛣️ ${currentTown.name} — Road Network`)
    .setDescription(`Roads connect the towns. Travel by road for **${Math.round(SAT.PORTAL_DISCOUNT * 100)}%** of the usual fare.\n\n${lines.join("\n")}`)
    .setFooter({ text: "Pick a destination below." });
}

export function buildPortalComponents(currentTown: Town, player: SatPlayerRow): ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] {
  const pick = new StringSelectMenuBuilder()
    .setCustomId(sqCid("portalpick"))
    .setPlaceholder("Travel by road to…")
    .addOptions(
      TOWNS.filter((t) => t.id !== currentTown.id).map((t) => {
        const est = estimateTravel(player, t.cx, t.cy);
        return {
          label: t.name,
          description: `~${travelCost(est, SAT.PORTAL_DISCOUNT)} sats · ${est.steps} tiles`,
          value: t.id,
        };
      }),
    );
  return [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(pick),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(sqCid("shopclose")).setLabel("Back to map").setEmoji("🗺️").setStyle(ButtonStyle.Primary),
    ),
  ];
}
