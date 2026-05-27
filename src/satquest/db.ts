import { supabase } from "../db.js";
import { getBalance, getOrCreateUser } from "../balance.js";
import { SAT, ensureEntityAt } from "./engine.js";
import type {
  CombatSessionRow,
  PlayerState,
  SatPlayerRow,
  ViewModel,
  WorldEntityRow,
} from "./types.js";

export async function getPlayer(discordId: string): Promise<SatPlayerRow | null> {
  const { data } = await supabase
    .from("sat_players")
    .select("*")
    .eq("discord_id", discordId)
    .maybeSingle();
  return (data as SatPlayerRow) ?? null;
}

/** Create or re-activate a player at the town origin. Caller must charge the buy-in first. */
export async function startRun(discordId: string): Promise<SatPlayerRow> {
  await getOrCreateUser(discordId); // ensure FK target in `users` exists
  const balance = await getBalance(discordId);
  const { data, error } = await supabase
    .from("sat_players")
    .upsert(
      {
        discord_id: discordId,
        x_coord: 0,
        y_coord: 0,
        hunger: 100,
        state: "idle",
        active: true,
        display_max_hp: balance,
        last_move_at: new Date().toISOString(),
      },
      { onConflict: "discord_id" },
    )
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data as SatPlayerRow;
}

/** Conditional state transition — only flips if the row is currently in `from`. */
export async function setStateIf(
  discordId: string,
  from: PlayerState,
  to: PlayerState,
): Promise<boolean> {
  const { data } = await supabase
    .from("sat_players")
    .update({ state: to })
    .eq("discord_id", discordId)
    .eq("state", from)
    .select("discord_id")
    .maybeSingle();
  return !!data;
}

export async function updatePlayer(
  discordId: string,
  patch: Partial<SatPlayerRow>,
): Promise<void> {
  await supabase.from("sat_players").update(patch).eq("discord_id", discordId);
}

/** Bump the HP-bar high-water mark if the live balance has grown. */
export async function refreshDisplayMaxHp(player: SatPlayerRow, hp: number): Promise<number> {
  if (hp > player.display_max_hp) {
    await updatePlayer(player.discord_id, { display_max_hp: hp });
    return hp;
  }
  return player.display_max_hp;
}

export async function getCombat(discordId: string): Promise<CombatSessionRow | null> {
  const { data } = await supabase
    .from("sat_combat_sessions")
    .select("*")
    .eq("discord_id", discordId)
    .maybeSingle();
  return (data as CombatSessionRow) ?? null;
}

export async function createCombat(session: CombatSessionRow): Promise<void> {
  await supabase.from("sat_combat_sessions").upsert(session, { onConflict: "discord_id" });
}

export async function updateCombat(
  discordId: string,
  patch: Partial<CombatSessionRow>,
): Promise<void> {
  await supabase.from("sat_combat_sessions").update(patch).eq("discord_id", discordId);
}

export async function deleteCombat(discordId: string): Promise<void> {
  await supabase.from("sat_combat_sessions").delete().eq("discord_id", discordId);
}

/** Materialise active entities within the viewport (generating on first visit). */
async function loadViewportEntities(
  cx: number,
  cy: number,
): Promise<WorldEntityRow[]> {
  const r = SAT.VIEW_RADIUS;
  const tiles: Array<Promise<WorldEntityRow | null>> = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      tiles.push(ensureEntityAt(cx + dx, cy + dy));
    }
  }
  const results = await Promise.all(tiles);
  return results.filter((e): e is WorldEntityRow => e !== null);
}

/** Build a complete render frame for a player. */
export async function loadView(discordId: string): Promise<ViewModel | null> {
  const player = await getPlayer(discordId);
  if (!player) return null;
  const [hp, combat, entities] = await Promise.all([
    getBalance(discordId),
    getCombat(discordId),
    loadViewportEntities(player.x_coord, player.y_coord),
  ]);
  await refreshDisplayMaxHp(player, hp);
  if (hp > player.display_max_hp) player.display_max_hp = hp;
  return { player, hp, entities, combat };
}
