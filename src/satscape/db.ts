import { supabase } from "../db.js";
import { getBalance, getOrCreateUser } from "../balance.js";
import { SAT, entityAt, viewportBounds } from "./engine.js";
import type {
  CombatSessionRow,
  OtherPlayer,
  PlayerState,
  SatPlayerRow,
  TileEntity,
  ViewModel,
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

export async function refreshDisplayMaxHp(player: SatPlayerRow, hp: number): Promise<void> {
  if (hp > player.display_max_hp) {
    await updatePlayer(player.discord_id, { display_max_hp: hp });
    player.display_max_hp = hp;
  }
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

/** Mark a tile consumed (looted/killed) so its deterministic spawn never returns. */
export async function clearTile(x: number, y: number): Promise<void> {
  await supabase
    .from("sat_world_entities")
    .upsert({ x, y, entity_type: "cleared", entity_data: {} }, { onConflict: "x,y" });
}

/** Is this single tile cleared? (used on a step-onto check) */
export async function isTileCleared(x: number, y: number): Promise<boolean> {
  const { data } = await supabase
    .from("sat_world_entities")
    .select("entity_type")
    .eq("x", x)
    .eq("y", y)
    .maybeSingle();
  return data?.entity_type === "cleared";
}

/** The set of cleared tiles within a bounding box, keyed "x,y". */
async function clearedInBox(minX: number, maxX: number, minY: number, maxY: number): Promise<Set<string>> {
  const { data } = await supabase
    .from("sat_world_entities")
    .select("x, y")
    .eq("entity_type", "cleared")
    .gte("x", minX)
    .lte("x", maxX)
    .gte("y", minY)
    .lte("y", maxY);
  return new Set((data ?? []).map((r) => `${r.x},${r.y}`));
}

/** Other active adventurers within a bounding box (with display names). */
async function othersInBox(
  selfId: string,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
): Promise<OtherPlayer[]> {
  const { data: rows } = await supabase
    .from("sat_players")
    .select("discord_id, x_coord, y_coord, state")
    .eq("active", true)
    .neq("state", "fainted")
    .neq("discord_id", selfId)
    .gte("x_coord", minX)
    .lte("x_coord", maxX)
    .gte("y_coord", minY)
    .lte("y_coord", maxY);
  if (!rows || rows.length === 0) return [];

  const ids = rows.map((r) => r.discord_id);
  const { data: users } = await supabase
    .from("users")
    .select("discord_id, username, display_name")
    .in("discord_id", ids);
  const nameById = new Map<string, string>();
  for (const u of users ?? []) nameById.set(u.discord_id, u.display_name || u.username || "Adventurer");

  return rows.map((r) => ({
    name: nameById.get(r.discord_id) ?? "Adventurer",
    x: r.x_coord,
    y: r.y_coord,
    state: r.state as PlayerState,
  }));
}

/** Compute the active (non-cleared) entities visible in the viewport — DB-free except one cleared-set query. */
async function loadViewportEntities(cx: number, cy: number): Promise<TileEntity[]> {
  const b = viewportBounds(cx, cy);
  const cleared = await clearedInBox(b.minX, b.maxX, b.minY, b.maxY);
  const out: TileEntity[] = [];
  for (let y = b.minY; y <= b.maxY; y++) {
    for (let x = b.minX; x <= b.maxX; x++) {
      if (cleared.has(`${x},${y}`)) continue;
      const e = entityAt(x, y);
      if (e) out.push(e);
    }
  }
  return out;
}

/** Build a complete render frame for a player. */
export async function loadView(discordId: string): Promise<ViewModel | null> {
  const player = await getPlayer(discordId);
  if (!player) return null;
  const b = viewportBounds(player.x_coord, player.y_coord);
  const [hp, combat, entities, others] = await Promise.all([
    getBalance(discordId),
    getCombat(discordId),
    loadViewportEntities(player.x_coord, player.y_coord),
    othersInBox(discordId, b.minX, b.maxX, b.minY, b.maxY),
  ]);
  await refreshDisplayMaxHp(player, hp);
  return { player, hp, entities, others, combat };
}
