import worldData from "./world.json";

type WorldJson = {
  seed: number;
  width: number;
  height: number;
  encoding: string;
  biome: string;
  solid: string;
  landmarks: Record<string, [number, number][]>;
};

const data = worldData as unknown as WorldJson;

export const MAP_W = data.width;
export const MAP_H = data.height;
export const WORLD_SEED = data.seed;
export const WORLD_LANDMARKS = data.landmarks;

export const BIOME = {
  OCEAN: 0,
  DEEP: 1,
  BEACH: 2,
  SAND: 3,
  GRASS: 4,
  GRASS_LUSH: 5,
  FOREST: 6,
  F_DENSE: 7,
  F_DARK: 8,
  SWAMP: 9,
  MOUNT: 10,
  SNOW: 11,
  LAKE: 12,
  RIVER: 13,
  PATH: 14,
  FARM_V: 15,
  FARM_H: 16,
  ORCHARD: 17,
  STONE_FLOOR: 18,
  HOUSE: 19,
  CASTLE: 20,
  BRIDGE: 21,
  AUTUMN_FOREST: 22,
  CHERRY_GROVE: 23,
  WHEAT_FIELD: 24,
  BAMBOO_GROVE: 25,
  DESERT: 26,
  HIGHWAY: 27,
  TRAIL: 28,
} as const;

export type BiomeId = typeof BIOME[keyof typeof BIOME];
export type BlockReason = "bounds" | "sea" | "solid";

const BIOME_GRID = new Uint8Array(Buffer.from(data.biome, "base64"));
const SOLID_GRID = new Uint8Array(Buffer.from(data.solid, "base64"));
const EXPECTED_SIZE = MAP_W * MAP_H;

if (BIOME_GRID.length !== EXPECTED_SIZE || SOLID_GRID.length !== EXPECTED_SIZE) {
  throw new Error(`Invalid SatScape world data: expected ${EXPECTED_SIZE} tiles`);
}

const SEA = new Set<number>([BIOME.OCEAN, BIOME.DEEP, BIOME.LAKE, BIOME.RIVER]);

export function inWorldBounds(x: number, y: number): boolean {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && x < MAP_W && y >= 0 && y < MAP_H;
}

function indexAt(x: number, y: number): number {
  return y * MAP_W + x;
}

export function tileAt(x: number, y: number): BiomeId {
  if (!inWorldBounds(x, y)) return BIOME.OCEAN;
  return BIOME_GRID[indexAt(x, y)] as BiomeId;
}

export function isSea(x: number, y: number): boolean {
  return SEA.has(tileAt(x, y));
}

export function isSolid(x: number, y: number): boolean {
  if (!inWorldBounds(x, y)) return true;
  return SOLID_GRID[indexAt(x, y)] === 1;
}

export function blockReasonAt(x: number, y: number, opts: { ownsBoat?: boolean } = {}): BlockReason | null {
  if (!inWorldBounds(x, y)) return "bounds";
  if (isSolid(x, y)) return "solid";
  if (isSea(x, y) && !opts.ownsBoat) return "sea";
  return null;
}

export function canEnter(x: number, y: number, opts: { ownsBoat?: boolean } = {}): boolean {
  return blockReasonAt(x, y, opts) === null;
}
