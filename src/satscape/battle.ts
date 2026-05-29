import type { ShopItem } from "./items.js";
import type { CombatSessionRow, Direction, SatPlayerRow } from "./types.js";
import { bootBonus, ITEM_BY_ID } from "./towns.js";
import {
  addStatus,
  cardById,
  CARD_BY_ID,
  decayStatuses,
  dotDamage,
  hasStatus,
  monsterAbility,
  parseStatuses,
  totalOf,
  type CardDef,
  type StatusEffect,
} from "./cards.js";

export const ARENA_SIZE = 8;

export type BattleMove = Direction | "stay";
export type WeaponPattern = "dagger" | "longsword" | "hammer" | "spear" | "arc" | "star";
export type MonsterPattern = "line" | "cone" | "slam" | "dash";

export interface Point {
  x: number;
  y: number;
}

export interface WeaponProfile {
  name: string;
  emoji: string;
  pattern: WeaponPattern;
  damage: number;
  power: number;
  summary: string;
}

/** What the monster does on a telegraphed tick. Only ONE per round is "attack". */
export type MonsterAct = "attack" | "advance" | "rest";

export interface MonsterIntent {
  /** 1-based position in the telegraphed sequence (①②③). */
  order: number;
  act: MonsterAct;
  pattern: MonsterPattern;
  name: string;
  description: string;
  from: Point;
  to: Point;
  attackTiles: Point[];
  damage: number;
  /** Statuses inflicted on the player if this strike connects. */
  apply: StatusEffect[];
}

export type PlanAction =
  | { kind: "move"; dir: Direction }
  | { kind: "card"; cardId: string }
  | { kind: "wait" };

/** Max queued actions (ticks) per round — the monster telegraphs the same count. */
export const MAX_PLAN = 3;

/** One step of the interleaved resolution, for the log + board preview. */
export interface ResolutionStep {
  player: PlanAction | null;
  playerPos: Point;
  attackTiles: Point[];
  monsterPos: Point;
  dealt: number;
  taken: number;
  line: string;
}

export interface BattleResolution {
  steps: ResolutionStep[];
  playerEnd: Point;
  monsterEnd: Point;
  monsterHp: number;
  totalDealt: number;
  totalTaken: number;
  monsterDead: boolean;
  /** Persist these back onto the combat row for the next round. */
  playerStatusEnd: StatusEffect[];
  monsterStatusEnd: StatusEffect[];
}

const MOVE_DELTA: Record<BattleMove, Point> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  stay: { x: 0, y: 0 },
};

const DIR_DELTA: Record<Direction, Point> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

export function clampArena(n: number): number {
  return Math.max(0, Math.min(ARENA_SIZE - 1, Math.trunc(n)));
}

export function inArena(p: Point): boolean {
  return p.x >= 0 && p.x < ARENA_SIZE && p.y >= 0 && p.y < ARENA_SIZE;
}

export function samePoint(a: Point, b: Point): boolean {
  return a.x === b.x && a.y === b.y;
}

export function pointKey(p: Point): string {
  return `${p.x},${p.y}`;
}

export function battleMoveRange(player: SatPlayerRow): number {
  return Math.min(10, 5 + bootBonus(player));
}

export function battleMovePoints(combat: CombatSessionRow, player: SatPlayerRow): number {
  return Math.max(0, Math.min(battleMoveRange(player), combat.battle_move_points ?? battleMoveRange(player)));
}

const MOVE_TOKENS = new Set<Direction>(["up", "down", "left", "right"]);

/**
 * Decode the persisted plan string into an action list (capped at MAX_PLAN).
 * Card tokens are `card-<id>`. Legacy `strike` / `strike-*` tokens map to the
 * baseline Strike card so old combat rows keep resolving.
 */
export function parsePlan(plan: string | null | undefined): PlanAction[] {
  if (!plan) return [];
  const out: PlanAction[] = [];
  for (const raw of plan.split(",")) {
    const tok = raw.trim();
    if (!tok) continue;
    if (tok === "wait") out.push({ kind: "wait" });
    else if (tok.startsWith("card-")) {
      const id = tok.slice(5);
      if (CARD_BY_ID.has(id)) out.push({ kind: "card", cardId: id });
    } else if (tok === "strike" || tok.startsWith("strike-")) {
      out.push({ kind: "card", cardId: "strike" }); // legacy
    } else if (MOVE_TOKENS.has(tok as Direction)) out.push({ kind: "move", dir: tok as Direction });
    if (out.length >= MAX_PLAN) break;
  }
  return out;
}

/** Encode an action list back to the persisted comma-joined token form. */
export function serializePlan(actions: PlanAction[]): string {
  return actions
    .slice(0, MAX_PLAN)
    .map((a) => (a.kind === "move" ? a.dir : a.kind === "card" ? `card-${a.cardId}` : "wait"))
    .join(",");
}

/** AP cost of one queued action: move = 1, wait = 0, card = its apCost. */
export function actionAP(action: PlanAction): number {
  if (action.kind === "move") return 1;
  if (action.kind === "wait") return 0;
  return cardById(action.cardId)?.apCost ?? 0;
}

/** Total AP a queued plan spends. */
export function planAP(plan: PlanAction[]): number {
  return plan.reduce((sum, a) => sum + actionAP(a), 0);
}

/** Compact glyph for a plan action — used in the embed plan strip. */
export function planGlyph(action: PlanAction): string {
  if (action.kind === "card") return cardById(action.cardId)?.emoji ?? "✨";
  if (action.kind === "wait") return "⏳";
  return action.dir === "up" ? "⬆️" : action.dir === "down" ? "⬇️" : action.dir === "left" ? "⬅️" : "➡️";
}

/**
 * Where the player would stand after applying the already-queued moves. Used to
 * validate the next queued move against the *end* of the plan.
 */
export function projectedPlayerPos(combat: CombatSessionRow, plan: PlanAction[]): Point {
  let pos = { x: combat.player_battle_x, y: combat.player_battle_y };
  const monster = { x: combat.monster_battle_x, y: combat.monster_battle_y };
  for (const a of plan) {
    if (a.kind !== "move") continue;
    const d = DIR_DELTA[a.dir];
    const next = { x: clampArena(pos.x + d.x), y: clampArena(pos.y + d.y) };
    if (samePoint(next, monster)) continue; // blocked — stay put
    pos = next;
  }
  return pos;
}

export function startingBattlePositions(worldX: number, worldY: number): {
  player: Point;
  monster: Point;
} {
  const h = Math.abs((worldX * 31 + worldY * 17) | 0);
  return {
    player: { x: 2 + (h % 4), y: 6 },
    monster: { x: 2 + ((h >> 2) % 4), y: 1 },
  };
}

export function legalBattleMoves(combat: CombatSessionRow, player: SatPlayerRow): Point[] {
  const origin = { x: combat.player_battle_x, y: combat.player_battle_y };
  const occupied = { x: combat.monster_battle_x, y: combat.monster_battle_y };
  const range = battleMovePoints(combat, player);
  const out: Point[] = [];
  for (let y = 0; y < ARENA_SIZE; y++) {
    for (let x = 0; x < ARENA_SIZE; x++) {
      const p = { x, y };
      const dist = Math.abs(x - origin.x) + Math.abs(y - origin.y);
      if (dist <= range && !samePoint(p, occupied)) out.push(p);
    }
  }
  return out;
}

export function moveByButton(combat: CombatSessionRow, move: BattleMove, player: SatPlayerRow): Point {
  const d = MOVE_DELTA[move];
  return {
    x: clampArena(combat.player_battle_x + d.x),
    y: clampArena(combat.player_battle_y + d.y),
  };
}

export function selectedWeaponId(combat: CombatSessionRow | null, player: SatPlayerRow): string | null {
  return combat?.selected_battle_weapon ?? player.equipped_weapon ?? null;
}

/** Raw gear power of the weapon used to scale attack-card damage. */
export function weaponPower(player: SatPlayerRow, weaponId?: string | null): number {
  const id = weaponId === undefined ? player.equipped_weapon : weaponId;
  const item = id ? ITEM_BY_ID.get(id) : null;
  return item?.power ?? 0;
}

export function weaponFor(player: SatPlayerRow, weaponId?: string | null): WeaponProfile {
  const id = weaponId === undefined ? player.equipped_weapon : weaponId;
  const item = id ? ITEM_BY_ID.get(id) : null;
  const pattern = weaponPatternFor(item);
  const power = item?.power ?? 0;
  const damage = Math.max(5, Math.round(5 + power * 1.2));
  return {
    name: item?.name ?? "Bare Fists",
    emoji: item?.emoji ?? "👊",
    pattern,
    damage,
    power,
    summary: weaponSummary(pattern),
  };
}

function weaponPatternFor(item: ShopItem | null | undefined): WeaponPattern {
  if (!item) return "dagger";
  if (item.id === "rest_weapon") return "longsword";
  if (item.id === "jaipur_weapon") return "spear";
  if (item.id === "dustfall_weapon") return "hammer";
  if (item.id === "frosthold_weapon") return "arc";
  if (item.id === "jaipur_unlock") return "star";
  return "longsword";
}

function weaponSummary(pattern: WeaponPattern): string {
  switch (pattern) {
    case "dagger": return "light, low power";
    case "longsword": return "balanced reach";
    case "hammer": return "heavy impact";
    case "spear": return "long reach";
    case "arc": return "wide cleave";
    case "star": return "burst power";
  }
}

export function attackDirection(from: Point, to: Point): Direction {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "right" : "left";
  return dy > 0 ? "down" : "up";
}

/**
 * Tiles a card's shape covers, oriented toward the target from `from`. Damage is
 * decoupled (it comes from the card + weapon power), so the shape is purely
 * geometric. Unknown shapes fall back to a 3-tile line.
 */
export function attackTilesForShape(from: Point, target: Point, shape: string): Point[] {
  const dir = attackDirection(from, target);
  const d = DIR_DELTA[dir];
  const forward = (n: number) => ({ x: from.x + d.x * n, y: from.y + d.y * n });
  const lateral = dir === "up" || dir === "down" ? { x: 1, y: 0 } : { x: 0, y: 1 };

  const raw: Point[] = [];
  switch (shape) {
    case "longsword":
      raw.push(forward(1), forward(2));
      break;
    case "spear":
      raw.push(forward(1), forward(2), forward(3));
      break;
    case "hammer": {
      const anchor = forward(1);
      raw.push(anchor, { x: anchor.x + lateral.x, y: anchor.y + lateral.y }, forward(2), { x: anchor.x + lateral.x + d.x, y: anchor.y + lateral.y + d.y });
      break;
    }
    case "cleave":
    case "arc": {
      const c = forward(1);
      raw.push(c, { x: c.x + lateral.x, y: c.y + lateral.y }, { x: c.x - lateral.x, y: c.y - lateral.y });
      break;
    }
    case "star":
      raw.push(
        { x: from.x - 1, y: from.y - 1 },
        { x: from.x + 1, y: from.y - 1 },
        { x: from.x - 1, y: from.y + 1 },
        { x: from.x + 1, y: from.y + 1 },
        forward(2),
      );
      break;
    case "slam":
      for (let yy = from.y - 1; yy <= from.y + 1; yy++) {
        for (let xx = from.x - 1; xx <= from.x + 1; xx++) {
          if (xx !== from.x || yy !== from.y) raw.push({ x: xx, y: yy });
        }
      }
      break;
    case "bolt": // ranged: a straight line all the way across the arena
      for (let i = 1; i < ARENA_SIZE; i++) raw.push(forward(i));
      break;
    case "nova":
      for (let yy = from.y - 2; yy <= from.y + 2; yy++) {
        for (let xx = from.x - 2; xx <= from.x + 2; xx++) {
          if (xx !== from.x || yy !== from.y) raw.push({ x: xx, y: yy });
        }
      }
      break;
    case "line":
    default:
      raw.push(forward(1), forward(2), forward(3));
      break;
  }
  return uniquePoints(raw.filter(inArena));
}

/**
 * The monster's next MAX_PLAN telegraphed acts. Exactly one tick is an attack —
 * the monster advances toward the player before it, then rests after. The attack
 * tick carries the monster's signature ability (name + inflicted statuses).
 */
export function monsterPlan(combat: CombatSessionRow, _player?: SatPlayerRow): MonsterIntent[] {
  const target = { x: combat.player_battle_x, y: combat.player_battle_y };
  const damage = Math.max(3, 3 + combat.monster_level * 2);
  const ability = monsterAbility(combat.monster_name);
  const base = `${combat.monster_name}:${combat.monster_level}:${combat.turn_number}:${combat.enemy_x}:${combat.enemy_y}`;
  const attackIndex = hash(base) % MAX_PLAN;
  const out: MonsterIntent[] = [];
  let from = { x: combat.monster_battle_x, y: combat.monster_battle_y };

  for (let k = 0; k < MAX_PLAN; k++) {
    const seed = hash(`${base}:${k}`);
    if (k === attackIndex) {
      const pattern = monsterPatternFor(combat.monster_name, seed);
      const move = monsterStep(from, target, pattern, seed);
      const to = { x: clampArena(from.x + move.x), y: clampArena(from.y + move.y) };
      const dir = attackDirection(to, target);
      out.push({
        order: k + 1, act: "attack", pattern,
        name: ability.name,
        description: monsterIntentDescription(pattern, move, dir, ability.apply),
        from, to,
        attackTiles: monsterAttackTiles(to, dir, pattern, seed),
        damage,
        apply: ability.apply,
      });
      from = to;
    } else {
      const advancing = k < attackIndex;
      const move = advancing ? stepToward(from, target) : { x: 0, y: 0 };
      const to = { x: clampArena(from.x + move.x), y: clampArena(from.y + move.y) };
      out.push({
        order: k + 1, act: advancing ? "advance" : "rest", pattern: "line",
        name: advancing ? "Advance" : "Rest",
        description: advancing ? `Will close in ${dirWord(move)} — no attack.` : "Resting — no attack.",
        from, to, attackTiles: [], damage: 0, apply: [],
      });
      from = to;
    }
  }
  return out;
}

function stepToward(from: Point, target: Point): Point {
  const dx = target.x - from.x;
  const dy = target.y - from.y;
  if (Math.abs(dx) + Math.abs(dy) <= 1) return { x: 0, y: 0 };
  if (Math.abs(dx) >= Math.abs(dy)) return { x: Math.sign(dx), y: 0 };
  return { x: 0, y: Math.sign(dy) };
}

function dirWord(move: Point): string {
  if (move.x > 0) return "east";
  if (move.x < 0) return "west";
  if (move.y > 0) return "south";
  if (move.y < 0) return "north";
  return "in place";
}

/** Back-compat single-intent accessor (the next strike only). */
export function monsterIntent(combat: CombatSessionRow, player: SatPlayerRow): MonsterIntent {
  return monsterPlan(combat, player)[0];
}

/**
 * Deterministically resolve a player plan against the monster's telegraph,
 * interleaved tick-by-tick, with action-point cards and status effects. Pure —
 * used both to apply the round and to preview it.
 *
 * Status timing: DoTs, Stun and Chill read from statuses present at round start;
 * debuffs inflicted this round persist into the NEXT round (so a Stun fizzles the
 * monster's following attack). Self-buffs (Shield/Empower) are this-round only.
 */
export function simulateBattle(
  combat: CombatSessionRow,
  weapon: { power: number },
  plan: PlanAction[],
): BattleResolution {
  const intents = monsterPlan(combat);
  let playerPos = { x: combat.player_battle_x, y: combat.player_battle_y };
  let monsterPos = { x: combat.monster_battle_x, y: combat.monster_battle_y };
  let monsterHp = combat.monster_current_hp;

  // Statuses active at the start of this round (the "old" set that decays at end).
  const playerOld = parseStatuses(combat.player_status);
  const monsterOld = parseStatuses(combat.monster_status);
  // Debuffs inflicted during this round — carried at full duration into next round.
  const playerAdds: StatusEffect[] = [];
  const monsterAdds: StatusEffect[] = [];

  const steps: ResolutionStep[] = [];
  let totalDealt = 0;
  let totalTaken = 0;

  // Round-start damage-over-time.
  const monsterDot = monsterHp > 0 ? dotDamage(monsterOld) : 0;
  if (monsterDot > 0) monsterHp = Math.max(0, monsterHp - monsterDot);
  const playerDot = dotDamage(playerOld);
  totalDealt += monsterDot;
  totalTaken += playerDot;
  if (monsterDot > 0 || playerDot > 0) {
    const bits: string[] = [];
    if (monsterDot > 0) bits.push(`🩸 lingering effects deal ${monsterDot} to ${combat.monster_name}`);
    if (playerDot > 0) bits.push(`🩸 you take ${playerDot} from lingering effects`);
    steps.push({ player: null, playerPos, attackTiles: [], monsterPos, dealt: monsterDot, taken: playerDot, line: `• ${bits.join(" · ")}` });
  }

  let playerShield = 0; // built from self-buff cards played this round (one-round)
  let empower = 0;
  const monsterStunned = hasStatus(monsterOld, "stun");
  const monsterChill = totalOf(monsterOld, "chill"); // flat damage reduction while chilled

  for (let k = 0; k < MAX_PLAN; k++) {
    const action = plan[k] ?? null;
    let dealt = 0;
    let taken = 0;
    let attackTiles: Point[] = [];
    const parts: string[] = [];

    // 1) Player acts first (so a move can dodge this tick's strike).
    if (action?.kind === "move") {
      const d = DIR_DELTA[action.dir];
      const next = { x: clampArena(playerPos.x + d.x), y: clampArena(playerPos.y + d.y) };
      if (!samePoint(next, monsterPos)) playerPos = next;
      parts.push(`${planGlyph(action)} to ${arenaTag(playerPos)}`);
    } else if (action?.kind === "card") {
      const card = cardById(action.cardId);
      if (!card) {
        parts.push("— fizzle");
      } else if (card.kind === "buff") {
        for (const eff of card.apply ?? []) {
          if (eff.kind === "shield") playerShield += eff.amount;
          else if (eff.kind === "empower") empower += eff.amount;
        }
        parts.push(`${card.emoji} ${card.name}`);
      } else {
        attackTiles = attackTilesForShape(playerPos, monsterPos, card.shape ?? "line");
        const onTarget = attackTiles.some((p) => samePoint(p, monsterPos));
        if (onTarget && monsterHp > 0) {
          dealt = Math.max(1, (card.damage ?? 0) + Math.round(weapon.power) + empower);
          if (empower > 0) empower = 0; // consumed
          monsterHp = Math.max(0, monsterHp - dealt);
          for (const eff of card.apply ?? []) monsterAdds.push({ ...eff });
          const tag = (card.apply ?? []).length ? ` (+${(card.apply ?? []).map((e) => e.kind).join(",")})` : "";
          parts.push(`${card.emoji} ${card.name} hit for ${dealt}${tag}`);
        } else {
          parts.push(`${card.emoji} ${card.name} whiffed`);
        }
      }
    } else if (action?.kind === "wait") {
      parts.push("⏳ hold");
    } else {
      parts.push("— idle");
    }

    // 2) Monster executes its k-th telegraphed act.
    const intent = intents[k];
    if (intent) {
      monsterPos = intent.to;
      if (intent.act === "attack" && monsterHp > 0) {
        if (monsterStunned) {
          parts.push("💫 stunned — its strike fizzles");
        } else {
          const struck = samePoint(playerPos, monsterPos) || intent.attackTiles.some((p) => samePoint(p, playerPos));
          if (struck) {
            const raw = Math.max(1, intent.damage - monsterChill);
            const absorbed = Math.min(playerShield, raw);
            playerShield -= absorbed;
            taken = raw - absorbed;
            if (taken > 0) for (const eff of intent.apply ?? []) playerAdds.push({ ...eff });
            parts.push(absorbed > 0
              ? `🛡️ shield soaks ${absorbed}${taken > 0 ? `, ${intent.name} took ${taken}` : ""}`
              : `🩸 ${intent.name} hit you for ${taken}`);
          } else {
            parts.push(`✨ dodged ${intent.name}`);
          }
        }
      } else if (monsterHp > 0) {
        parts.push(intent.act === "rest" ? "💤 it rests" : "👣 it advances");
      }
    }

    totalDealt += dealt;
    totalTaken += taken;
    steps.push({ player: action, playerPos, attackTiles, monsterPos, dealt, taken, line: `${k + 1}. ${parts.join(" · ")}` });

    if (monsterHp <= 0) break;
  }

  // Old statuses age one round; freshly-inflicted debuffs carry over at full duration.
  const playerStatusEnd = decayStatuses(playerOld).concat(playerAdds);
  const monsterStatusEnd = decayStatuses(monsterOld).concat(monsterAdds);

  return {
    steps,
    playerEnd: playerPos,
    monsterEnd: monsterPos,
    monsterHp,
    totalDealt,
    totalTaken,
    monsterDead: monsterHp <= 0,
    playerStatusEnd,
    monsterStatusEnd,
  };
}

/** Arena tag like "C4" for log lines. */
function arenaTag(p: Point): string {
  return `${String.fromCharCode(65 + p.x)}${p.y + 1}`;
}

function monsterPatternFor(monsterName: string, seed: number): MonsterPattern {
  const name = monsterName.toLowerCase();
  if (name.includes("wolf") || name.includes("tiger") || name.includes("yeti")) return seed % 2 === 0 ? "cone" : "dash";
  if (name.includes("golem") || name.includes("wraith") || name.includes("revenant")) return seed % 2 === 0 ? "slam" : "line";
  if (name.includes("naga") || name.includes("wyrm") || name.includes("scorpion")) return seed % 2 === 0 ? "line" : "cone";
  return (["line", "cone", "slam", "dash"] as const)[seed % 4];
}

function monsterStep(from: Point, target: Point, pattern: MonsterPattern, seed: number): Point {
  if (pattern === "slam") return { x: 0, y: 0 };
  const max = pattern === "dash" ? 2 : 1;
  const dx = target.x - from.x;
  const dy = target.y - from.y;
  if (Math.abs(dx) === Math.abs(dy) && dx !== 0) {
    return seed % 2 === 0 ? { x: Math.sign(dx) * max, y: 0 } : { x: 0, y: Math.sign(dy) * max };
  }
  if (Math.abs(dx) > Math.abs(dy)) return { x: Math.sign(dx) * max, y: 0 };
  if (dy !== 0) return { x: 0, y: Math.sign(dy) * max };
  return { x: 0, y: 0 };
}

function monsterAttackTiles(from: Point, dir: Direction, pattern: MonsterPattern, seed: number): Point[] {
  const d = DIR_DELTA[dir];
  const lateral = dir === "up" || dir === "down" ? { x: 1, y: 0 } : { x: 0, y: 1 };
  const raw: Point[] = [];
  switch (pattern) {
    case "line":
      for (let i = 1; i < ARENA_SIZE; i++) raw.push({ x: from.x + d.x * i, y: from.y + d.y * i });
      break;
    case "cone":
      raw.push(
        { x: from.x + d.x, y: from.y + d.y },
        { x: from.x + d.x * 2, y: from.y + d.y * 2 },
        { x: from.x + d.x * 2 + lateral.x, y: from.y + d.y * 2 + lateral.y },
        { x: from.x + d.x * 2 - lateral.x, y: from.y + d.y * 2 - lateral.y },
      );
      break;
    case "slam":
      for (let y = from.y - 1; y <= from.y + 1; y++) {
        for (let x = from.x - 1; x <= from.x + 1; x++) {
          if (x !== from.x || y !== from.y) raw.push({ x, y });
        }
      }
      break;
    case "dash":
      for (let i = 1; i <= 3; i++) raw.push({ x: from.x + d.x * i, y: from.y + d.y * i });
      if (seed % 3 === 0) {
        raw.push({ x: from.x + d.x * 2 + lateral.x, y: from.y + d.y * 2 + lateral.y });
      }
      break;
  }
  return uniquePoints(raw.filter(inArena));
}

function monsterIntentDescription(pattern: MonsterPattern, move: Point, dir: Direction, apply: StatusEffect[]): string {
  const moveText = move.x === 0 && move.y === 0
    ? "hold position"
    : `move ${move.x !== 0 ? Math.abs(move.x) : Math.abs(move.y)} ${move.x > 0 ? "east" : move.x < 0 ? "west" : move.y > 0 ? "south" : "north"}`;
  const fx = apply.length ? ` (inflicts ${apply.map((e) => e.kind).join(", ")})` : "";
  switch (pattern) {
    case "line": return `Will ${moveText}, then strike a straight ${dir} line${fx}.`;
    case "cone": return `Will ${moveText}, then strike in a ${dir}-facing cone${fx}.`;
    case "slam": return `Will ${moveText}, then slam all adjacent tiles${fx}.`;
    case "dash": return `Will ${moveText}, then lunge ${dir}${fx}.`;
  }
}

function uniquePoints(points: Point[]): Point[] {
  const seen = new Set<string>();
  const out: Point[] = [];
  for (const p of points) {
    const key = pointKey(p);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function hash(s: string): number {
  let h = 2166136261;
  for (const ch of s) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Re-export card-kit helpers so callers can keep importing from battle.ts.
export type { CardDef } from "./cards.js";
