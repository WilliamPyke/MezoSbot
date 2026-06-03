import type { SatPlayerRow } from "./types.js";
import { ITEM_BY_ID } from "./towns.js";

/**
 * DnD-style ability cards. Gear grants cards; an action-point (AP) budget gates
 * how many you can play per round; cards apply status effects. Everything here is
 * pure data + small lookups — the actual tile geometry and resolution live in
 * battle.ts (which imports this module), so there is no runtime cycle back here.
 */

/* ─────────── status effects ─────────── */

export type StatusKind = "bleed" | "poison" | "burn" | "stun" | "chill" | "shield" | "empower";

export interface StatusEffect {
  kind: StatusKind;
  /** Magnitude: damage-per-round for DoTs, absorb pool for shield, bonus dmg for empower. */
  amount: number;
  /** Rounds remaining. Decremented at the end of each resolved round; dropped at 0. */
  turns: number;
}

export interface StatusMeta {
  kind: StatusKind;
  emoji: string;
  label: string;
  /** Damage-over-time (ticks each round on the bearer). */
  dot: boolean;
}

export const STATUS_META: Record<StatusKind, StatusMeta> = {
  bleed: { kind: "bleed", emoji: "🩸", label: "Bleed", dot: true },
  poison: { kind: "poison", emoji: "🟢", label: "Poison", dot: true },
  burn: { kind: "burn", emoji: "🔥", label: "Burn", dot: true },
  stun: { kind: "stun", emoji: "💫", label: "Stun", dot: false },
  chill: { kind: "chill", emoji: "❄️", label: "Chill", dot: false },
  shield: { kind: "shield", emoji: "🛡️", label: "Shield", dot: false },
  empower: { kind: "empower", emoji: "⚡", label: "Empower", dot: false },
};

/** Parse the persisted JSON status list, tolerating null/garbage. */
export function parseStatuses(raw: string | null | undefined): StatusEffect[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((s) => s && STATUS_META[s.kind as StatusKind] && Number.isFinite(s.amount) && Number.isFinite(s.turns) && s.turns > 0)
      .map((s) => ({ kind: s.kind as StatusKind, amount: Math.max(0, Math.trunc(s.amount)), turns: Math.max(0, Math.trunc(s.turns)) }));
  } catch {
    return [];
  }
}

export function serializeStatuses(list: StatusEffect[]): string {
  return JSON.stringify(list.filter((s) => s.turns > 0));
}

/** Total damage-per-round from all DoT (bleed/poison) stacks on a bearer. */
export function dotDamage(list: StatusEffect[]): number {
  return list.filter((s) => STATUS_META[s.kind].dot).reduce((sum, s) => sum + s.amount, 0);
}

export function totalOf(list: StatusEffect[], kind: StatusKind): number {
  return list.filter((s) => s.kind === kind).reduce((sum, s) => sum + s.amount, 0);
}

export function hasStatus(list: StatusEffect[], kind: StatusKind): boolean {
  return list.some((s) => s.kind === kind && s.turns > 0);
}

/** Add a status stack (kept separate so durations decay independently). */
export function addStatus(list: StatusEffect[], eff: StatusEffect): StatusEffect[] {
  if (eff.amount <= 0 || eff.turns <= 0) return list;
  return [...list, { ...eff }];
}

/** Decrement every status' duration by one round; drop the expired ones. */
export function decayStatuses(list: StatusEffect[]): StatusEffect[] {
  return list.map((s) => ({ ...s, turns: s.turns - 1 })).filter((s) => s.turns > 0);
}

/* ─────────── card definitions ─────────── */

/** Tile pattern a card paints, oriented toward the target. Resolved in battle.ts. */
export type AttackShape =
  | "line" | "longsword" | "spear" | "hammer" | "cleave" | "arc" | "star" | "slam" | "bolt" | "nova";

export type CardKind = "attack" | "buff";

export interface CardDef {
  id: string;
  name: string;
  emoji: string;
  apCost: number;
  kind: CardKind;
  /** Attack cards: the tile shape struck. Omitted for self-buff cards. */
  shape?: AttackShape;
  /** Base damage before weapon-power scaling and empower. Attack cards only. */
  damage?: number;
  /** Statuses applied — to the monster for attacks, to the player for buffs. */
  apply?: StatusEffect[];
  /** True for self-targeted buff cards (shield/empower). */
  self?: boolean;
  desc: string;
}

const st = (kind: StatusKind, amount: number, turns: number): StatusEffect => ({ kind, amount, turns });

/** Every card in the game, keyed by id. */
export const CARDS: CardDef[] = [
  /* baseline — available to everyone, no gear required */
  { id: "strike", name: "Strike", emoji: "🗡️", apCost: 1, kind: "attack", shape: "line", damage: 5, desc: "3 tiles straight toward the monster." },
  { id: "cleave", name: "Cleave", emoji: "🪓", apCost: 1, kind: "attack", shape: "cleave", damage: 4, desc: "3-tile arc in front." },
  { id: "guard", name: "Guard", emoji: "🛡️", apCost: 1, kind: "buff", self: true, apply: [st("shield", 8, 1)], desc: "Gain an 8-point shield this round." },

  /* weapon signature cards */
  { id: "longsword_slash", name: "Longsword Slash", emoji: "⚔️", apCost: 1, kind: "attack", shape: "longsword", damage: 7, desc: "2 tiles in a straight line." },
  { id: "spear_thrust", name: "Spear Thrust", emoji: "🔱", apCost: 2, kind: "attack", shape: "spear", damage: 8, apply: [st("bleed", 3, 3)], desc: "3-tile reach; inflicts Bleed (3 dmg/round, 3 rounds)." },
  { id: "hammer_smash", name: "Hammer Smash", emoji: "🔨", apCost: 2, kind: "attack", shape: "hammer", damage: 10, apply: [st("stun", 1, 1)], desc: "2×2 impact; Stuns the monster next round." },
  { id: "frost_cleave", name: "Frost Cleave", emoji: "🪓", apCost: 2, kind: "attack", shape: "arc", damage: 9, apply: [st("chill", 2, 2)], desc: "3-tile cleave; Chills the monster (-dmg, 2 rounds)." },
  { id: "royal_starburst", name: "Royal Starburst", emoji: "👑", apCost: 3, kind: "attack", shape: "star", damage: 16, desc: "Diagonal star burst — heavy damage." },

  /* armor signature cards */
  { id: "bulwark", name: "Bulwark", emoji: "🦾", apCost: 1, kind: "buff", self: true, apply: [st("shield", 14, 1)], desc: "Brace for a 14-point shield this round." },

  /* accessory signature cards */
  { id: "ember_bolt", name: "Ember Bolt", emoji: "🔥", apCost: 2, kind: "attack", shape: "bolt", damage: 9, desc: "Ranged bolt down a straight line — hits from afar." },
  { id: "aurora_ward", name: "Aurora Ward", emoji: "🌌", apCost: 2, kind: "buff", self: true, apply: [st("shield", 8, 1), st("empower", 4, 1)], desc: "Gain an 8-point shield and Empower your next strike (+4)." },
];

export const CARD_BY_ID = new Map<string, CardDef>(CARDS.map((c) => [c.id, c]));

/** Cards every player always has, regardless of gear. */
export const BASELINE_CARD_IDS = ["strike", "cleave", "guard"];

export function cardById(id: string | null | undefined): CardDef | null {
  return id ? CARD_BY_ID.get(id) ?? null : null;
}

/* ─────────── player kit / AP ─────────── */

export const BASE_AP = 3;

const EQUIP_SLOTS: Array<keyof SatPlayerRow> = ["equipped_weapon", "equipped_armor", "equipped_accessory", "equipped_boots"];

/** The card ids a player can play this fight: baseline + everything their gear grants. */
export function playerCardIds(player: SatPlayerRow): string[] {
  const ids = [...BASELINE_CARD_IDS];
  for (const slot of EQUIP_SLOTS) {
    const itemId = player[slot] as string | null;
    const item = itemId ? ITEM_BY_ID.get(itemId) : null;
    for (const cid of item?.cards ?? []) if (CARD_BY_ID.has(cid)) ids.push(cid);
  }
  return Array.from(new Set(ids));
}

export function playerKit(player: SatPlayerRow): CardDef[] {
  return playerCardIds(player).map((id) => CARD_BY_ID.get(id)!).filter(Boolean);
}

/** Base AP budget per round = BASE_AP + summed gear apBonus passives. */
export function basePlayerAP(player: SatPlayerRow): number {
  let ap = BASE_AP;
  for (const slot of EQUIP_SLOTS) {
    const itemId = player[slot] as string | null;
    const item = itemId ? ITEM_BY_ID.get(itemId) : null;
    ap += item?.passive?.apBonus ?? 0;
  }
  return ap;
}

/** AP actually available this round, after status penalties (Stun saps AP). */
export function effectivePlayerAP(player: SatPlayerRow, playerStatus: StatusEffect[]): number {
  return Math.max(0, basePlayerAP(player) - totalOf(playerStatus, "stun"));
}

/* ─────────── monster kits ─────────── */

export interface MonsterAbility {
  name: string;
  apply: StatusEffect[];
}

/**
 * A monster's signature debuff, by archetype (mirrors the name-bucketing in
 * battle.ts monsterPatternFor). The telegraphed tile geometry still comes from the
 * monster's movement pattern; this only names the strike and attaches its status.
 */
export function monsterAbility(monsterName: string): MonsterAbility {
  const name = monsterName.toLowerCase();
  if (name.includes("wolf") || name.includes("tiger") || name.includes("yeti")) {
    return { name: "Rend", apply: [st("bleed", 3, 3)] };
  }
  if (name.includes("golem") || name.includes("wraith") || name.includes("revenant")) {
    return { name: "Crushing Blow", apply: [st("stun", 1, 1)] };
  }
  if (name.includes("wyrm") || name.includes("dragon") || name.includes("drake") || name.includes("djinn")) {
    return { name: "Searing Breath", apply: [st("burn", 4, 3)] };
  }
  if (name.includes("naga") || name.includes("scorpion")) {
    return { name: "Venom Strike", apply: [st("poison", 4, 3)] };
  }
  return { name: "Savage Hit", apply: [] };
}
