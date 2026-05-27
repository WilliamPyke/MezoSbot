import { getBalance, subtractBalance } from "../balance.js";
import { formatSats } from "../format.js";
import { addToPool, payoutFromPool, takeDamage } from "./economy.js";
import { SAT, biomeAt, entityAt, rollPlayerDamage } from "./engine.js";
import {
  clearTile,
  createCombat,
  deleteCombat,
  getCombat,
  getPlayer,
  isTileCleared,
  setStateIf,
  updateCombat,
  updatePlayer,
} from "./db.js";
import type { Direction, SatPlayerRow } from "./types.js";

const BREAD_COST = 1; // sats → pool
const FLEE_COST = 1; // sats → pool

export interface ActionResult {
  ok: boolean;
  note: string;
  /** True when this action put the player into combat (used to stop auto-explore). */
  enteredCombat?: boolean;
}

const DELTA: Record<Direction, [number, number]> = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};

/** Move one tile, applying stamina/starvation, then resolve whatever is there. */
export async function move(discordId: string, dir: Direction): Promise<ActionResult> {
  const player = await getPlayer(discordId);
  if (!player || !player.active) return { ok: false, note: "Use `/satscape join` to start a run first." };
  if (player.state === "combat") return { ok: false, note: "You're in combat — Attack or Flee." };

  const [dx, dy] = DELTA[dir];
  const nx = player.x_coord + dx;
  const ny = player.y_coord + dy;

  // Stamina first; once it's gone each step burns 1 sat (HP) into the pool.
  let note = "";
  let hunger = player.hunger;
  if (hunger > 0) {
    hunger -= 1;
  } else {
    const burned = await takeDamage(discordId, 1);
    if (burned > 0) note = "💀 Exhausted! Lost 1 sat. ";
  }

  await updatePlayer(discordId, {
    x_coord: nx,
    y_coord: ny,
    hunger,
    last_move_at: new Date().toISOString(),
  });

  if ((await getBalance(discordId)) <= 0) {
    return { ok: true, note: note + (await faint(discordId)).note };
  }

  const resolved = await resolveTile(discordId, nx, ny);
  return { ...resolved, note: note + resolved.note };
}

/** Resolve whatever sits on a tile the player just arrived on (chest/monster/empty). */
export async function resolveTile(discordId: string, x: number, y: number): Promise<ActionResult> {
  if (biomeAt(x, y) === "town") return { ok: true, note: "🏙️ Town — safe." };
  if (await isTileCleared(x, y)) return { ok: true, note: "…nothing here." };

  const entity = entityAt(x, y);
  if (!entity) return { ok: true, note: "…nothing here." };

  if (entity.type === "chest") {
    const reward = Number(entity.data.reward ?? 0);
    const granted = await payoutFromPool(discordId, reward);
    await clearTile(x, y);
    return {
      ok: true,
      note: granted > 0
        ? `🟫 Chest! You found **${formatSats(granted)}**.`
        : "🟫 Chest — but the prize pool is empty.",
    };
  }

  // Monster → lock into combat (only if still idle).
  if (!(await setStateIf(discordId, "idle", "combat"))) {
    return { ok: true, note: "Something interrupted you." };
  }
  const m = entity.data as { name: string; max_hp: number; attack: number; reward: number };
  await createCombat({
    discord_id: discordId,
    monster_name: m.name,
    monster_max_hp: m.max_hp,
    monster_current_hp: m.max_hp,
    monster_attack: m.attack,
    reward_sats: m.reward,
    enemy_x: x,
    enemy_y: y,
    turn_number: 1,
    created_at: new Date().toISOString(),
  });
  return { ok: true, note: `👹 A **${m.name}** blocks your path!`, enteredCombat: true };
}

/** One combat round: player hits, then (if it survives) the monster hits back. */
export async function attack(discordId: string): Promise<ActionResult> {
  const combat = await getCombat(discordId);
  if (!combat) return { ok: false, note: "No active fight." };

  const dmg = rollPlayerDamage();
  const monsterHp = combat.monster_current_hp - dmg;

  if (monsterHp <= 0) {
    const granted = await payoutFromPool(discordId, combat.reward_sats);
    await clearTile(combat.enemy_x, combat.enemy_y);
    await deleteCombat(discordId);
    await updatePlayer(discordId, { state: "idle" });
    return {
      ok: true,
      note:
        `⚔️ You hit for ${dmg} and slew the **${combat.monster_name}**! ` +
        (granted > 0 ? `Looted **${formatSats(granted)}**.` : "(Prize pool was empty — no loot.)"),
    };
  }

  const taken = await takeDamage(discordId, combat.monster_attack);
  if ((await getBalance(discordId)) <= 0) {
    return { ok: true, note: `⚔️ You hit for ${dmg}. The ${combat.monster_name} struck back… ` + (await faint(discordId)).note };
  }
  await updateCombat(discordId, { monster_current_hp: monsterHp, turn_number: combat.turn_number + 1 });
  return { ok: true, note: `⚔️ You hit for ${dmg}; the **${combat.monster_name}** hit back for ${taken} sats.` };
}

export async function flee(discordId: string): Promise<ActionResult> {
  const combat = await getCombat(discordId);
  if (!combat) return { ok: false, note: "No active fight." };
  const paid = await takeDamage(discordId, FLEE_COST);
  await deleteCombat(discordId);
  await updatePlayer(discordId, { state: "idle" });
  return { ok: true, note: `🏃 You fled the ${combat.monster_name}${paid > 0 ? ` (−${paid} sat)` : ""}.` };
}

/** Eat bread: costs sats (→ pool), restores stamina only (HP is never minted). */
export async function eat(discordId: string): Promise<ActionResult> {
  const player = await getPlayer(discordId);
  if (!player) return { ok: false, note: "No run in progress." };
  if (player.hunger >= 100) return { ok: false, note: "Stamina is already full." };
  const paid = await takeDamage(discordId, BREAD_COST);
  if (paid <= 0) return { ok: false, note: "You can't afford even a crust of bread." };
  await updatePlayer(discordId, { hunger: Math.min(100, player.hunger + SAT.BREAD_STAMINA) });
  return { ok: true, note: `🍞 Ate bread (−${paid} sat). +${SAT.BREAD_STAMINA} stamina.` };
}

/** Faint: fixed penalty (clamped to balance, → pool), warp to town, restore stamina. */
export async function faint(discordId: string): Promise<ActionResult> {
  const lost = await takeDamage(discordId, SAT.DEATH_PENALTY_SATS);
  await deleteCombat(discordId);
  await updatePlayer(discordId, { x_coord: 0, y_coord: 0, hunger: 100, state: "idle" });
  return { ok: true, note: `☠️ You fainted! Lost ${lost} sats and woke up back in town.` };
}

export async function chargeBuyIn(discordId: string): Promise<boolean> {
  const paid = await subtractBalance(discordId, SAT.BUYIN_SATS);
  if (!paid) return false;
  await addToPool(SAT.BUYIN_SATS);
  return true;
}

/* ─────────── Fast travel ─────────── */

export interface TravelEstimate {
  tx: number;
  ty: number;
  steps: number;
  staminaAfterFree: number; // stamina remaining if you just walk (no bread)
  breadNeeded: number; // loaves to avoid HP loss over the trip
  satCost: number; // = breadNeeded (cheapest route)
  hpOnlyCost: number; // sats lost if you walk it with no bread
}

/** Manhattan-distance cost estimate for walking to (tx, ty). */
export function estimateTravel(player: SatPlayerRow, tx: number, ty: number): TravelEstimate {
  const steps = Math.abs(tx - player.x_coord) + Math.abs(ty - player.y_coord);
  const overflow = Math.max(0, steps - player.hunger); // steps taken on an empty stamina bar
  const breadNeeded = Math.ceil(overflow / SAT.BREAD_STAMINA);
  return {
    tx,
    ty,
    steps,
    staminaAfterFree: Math.max(0, player.hunger - steps),
    breadNeeded,
    satCost: breadNeeded,
    hpOnlyCost: overflow,
  };
}

/**
 * Execute a confirmed fast-travel: deduct the (cheapest) bread cost to the pool,
 * teleport to the destination, set the resulting stamina, and resolve the tile.
 * Encounters along the way are abstracted away — only the destination is resolved.
 */
export async function travelTo(discordId: string, tx: number, ty: number): Promise<ActionResult> {
  const player = await getPlayer(discordId);
  if (!player || !player.active) return { ok: false, note: "Use `/satscape join` first." };
  if (player.state === "combat") return { ok: false, note: "Can't travel mid-combat." };

  const est = estimateTravel(player, tx, ty);
  if (est.steps === 0) return { ok: false, note: "You're already there." };

  let paidNote = "";
  if (est.satCost > 0) {
    const paid = await takeDamage(discordId, est.satCost);
    if (paid < est.satCost) {
      // Couldn't fully fund the trip → arrive exhausted, HP already drained by `paid`.
      paidNote = `Provisions ran short (−${paid} sat). `;
    } else {
      paidNote = `Bought ${est.breadNeeded} bread (−${est.satCost} sat). `;
    }
  }

  const endStamina = Math.max(0, Math.min(100, player.hunger - est.steps + est.breadNeeded * SAT.BREAD_STAMINA));
  await updatePlayer(discordId, { x_coord: tx, y_coord: ty, hunger: endStamina, last_move_at: new Date().toISOString() });

  if ((await getBalance(discordId)) <= 0) {
    return { ok: true, note: paidNote + (await faint(discordId)).note };
  }
  const arrival = await resolveTile(discordId, tx, ty);
  return { ...arrival, note: `🧭 Travelled ${est.steps} tiles to (${tx}, ${ty}). ${paidNote}${arrival.note}` };
}
