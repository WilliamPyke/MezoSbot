import { supabase } from "../db.js";
import { getBalance, getOrCreateUser } from "../balance.js";
import { SAT, entityAt, viewportBounds } from "./engine.js";
import { TOWN_BY_ID } from "./towns.js";
import type {
  CombatSessionRow,
  OtherPlayer,
  PlayerState,
  SatPlayerRow,
  TileEntity,
  ViewModel,
} from "./types.js";

/**
 * Resolve a player's current HP, enforcing the invariant `0 ≤ hp ≤ min(balance, max_hp)`.
 *
 * HP is the *at-risk* slice of the player's sats balance (capped at `max_hp`, default
 * `SAT.HP_MAX_DEFAULT`). A NULL `hp` column means "not yet armed" → derive `min(balance, max_hp)`.
 * Balance-only spends (bread, flee, shop) may leave the stored `hp` momentarily above the
 * balance; this clamp keeps every read consistent without a write on every spend.
 */
export function effectiveHp(player: Pick<SatPlayerRow, "hp" | "max_hp">, balance: number): number {
  const cap = Math.min(balance, player.max_hp ?? SAT.HP_MAX_DEFAULT);
  const cur = player.hp ?? cap;
  return Math.max(0, Math.min(cur, cap));
}

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
  const spawn = TOWN_BY_ID.get("rest") ?? { cx: 0, cy: 0 };
  const { data, error } = await supabase
    .from("sat_players")
    .upsert(
      {
        discord_id: discordId,
        x_coord: spawn.cx,
        y_coord: spawn.cy,
        hunger: 100,
        state: "idle",
        active: true,
        hp: Math.min(balance, SAT.HP_MAX_DEFAULT), // arm HP from balance, up to the cap
        max_hp: SAT.HP_MAX_DEFAULT,
        last_move_at: new Date().toISOString(),
      },
      { onConflict: "discord_id" },
    )
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  await revealAround(discordId, spawn.cx, spawn.cy); // light up the spawn town
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

/* ─────────── inventory & equipment ─────────── */

export async function getOwnedItemIds(discordId: string): Promise<string[]> {
  const { data } = await supabase
    .from("sat_inventories")
    .select("item_id")
    .eq("discord_id", discordId)
    .gt("quantity", 0);
  return (data ?? []).map((r) => r.item_id as string);
}

export async function ownsItem(discordId: string, itemId: string): Promise<boolean> {
  const { data } = await supabase
    .from("sat_inventories")
    .select("quantity")
    .eq("discord_id", discordId)
    .eq("item_id", itemId)
    .maybeSingle();
  return !!data && (data.quantity ?? 0) > 0;
}

export async function addInventoryItem(discordId: string, itemId: string): Promise<void> {
  const { data } = await supabase
    .from("sat_inventories")
    .select("quantity")
    .eq("discord_id", discordId)
    .eq("item_id", itemId)
    .maybeSingle();
  if (data) {
    await supabase.from("sat_inventories").update({ quantity: (data.quantity ?? 0) + 1 }).eq("discord_id", discordId).eq("item_id", itemId);
  } else {
    await supabase.from("sat_inventories").insert({ discord_id: discordId, item_id: itemId, quantity: 1 });
  }
}

export async function setEquipped(
  discordId: string,
  slot: "weapon" | "armor" | "accessory" | "boots",
  itemId: string,
): Promise<void> {
  const col = slot === "weapon" ? "equipped_weapon"
    : slot === "armor" ? "equipped_armor"
    : slot === "accessory" ? "equipped_accessory"
    : "equipped_boots";
  await supabase.from("sat_players").update({ [col]: itemId }).eq("discord_id", discordId);
}

/* ─────────── fog of war ─────────── */

/** Reveal the vision disc for shared fog plus the player's personal cartography progress. */
export async function revealAround(discordId: string, cx: number, cy: number): Promise<void> {
  const r = SAT.SIGHT;
  const rows: Array<{ x: number; y: number }> = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy <= r * r + r) rows.push({ x: cx + dx, y: cy + dy });
    }
  }
  if (rows.length) {
    await Promise.all([
      supabase.from("sat_world_explored").upsert(rows, { onConflict: "x,y", ignoreDuplicates: true }),
      supabase
        .from("sat_explored")
        .upsert(rows.map((row) => ({ discord_id: discordId, ...row })), { onConflict: "discord_id,x,y", ignoreDuplicates: true }),
    ]);
  }
}

async function exploredInBox(
  _discordId: string,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
): Promise<Set<string>> {
  const { data } = await supabase
    .from("sat_world_explored")
    .select("x, y")
    .gte("x", minX)
    .lte("x", maxX)
    .gte("y", minY)
    .lte("y", maxY);
  return new Set((data ?? []).map((r) => `${r.x},${r.y}`));
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

/**
 * Process-wide cache of discord_id → display name. Names change rarely; caching them
 * spares us a second `users` query on every tick of the passive map refresh.
 */
const userNameCache = new Map<string, string>();

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

  // Only look up names we haven't cached yet.
  const missing = rows.filter((r) => !userNameCache.has(r.discord_id)).map((r) => r.discord_id);
  if (missing.length > 0) {
    const { data: users } = await supabase
      .from("users")
      .select("discord_id, username, display_name")
      .in("discord_id", missing);
    for (const u of users ?? []) {
      userNameCache.set(u.discord_id, u.display_name || u.username || "Adventurer");
    }
  }

  return rows.map((r) => ({
    name: userNameCache.get(r.discord_id) ?? "Adventurer",
    x: r.x_coord,
    y: r.y_coord,
    state: r.state as PlayerState,
  }));
}

/**
 * Lightweight viewport refresh: only the neighbors-in-box query (with name cache).
 * Cheap path for passive-tick refreshes — everything else in the view is either
 * driven by the player's own actions or stale-tolerant.
 */
export async function loadOthersInView(
  discordId: string,
  cx: number,
  cy: number,
): Promise<OtherPlayer[]> {
  const b = viewportBounds(cx, cy);
  return othersInBox(discordId, b.minX, b.maxX, b.minY, b.maxY);
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
  const [balance, combat, entities, others, explored, ownedItemIds] = await Promise.all([
    getBalance(discordId),
    getCombat(discordId),
    loadViewportEntities(player.x_coord, player.y_coord),
    othersInBox(discordId, b.minX, b.maxX, b.minY, b.maxY),
    exploredInBox(discordId, b.minX, b.maxX, b.minY, b.maxY),
    getOwnedItemIds(discordId),
  ]);
  const maxHp = player.max_hp ?? SAT.HP_MAX_DEFAULT;
  const hp = effectiveHp(player, balance);
  return { player, hp, maxHp, balance, entities, others, combat, ownedItemIds, explored };
}
