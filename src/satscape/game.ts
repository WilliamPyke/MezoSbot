import { getBalance, subtractBalance } from "../balance.js";
import { formatSats } from "../format.js";
import { addToPool, payoutFromPool, takeDamage } from "./economy.js";
import { SAT, entityAt } from "./engine.js";
import {
  addInventoryItem,
  clearTile,
  createCombat,
  deleteCombat,
  effectiveHp,
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
import {
  battleMoveRange,
  MAX_PLAN,
  parsePlan,
  planAP,
  planGlyph,
  projectedPlayerPos,
  samePoint,
  selectedWeaponId,
  serializeMonsters,
  serializePlan,
  simulateBattle,
  startingBattlePositions,
  startingMonsterPositions,
  weaponPower,
  type BattleMove,
  type PlanAction,
  type ResolutionStep,
} from "./battle.js";
import {
  cardById,
  effectivePlayerAP,
  parseStatuses,
  playerCardIds,
  serializeStatuses,
} from "./cards.js";
import { bootBonus, effectivePrice, fastTravelRadius, ITEM_BY_ID, nearestTown, townAt } from "./towns.js";
import { getRep, onArriveTown, onCombatWin } from "./quests.js";
import { keeperLine } from "./lines.js";
import type { BattleMonster, CombatSessionRow, Direction, SatPlayerRow } from "./types.js";
import { BIOME, blockReasonAt, tileAt } from "./world.js";

const BREAD_COST = 1; // sats → pool
const FLEE_COST = 1; // sats → pool

/** Step-by-step resolution data so the web client can animate the round playing out. */
export interface BattlePlayback {
  steps: ResolutionStep[];
  dealt: number;
  taken: number;
  /** True when every monster died this round (fight ends). */
  monsterDead: boolean;
  /** True when the player fainted resolving this round. */
  fainted: boolean;
}

export interface ActionResult {
  ok: boolean;
  note: string;
  /** True when this action put the player into combat (used to stop auto-explore). */
  enteredCombat?: boolean;
  /** Present on a resolved battle round — drives the sequential board playback. */
  playback?: BattlePlayback;
}

/**
 * Take a hit: burn `dmg` sats balance→pool (closed-loop, unchanged) AND lower the
 * player's at-risk HP by the same amount. This is the single "got hurt" path.
 * Faint when the returned `hp` reaches 0 (the burned sats ARE the cost of fainting).
 */
export async function loseHp(discordId: string, dmg: number): Promise<{ burned: number; hp: number }> {
  const burned = await takeDamage(discordId, dmg);
  const [player, balance] = await Promise.all([getPlayer(discordId), getBalance(discordId)]);
  if (!player) return { burned, hp: 0 };
  if (burned <= 0) return { burned: 0, hp: effectiveHp(player, balance) };
  // `balance` is already post-damage; reconstruct the pre-damage HP, then subtract.
  const prevHp = effectiveHp(player, balance + burned);
  const cap = Math.min(balance, player.max_hp ?? SAT.HP_MAX_DEFAULT);
  const hp = Math.max(0, Math.min(prevHp - burned, cap));
  await updatePlayer(discordId, { hp });
  return { burned, hp };
}

/**
 * Refill HP by re-exposing the player's own *banked* sats (balance unchanged — no pool
 * transfer). Caller picks `n`; it's clamped to `min(max_hp − hp, balance − hp)`.
 */
export async function refillHp(discordId: string, n: number): Promise<{ ok: boolean; added: number; hp: number; maxHp: number; note: string }> {
  const [player, balance] = await Promise.all([getPlayer(discordId), getBalance(discordId)]);
  if (!player || !player.active) return { ok: false, added: 0, hp: 0, maxHp: SAT.HP_MAX_DEFAULT, note: "Use `/satscape join` first." };
  const maxHp = player.max_hp ?? SAT.HP_MAX_DEFAULT;
  const cur = effectiveHp(player, balance);
  const headroom = Math.max(0, Math.min(maxHp - cur, balance - cur)); // banked sats available to commit
  const add = Math.max(0, Math.min(Math.floor(n), headroom));
  if (add <= 0) {
    const why = cur >= maxHp ? "HP is already full." : "No banked sats to commit.";
    return { ok: false, added: 0, hp: cur, maxHp, note: why };
  }
  const hp = cur + add;
  await updatePlayer(discordId, { hp });
  return { ok: true, added: add, hp, maxHp, note: `🩹 Committed ${formatSats(add)} to HP (${formatSats(hp)}/${formatSats(maxHp)}).` };
}

const DELTA: Record<Direction, [number, number]> = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};

function blockedMoveNote(x: number, y: number, ownsBoat: boolean): string | null {
  const reason = blockReasonAt(x, y, { ownsBoat });
  if (!reason) return null;
  if (reason === "sea") return "🌊 The sea blocks your path.";
  const tile = tileAt(x, y);
  if (tile === BIOME.HOUSE || tile === BIOME.CASTLE) return "🧱 A wall blocks your path.";
  return "⛰️ The way is blocked.";
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
  if (actual === 0 && events.length) return { ok: false, note: events.join("\n"), enteredCombat: entered };
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
  const ownsBoatNow = await ownsItem(discordId, "boat");
  const blocked = blockedMoveNote(nx, ny, ownsBoatNow);
  if (blocked) return { ok: false, note: blocked };

  // Stamina first; once it's gone each step burns 1 sat of HP into the pool.
  let note = "";
  let hunger = player.hunger;
  let hpAfter: number | null = null;
  if (hunger > 0) {
    hunger -= 1;
  } else {
    const { burned, hp } = await loseHp(discordId, 1);
    hpAfter = hp;
    if (burned > 0) note = "💀 Exhausted! Lost 1 sat of HP. ";
  }

  await updatePlayer(discordId, {
    x_coord: nx,
    y_coord: ny,
    hunger,
    last_move_at: new Date().toISOString(),
  });
  await revealAround(discordId, nx, ny);

  if (hpAfter !== null && hpAfter <= 0) {
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

  // Spawn a small pack (1–3) for a chess-like board, with VARIED species drawn from
  // the local town's roster — different species attack differently (cone/dash+bleed,
  // slam/line+stun, line/cone+poison…), so a pack mixes attack styles. Per-monster HP
  // and loot scale down so a pack is tougher but not punishing.
  const count = monsterCountFor(m.level, x, y);
  const pool = nearestTown(x, y).town.monsters;
  const names = packSpecies(m.name, pool, count, x, y);
  const perHp = count > 1 ? Math.max(8, Math.round((18 + m.level * 8) * 0.65)) : 18 + m.level * 8;
  const perReward = Math.max(1, Math.round(m.reward / count));
  const starts = startingMonsterPositions(x, y, count);
  const monsters: BattleMonster[] = starts.map((pos, i) => ({
    id: `m${i}`,
    name: names[i],
    level: m.level,
    maxHp: perHp,
    hp: perHp,
    x: pos.x,
    y: pos.y,
    attack: 3 + m.level * 2,
    reward: perReward,
    status: [],
  }));
  const primary = monsters[0];

  // Only persist the `monsters` JSON for actual packs. Single-monster fights stay on
  // the legacy singular columns, so combat keeps working even before the multi-monster
  // migration is applied (readMonsters falls back to those columns).
  await createCombat({
    discord_id: discordId,
    monster_name: primary.name,
    monster_level: primary.level,
    monster_max_hp: primary.maxHp,
    monster_current_hp: primary.hp,
    monster_attack: primary.attack,
    reward_sats: m.reward,
    enemy_x: x,
    enemy_y: y,
    player_battle_x: positions.player.x,
    player_battle_y: positions.player.y,
    monster_battle_x: primary.x,
    monster_battle_y: primary.y,
    battle_move_points: fighter ? battleMoveRange(fighter) : 5,
    battle_plan: null,
    ...(count > 1 ? { monsters: serializeMonsters(monsters) } : {}),
    selected_battle_weapon: null,
    player_status: "[]",
    monster_status: "[]",
    turn_number: 1,
    created_at: new Date().toISOString(),
  } as CombatSessionRow);
  const note = count > 1
    ? `👹 An ambush! **${count} foes** block your path — ${names.join(", ")}!`
    : `👹 A level ${m.level} **${m.name}** blocks your path!`;
  return { ok: true, note, enteredCombat: true };
}

/** Deterministic pack size (1–3): ~half of encounters are packs, scaling up with level. */
function monsterCountFor(level: number, x: number, y: number): number {
  const h = Math.abs(((x * 73856093) ^ (y * 19349663)) >>> 0);
  let count = 1;
  if (h % 2 === 0) count++; // ~50% spawn at least a pair, even near spawn
  if ((level >= 2 && h % 3 === 0) || h % 7 === 0) count++; // a subset gets a third
  return Math.min(3, count);
}

/**
 * Distinct species for a pack: the encountered monster first, then other species
 * from the same town's roster (so a pack mixes attack styles). Deterministic.
 */
function packSpecies(primaryName: string, pool: readonly string[], count: number, x: number, y: number): string[] {
  const names = [primaryName];
  const h = Math.abs(((x * 2654435761) ^ (y * 40503)) >>> 0);
  for (let i = 1; i < count; i++) {
    const start = (h >> (i * 3)) % Math.max(1, pool.length);
    let pick = pool[start] ?? primaryName;
    // prefer a species not already in the pack, for visible variety
    for (let t = 0; t < pool.length && names.indexOf(pick) !== -1; t++) {
      pick = pool[(start + t + 1) % pool.length];
    }
    names.push(pick);
  }
  return names;
}

/**
 * Append one action to the combat plan. Bounded by both the tick cap (MAX_PLAN)
 * and the player's action-point budget — move = 1 AP, wait = 0, card = its cost.
 */
async function queueAction(discordId: string, action: PlanAction): Promise<ActionResult> {
  const [combat, player] = await Promise.all([getCombat(discordId), getPlayer(discordId)]);
  if (!combat || !player) return { ok: false, note: "No active fight." };
  const plan = parsePlan(combat.battle_plan);
  if (plan.length >= MAX_PLAN) return { ok: false, note: `That's all ${MAX_PLAN} actions. Resolve or Undo.` };

  const budget = effectivePlayerAP(player, parseStatuses(combat.player_status));
  const next = [...plan, action];
  if (planAP(next) > budget) {
    return { ok: false, note: `Not enough AP (${planAP(plan)}/${budget} used). Resolve, Undo, or queue a cheaper action.` };
  }

  if (action.kind === "move") {
    const before = projectedPlayerPos(combat, plan);
    const after = projectedPlayerPos(combat, next);
    if (samePoint(before, after)) {
      return { ok: false, note: "That step is blocked (arena edge or the monster's tile)." };
    }
  }

  await updateCombat(discordId, { battle_plan: serializePlan(next) });
  return { ok: true, note: `Queued ${planGlyph(action)} (${planAP(next)}/${budget} AP).` };
}

/** Queue a directional step into the plan (costs 1 AP). */
export async function battleMove(discordId: string, move: BattleMove): Promise<ActionResult> {
  if (move === "stay") return queueAction(discordId, { kind: "wait" });
  return queueAction(discordId, { kind: "move", dir: move });
}

/** Queue an ability card the player owns in their kit. */
export async function queueCard(discordId: string, cardId: string): Promise<ActionResult> {
  const player = await getPlayer(discordId);
  if (!player) return { ok: false, note: "No active fight." };
  const card = cardById(cardId);
  if (!card) return { ok: false, note: "Unknown ability." };
  if (!playerCardIds(player).includes(cardId)) return { ok: false, note: `${card.name} isn't in your kit — equip the gear that grants it.` };
  return queueAction(discordId, { kind: "card", cardId });
}

/** Queue a wait (hold position one tick) into the plan. */
export async function queueWait(discordId: string): Promise<ActionResult> {
  return queueAction(discordId, { kind: "wait" });
}

/** Remove the last queued action. */
export async function undoPlanAction(discordId: string): Promise<ActionResult> {
  const combat = await getCombat(discordId);
  if (!combat) return { ok: false, note: "No active fight." };
  const plan = parsePlan(combat.battle_plan);
  if (plan.length === 0) return { ok: false, note: "Nothing queued to undo." };
  const popped = plan.pop()!;
  await updateCombat(discordId, { battle_plan: serializePlan(plan) });
  return { ok: true, note: `Removed ${planGlyph(popped)} (${plan.length}/${MAX_PLAN}).` };
}

/**
 * Resolve the queued plan against the monster's 3 telegraphed strikes,
 * interleaved tick-by-tick (see simulateBattle). Persists the outcome + statuses,
 * clears the plan, and advances the turn — or ends the fight on a kill / faint.
 * The plan may be partial (any unqueued ticks resolve as idle), so the player can
 * end the turn after spending their AP.
 */
export async function resolvePlan(discordId: string): Promise<ActionResult> {
  const [combat, player] = await Promise.all([getCombat(discordId), getPlayer(discordId)]);
  if (!combat || !player) return { ok: false, note: "No active fight." };

  const power = weaponPower(player, selectedWeaponId(combat, player));
  const plan = parsePlan(combat.battle_plan);
  const res = simulateBattle(combat, { power }, plan);

  const note = res.steps.map((s) => s.line).join("\n");
  const playback: BattlePlayback = {
    steps: res.steps,
    dealt: res.totalDealt,
    taken: res.totalTaken,
    monsterDead: res.monsterDead,
    fainted: false,
  };

  // Apply damage the player took: burn sats → pool AND lower HP. Faint at 0 HP.
  if (res.totalTaken > 0) {
    const { hp } = await loseHp(discordId, res.totalTaken);
    if (hp <= 0) {
      return { ok: true, note: `${note}\n` + (await faint(discordId)).note, playback: { ...playback, fainted: true } };
    }
  }

  if (res.monsterDead) {
    const totalReward = res.monsters.reduce((sum, mm) => sum + (mm.reward || 0), 0) || combat.reward_sats;
    const granted = await payoutFromPool(discordId, totalReward);
    await clearTile(combat.enemy_x, combat.enemy_y);
    await deleteCombat(discordId);
    await updatePlayer(discordId, { state: "idle" });
    for (const mm of res.monsters) await onCombatWin(discordId, mm.level); // advance bounty quests per kill
    const slain = res.monsters.length > 1 ? `all ${res.monsters.length} foes` : `the **${combat.monster_name}**`;
    return {
      ok: true,
      note: `${note}\n🏆 You defeated ${slain}! ` +
        (granted > 0 ? `Looted **${formatSats(granted)}**.` : "(Prize pool was empty — no loot.)"),
      playback,
    };
  }

  const primary = res.monsters[0];
  const patch: Partial<CombatSessionRow> = {
    player_battle_x: res.playerEnd.x,
    player_battle_y: res.playerEnd.y,
    monster_battle_x: primary ? primary.x : res.monsterEnd.x,
    monster_battle_y: primary ? primary.y : res.monsterEnd.y,
    monster_current_hp: primary ? primary.hp : res.monsterHp,
    battle_plan: null,
    player_status: serializeStatuses(res.playerStatusEnd),
    monster_status: serializeStatuses(res.monsterStatusEnd),
    turn_number: combat.turn_number + 1,
  };
  // Persist the full roster only for packs (keeps single-monster fights migration-free).
  if (res.monsters.length > 1) patch.monsters = serializeMonsters(res.monsters);
  await updateCombat(discordId, patch);
  return { ok: true, note: `${note}\n🗡️ Dealt ${res.totalDealt}, took ${res.totalTaken}. Plan your next move.`, playback };
}

/** Back-compat alias — older callers used "battleAttack". */
export async function battleAttack(discordId: string): Promise<ActionResult> {
  return resolvePlan(discordId);
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

/** Back-compat for older callers: resolve the current plan. */
export async function battleTurn(discordId: string, _destX?: number, _destY?: number): Promise<ActionResult> {
  return resolvePlan(discordId);
}

/** Back-compat helper (smoke): queue the baseline Strike, then resolve the round. */
export async function fight(discordId: string): Promise<ActionResult> {
  const combat = await getCombat(discordId);
  if (!combat) return { ok: false, note: "No active fight." };
  await queueCard(discordId, "strike");
  return resolvePlan(discordId);
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

/**
 * Faint at 0 HP: the sats already burned to the pool ARE the cost (no extra flat penalty,
 * so banked sats above the HP line stay safe). Warp to the nearest town, restore stamina,
 * and re-arm HP from whatever balance survived (up to the cap) so the run can continue.
 */
export async function faint(discordId: string): Promise<ActionResult> {
  await deleteCombat(discordId);
  const [player, balance] = await Promise.all([getPlayer(discordId), getBalance(discordId)]);
  const { town } = nearestTown(player?.x_coord ?? 0, player?.y_coord ?? 0);
  const maxHp = player?.max_hp ?? SAT.HP_MAX_DEFAULT;
  const rearmed = Math.min(balance, maxHp);
  await updatePlayer(discordId, { x_coord: town.cx, y_coord: town.cy, hunger: 100, state: "idle", hp: rearmed });
  await revealAround(discordId, town.cx, town.cy);
  const banked = balance - rearmed;
  return {
    ok: true,
    note: `☠️ You fainted and woke up in **${town.name}**. HP re-armed to ${formatSats(rearmed)}` +
      (banked > 0 ? ` (${formatSats(banked)} banked sats kept safe).` : "."),
  };
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

  // Fast-travel is bounded by the player's movement radius (base 5×5, widened by
  // boots). Long road hops between towns come through a separate discounted path.
  const radius = fastTravelRadius(player);
  const reach = Math.max(Math.abs(tx - player.x_coord), Math.abs(ty - player.y_coord)); // Chebyshev
  const viaRoad = (opts.discountMul ?? 1) < 1;
  if (!viaRoad && reach > radius) {
    return { ok: false, note: `🧭 Out of fast-travel range — you can hop within ${radius * 2 + 1}×${radius * 2 + 1} tiles (boots widen it).` };
  }

  const ownsBoatNow = await ownsItem(discordId, "boat");
  const blocked = blockedMoveNote(tx, ty, ownsBoatNow);
  if (blocked) return { ok: false, note: `Can't travel there. ${blocked}` };

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

  const [balAfter, plAfter] = await Promise.all([getBalance(discordId), getPlayer(discordId)]);
  if (plAfter && effectiveHp(plAfter, balAfter) <= 0) {
    return { ok: true, note: paidNote + (await faint(discordId)).note };
  }
  const arrival = await resolveTile(discordId, tx, ty);
  return { ...arrival, note: `🧭 Travelled ${est.steps} tiles to (${tx}, ${ty}). ${paidNote}${arrival.note}` };
}
