import type { ShopItem } from "./items.js";
import type { BattleMonster, CombatSessionRow, Direction, SatPlayerRow } from "./types.js";
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

/** Per-monster snapshot at the end of one resolution tick (drives playback). */
export interface StepMonster {
  id: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  /** Tiles this monster struck on this tick (empty unless it attacked this tick). */
  attackTiles: Point[];
  act: MonsterAct | "dead";
}

/** One step of the interleaved resolution, for the log + board preview. */
export interface ResolutionStep {
  player: PlanAction | null;
  playerPos: Point;
  /** The player's attack-card tiles this tick (back-compat: player's, not monster's). */
  attackTiles: Point[];
  /** Primary monster position (back-compat single-monster field). */
  monsterPos: Point;
  /** All monsters after this tick — positions, hp, per-tick strikes. */
  monsters: StepMonster[];
  dealt: number;
  taken: number;
  line: string;
}

export interface BattleResolution {
  steps: ResolutionStep[];
  playerEnd: Point;
  /** Primary monster end (back-compat single-monster field). */
  monsterEnd: Point;
  /** Primary monster end HP (back-compat single-monster field). */
  monsterHp: number;
  /** All monsters' end state — persist this back onto the combat row. */
  monsters: BattleMonster[];
  totalDealt: number;
  totalTaken: number;
  /** True only when EVERY monster is dead. */
  monsterDead: boolean;
  /** Persist these back onto the combat row for the next round. */
  playerStatusEnd: StatusEffect[];
  /** Primary monster end statuses (back-compat single-monster field). */
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
  const blockers = readMonsters(combat).filter((m) => m.hp > 0).map((m) => ({ x: m.x, y: m.y }));
  for (const a of plan) {
    if (a.kind !== "move") continue;
    const d = DIR_DELTA[a.dir];
    const next = { x: clampArena(pos.x + d.x), y: clampArena(pos.y + d.y) };
    if (blockers.some((b) => samePoint(next, b))) continue; // blocked — stay put
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

/**
 * Distinct starting tiles for `count` monsters along the top rows of the arena,
 * deterministically spread so they don't overlap (chess-like opening setup).
 */
export function startingMonsterPositions(worldX: number, worldY: number, count: number): Point[] {
  const h = Math.abs((worldX * 31 + worldY * 17) | 0);
  const n = Math.max(1, Math.min(ARENA_SIZE, count));
  const used = new Set<string>();
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    const seed = hash(`${worldX}:${worldY}:${i}`);
    let x = (1 + ((h >> (i * 2)) % (ARENA_SIZE - 2))) % ARENA_SIZE;
    let y = i % 2 === 0 ? 1 : 0;
    // nudge off any tile already taken
    let guard = 0;
    while (used.has(pointKey({ x, y })) && guard < ARENA_SIZE * 2) {
      x = (x + 1) % ARENA_SIZE;
      if (x === 0) y = (y + 1) % 2;
      guard++;
    }
    used.add(pointKey({ x, y }));
    out.push({ x: clampArena(x), y: clampArena(y) });
    void seed;
  }
  return out;
}

/**
 * Read the full monster roster. Falls back to synthesising a single monster from
 * the legacy singular `monster_*` columns when `monsters` is null/empty, so
 * in-flight fights (and rows written before the multi-monster migration) resolve.
 */
export function readMonsters(combat: CombatSessionRow): BattleMonster[] {
  if (combat.monsters) {
    try {
      const arr = JSON.parse(combat.monsters);
      if (Array.isArray(arr) && arr.length) return arr.map((m, i) => normalizeMonster(m, i));
    } catch {
      /* fall through to legacy columns */
    }
  }
  return [{
    id: "m0",
    name: combat.monster_name,
    level: combat.monster_level,
    maxHp: combat.monster_max_hp,
    hp: combat.monster_current_hp,
    x: combat.monster_battle_x,
    y: combat.monster_battle_y,
    attack: combat.monster_attack,
    reward: combat.reward_sats,
    status: parseStatuses(combat.monster_status),
  }];
}

function normalizeMonster(m: Record<string, unknown>, i: number): BattleMonster {
  const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const rawStatus = (m as { status?: unknown }).status;
  return {
    id: typeof m.id === "string" ? m.id : `m${i}`,
    name: String(m.name ?? "Monster"),
    level: num(m.level, 1),
    maxHp: num(m.maxHp, num(m.hp, 1)),
    hp: Math.max(0, num(m.hp, 0)),
    x: clampArena(num(m.x, 0)),
    y: clampArena(num(m.y, 0)),
    attack: num(m.attack, 0),
    reward: num(m.reward, 0),
    status: parseStatuses(typeof rawStatus === "string" ? rawStatus : JSON.stringify(rawStatus ?? [])),
  };
}

export function serializeMonsters(monsters: BattleMonster[]): string {
  return JSON.stringify(monsters);
}

export function allMonstersDead(combat: CombatSessionRow): boolean {
  return readMonsters(combat).every((m) => m.hp <= 0);
}

export function legalBattleMoves(combat: CombatSessionRow, player: SatPlayerRow): Point[] {
  const origin = { x: combat.player_battle_x, y: combat.player_battle_y };
  const occupied = readMonsters(combat).filter((m) => m.hp > 0).map((m) => ({ x: m.x, y: m.y }));
  const range = battleMovePoints(combat, player);
  const out: Point[] = [];
  for (let y = 0; y < ARENA_SIZE; y++) {
    for (let x = 0; x < ARENA_SIZE; x++) {
      const p = { x, y };
      const dist = Math.abs(x - origin.x) + Math.abs(y - origin.y);
      if (dist <= range && !occupied.some((o) => samePoint(p, o))) out.push(p);
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
export interface MonsterTelegraph {
  monster: BattleMonster;
  intents: MonsterIntent[];
}

/** Telegraph for one monster, with `blocked(p)` reserving tiles other monsters claimed. */
function monsterIntentsFor(
  m: BattleMonster,
  target: Point,
  turnNumber: number,
  blocked: (p: Point) => boolean,
): MonsterIntent[] {
  const damage = Math.max(3, 3 + m.level * 2);
  const ability = monsterAbility(m.name);
  const base = `${m.name}:${m.id}:${m.level}:${turnNumber}:${m.x}:${m.y}`;
  const attackIndex = hash(base) % MAX_PLAN;
  const out: MonsterIntent[] = [];
  let from = { x: m.x, y: m.y };

  for (let k = 0; k < MAX_PLAN; k++) {
    const seed = hash(`${base}:${k}`);
    if (k === attackIndex) {
      const pattern = monsterPatternFor(m.name, seed);
      const move = monsterStep(from, target, pattern, seed);
      let to = { x: clampArena(from.x + move.x), y: clampArena(from.y + move.y) };
      if (!samePoint(to, from) && blocked(to)) to = from; // don't stack onto a claimed tile
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
      let to = { x: clampArena(from.x + move.x), y: clampArena(from.y + move.y) };
      if (!samePoint(to, from) && blocked(to)) to = from;
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

/**
 * Telegraph every living monster's next MAX_PLAN acts. Monsters are processed in
 * roster order; each one reserves the tiles on its path so later monsters route
 * around it (so two monsters don't telegraph onto the same square). Deterministic,
 * so the preview shown to the player matches what {@link simulateBattle} resolves.
 */
export function monstersTelegraph(combat: CombatSessionRow): MonsterTelegraph[] {
  const monsters = readMonsters(combat).filter((m) => m.hp > 0);
  const target = { x: combat.player_battle_x, y: combat.player_battle_y };
  const claimed = new Set<string>();
  for (const m of monsters) claimed.add(pointKey({ x: m.x, y: m.y }));
  const out: MonsterTelegraph[] = [];
  for (const m of monsters) {
    const self = pointKey({ x: m.x, y: m.y });
    const blocked = (p: Point) => claimed.has(pointKey(p)) && pointKey(p) !== self;
    const intents = monsterIntentsFor(m, target, combat.turn_number, blocked);
    claimed.delete(self);
    for (const it of intents) claimed.add(pointKey(it.to));
    out.push({ monster: m, intents });
  }
  return out;
}

/** Back-compat: the primary (first living) monster's telegraph. */
export function monsterPlan(combat: CombatSessionRow, _player?: SatPlayerRow): MonsterIntent[] {
  const tele = monstersTelegraph(combat);
  return tele.length ? tele[0].intents : [];
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
  const telegraph = monstersTelegraph(combat);
  let playerPos = { x: combat.player_battle_x, y: combat.player_battle_y };

  // Working state per living monster: position/hp clone + this-round status bookkeeping.
  const mons = telegraph.map((t) => ({
    m: { ...t.monster, status: [...t.monster.status] },
    intents: t.intents,
    old: t.monster.status, // statuses at round start (decay at end)
    adds: [] as StatusEffect[], // inflicted this round → carry into next round
    stunned: hasStatus(t.monster.status, "stun"),
    chill: totalOf(t.monster.status, "chill"),
  }));

  const playerOld = parseStatuses(combat.player_status);
  const playerAdds: StatusEffect[] = [];

  const steps: ResolutionStep[] = [];
  let totalDealt = 0;
  let totalTaken = 0;

  const livingPositions = () => mons.filter((mm) => mm.m.hp > 0).map((mm) => ({ x: mm.m.x, y: mm.m.y }));
  const nearestLiving = (from: Point, posOf: (mm: typeof mons[number]) => Point) => {
    let best: typeof mons[number] | null = null;
    let bd = Infinity;
    for (const mm of mons) {
      if (mm.m.hp <= 0) continue;
      const p = posOf(mm);
      const d = Math.abs(p.x - from.x) + Math.abs(p.y - from.y);
      if (d < bd) { bd = d; best = mm; }
    }
    return best;
  };
  const snapshot = (tickStrikes: Record<string, Point[]>, k: number): StepMonster[] =>
    mons.map((mm) => ({
      id: mm.m.id,
      x: mm.m.x,
      y: mm.m.y,
      hp: mm.m.hp,
      maxHp: mm.m.maxHp,
      attackTiles: tickStrikes[mm.m.id] ?? [],
      act: mm.m.hp <= 0 ? "dead" : (mm.intents[k]?.act ?? "rest"),
    }));
  const primaryPos = (): Point => (mons[0] ? { x: mons[0].m.x, y: mons[0].m.y } : { x: combat.monster_battle_x, y: combat.monster_battle_y });

  // Round-start damage-over-time (each monster bleeds/poisons independently).
  let dotDealt = 0;
  for (const mm of mons) {
    if (mm.m.hp <= 0) continue;
    const d = dotDamage(mm.old);
    if (d > 0) { mm.m.hp = Math.max(0, mm.m.hp - d); dotDealt += d; }
  }
  const playerDot = dotDamage(playerOld);
  totalDealt += dotDealt;
  totalTaken += playerDot;
  if (dotDealt > 0 || playerDot > 0) {
    const bits: string[] = [];
    if (dotDealt > 0) bits.push(`🩸 lingering effects deal ${dotDealt}`);
    if (playerDot > 0) bits.push(`🩸 you take ${playerDot} from lingering effects`);
    steps.push({ player: null, playerPos, attackTiles: [], monsterPos: primaryPos(), monsters: snapshot({}, -1), dealt: dotDealt, taken: playerDot, line: `• ${bits.join(" · ")}` });
  }

  let playerShield = 0; // self-buff cards this round (one-round)
  let empower = 0;

  for (let k = 0; k < MAX_PLAN; k++) {
    const action = plan[k] ?? null;
    let dealt = 0;
    let taken = 0;
    let attackTiles: Point[] = [];
    const parts: string[] = [];
    const tickStrikes: Record<string, Point[]> = {};

    // 1) Player acts first (so a move can dodge this tick's strikes).
    if (action?.kind === "move") {
      const d = DIR_DELTA[action.dir];
      const next = { x: clampArena(playerPos.x + d.x), y: clampArena(playerPos.y + d.y) };
      if (!livingPositions().some((p) => samePoint(p, next))) playerPos = next;
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
        // Orient toward — and resolve hits against — where each monster will be
        // AFTER it moves on THIS tick (its telegraphed `intents[k].to`), not its
        // start-of-tick position. The player acts before monsters each tick, so
        // using the start-of-tick position aimed a strike one move "behind" the
        // monster whenever it advanced on the same tick the strike landed.
        const destOf = (mm: typeof mons[number]): Point => mm.intents[k]?.to ?? { x: mm.m.x, y: mm.m.y };
        const focus = nearestLiving(playerPos, destOf);
        attackTiles = focus ? attackTilesForShape(playerPos, destOf(focus), card.shape ?? "line") : [];
        const hits = mons.filter((mm) => mm.m.hp > 0 && attackTiles.some((p) => samePoint(p, destOf(mm))));
        if (hits.length) {
          const dmgEach = Math.max(1, (card.damage ?? 0) + Math.round(weapon.power) + empower);
          if (empower > 0) empower = 0; // consumed by the first swing
          for (const h of hits) {
            h.m.hp = Math.max(0, h.m.hp - dmgEach);
            for (const eff of card.apply ?? []) h.adds.push({ ...eff });
            dealt += dmgEach;
          }
          const tag = (card.apply ?? []).length ? ` (+${(card.apply ?? []).map((e) => e.kind).join(",")})` : "";
          parts.push(`${card.emoji} ${card.name} hit ${hits.length > 1 ? `${hits.length} foes ` : ""}for ${dmgEach}${tag}`);
        } else {
          parts.push(`${card.emoji} ${card.name} whiffed`);
        }
      }
    } else if (action?.kind === "wait") {
      parts.push("⏳ hold");
    } else {
      parts.push("— idle");
    }

    // 2) Each living monster executes its k-th telegraphed act, in roster order.
    for (const mm of mons) {
      if (mm.m.hp <= 0) continue;
      const intent = mm.intents[k];
      if (!intent) continue;
      mm.m.x = intent.to.x;
      mm.m.y = intent.to.y;
      if (intent.act === "attack") {
        if (mm.stunned) {
          parts.push(`💫 ${mm.m.name} fizzles`);
        } else {
          tickStrikes[mm.m.id] = intent.attackTiles;
          const struck = samePoint(playerPos, { x: mm.m.x, y: mm.m.y }) || intent.attackTiles.some((p) => samePoint(p, playerPos));
          if (struck) {
            const raw = Math.max(1, intent.damage - mm.chill);
            const absorbed = Math.min(playerShield, raw);
            playerShield -= absorbed;
            const t = raw - absorbed;
            taken += t;
            if (t > 0) for (const eff of intent.apply ?? []) playerAdds.push({ ...eff });
            parts.push(absorbed > 0
              ? `🛡️ soaks ${absorbed}${t > 0 ? `, ${intent.name} took ${t}` : ""}`
              : `🩸 ${intent.name} hit you for ${t}`);
          } else {
            parts.push(`✨ dodged ${mm.m.name}`);
          }
        }
      }
    }

    totalDealt += dealt;
    totalTaken += taken;
    steps.push({ player: action, playerPos, attackTiles, monsterPos: primaryPos(), monsters: snapshot(tickStrikes, k), dealt, taken, line: `${k + 1}. ${parts.join(" · ")}` });

    if (mons.every((mm) => mm.m.hp <= 0)) break;
  }

  // Old statuses age one round; freshly-inflicted debuffs carry over at full duration.
  for (const mm of mons) mm.m.status = decayStatuses(mm.old).concat(mm.adds);
  const playerStatusEnd = decayStatuses(playerOld).concat(playerAdds);

  const endMonsters = mons.map((mm) => mm.m);
  const primary = endMonsters[0];
  return {
    steps,
    playerEnd: playerPos,
    monsterEnd: primary ? { x: primary.x, y: primary.y } : { x: combat.monster_battle_x, y: combat.monster_battle_y },
    monsterHp: primary ? primary.hp : 0,
    monsters: endMonsters,
    totalDealt,
    totalTaken,
    monsterDead: endMonsters.length > 0 && endMonsters.every((m) => m.hp <= 0),
    playerStatusEnd,
    monsterStatusEnd: primary ? primary.status : [],
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
