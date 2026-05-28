export type ItemSlot = "weapon" | "armor" | "accessory" | "boots";

export type Rarity = "common" | "uncommon" | "rare" | "legendary";

export interface ShopItem {
  id: string;
  name: string;
  slot: ItemSlot;
  power: number; // contribution to gear score (boots are 0 — mobility only)
  price: number; // base sats (keepers may mark this up/down; flows to the pool)
  emoji: string;
  repReq?: number; // keeper reputation required to buy (gear unlocked by quests)
  stepBonus?: number; // boots only: extra tiles per directional press
  rarity?: Rarity; // display-only flavour
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
