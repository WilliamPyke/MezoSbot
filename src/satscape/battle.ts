import type { ShopItem } from "./items.js";
import type { CombatSessionRow, Direction, SatPlayerRow } from "./types.js";
import { bootBonus, ITEM_BY_ID } from "./towns.js";

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
  summary: string;
}

export interface MonsterIntent {
  pattern: MonsterPattern;
  name: string;
  description: string;
  from: Point;
  to: Point;
  attackTiles: Point[];
  damage: number;
}

export interface BattlePreview {
  combat: CombatSessionRow;
  player: SatPlayerRow;
  weapon: WeaponProfile;
  intent: MonsterIntent;
  playerMoveRange: number;
  legalMoves: Point[];
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
  return Math.min(3, 1 + Math.floor(bootBonus(player) / 3));
}

export function battleMovePoints(combat: CombatSessionRow, player: SatPlayerRow): number {
  return Math.max(0, Math.min(battleMoveRange(player), combat.battle_move_points ?? battleMoveRange(player)));
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

export function weaponFor(player: SatPlayerRow, weaponId?: string | null): WeaponProfile {
  const id = weaponId === undefined ? player.equipped_weapon : weaponId;
  const item = id ? ITEM_BY_ID.get(id) : null;
  const pattern = weaponPatternFor(item);
  const power = item?.power ?? 0;
  const damage = Math.max(5, Math.round(5 + power * 1.2));
  return {
    name: item?.name ?? "Training Dagger",
    emoji: item?.emoji ?? "🗡️",
    pattern,
    damage,
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
    case "dagger": return "1 tile toward the monster, high-risk";
    case "longsword": return "2 tiles in a straight line";
    case "hammer": return "2x2 impact near the monster";
    case "spear": return "3 tiles in a straight line";
    case "arc": return "3-tile cleave in front";
    case "star": return "diagonal star burst";
  }
}

export function attackDirection(from: Point, to: Point): Direction {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "right" : "left";
  return dy > 0 ? "down" : "up";
}

export function playerAttackTiles(from: Point, target: Point, weapon: WeaponProfile): Point[] {
  const dir = attackDirection(from, target);
  const d = DIR_DELTA[dir];
  const forward = (n: number) => ({ x: from.x + d.x * n, y: from.y + d.y * n });
  const lateral = dir === "up" || dir === "down" ? { x: 1, y: 0 } : { x: 0, y: 1 };

  const raw: Point[] = [];
  switch (weapon.pattern) {
    case "dagger":
      raw.push(forward(1));
      break;
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
    case "arc": {
      const center = forward(1);
      raw.push(center, { x: center.x + lateral.x, y: center.y + lateral.y }, { x: center.x - lateral.x, y: center.y - lateral.y });
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
  }
  return uniquePoints(raw.filter(inArena));
}

export function monsterIntent(combat: CombatSessionRow, player: SatPlayerRow): MonsterIntent {
  const monster = { x: combat.monster_battle_x, y: combat.monster_battle_y };
  const target = { x: combat.player_battle_x, y: combat.player_battle_y };
  const seed = hash(`${combat.monster_name}:${combat.monster_level}:${combat.turn_number}:${combat.enemy_x}:${combat.enemy_y}`);
  const pattern = monsterPatternFor(combat.monster_name, seed);
  const move = monsterStep(monster, target, pattern, seed);
  const to = {
    x: clampArena(monster.x + move.x),
    y: clampArena(monster.y + move.y),
  };
  const dir = attackDirection(to, target);
  const tiles = monsterAttackTiles(to, dir, pattern, seed);
  const damage = Math.max(3, 3 + combat.monster_level * 2);
  const name = monsterIntentName(pattern);
  return {
    pattern,
    name,
    description: monsterIntentDescription(pattern, move, dir),
    from: monster,
    to,
    attackTiles: tiles,
    damage,
  };
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

function monsterIntentName(pattern: MonsterPattern): string {
  switch (pattern) {
    case "line": return "Line Strike";
    case "cone": return "Raking Cone";
    case "slam": return "Ground Slam";
    case "dash": return "Dash Bite";
  }
}

function monsterIntentDescription(pattern: MonsterPattern, move: Point, dir: Direction): string {
  const moveText = move.x === 0 && move.y === 0
    ? "hold position"
    : `move ${move.x !== 0 ? Math.abs(move.x) : Math.abs(move.y)} ${move.x > 0 ? "east" : move.x < 0 ? "west" : move.y > 0 ? "south" : "north"}`;
  switch (pattern) {
    case "line": return `Will ${moveText}, then attack a straight ${dir} line.`;
    case "cone": return `Will ${moveText}, then bite in a ${dir}-facing cone.`;
    case "slam": return `Will ${moveText}, then slam all adjacent tiles.`;
    case "dash": return `Will ${moveText}, then lunge ${dir}.`;
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
