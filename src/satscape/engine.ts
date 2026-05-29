import { nearestTown, townAt } from "./towns.js";
import type { Terrain } from "./towns.js";
import type { TileEntity } from "./types.js";
import { BIOME, canEnter, tileAt, type BiomeId } from "./world.js";

/** Tunables for the game loop. */
export const SAT = {
  VIEW_W: 16, // viewport width in tiles
  VIEW_H: 16, // viewport height in tiles
  VIEW_OX: 8, // player column offset from the left edge (so dx is [-8, 7])
  VIEW_OY: 8, // player row offset from the top edge
  REGION_SIZE: 22, // legacy biome-region size; retained for compatibility
  SIGHT: 5, // fog-of-war vision radius around the player
  BUYIN_SATS: 50, // paid on /join, seeds the prize pool
  DEATH_PENALTY_SATS: 50, // legacy flat faint penalty; no longer charged
  HP_MAX_DEFAULT: 250, // default HP-bar cap: the at-risk slice of your sats
  CHEST_SPAWN: 0.03, // per-tile spawn probability in the wilds
  MONSTER_SPAWN: 0.08, // cumulative upper bound (monster occupies 0.03..0.08)
  BREAD_STAMINA: 20, // stamina restored per 1-sat loaf
  PORTAL_DISCOUNT: 0.5, // town-to-town road travel cost multiplier
  MAX_STEPS_BASE: 8, // tiles per directional press without boots
  MAX_STEPS_CAP: 15, // hard ceiling regardless of boots
} as const;

/** Deterministic [0,1) hash. */
function hash01(a: number, b: number, salt: number): number {
  return Math.abs(Math.sin(a * 12.9898 + b * 78.233 + salt) * 43758.5453) % 1;
}

const BIOME_DISPLAY: Record<BiomeId, { terrain: Terrain; name: string; color: string }> = {
  [BIOME.OCEAN]: { terrain: "oasis", name: "Ocean", color: "#1d4ed8" },
  [BIOME.DEEP]: { terrain: "oasis", name: "Deep Sea", color: "#1e3a8a" },
  [BIOME.BEACH]: { terrain: "desert", name: "Beach", color: "#d6b46a" },
  [BIOME.SAND]: { terrain: "desert", name: "Sand", color: "#d8a84f" },
  [BIOME.GRASS]: { terrain: "plains", name: "Grassland", color: "#65a30d" },
  [BIOME.GRASS_LUSH]: { terrain: "plains", name: "Lush Grass", color: "#4d9f38" },
  [BIOME.FOREST]: { terrain: "forest", name: "Forest", color: "#166534" },
  [BIOME.F_DENSE]: { terrain: "forest", name: "Dense Forest", color: "#14532d" },
  [BIOME.F_DARK]: { terrain: "forest", name: "Dark Forest", color: "#0f3d24" },
  [BIOME.SWAMP]: { terrain: "monsoon", name: "Swamp", color: "#4b6b3f" },
  [BIOME.MOUNT]: { terrain: "hills", name: "Mountain", color: "#78716c" },
  [BIOME.SNOW]: { terrain: "snow", name: "Snowcap", color: "#e2e8f0" },
  [BIOME.LAKE]: { terrain: "oasis", name: "Lake", color: "#0ea5e9" },
  [BIOME.RIVER]: { terrain: "oasis", name: "River", color: "#0284c7" },
  [BIOME.PATH]: { terrain: "plains", name: "Path", color: "#b98649" },
  [BIOME.FARM_V]: { terrain: "plains", name: "Farmland", color: "#7c5f2f" },
  [BIOME.FARM_H]: { terrain: "plains", name: "Farmland", color: "#7c5f2f" },
  [BIOME.ORCHARD]: { terrain: "forest", name: "Orchard", color: "#3f7f35" },
  [BIOME.STONE_FLOOR]: { terrain: "town", name: "Stone Road", color: "#9ca3af" },
  [BIOME.HOUSE]: { terrain: "town", name: "Building", color: "#92400e" },
  [BIOME.CASTLE]: { terrain: "town", name: "Castle", color: "#64748b" },
  [BIOME.BRIDGE]: { terrain: "plains", name: "Bridge", color: "#8b5e34" },
  [BIOME.AUTUMN_FOREST]: { terrain: "forest", name: "Autumn Forest", color: "#b45309" },
  [BIOME.CHERRY_GROVE]: { terrain: "forest", name: "Cherry Grove", color: "#f9a8d4" },
  [BIOME.WHEAT_FIELD]: { terrain: "plains", name: "Wheat Field", color: "#ca8a04" },
  [BIOME.BAMBOO_GROVE]: { terrain: "jungle", name: "Bamboo Grove", color: "#4d7c0f" },
  [BIOME.DESERT]: { terrain: "desert", name: "Desert", color: "#d97706" },
  [BIOME.HIGHWAY]: { terrain: "plains", name: "Highway", color: "#a16207" },
  [BIOME.TRAIL]: { terrain: "plains", name: "Trail", color: "#92400e" },
};

/** Terrain now comes from the finite generated world grid. */
export function biomeAt(x: number, y: number): Terrain {
  if (townAt(x, y)) return "town";
  return BIOME_DISPLAY[tileAt(x, y)].terrain;
}

export function biomeNameAt(x: number, y: number): string {
  const town = townAt(x, y);
  if (town) return town.name;
  return BIOME_DISPLAY[tileAt(x, y)].name;
}

export function biomeColorAt(x: number, y: number): string {
  const town = townAt(x, y);
  if (town) return "#1e3a8a";
  return BIOME_DISPLAY[tileAt(x, y)].color;
}

export interface MonsterSpec {
  name: string;
  level: number; // challenge rating, 1..8; rises with distance from the nearest town
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
    reward: 40 + level * 25 + Math.floor(hash01(x, y, 17) * 30),
  };
}

/**
 * Pure, DB-free entity lookup: what would be on this tile by deterministic
 * roll. Callers subtract the cleared tombstone set to know what's still there.
 * Town, sea, solid, and out-of-bounds tiles never spawn anything.
 */
export function entityAt(x: number, y: number): TileEntity | null {
  if (biomeAt(x, y) === "town") return null;
  if (!canEnter(x, y, { ownsBoat: false })) return null;
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
