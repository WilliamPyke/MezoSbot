import type { SatPlayerRow } from "./types.js";

export type ItemSlot = "weapon" | "armor" | "accessory";

export interface ShopItem {
  id: string;
  name: string;
  slot: ItemSlot;
  power: number; // contribution to gear score
  price: number; // sats (flows to the prize pool on purchase)
  emoji: string;
}

/** The town item shop catalogue. Tuning lives here. */
export const ITEMS: ShopItem[] = [
  // weapons
  { id: "wooden_sword", name: "Wooden Sword", slot: "weapon", power: 2, price: 30, emoji: "🗡️" },
  { id: "iron_sword", name: "Iron Sword", slot: "weapon", power: 5, price: 120, emoji: "⚔️" },
  { id: "steel_blade", name: "Steel Blade", slot: "weapon", power: 8, price: 320, emoji: "🔪" },
  { id: "dragon_fang", name: "Dragon Fang", slot: "weapon", power: 12, price: 750, emoji: "🐉" },
  // armor
  { id: "leather_vest", name: "Leather Vest", slot: "armor", power: 2, price: 30, emoji: "🦺" },
  { id: "chainmail", name: "Chainmail", slot: "armor", power: 5, price: 120, emoji: "🛡️" },
  { id: "plate_armor", name: "Plate Armor", slot: "armor", power: 8, price: 320, emoji: "🪖" },
  { id: "aegis", name: "Aegis", slot: "armor", power: 12, price: 750, emoji: "✨" },
  // accessories
  { id: "copper_ring", name: "Copper Ring", slot: "accessory", power: 2, price: 30, emoji: "💍" },
  { id: "jade_charm", name: "Jade Charm", slot: "accessory", power: 5, price: 120, emoji: "🟢" },
  { id: "rune_sigil", name: "Rune Sigil", slot: "accessory", power: 8, price: 320, emoji: "🔮" },
  { id: "phoenix_amulet", name: "Phoenix Amulet", slot: "accessory", power: 12, price: 750, emoji: "🔥" },
];

export const ITEM_BY_ID = new Map(ITEMS.map((i) => [i.id, i]));

export function itemPower(id: string | null | undefined): number {
  return id ? ITEM_BY_ID.get(id)?.power ?? 0 : 0;
}

export function equippedSlot(player: SatPlayerRow, slot: ItemSlot): string | null {
  return slot === "weapon" ? player.equipped_weapon
    : slot === "armor" ? player.equipped_armor
    : player.equipped_accessory;
}

/** Total gear score from the player's three equipped slots. */
export function gearScore(player: SatPlayerRow): number {
  return itemPower(player.equipped_weapon) + itemPower(player.equipped_armor) + itemPower(player.equipped_accessory);
}

/* ─────────── combat math ─────────── */
export const COMBAT = {
  BASE: 0.45, // unequipped win chance vs a level-1 monster
  GEAR_W: 0.025, // win chance per point of gear score
  LEVEL_W: 0.05, // win chance lost per monster level above 1
  MIN: 0.05,
  MAX: 0.95,
} as const;

/** Probability (0..1) the player beats a monster of the given level with `gear` score. */
export function winChance(gear: number, level: number): number {
  const raw = COMBAT.BASE + COMBAT.GEAR_W * gear - COMBAT.LEVEL_W * (level - 1);
  return Math.max(COMBAT.MIN, Math.min(COMBAT.MAX, raw));
}

/** Sats lost on a defeat, scaled by monster level (flows to the pool). */
export function lossFor(level: number): number {
  return 10 + level * 8;
}
