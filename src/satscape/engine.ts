import { nearestTown } from "./towns.js";
import type { Terrain } from "./towns.js";
import type { TileEntity } from "./types.js";

/** Tunables for the game loop. */
export const SAT = {
  VIEW_W: 16, // viewport width in tiles
  VIEW_H: 16, // viewport height in tiles
  VIEW_OX: 8, // player column offset from the left edge (so dx ∈ [-8, 7])
  VIEW_OY: 8, // player row offset from the top edge
  REGION_SIZE: 22, // tiles per biome region cell (contiguous zones within a territory)
  SIGHT: 3, // fog-of-war vision radius around the player
  BUYIN_SATS: 50, // paid on /join, seeds the prize pool
  DEATH_PENALTY_SATS: 50, // taken on faint (clamped to remaining balance)
  CHEST_SPAWN: 0.03, // per-tile spawn probability in the wilds
  MONSTER_SPAWN: 0.08, // cumulative upper bound (monster occupies 0.03..0.08)
  BREAD_STAMINA: 20, // stamina restored per 1-sat loaf
} as const;

/** Deterministic [0,1) hash. */
function hash01(a: number, b: number, salt: number): number {
  return Math.abs(Math.sin(a * 12.9898 + b * 78.233 + salt) * 43758.5453) % 1;
}

/**
 * Terrain is computed from coordinates, never stored. Every tile belongs to its
 * nearest town's territory; inside the safe radius it's "town", otherwise it's
 * one of that town's three palette biomes, chosen by a warped region grid so
 * each territory reads as a few large contiguous zones.
 */
export function biomeAt(x: number, y: number): Terrain {
  const { town, dist } = nearestTown(x, y);
  if (dist <= town.safeRadius) return "town";
  const wx = x + Math.sin(y * 0.12) * 4; // domain warp → wavy borders
  const wy = y + Math.cos(x * 0.12) * 4;
  const cx = Math.floor(wx / SAT.REGION_SIZE);
  const cy = Math.floor(wy / SAT.REGION_SIZE);
  const h = hash01(cx * 1.7, cy * 2.3, 99);
  const idx = h < 0.34 ? 0 : h < 0.67 ? 1 : 2;
  return town.palette[idx];
}

export interface MonsterSpec {
  name: string;
  level: number; // challenge rating, 1..8 — rises with distance from the nearest town
  reward: number; // sats looted on a win (from the pool)
}

/** Challenge rating climbs the farther you stray from any town's safety. */
export function monsterLevelAt(x: number, y: number): number {
  const { dist } = nearestTown(x, y);
  const base = 1 + Math.floor(dist / 35);
  const bump = hash01(x, y, 23) < 0.3 ? 1 : 0;
  return Math.max(1, Math.min(8, base + bump));
}

function monsterFor(x: number, y: number): MonsterSpec {
  const { town } = nearestTown(x, y);
  const pool = town.monsters;
  const level = monsterLevelAt(x, y);
  return {
    name: pool[Math.floor(hash01(x, y, 7) * pool.length)],
    level,
    reward: 40 + level * 25 + Math.floor(hash01(x, y, 17) * 30), // grows with CR
  };
}

/**
 * Pure, DB-free entity lookup: what *would* be on this tile by the deterministic
 * roll. Callers subtract the "cleared" tombstone set to know what's actually
 * still there. Town tiles never spawn anything.
 */
export function entityAt(x: number, y: number): TileEntity | null {
  if (biomeAt(x, y) === "town") return null;
  const r = hash01(x, y, 3);
  if (r < SAT.CHEST_SPAWN) {
    const reward = 20 + Math.floor(hash01(x, y, 5) * 80); // 20..99
    return { x, y, type: "chest", data: { reward } };
  }
  if (r < SAT.MONSTER_SPAWN) {
    return { x, y, type: "monster", data: { ...monsterFor(x, y) } };
  }
  return null;
}

/** Inclusive tile bounds of the viewport centred on (cx, cy). */
export function viewportBounds(cx: number, cy: number) {
  return {
    minX: cx - SAT.VIEW_OX,
    maxX: cx + (SAT.VIEW_W - 1 - SAT.VIEW_OX),
    minY: cy - SAT.VIEW_OY,
    maxY: cy + (SAT.VIEW_H - 1 - SAT.VIEW_OY),
  };
}
