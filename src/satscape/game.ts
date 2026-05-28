import { getBalance, subtractBalance } from "../balance.js";
import { formatSats } from "../format.js";
import { addToPool, payoutFromPool, takeDamage } from "./economy.js";
import { SAT, entityAt } from "./engine.js";
import {
  addInventoryItem,
  clearTile,
  createCombat,
  deleteCombat,
  getCombat,
  getOwnedItemIds,
  getPlayer,
  isTileCleared,
  ownsItem,
  revealAround,
  setEquipped,
  setStateIf,
  updateCombat,
  updatePlayer,
} from "./db.js";
import { battleMovePoints, battleMoveRange, legalBattleMoves, monsterIntent, moveByButton, playerAttackTiles, samePoint, selectedWeaponId, startingBattlePositions, weaponFor, type BattleMove } from "./battle.js";
import { bootBonus, effectivePrice, ITEM_BY_ID, nearestTown, townAt } from "./towns.js";
import { getRep, onArriveTown, onCombatWin } from "./quests.js";
import { keeperLine } from "./lines.js";
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

function arenaLabel(x: number, y: number): string {
  return `${String.fromCharCode(65 + x)}${y + 1}`;
}

/** The most tiles a single directional press can cover, given equipped boots. */
export function maxStepsFor(player: SatPlayerRow): number {
  return Math.min(SAT.MAX_STEPS_CAP, SAT.MAX_STEPS_BASE + bootBonus(player));
}

/** Persist a player's steps-per-press setting, clamped to their current allowance. */
export async function setStepsPerMove(discordId: string, n: number): Promise<{ ok: boolean; note: string; value?: number }> {
  const player = await getPlayer(discordId);
  if (!player) return { ok: false, note: "Use `/satscape join` first." };
  const max = maxStepsFor(player);
  const clamped = Math.max(1, Math.min(max, Math.trunc(n)));
  await updatePlayer(discordId, { steps_per_move: clamped });
  return { ok: true, note: `⚙️ Steps-per-press set to **${clamped}** (max ${max}).`, value: clamped };
}

/**
 * Walk in a single direction for `steps_per_move` tiles, stopping early on
 * combat, faint, or any failed step. Notes from each step are gathered and
 * shown together so chests/towns/exhaustion along the way aren't lost.
 */
export async function moveMany(discordId: string, dir: Direction): Promise<ActionResult> {
  const player = await getPlayer(discordId);
  if (!player) return { ok: false, note: "Use `/satscape join` first." };
  const n = Math.max(1, Math.min(maxStepsFor(player), player.steps_per_move ?? 1));
  if (n === 1) return move(discordId, dir);

  const events: string[] = [];
  let entered = false;
  let actual = 0;
  for (let i = 0; i < n; i++) {
    const res = await move(discordId, dir);
    if (!res.ok) {
      if (res.note) events.push(res.note);
      break;
    }
    actual++;
    if (res.note && res.note !== "…nothing here.") events.push(res.note);
    if (res.enteredCombat) { entered = true; break; }
    if (res.note.includes("fainted")) break;
  }
  const header = `🏃 ×${actual}`;
  const note = events.length ? `${header}\n${events.join("\n")}` : header;
  return { ok: true, note, enteredCombat: entered };
}

/** Move one tile, applying stamina/starvation, then resolve whatever is there. */
export async function move(discordId: string, dir: Direction): Promise<ActionResult> {
  const player = await getPlayer(discordId);
  if (!player || !player.active) return { ok: false, note: "Use `/satscape join` to start a run first." };
  if (player.state === "combat") return { ok: false, note: "You're in combat — pick a battle move or flee." };

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
  await revealAround(discordId, nx, ny);

  if ((await getBalance(discordId)) <= 0) {
    return { ok: true, note: note + (await faint(discordId)).note };
  }

  const resolved = await resolveTile(discordId, nx, ny);
  return { ...resolved, note: note + resolved.note };
}

/** Resolve whatever sits on a tile the player just arrived on (chest/monster/empty). */
export async function resolveTile(discordId: string, x: number, y: number): Promise<ActionResult> {
  const town = townAt(x, y);
  if (town) {
    await onArriveTown(discordId, town); // completes delivery / discover quests
    return { ok: true, note: `🏙️ ${town.name} — safe.` };
  }
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
  const m = entity.data as { name: string; level: number; reward: number };
  const fighter = await getPlayer(discordId);
  const positions = startingBattlePositions(x, y);
  const monsterHp = 18 + m.level * 8;
  await createCombat({
    discord_id: discordId,
    monster_name: m.name,
    monster_level: m.level,
    monster_max_hp: monsterHp,
    monster_current_hp: monsterHp,
    monster_attack: 3 + m.level * 2,
    reward_sats: m.reward,
    enemy_x: x,
    enemy_y: y,
    player_battle_x: positions.player.x,
    player_battle_y: positions.player.y,
    monster_battle_x: positions.monster.x,
    monster_battle_y: positions.monster.y,
    battle_move_points: fighter ? battleMoveRange(fighter) : 1,
    selected_battle_weapon: null,
    turn_number: 1,
    created_at: new Date().toISOString(),
  });
  return { ok: true, note: `👹 A level ${m.level} **${m.name}** blocks your path!`, enteredCombat: true };
}

/** Preview movement inside combat. Arrows spend movement; Attack resolves the turn. */
export async function battleMove(discordId: string, move: BattleMove): Promise<ActionResult> {
  const [combat, player] = await Promise.all([getCombat(discordId), getPlayer(discordId)]);
  if (!combat || !player) return { ok: false, note: "No active fight." };
  const points = battleMovePoints(combat, player);
  if (points <= 0) return { ok: false, note: "No movement left this turn. Attack or flee." };

  const destination = moveByButton(combat, move, player);
  const monster = { x: combat.monster_battle_x, y: combat.monster_battle_y };
  if (samePoint(destination, monster)) return { ok: false, note: "The monster blocks that tile." };
  if (samePoint(destination, { x: combat.player_battle_x, y: combat.player_battle_y })) {
    return { ok: false, note: "You are already at the edge of the arena." };
  }

  await updateCombat(discordId, {
    player_battle_x: destination.x,
    player_battle_y: destination.y,
    battle_move_points: points - 1,
  });
  return { ok: true, note: `Moved to **${arenaLabel(destination.x, destination.y)}**. ${points - 1} move left.` };
}

/** Resolve the monster telegraph and the currently selected weapon. */
export async function battleAttack(discordId: string): Promise<ActionResult> {
  const [combat, player] = await Promise.all([getCombat(discordId), getPlayer(discordId)]);
  if (!combat || !player) return { ok: false, note: "No active fight." };

  const destination = { x: combat.player_battle_x, y: combat.player_battle_y };
  const intent = monsterIntent(combat, player);
  const weapon = weaponFor(player, selectedWeaponId(combat, player));
  const monsterPos = intent.to;
  const bodyChecked = samePoint(destination, monsterPos);
  const wasHit = bodyChecked || intent.attackTiles.some((p) => samePoint(p, destination));
  const hitTiles = playerAttackTiles(destination, monsterPos, weapon);
  const hitMonster = hitTiles.some((p) => samePoint(p, monsterPos)) || bodyChecked;

  let note = `Moved to **${arenaLabel(destination.x, destination.y)}**.`;
  if (wasHit) {
    const lost = await takeDamage(discordId, intent.damage);
    note += ` 🩸 ${combat.monster_name}'s ${intent.name} hit you for ${lost} sats.`;
    if ((await getBalance(discordId)) <= 0) {
      return { ok: true, note: `${note} ` + (await faint(discordId)).note };
    }
  } else {
    note += ` ✨ Dodged ${combat.monster_name}'s ${intent.name}.`;
  }

  const nextHp = hitMonster ? Math.max(0, combat.monster_current_hp - weapon.damage) : combat.monster_current_hp;
  if (hitMonster) {
    note += ` ${weapon.emoji} ${weapon.name} landed for **${weapon.damage}**.`;
  } else {
    note += ` ${weapon.emoji} ${weapon.name} missed.`;
  }

  if (nextHp <= 0) {
    const granted = await payoutFromPool(discordId, combat.reward_sats);
    await clearTile(combat.enemy_x, combat.enemy_y);
    await deleteCombat(discordId);
    await updatePlayer(discordId, { state: "idle" });
    await onCombatWin(discordId, combat.monster_level); // advance bounty quests
    return {
      ok: true,
      note: `${note}\n🏆 You defeated the **${combat.monster_name}**! ` +
        (granted > 0 ? `Looted **${formatSats(granted)}**.` : "(Prize pool was empty — no loot.)"),
    };
  }

  await updateCombat(discordId, {
    player_battle_x: destination.x,
    player_battle_y: destination.y,
    monster_battle_x: monsterPos.x,
    monster_battle_y: monsterPos.y,
    monster_current_hp: nextHp,
    battle_move_points: battleMoveRange(player),
    turn_number: combat.turn_number + 1,
  });
  return { ok: true, note };
}

export async function selectBattleWeapon(discordId: string, itemId: string): Promise<ActionResult> {
  const [combat, player, owned] = await Promise.all([getCombat(discordId), getPlayer(discordId), getOwnedItemIds(discordId)]);
  if (!combat || !player) return { ok: false, note: "No active fight." };
  if (!owned.includes(itemId)) return { ok: false, note: "You don't own that weapon." };
  const item = ITEM_BY_ID.get(itemId);
  if (!item || item.slot !== "weapon") return { ok: false, note: "That is not a weapon." };
  await updateCombat(discordId, { selected_battle_weapon: itemId });
  return { ok: true, note: `Readied ${item.emoji} **${item.name}**.` };
}

/** Back-compat for older callers: attack from the current preview position. */
export async function battleTurn(discordId: string, _destX: number, _destY: number): Promise<ActionResult> {
  return battleAttack(discordId);
}

/** Back-compat for older smoke helpers: take the first legal tactical move. */
export async function fight(discordId: string): Promise<ActionResult> {
  const [combat, player] = await Promise.all([getCombat(discordId), getPlayer(discordId)]);
  if (!combat || !player) return { ok: false, note: "No active fight." };
  const choice = legalBattleMoves(combat, player)[0] ?? { x: combat.player_battle_x, y: combat.player_battle_y };
  return battleTurn(discordId, choice.x, choice.y);
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

/** Faint: fixed penalty (clamped to balance, → pool), warp to the nearest town, restore stamina. */
export async function faint(discordId: string): Promise<ActionResult> {
  const lost = await takeDamage(discordId, SAT.DEATH_PENALTY_SATS);
  await deleteCombat(discordId);
  const player = await getPlayer(discordId);
  const { town } = nearestTown(player?.x_coord ?? 0, player?.y_coord ?? 0);
  await updatePlayer(discordId, { x_coord: town.cx, y_coord: town.cy, hunger: 100, state: "idle" });
  await revealAround(discordId, town.cx, town.cy);
  return { ok: true, note: `☠️ You fainted! Lost ${lost} sats and woke up in **${town.name}**.` };
}

export async function chargeBuyIn(discordId: string): Promise<boolean> {
  const paid = await subtractBalance(discordId, SAT.BUYIN_SATS);
  if (!paid) return false;
  await addToPool(SAT.BUYIN_SATS);
  return true;
}

/* ─────────── shop ─────────── */

/** Buy an item from the current town's catalogue. Price (keeper-adjusted) flows to the pool. */
export async function buyItem(discordId: string, itemId: string): Promise<ActionResult> {
  const player = await getPlayer(discordId);
  if (!player) return { ok: false, note: "Use `/satscape join` first." };
  const town = townAt(player.x_coord, player.y_coord);
  if (!town) return { ok: false, note: "The shop is only open in town." };
  const item = town.catalog.find((i) => i.id === itemId);
  if (!item) return { ok: false, note: `${town.keeper.name} doesn't stock that here.` };
  if (await ownsItem(discordId, itemId)) return { ok: false, note: `You already own a ${item.name}. *"${keeperLine(town.keeper.persona, "owned")}"*` };
  const rep = await getRep(discordId, town.id);
  if (item.repReq && rep < item.repReq) {
    return { ok: false, note: `🔒 ${item.name} is locked — reach ${item.repReq} rep with ${town.keeper.name} first.` };
  }
  const price = effectivePrice(item, town.keeper, rep);
  const paid = await subtractBalance(discordId, price);
  if (!paid) return { ok: false, note: `Not enough sats for ${item.name} (${formatSats(price)}). *"${keeperLine(town.keeper.persona, "poor")}"*` };
  await addToPool(price);
  await addInventoryItem(discordId, itemId);
  return { ok: true, note: `🛒 Bought ${item.emoji} **${item.name}** for ${formatSats(price)}. *"${keeperLine(town.keeper.persona, "buy")}"*` };
}

/** Equip an owned item into its slot (allowed anywhere — gear up before heading out). */
export async function equipItem(discordId: string, itemId: string): Promise<ActionResult> {
  const player = await getPlayer(discordId);
  if (!player) return { ok: false, note: "No run in progress." };
  if (!(await ownsItem(discordId, itemId))) return { ok: false, note: "You don't own that item." };
  const item = ITEM_BY_ID.get(itemId);
  if (!item) return { ok: false, note: "Unknown item." };
  await setEquipped(discordId, item.slot, itemId);
  return { ok: true, note: `✅ Equipped ${item.emoji} **${item.name}** (${item.slot}).` };
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

/** Sats actually charged for a trip, after any road/portal discount. */
export function travelCost(est: TravelEstimate, discountMul = 1): number {
  return Math.ceil(est.satCost * discountMul);
}

/**
 * Execute a confirmed fast-travel: deduct the (discounted) bread cost to the pool,
 * teleport to the destination, set the resulting stamina, and resolve the tile.
 * Encounters along the way are abstracted away — only the destination is resolved.
 * `discountMul` < 1 models a road/portal between towns (provisions are subsidised).
 */
export async function travelTo(
  discordId: string,
  tx: number,
  ty: number,
  opts: { discountMul?: number } = {},
): Promise<ActionResult> {
  const player = await getPlayer(discordId);
  if (!player || !player.active) return { ok: false, note: "Use `/satscape join` first." };
  if (player.state === "combat") return { ok: false, note: "Can't travel mid-combat." };

  const est = estimateTravel(player, tx, ty);
  if (est.steps === 0) return { ok: false, note: "You're already there." };

  const cost = travelCost(est, opts.discountMul ?? 1);
  const viaPortal = (opts.discountMul ?? 1) < 1;
  let paidNote = "";
  if (cost > 0) {
    const paid = await takeDamage(discordId, cost);
    if (paid < cost) {
      paidNote = `Provisions ran short (−${paid} sat). `;
    } else {
      paidNote = viaPortal ? `Road toll (−${cost} sat, ½ price). ` : `Bought ${est.breadNeeded} bread (−${cost} sat). `;
    }
  }

  const endStamina = Math.max(0, Math.min(100, player.hunger - est.steps + est.breadNeeded * SAT.BREAD_STAMINA));
  await updatePlayer(discordId, { x_coord: tx, y_coord: ty, hunger: endStamina, last_move_at: new Date().toISOString() });
  await revealAround(discordId, tx, ty);

  if ((await getBalance(discordId)) <= 0) {
    return { ok: true, note: paidNote + (await faint(discordId)).note };
  }
  const arrival = await resolveTile(discordId, tx, ty);
  return { ...arrival, note: `🧭 Travelled ${est.steps} tiles to (${tx}, ${ty}). ${paidNote}${arrival.note}` };
}
