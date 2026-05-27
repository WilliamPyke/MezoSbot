import { getBalance, subtractBalance } from "../balance.js";
import { formatSats } from "../format.js";
import { addToPool, payoutFromPool, takeDamage } from "./economy.js";
import {
  SAT,
  biomeAt,
  clearEntityAt,
  ensureEntityAt,
  rollPlayerDamage,
} from "./engine.js";
import {
  createCombat,
  deleteCombat,
  getCombat,
  getPlayer,
  setStateIf,
  updateCombat,
  updatePlayer,
} from "./db.js";
import type { Direction } from "./types.js";

const BREAD_COST = 1; // sats → pool
const BREAD_HUNGER = 20;
const FLEE_COST = 1; // sats → pool

export interface ActionResult {
  ok: boolean;
  note: string;
}

const DELTA: Record<Direction, [number, number]> = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};

/** Move one tile, applying hunger/starvation, then resolve whatever is there. */
export async function move(discordId: string, dir: Direction): Promise<ActionResult> {
  const player = await getPlayer(discordId);
  if (!player || !player.active) return { ok: false, note: "Use `/satquest join` to start a run first." };
  if (player.state === "combat") return { ok: false, note: "You're in combat — Attack or Flee." };

  const [dx, dy] = DELTA[dir];
  const nx = player.x_coord + dx;
  const ny = player.y_coord + dy;

  // Hunger first; starvation burns 1 sat (HP) per step into the pool.
  let note = "";
  let hunger = player.hunger;
  if (hunger > 0) {
    hunger -= 1;
  } else {
    const burned = await takeDamage(discordId, 1);
    if (burned > 0) note = "💀 Starving! Lost 1 sat. ";
  }

  await updatePlayer(discordId, {
    x_coord: nx,
    y_coord: ny,
    hunger,
    last_move_at: new Date().toISOString(),
  });

  // Starvation may have emptied the wallet.
  if ((await getBalance(discordId)) <= 0) {
    return { ok: true, note: note + (await faint(discordId)).note };
  }

  const entity = await ensureEntityAt(nx, ny);
  if (!entity) {
    const biome = biomeAt(nx, ny);
    return { ok: true, note: note + (biome === "town" ? "🏙️ Back in town — safe." : "…nothing here.") };
  }

  if (entity.entity_type === "chest") {
    const reward = Number(entity.entity_data.reward ?? 0);
    const granted = await payoutFromPool(discordId, reward);
    await clearEntityAt(nx, ny);
    return {
      ok: true,
      note:
        note +
        (granted > 0
          ? `🟫 Chest! You found **${formatSats(granted)}**.`
          : "🟫 Chest — but the prize pool is empty. Better luck next time."),
    };
  }

  // Monster: lock into combat (only if still idle) and spin up a session.
  if (!(await setStateIf(discordId, "idle", "combat"))) {
    return { ok: true, note: note + "Something interrupted you." };
  }
  const m = entity.entity_data as { name: string; max_hp: number; attack: number; reward: number };
  await createCombat({
    discord_id: discordId,
    monster_name: m.name,
    monster_max_hp: m.max_hp,
    monster_current_hp: m.max_hp,
    monster_attack: m.attack,
    reward_sats: m.reward,
    enemy_x: nx,
    enemy_y: ny,
    turn_number: 1,
    created_at: new Date().toISOString(),
  });
  return { ok: true, note: note + `👹 A **${m.name}** blocks your path!` };
}

/** One combat round: player hits, then (if it survives) the monster hits back. */
export async function attack(discordId: string): Promise<ActionResult> {
  const combat = await getCombat(discordId);
  if (!combat) return { ok: false, note: "No active fight." };

  const dmg = rollPlayerDamage();
  const monsterHp = combat.monster_current_hp - dmg;

  if (monsterHp <= 0) {
    const granted = await payoutFromPool(discordId, combat.reward_sats);
    await clearEntityAt(combat.enemy_x, combat.enemy_y);
    await deleteCombat(discordId);
    await updatePlayer(discordId, { state: "idle" });
    return {
      ok: true,
      note:
        `⚔️ You hit for ${dmg} and slew the **${combat.monster_name}**! ` +
        (granted > 0 ? `Looted **${formatSats(granted)}**.` : "(Prize pool was empty — no loot.)"),
    };
  }

  // Monster survives and strikes back — damage drains sats into the pool.
  const taken = await takeDamage(discordId, combat.monster_attack);
  if ((await getBalance(discordId)) <= 0) {
    return { ok: true, note: `⚔️ You hit for ${dmg}. The ${combat.monster_name} struck back… ` + (await faint(discordId)).note };
  }
  await updateCombat(discordId, {
    monster_current_hp: monsterHp,
    turn_number: combat.turn_number + 1,
  });
  return {
    ok: true,
    note: `⚔️ You hit for ${dmg}; the **${combat.monster_name}** hit back for ${taken} sats.`,
  };
}

/** Flee combat for a small toll. */
export async function flee(discordId: string): Promise<ActionResult> {
  const combat = await getCombat(discordId);
  if (!combat) return { ok: false, note: "No active fight." };
  const paid = await takeDamage(discordId, FLEE_COST);
  await deleteCombat(discordId);
  await updatePlayer(discordId, { state: "idle" });
  return { ok: true, note: `🏃 You fled the ${combat.monster_name}${paid > 0 ? ` (−${paid} sat)` : ""}.` };
}

/** Eat bread: costs sats (→ pool), restores hunger only (HP is never minted). */
export async function eat(discordId: string): Promise<ActionResult> {
  const player = await getPlayer(discordId);
  if (!player) return { ok: false, note: "No run in progress." };
  if (player.hunger >= 100) return { ok: false, note: "You're already full." };
  const paid = await takeDamage(discordId, BREAD_COST);
  if (paid <= 0) return { ok: false, note: "You can't afford even a crust of bread." };
  await updatePlayer(discordId, { hunger: Math.min(100, player.hunger + BREAD_HUNGER) });
  return { ok: true, note: `🍞 Ate bread (−${paid} sat). +${BREAD_HUNGER} hunger.` };
}

/** Faint: fixed penalty (clamped to balance, → pool), warp to town, restore hunger. */
export async function faint(discordId: string): Promise<ActionResult> {
  const lost = await takeDamage(discordId, SAT.DEATH_PENALTY_SATS);
  await deleteCombat(discordId);
  await updatePlayer(discordId, { x_coord: 0, y_coord: 0, hunger: 100, state: "idle" });
  return {
    ok: true,
    note: `☠️ You fainted! Lost ${lost} sats and woke up back in town.`,
  };
}

/** Charge the buy-in (all-or-nothing) and seed the pool. Returns false if the player can't pay. */
export async function chargeBuyIn(discordId: string): Promise<boolean> {
  const paid = await subtractBalance(discordId, SAT.BUYIN_SATS);
  if (!paid) return false;
  await addToPool(SAT.BUYIN_SATS);
  return true;
}
