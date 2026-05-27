import type { Biome, TileEntity } from "./types.js";

/** Tunables for the game loop. */
export const SAT = {
  TOWN_RADIUS: 15, // tiles from origin that stay a safe town
  VIEW_W: 16, // viewport width in tiles
  VIEW_H: 16, // viewport height in tiles
  VIEW_OX: 8, // player column offset from the left edge (so dx ∈ [-8, 7])
  VIEW_OY: 8, // player row offset from the top edge
  REGION_SIZE: 22, // tiles per biome region cell (large contiguous zones)
  BUYIN_SATS: 50, // paid on /join, seeds the prize pool
  DEATH_PENALTY_SATS: 50, // taken on faint (clamped to remaining balance)
  CHEST_SPAWN: 0.03, // per-tile spawn probability in the wilds
  MONSTER_SPAWN: 0.08, // cumulative upper bound (monster occupies 0.03..0.08)
  PLAYER_DMG_MIN: 8,
  PLAYER_DMG_MAX: 16,
  BREAD_STAMINA: 20, // stamina restored per 1-sat loaf
} as const;

/** Deterministic [0,1) hash. */
function hash01(a: number, b: number, salt: number): number {
  return Math.abs(Math.sin(a * 12.9898 + b * 78.233 + salt) * 43758.5453) % 1;
}

/**
 * Biome is computed from coordinates and never stored. The world is carved into
 * large contiguous regions (REGION_SIZE tiles), so you walk through a jungle,
 * then a desert, rather than a per-tile checkerboard. Region borders are warped
 * with a low-frequency wave so they aren't hard squares.
 */
export function biomeAt(x: number, y: number): Biome {
  if (Math.hypot(x, y) <= SAT.TOWN_RADIUS) return "town";
  const wx = x + Math.sin(y * 0.12) * 4; // domain warp → wavy borders
  const wy = y + Math.cos(x * 0.12) * 4;
  const cx = Math.floor(wx / SAT.REGION_SIZE);
  const cy = Math.floor(wy / SAT.REGION_SIZE);
  const h = hash01(cx * 1.7, cy * 2.3, 99);
  if (h < 0.3) return "jungle";
  if (h < 0.55) return "desert";
  if (h < 0.78) return "winter";
  return "india";
}

export interface MonsterSpec {
  name: string;
  max_hp: number;
  attack: number;
  reward: number;
}

const MONSTERS: Record<Exclude<Biome, "town">, string[]> = {
  jungle: ["Vine Stalker", "Jaguar Wraith", "Spore Beast"],
  desert: ["Sand Lurker", "Dune Scorpion", "Mirage Hound"],
  winter: ["Frost Gnoll", "Ice Revenant", "Snow Troll"],
  india: ["Bengal Tiger", "Rakshasa Fiend", "River Naga"],
};

function monsterFor(x: number, y: number, biome: Biome): MonsterSpec {
  const r = hash01(x, y, 7);
  const pool = MONSTERS[biome as Exclude<Biome, "town">] ?? MONSTERS.jungle;
  return {
    name: pool[Math.floor(r * pool.length)],
    max_hp: 30 + Math.floor(hash01(x, y, 11) * 40), // 30..69
    attack: 6 + Math.floor(hash01(x, y, 13) * 12), // 6..17
    reward: 30 + Math.floor(hash01(x, y, 17) * 90), // 30..119
  };
}

/**
 * Pure, DB-free entity lookup: what *would* be on this tile by the deterministic
 * roll. Callers subtract the "cleared" tombstone set to know what's actually
 * still there. Town tiles never spawn anything.
 */
export function entityAt(x: number, y: number): TileEntity | null {
  const biome = biomeAt(x, y);
  if (biome === "town") return null;
  const r = hash01(x, y, 3);
  if (r < SAT.CHEST_SPAWN) {
    const reward = 20 + Math.floor(hash01(x, y, 5) * 80); // 20..99
    return { x, y, type: "chest", data: { reward } };
  }
  if (r < SAT.MONSTER_SPAWN) {
    return { x, y, type: "monster", data: { ...monsterFor(x, y, biome) } };
  }
  return null;
}

export function rollPlayerDamage(): number {
  return SAT.PLAYER_DMG_MIN + Math.floor(Math.random() * (SAT.PLAYER_DMG_MAX - SAT.PLAYER_DMG_MIN + 1));
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
