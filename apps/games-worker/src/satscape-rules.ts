import { BIOME, canEnter, isChestAt, tileAt } from "@mezosbot/game-core";

/**
 * Browser movement rules mirrored from the legacy bot (src/satscape/engine.ts,
 * src/satscape/towns.ts, src/satscape/game.ts move()). The Worker never moves
 * money, so tiles that would need a money-moving resolution (chest payout,
 * monster combat, starvation HP burn) are refused here and resolved in Discord.
 */
export const SATSCAPE_SIGHT = 5;
export const SATSCAPE_MONSTER_SPAWN = 0.08;
/** Server-side throttle between browser steps (legacy has none; this only caps spam). */
export const SATSCAPE_MIN_MOVE_INTERVAL_MS = 150;

/** Biomes whose legacy display terrain is "town" (src/satscape/engine.ts BIOME_DISPLAY): never spawn. */
const TOWN_BIOMES = new Set<number>([BIOME.STONE_FLOOR, BIOME.HOUSE, BIOME.CASTLE]);

const TOWNS = [
  { id: "rest", cx: 127, cy: 111, safeRadius: 12 },
  { id: "jaipur", cx: 185, cy: 66, safeRadius: 14 },
  { id: "dustfall", cx: 27, cy: 97, safeRadius: 14 },
  { id: "frosthold", cx: 31, cy: 59, safeRadius: 14 },
] as const;

/** Deterministic [0,1) hash — identical to src/satscape/engine.ts hash01. */
function hash01(a: number, b: number, salt: number): number {
  return Math.abs(Math.sin(a * 12.9898 + b * 78.233 + salt) * 43758.5453) % 1;
}

export function townAt(x: number, y: number): string | null {
  let best: (typeof TOWNS)[number] = TOWNS[0];
  let bestD = Infinity;
  for (const town of TOWNS) {
    const d = Math.hypot(x - town.cx, y - town.cy);
    if (d < bestD) { bestD = d; best = town; }
  }
  return bestD <= best.safeRadius ? best.id : null;
}

/**
 * What legacy resolveTile() would do on arrival: towns are safe, cleared
 * tiles are empty, otherwise the deterministic entity roll decides.
 */
export function encounterAt(x: number, y: number, cleared: ReadonlySet<string>): "chest" | "monster" | null {
  if (townAt(x, y)) return null;
  if (cleared.has(`${x},${y}`)) return null;
  if (isChestAt(x, y)) return "chest";
  if (TOWN_BIOMES.has(tileAt(x, y))) return null;
  if (!canEnter(x, y, { ownsBoat: false })) return null;
  return hash01(x, y, 3) < SATSCAPE_MONSTER_SPAWN ? "monster" : null;
}

/** Fog-of-war disc revealed on arrival — identical to src/satscape/db.ts revealAround(). */
export function revealTiles(cx: number, cy: number): Array<{ x: number; y: number }> {
  const r = SATSCAPE_SIGHT;
  const tiles: Array<{ x: number; y: number }> = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy <= r * r + r) tiles.push({ x: cx + dx, y: cy + dy });
    }
  }
  return tiles;
}
