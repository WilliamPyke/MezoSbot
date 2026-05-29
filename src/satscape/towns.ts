import type { ShopItem, ItemSlot } from "./items.js";
import type { SatPlayerRow } from "./types.js";

/* ─────────── terrain ─────────── */

export type Terrain =
  | "town"
  | "plains" | "forest" | "hills"
  | "jungle" | "monsoon" | "savanna"
  | "desert" | "canyon" | "oasis"
  | "snow" | "tundra" | "ice";

export const TERRAIN_COLOR: Record<Terrain, string> = {
  town: "#1e3a8a",
  plains: "#65a30d", forest: "#166534", hills: "#4d7c0f",
  jungle: "#15803d", monsoon: "#0e7490", savanna: "#ca8a04",
  desert: "#d97706", canyon: "#b45309", oasis: "#0d9488",
  snow: "#e2e8f0", tundra: "#94a3b8", ice: "#67e8f9",
};

/* ─────────── keepers ─────────── */

export type KeeperPersona = "business" | "fair" | "greedy" | "bargain";

export interface Keeper {
  name: string;
  persona: KeeperPersona;
  blurb: string;
}

/** Price a keeper charges for an item: persona quirk × reputation discount. */
export function effectivePrice(item: ShopItem, keeper: Keeper, rep = 0): number {
  let base: number;
  switch (keeper.persona) {
    case "business": base = item.price * 1.25; break;
    case "greedy": base = item.price * 1.4; break;
    case "bargain": {
      // "Miscounts" — half the stock is deterministically half-price.
      let h = 0;
      for (const ch of item.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      base = h % 2 === 0 ? item.price * 0.5 : item.price;
      break;
    }
    case "fair":
    default:
      base = item.price;
  }
  const repMul = Math.max(0.5, 1 - rep * 0.05); // 5% off per rep point, floored at -50%
  return Math.round(base * repMul);
}

/* ─────────── towns ─────────── */

export interface Town {
  id: string;
  name: string;
  cx: number;
  cy: number;
  safeRadius: number; // tiles of safe zone around the centre
  identity: string;
  palette: [Terrain, Terrain, Terrain]; // biomes filling this town's territory
  monsterColor: string; // sprite tint for this territory's monsters
  monsters: string[];
  keeper: Keeper;
  catalog: ShopItem[];
}

type GearCatalogSlot = Exclude<ItemSlot, "boots">;

/** Build a town's themed 3-item gear catalogue (boots are added separately). */
function catalog(townId: string, power: number, price: number, names: Record<GearCatalogSlot, string>, emoji: Record<GearCatalogSlot, string>): ShopItem[] {
  return (["weapon", "armor", "accessory"] as GearCatalogSlot[]).map((slot) => ({
    id: `${townId}_${slot}`,
    name: names[slot],
    slot,
    power,
    price,
    emoji: emoji[slot],
  }));
}

export const TOWNS: Town[] = [
  {
    id: "rest",
    name: "Satoshi's Rest",
    cx: 127, cy: 111, safeRadius: 12,
    identity: "The temperate starter town — rolling plains, woods and hills.",
    palette: ["plains", "forest", "hills"],
    monsterColor: "#6b7280",
    monsters: ["Highway Bandit", "Dire Wolf", "Stone Golem"],
    keeper: { name: "Hodlnaur", persona: "business", blurb: "Time is sats. What'll it be?" },
    catalog: [
      ...catalog("rest", 3, 40,
        { weapon: "Iron Shortsword", armor: "Town Guard Vest", accessory: "Copper Band" },
        { weapon: "🗡️", armor: "🦺", accessory: "💍" }),
      { id: "rest_boots", name: "Worn Boots", slot: "boots", power: 0, price: 60, emoji: "🥾", stepBonus: 1, rarity: "common" },
    ],
  },
  {
    id: "jaipur",
    name: "Jaipur",
    cx: 185, cy: 66, safeRadius: 14,
    identity: "A vast eastern realm of jungle, monsoon wetlands and golden savanna.",
    palette: ["jungle", "monsoon", "savanna"],
    monsterColor: "#b45309",
    monsters: ["Bengal Tiger", "Rakshasa Fiend", "River Naga"],
    keeper: { name: "Ravi the Fair", persona: "fair", blurb: "Browse freely, traveller. Honest prices here." },
    catalog: [
      ...catalog("jaipur", 6, 160,
        { weapon: "Tiger Talwar", armor: "Silk-Steel Kurta", accessory: "Jade Tilak" },
        { weapon: "⚔️", armor: "🥋", accessory: "🟢" }),
      { id: "jaipur_boots", name: "Trail Sandals", slot: "boots", power: 0, price: 200, emoji: "👡", stepBonus: 3, rarity: "uncommon" },
      // unlocked by the "Tiger Trouble" quest (rep ≥ 3)
      { id: "jaipur_unlock", name: "Maharaja Blade", slot: "weapon", power: 15, price: 1200, emoji: "👑", repReq: 3 },
    ],
  },
  {
    id: "dustfall",
    name: "Dustfall",
    cx: 27, cy: 97, safeRadius: 14,
    identity: "A sun-blasted expanse of desert, slot canyons and rare oases.",
    palette: ["desert", "canyon", "oasis"],
    monsterColor: "#a16207",
    monsters: ["Sand Wraith", "Dune Scorpion", "Mirage Djinn"],
    keeper: { name: "Dim Dougal", persona: "bargain", blurb: "Uhh… prices are whatever. Two-for-one? Sure, why not!" },
    catalog: [
      ...catalog("dustfall", 8, 320,
        { weapon: "Scorpion Khopesh", armor: "Sun-Baked Plate", accessory: "Mirage Charm" },
        { weapon: "🪒", armor: "🪖", accessory: "🟡" }),
      { id: "dustfall_boots", name: "Sand-Strider Greaves", slot: "boots", power: 0, price: 450, emoji: "🩴", stepBonus: 5, rarity: "rare" },
    ],
  },
  {
    id: "frosthold",
    name: "Frosthold",
    cx: 31, cy: 59, safeRadius: 14,
    identity: "A frozen north of snowfields, frostbitten tundra and blue ice.",
    palette: ["snow", "tundra", "ice"],
    monsterColor: "#7c3aed",
    monsters: ["Frost Wyrm", "Ice Revenant", "Yeti"],
    keeper: { name: "Greta the Greedy", persona: "greedy", blurb: "Everything's for sale… at a price you'll hate." },
    catalog: [
      ...catalog("frosthold", 11, 640,
        { weapon: "Frostfang Axe", armor: "Yeti-Hide Coat", accessory: "Aurora Pendant" },
        { weapon: "🪓", armor: "🧥", accessory: "🔵" }),
      { id: "frosthold_boots", name: "Sprinter's Plate", slot: "boots", power: 0, price: 900, emoji: "🥾", stepBonus: 7, rarity: "legendary" },
    ],
  },
];

export const TOWN_BY_ID = new Map(TOWNS.map((t) => [t.id, t]));

/* ─────────── item lookup (built from every town catalogue) ─────────── */

export const ALL_ITEMS: ShopItem[] = TOWNS.flatMap((t) => t.catalog);
export const ITEM_BY_ID = new Map(ALL_ITEMS.map((i) => [i.id, i]));

export function itemPower(id: string | null | undefined): number {
  return id ? ITEM_BY_ID.get(id)?.power ?? 0 : 0;
}

export function gearScore(player: SatPlayerRow): number {
  return itemPower(player.equipped_weapon) + itemPower(player.equipped_armor) + itemPower(player.equipped_accessory);
}

/** Extra tiles per directional press granted by the equipped boots, if any. */
export function bootBonus(player: SatPlayerRow): number {
  const id = player.equipped_boots;
  if (!id) return 0;
  return ITEM_BY_ID.get(id)?.stepBonus ?? 0;
}

/* ─────────── geography ─────────── */

/** Nearest town to a coordinate (Voronoi ownership) and the distance to it. */
export function nearestTown(x: number, y: number): { town: Town; dist: number } {
  let best = TOWNS[0];
  let bestD = Infinity;
  for (const t of TOWNS) {
    const d = Math.hypot(x - t.cx, y - t.cy);
    if (d < bestD) { bestD = d; best = t; }
  }
  return { town: best, dist: bestD };
}

/** The town whose safe zone you're standing in, or null if you're in the wilds. */
export function townAt(x: number, y: number): Town | null {
  const { town, dist } = nearestTown(x, y);
  return dist <= town.safeRadius ? town : null;
}
