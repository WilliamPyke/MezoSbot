import { supabase } from "../db.js";
import type { Biome, WorldEntityRow } from "./types.js";

/** Tunables for the v1 game loop. */
export const SAT = {
  TOWN_RADIUS: 15, // tiles from origin that stay a safe town
  VIEW_RADIUS: 2, // 5x5 viewport
  BUYIN_SATS: 50, // paid on /join, seeds the prize pool
  DEATH_PENALTY_SATS: 50, // taken on faint (clamped to remaining balance)
  CHEST_SPAWN: 0.03, // per-tile spawn probability in the wilds
  MONSTER_SPAWN: 0.08, // cumulative upper bound (monster occupies 0.03..0.08)
  PLAYER_DMG_MIN: 8,
  PLAYER_DMG_MAX: 16,
} as const;

/** Deterministic [0,1) hash for a coordinate pair. */
function hash01(x: number, y: number, salt: number): number {
  return Math.abs(Math.sin(x * 12.9898 + y * 78.233 + salt) * 43758.5453) % 1;
}

/** Biome is computed from coordinates — never stored. */
export function biomeAt(x: number, y: number): Biome {
  if (Math.hypot(x, y) <= SAT.TOWN_RADIUS) return "town";
  const h = hash01(x, y, 0);
  if (h < 0.34) return "jungle";
  if (h < 0.67) return "desert";
  return "winter";
}

export interface MonsterSpec {
  name: string;
  max_hp: number;
  attack: number;
  reward: number;
}

/** Deterministic monster stats for a tile, themed by biome. */
function monsterFor(x: number, y: number, biome: Biome): MonsterSpec {
  const r = hash01(x, y, 7);
  const byBiome: Record<Exclude<Biome, "town">, string[]> = {
    jungle: ["Vine Stalker", "Jaguar Wraith", "Spore Beast"],
    desert: ["Sand Lurker", "Dune Scorpion", "Mirage Hound"],
    winter: ["Frost Gnoll", "Ice Revenant", "Snow Troll"],
  };
  const pool = byBiome[biome as Exclude<Biome, "town">] ?? byBiome.jungle;
  const name = pool[Math.floor(r * pool.length)];
  const max_hp = 30 + Math.floor(hash01(x, y, 11) * 40); // 30..69
  const attack = 6 + Math.floor(hash01(x, y, 13) * 12); // 6..17
  const reward = 30 + Math.floor(hash01(x, y, 17) * 90); // 30..119
  return { name, max_hp, attack, reward };
}

/**
 * Return the active consumable entity at a tile, generating one on first visit.
 * Empty rolls persist nothing (the deterministic roll keeps them empty on
 * revisit). A 'cleared' tombstone — left behind after looting/killing — is
 * treated as "nothing here" so consumed tiles never re-spawn.
 */
export async function ensureEntityAt(x: number, y: number): Promise<WorldEntityRow | null> {
  const biome = biomeAt(x, y);
  if (biome === "town") return null;

  const { data: existing } = await supabase
    .from("sat_world_entities")
    .select("*")
    .eq("x", x)
    .eq("y", y)
    .maybeSingle();

  if (existing) {
    return (existing as WorldEntityRow).entity_type === "cleared" ? null : (existing as WorldEntityRow);
  }

  const r = hash01(x, y, 3);
  let row: { entity_type: string; entity_data: Record<string, unknown> } | null = null;
  if (r < SAT.CHEST_SPAWN) {
    const reward = 20 + Math.floor(hash01(x, y, 5) * 80); // 20..99
    row = { entity_type: "chest", entity_data: { reward } };
  } else if (r < SAT.MONSTER_SPAWN) {
    row = { entity_type: "monster", entity_data: { ...monsterFor(x, y, biome) } };
  }
  if (!row) return null;

  // UNIQUE(x,y) makes concurrent first-visits race-safe; ignore the conflict
  // and re-read the winner.
  await supabase
    .from("sat_world_entities")
    .upsert({ x, y, ...row }, { onConflict: "x,y", ignoreDuplicates: true });

  const { data } = await supabase
    .from("sat_world_entities")
    .select("*")
    .eq("x", x)
    .eq("y", y)
    .maybeSingle();
  if (!data) return null;
  return (data as WorldEntityRow).entity_type === "cleared" ? null : (data as WorldEntityRow);
}

/** Replace a tile's entity with a 'cleared' tombstone after it's consumed. */
export async function clearEntityAt(x: number, y: number): Promise<void> {
  await supabase
    .from("sat_world_entities")
    .upsert({ x, y, entity_type: "cleared", entity_data: {} }, { onConflict: "x,y" });
}

export function rollPlayerDamage(): number {
  return SAT.PLAYER_DMG_MIN + Math.floor(Math.random() * (SAT.PLAYER_DMG_MAX - SAT.PLAYER_DMG_MIN + 1));
}
