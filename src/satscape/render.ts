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
import { estimateTravel, travelCost } from "./game.js";
import { type ItemSlot } from "./items.js";
import { keeperLine } from "./lines.js";
import {
  ARENA_SIZE,
  battleMovePoints,
  battleMoveRange,
  legalBattleMoves,
  monsterIntent,
  playerAttackTiles,
  pointKey,
  selectedWeaponId,
  weaponFor,
  type Point,
} from "./battle.js";
import type { QuestView } from "./quests.js";
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

export const MAP_FILE = "satscape-map.webp";

const TILE = 22;
const FOG = "#060a14";

/**
 * FIFO cache of encoded WebP buffers keyed by a visual signature supplied by
 * the caller. When the same scene recurs (player walks back to a tile they
 * just left, neighbor stands still, etc.) we skip both canvas drawing and
 * re-encoding. Bounded so it never grows without limit.
 */
const IMG_CACHE_MAX = 64;
const mapImageCache = new Map<string, Buffer>();

function cacheMapImage(key: string, buf: Buffer): void {
  mapImageCache.set(key, buf);
  while (mapImageCache.size > IMG_CACHE_MAX) {
    const oldest = mapImageCache.keys().next().value;
    if (oldest === undefined) break;
    mapImageCache.delete(oldest);
  }
}

/** Synchronous cache probe so paint() can decide single-edit vs. two-phase. */
export function hasMapImageCached(cacheKey: string): boolean {
  return !!cacheKey && mapImageCache.has(cacheKey);
}

/**
 * WebP encode quality. q75 is the sweet spot for flat-color tile art —
 * indistinguishable from q90 in-game, but typically 25–35 % smaller on the
 * wire. Drop to q60 if upload latency is still the bottleneck.
 */
const WEBP_QUALITY = 75;

function terrainLabel(t: Terrain): string {
  return t === "town" ? "Town" : t.charAt(0).toUpperCase() + t.slice(1);
}

/** Where am I, in words: town name if in a safe zone, else "terrain · near Town". */
function locationLabel(x: number, y: number): string {
  const here = townAt(x, y);
  if (here) return `🏙️ ${here.name}`;
  return `${terrainLabel(biomeAt(x, y))} · near ${nearestTown(x, y).town.name}`;
}

/**
 * Render the viewport and encode it as WebP. Async because canvas.encode runs
 * the heavy compression step on the libuv thread pool — frees the main event
 * loop to handle other Discord interactions while a frame is being encoded.
 *
 * `cacheKey` (typically the caller's visual signature) lets us reuse a buffer
 * when the same scene recurs. Pass an empty string to disable caching.
 */
export async function buildMapImage(view: ViewModel, cacheKey = ""): Promise<AttachmentBuilder> {
  if (cacheKey) {
    const hit = mapImageCache.get(cacheKey);
    if (hit) return new AttachmentBuilder(hit, { name: MAP_FILE });
  }

  if (view.combat) {
    const image = await buildBattleImage(view);
    if (cacheKey) cacheMapImage(cacheKey, image);
    return new AttachmentBuilder(image, { name: MAP_FILE });
  }

  const { player, entities, others, combat, explored } = view;
  const w = SAT.VIEW_W * TILE;
  const h = SAT.VIEW_H * TILE; // no in-image legend — embed's Location field shows the same text
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  const b = viewportBounds(player.x_coord, player.y_coord);
  const r2 = SAT.SIGHT * SAT.SIGHT + SAT.SIGHT;
  const inSight = (x: number, y: number) => {
    const dx = x - player.x_coord;
    const dy = y - player.y_coord;
    return dx * dx + dy * dy <= r2;
  };

  // Flat tiles only — no per-tile noise or stroke. WebP compresses large
  // solid-color regions trivially; the previous jitter overlay and tile
  // borders sabotaged that, bloating the file with high-frequency detail.
  // The wavy biome borders supplied by biomeAt are still the visual identity.
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
      if (!seen) {
        // explored but out of current sight → dim "memory"
        ctx.fillStyle = "rgba(2,6,23,0.5)";
        ctx.fillRect(px, py, TILE, TILE);
      }
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

  const buf = await canvas.encode("webp", WEBP_QUALITY);
  if (cacheKey) cacheMapImage(cacheKey, buf);
  return new AttachmentBuilder(buf, { name: MAP_FILE });
}

/* ─────────── sprites (drawn procedurally — no binary art) ─────────── */

async function buildBattleImage(view: ViewModel): Promise<Buffer> {
  const combat = view.combat;
  if (!combat) throw new Error("No combat to render");

  const size = SAT.VIEW_W * TILE;
  const tile = size / ARENA_SIZE;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");
  const intent = monsterIntent(combat, view.player);
  const weapon = weaponFor(view.player, selectedWeaponId(combat, view.player));
  const player = { x: combat.player_battle_x, y: combat.player_battle_y };
  const monster = intent.to;
  const legal = new Set(legalBattleMoves(combat, view.player).map(pointKey));
  const danger = new Set(intent.attackTiles.map(pointKey));
  const attack = new Set(playerAttackTiles(player, monster, weapon).map(pointKey));
  const town = nearestTown(combat.enemy_x, combat.enemy_y).town;

  ctx.fillStyle = "#07111f";
  ctx.fillRect(0, 0, size, size);

  for (let y = 0; y < ARENA_SIZE; y++) {
    for (let x = 0; x < ARENA_SIZE; x++) {
      const key = `${x},${y}`;
      const px = x * tile;
      const py = y * tile;
      ctx.fillStyle = TERRAIN_COLOR[biomeAt(combat.enemy_x + x - 4, combat.enemy_y + y - 4)];
      ctx.fillRect(px, py, tile, tile);

      if (legal.has(key)) {
        ctx.fillStyle = "rgba(34,197,94,0.30)";
        ctx.fillRect(px, py, tile, tile);
      }
      if (attack.has(key)) {
        ctx.fillStyle = "rgba(56,189,248,0.40)";
        ctx.fillRect(px, py, tile, tile);
      }
      if (danger.has(key)) {
        ctx.fillStyle = "rgba(239,68,68,0.52)";
        ctx.fillRect(px, py, tile, tile);
      }

      ctx.strokeStyle = "rgba(15,23,42,0.45)";
      ctx.lineWidth = 1;
      ctx.strokeRect(px + 0.5, py + 0.5, tile - 1, tile - 1);
    }
  }

  drawTileOutlines(ctx, [...attack].map(keyToPoint), tile, "#38bdf8", 3);
  drawTileOutlines(ctx, [...danger].map(keyToPoint), tile, "#ef4444", 3);

  const playerCx = player.x * tile + tile / 2;
  const playerCy = player.y * tile + tile / 2;
  ctx.fillStyle = "#f8fafc";
  ctx.beginPath();
  ctx.arc(playerCx, playerCy, tile * 0.28, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#2563eb";
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.fillStyle = "#0f172a";
  ctx.beginPath();
  ctx.arc(playerCx, playerCy - tile * 0.06, tile * 0.08, 0, Math.PI * 2);
  ctx.fill();

  drawMonster(ctx, monster.x * tile + tile / 2, monster.y * tile + tile / 2, town.monsterColor, nameVariant(combat.monster_name));

  return canvas.encode("webp", WEBP_QUALITY);
}

function keyToPoint(key: string): Point {
  const [x, y] = key.split(",").map(Number);
  return { x, y };
}

function drawTileOutlines(ctx: SKRSContext2D, points: Point[], tile: number, color: string, width: number): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  for (const p of points) {
    ctx.strokeRect(p.x * tile + width / 2, p.y * tile + width / 2, tile - width, tile - width);
  }
}

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

export const KEEPER_FILE = "satscape-keeper.webp";

/**
 * Per-town keeper portrait cache. Bounded by the (small, finite) town count, so
 * no eviction needed — first call per town encodes once, subsequent calls reuse.
 */
const keeperImageCache = new Map<string, Buffer>();

/** A small keeper portrait for the shop embed thumbnail. */
export async function buildKeeperPortrait(town: Town): Promise<AttachmentBuilder> {
  const cached = keeperImageCache.get(town.id);
  if (cached) return new AttachmentBuilder(cached, { name: KEEPER_FILE });

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
  const buf = await canvas.encode("webp", WEBP_QUALITY);
  keeperImageCache.set(town.id, buf);
  return new AttachmentBuilder(buf, { name: KEEPER_FILE });
}

// Pre-warm every town's keeper portrait at module load — encode work happens
// in the background on libuv, so the first shop visit per town is instant
// instead of paying a ~5 ms encode + upload roundtrip then. Errors are
// swallowed; the lazy path on first real call still works.
void Promise.all(TOWNS.map((t) => buildKeeperPortrait(t).catch(() => {})));

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
    const preview = buildBattlePreviewText(view);
    embed.addFields({
      name: `👹 ${combat.monster_name} — level ${combat.monster_level}`,
      value: preview,
      inline: false,
    });
  } else if (others.length > 0) {
    embed.setFooter({ text: `👥 ${others.length} adventurer${others.length === 1 ? "" : "s"} in sight` });
  }

  return embed;
}

function buildBattlePreviewText(view: ViewModel): string {
  const { combat, player } = view;
  if (!combat) return "";
  const intent = monsterIntent(combat, player);
  const weapon = weaponFor(player, selectedWeaponId(combat, player));
  const moveLeft = battleMovePoints(combat, player);
  return [
    `**Intent:** ${intent.description}`,
    `**Weapon:** ${weapon.emoji} ${weapon.name} - ${weapon.summary} (${weapon.damage} dmg)`,
    `**Monster HP:** ${bar(combat.monster_current_hp, combat.monster_max_hp)} ${combat.monster_current_hp}/${combat.monster_max_hp}`,
    `**Move left:** ${moveLeft} | **Loot:** up to ${formatSats(combat.reward_sats)}`,
    "Red tiles are danger. Blue tiles are your attack preview. Green tiles are reachable.",
  ].join("\n");
}

function dirButton(action: string, label: string): ButtonBuilder {
  const emoji = action === "up" ? "⬆️" : action === "down" ? "⬇️" : action === "left" ? "⬅️" : "➡️";
  return new ButtonBuilder().setCustomId(sqCid(action)).setLabel(label).setEmoji(emoji).setStyle(ButtonStyle.Primary);
}

function buildBattleWeaponSelect(view: ViewModel): StringSelectMenuBuilder | null {
  const combat = view.combat;
  if (!combat) return null;
  const weapons = view.ownedItemIds
    .map((id) => ITEM_BY_ID.get(id))
    .filter((it): it is NonNullable<typeof it> => !!it && it.slot === "weapon")
    .slice(0, 25);
  if (weapons.length === 0) return null;

  const selected = selectedWeaponId(combat, view.player);
  return new StringSelectMenuBuilder()
    .setCustomId(sqCid("battleweapon"))
    .setPlaceholder("Choose weapon preview...")
    .addOptions(weapons.map((it) => {
      const profile = weaponFor(view.player, it.id);
      return {
        label: it.name,
        description: `${profile.summary} - ${profile.damage} dmg`,
        value: it.id,
        emoji: it.emoji,
        default: it.id === selected,
      };
    }));
}

export function buildComponents(
  view: ViewModel,
  opts: { autoExploring?: boolean } = {},
): ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] {
  if (view.combat) {
    const rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [
      new ActionRowBuilder<ButtonBuilder>().addComponents(dirButton("up", "Up")),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        dirButton("left", "Left"),
        dirButton("down", "Down"),
        dirButton("right", "Right"),
      ),
    ];
    const weaponSelect = buildBattleWeaponSelect(view);
    if (weaponSelect) rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(weaponSelect));
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(sqCid("battleattack")).setLabel("Attack").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(sqCid("flee")).setLabel("Flee").setStyle(ButtonStyle.Secondary),
    ));
    return rows;
  }
  const auto = opts.autoExploring
    ? new ButtonBuilder().setCustomId(sqCid("autostop")).setLabel("Stop").setEmoji("⏹️").setStyle(ButtonStyle.Danger)
    : new ButtonBuilder().setCustomId(sqCid("auto")).setLabel("Auto-Explore").setEmoji("🤖").setStyle(ButtonStyle.Secondary);

  const steps = Math.max(1, view.player.steps_per_move ?? 1);
  const stride = steps > 1 ? `×${steps}` : null;
  const dirBtn = (action: string, emoji: string) => {
    const b = new ButtonBuilder().setCustomId(sqCid(action)).setEmoji(emoji).setStyle(ButtonStyle.Primary);
    if (stride) b.setLabel(stride);
    return b;
  };

  const rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(dirBtn("up", "⬆️")),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      dirBtn("left", "⬅️"),
      dirBtn("down", "⬇️"),
      dirBtn("right", "➡️"),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(sqCid("eat")).setLabel("Eat").setEmoji("🍞").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(sqCid("travel")).setLabel("Travel").setEmoji("🧭").setStyle(ButtonStyle.Primary),
      auto,
    ),
    // Utility row — always available, anywhere in the world.
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(sqCid("settings")).setLabel("Settings").setEmoji("⚙️").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(sqCid("inventory")).setLabel("Inventory").setEmoji("🎒").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(sqCid("quests")).setLabel("Quests").setEmoji("📜").setStyle(ButtonStyle.Secondary),
    ),
  ];
  if (townAt(view.player.x_coord, view.player.y_coord)) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(sqCid("shop")).setLabel("Shop").setEmoji("🛒").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(sqCid("roads")).setLabel("Roads").setEmoji("🛣️").setStyle(ButtonStyle.Secondary),
      ),
    );
  }
  return rows;
}

/* ─────────── shop view (per town / keeper) ─────────── */

const SLOT_EMOJI = { weapon: "🗡️", armor: "🛡️", accessory: "💍" } as const;

function equippedName(id: string | null): string {
  if (!id) return "—";
  const it = ITEM_BY_ID.get(id);
  return it ? `${it.emoji} ${it.name} (+${it.power})` : "—";
}

export function buildShopEmbed(town: Town, player: SatPlayerRow, hp: number, _ownedIds: string[], rep = 0): EmbedBuilder {
  const gear = gearScore(player);
  const weapon = weaponFor(player);
  const move = battleMoveRange(player);
  const discount = Math.round((1 - Math.max(0.5, 1 - rep * 0.05)) * 100);
  return new EmbedBuilder()
    .setColor(0x1d4ed8)
    .setTitle(`🛒 ${town.name} — ${town.keeper.name}`)
    .setThumbnail(`attachment://${KEEPER_FILE}`)
    .setDescription(
      `*"${keeperLine(town.keeper.persona, "greet")}"*\n\n` +
        `Balance: **${formatSats(hp)}**  ·  Gear score: **${gear}**\n` +
        `Reputation: **${rep}**${discount > 0 ? ` (−${discount}% prices)` : ""}\n` +
        `Battle: **${weapon.name}** (${weapon.summary}, ${weapon.damage} dmg) · Move **${move}**`,
    )
    .addFields(
      { name: `${SLOT_EMOJI.weapon} Weapon`, value: equippedName(player.equipped_weapon), inline: true },
      { name: `${SLOT_EMOJI.armor} Armor`, value: equippedName(player.equipped_armor), inline: true },
      { name: `${SLOT_EMOJI.accessory} Accessory`, value: equippedName(player.equipped_accessory), inline: true },
    )
    .setFooter({ text: `${town.name} stocks gear found nowhere else. Earn reputation via quests for discounts & unlocks.` });
}

export function buildShopComponents(town: Town, ownedIds: string[], rep = 0): ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] {
  const owned = new Set(ownedIds);
  const buy = new StringSelectMenuBuilder()
    .setCustomId(sqCid("buy"))
    .setPlaceholder(`Buy from ${town.keeper.name}…`)
    .addOptions(
      town.catalog.map((it) => {
        const locked = it.repReq != null && rep < it.repReq;
        return {
          label: `${locked ? "🔒 " : ""}${it.name} (+${it.power})${owned.has(it.id) ? " — owned" : ""}`,
          description: locked ? `locked · needs ${it.repReq} rep` : `${effectivePrice(it, town.keeper, rep)} sats · ${it.slot}`,
          value: it.id,
          emoji: it.emoji,
        };
      }),
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

/* ─────────── quest board ─────────── */

const QUEST_ICON: Record<string, string> = { available: "⚪", active: "🔄", claimable: "✅", claimed: "☑️" };

function questLine(v: QuestView): string {
  const icon = QUEST_ICON[v.status] ?? "•";
  const prog = v.def.type === "tribute"
    ? `${v.def.target} sats`
    : v.def.target > 1 && (v.status === "active" || v.status === "claimable")
      ? ` — ${v.progress}/${v.def.target}`
      : "";
  const rw = [v.def.reward.sats ? `${v.def.reward.sats}s` : null, `+${v.def.reward.rep}rep`, v.def.reward.title ? `title` : null, v.def.reward.unlocks ? `unlock` : null].filter(Boolean).join(" ");
  return `${icon} **${v.def.title}**${prog} — _${v.def.desc}_ (${rw})`;
}

export function buildQuestEmbed(
  town: Town,
  board: { offered: QuestView[]; carry: QuestView[] },
  rep: number,
  titles: string[],
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(0xb45309)
    .setTitle(`📜 ${town.name} — ${town.keeper.name}'s Quests`)
    .setThumbnail(`attachment://${KEEPER_FILE}`)
    .setDescription(`Reputation with ${town.keeper.name}: **${rep}**${titles.length ? `\n🎖️ Titles: ${titles.join(", ")}` : ""}`);

  embed.addFields({ name: "Available here", value: board.offered.map(questLine).join("\n") || "— none —", inline: false });
  if (board.carry.length) {
    embed.addFields({ name: "Your journeys", value: board.carry.map(questLine).join("\n"), inline: false });
  }
  return embed;
}

export function buildQuestComponents(board: { offered: QuestView[]; carry: QuestView[] }): ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] {
  const rows: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [];

  const acceptable = board.offered.filter((v) => v.status === "available" && v.def.type !== "tribute");
  if (acceptable.length) {
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder().setCustomId(sqCid("qaccept")).setPlaceholder("Accept a quest…")
        .addOptions(acceptable.map((v) => ({ label: v.def.title, description: v.def.desc.slice(0, 90), value: v.def.key }))),
    ));
  }

  const claimable = [...board.offered, ...board.carry].filter((v) => v.status === "claimable");
  if (claimable.length) {
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder().setCustomId(sqCid("qclaim")).setPlaceholder("Claim a finished quest…")
        .addOptions(claimable.map((v) => ({ label: v.def.title, description: "Claim your reward", value: v.def.key, emoji: "🏆" }))),
    ));
  }

  const tribute = board.offered.filter((v) => v.def.type === "tribute" && v.status !== "claimed");
  const lastRow = new ActionRowBuilder<ButtonBuilder>();
  for (const v of tribute.slice(0, 4)) {
    lastRow.addComponents(new ButtonBuilder().setCustomId(sqCid("qtribute", v.def.key)).setLabel(`Pay ${v.def.target}`).setEmoji("💰").setStyle(ButtonStyle.Danger));
  }
  lastRow.addComponents(new ButtonBuilder().setCustomId(sqCid("shopclose")).setLabel("Back to map").setEmoji("🗺️").setStyle(ButtonStyle.Primary));
  rows.push(lastRow);
  return rows;
}

/* ─────────── settings (cog) ─────────── */

export function buildSettingsEmbed(player: SatPlayerRow, maxSteps: number): EmbedBuilder {
  const boots = player.equipped_boots ? ITEM_BY_ID.get(player.equipped_boots) : null;
  const bootLine = boots ? `${boots.emoji} **${boots.name}** (+${boots.stepBonus} tiles · ${boots.rarity})` : "— none equipped —";
  return new EmbedBuilder()
    .setColor(0x475569)
    .setTitle("⚙️ Settings")
    .setDescription(
      `**Steps per directional press**\nCurrent: **${player.steps_per_move}** · Max: **${maxSteps}** (8 base + ${maxSteps - 8} from boots)\n\n` +
        `**Boots**\n${bootLine}`,
    )
    .setFooter({ text: "Pick a stride below. Higher = cover ground faster but blow past loot if you're not paying attention." });
}

export function buildSettingsComponents(player: SatPlayerRow, maxSteps: number): ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] {
  const opts = [];
  for (let i = 1; i <= maxSteps; i++) {
    opts.push({
      label: `${i} tile${i === 1 ? "" : "s"} per press`,
      description: i === player.steps_per_move ? "current" : "",
      value: String(i),
      default: i === player.steps_per_move,
    });
  }
  return [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder().setCustomId(sqCid("stepselect")).setPlaceholder("Stride…").addOptions(opts),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(sqCid("shopclose")).setLabel("Back to map").setEmoji("🗺️").setStyle(ButtonStyle.Primary),
    ),
  ];
}

/* ─────────── inventory ─────────── */

function inventoryListFor(slot: ItemSlot, ownedIds: string[], player: SatPlayerRow): string {
  const equippedId = slot === "weapon" ? player.equipped_weapon
    : slot === "armor" ? player.equipped_armor
    : slot === "accessory" ? player.equipped_accessory
    : player.equipped_boots;
  const owned = ownedIds.map((id) => ITEM_BY_ID.get(id)).filter((i): i is NonNullable<typeof i> => !!i && i.slot === slot);
  if (owned.length === 0) return "— none —";
  return owned.map((it) => {
    const star = it.id === equippedId ? "★ " : "  ";
    const extra = it.slot === "boots" ? ` · +${it.stepBonus} tiles` : ` · +${it.power}`;
    return `${star}${it.emoji} **${it.name}**${extra}`;
  }).join("\n");
}

export function buildInventoryEmbed(player: SatPlayerRow, ownedIds: string[]): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x475569)
    .setTitle("🎒 Inventory")
    .setDescription("★ = currently equipped")
    .addFields(
      { name: "🗡️ Weapons", value: inventoryListFor("weapon", ownedIds, player), inline: true },
      { name: "🛡️ Armor", value: inventoryListFor("armor", ownedIds, player), inline: true },
      { name: "💍 Accessories", value: inventoryListFor("accessory", ownedIds, player), inline: true },
      { name: "🥾 Boots", value: inventoryListFor("boots", ownedIds, player), inline: false },
    );
}

export function buildInventoryComponents(ownedIds: string[]): ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] {
  const rows: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [];
  if (ownedIds.length > 0) {
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder().setCustomId(sqCid("invequip")).setPlaceholder("Equip an item…").addOptions(
        ownedIds.map((id) => ITEM_BY_ID.get(id))
          .filter((it): it is NonNullable<typeof it> => !!it)
          .map((it) => ({
            label: `${it.name}${it.slot === "boots" ? ` (+${it.stepBonus} tiles)` : ` (+${it.power})`}`,
            description: `equip as ${it.slot}`,
            value: it.id,
            emoji: it.emoji,
          })),
      ),
    ));
  }
  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(sqCid("shopclose")).setLabel("Back to map").setEmoji("🗺️").setStyle(ButtonStyle.Primary),
  ));
  return rows;
}

/* ─────────── active quests (read-only, anywhere) ─────────── */

export function buildActiveQuestsEmbed(carry: QuestView[], titles: string[]): EmbedBuilder {
  const lines = carry.length ? carry.map(questLine).join("\n") : "— no active quests. Visit a town's quest board to accept one. —";
  return new EmbedBuilder()
    .setColor(0xb45309)
    .setTitle("📜 Your Active Quests")
    .setDescription(titles.length ? `🎖️ Titles: ${titles.join(", ")}\n\n${lines}` : lines)
    .setFooter({ text: "Visit a town to accept or claim quests." });
}

export function buildActiveQuestsComponents(): ActionRowBuilder<ButtonBuilder>[] {
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(sqCid("shopclose")).setLabel("Back to map").setEmoji("🗺️").setStyle(ButtonStyle.Primary),
  )];
}
