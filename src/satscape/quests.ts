import { supabase } from "../db.js";
import { subtractBalance } from "../balance.js";
import { addToPool, payoutFromPool } from "./economy.js";
import { TOWN_BY_ID, type Town } from "./towns.js";

export type QuestType = "bounty" | "cartography" | "delivery" | "tribute";

export interface QuestDef {
  key: string;
  townId: string; // keeper that offers it
  type: QuestType;
  title: string;
  desc: string;
  target: number; // kills / tiles / (tribute: sats) ; delivery & discover use 1
  minLevel?: number; // bounty
  destTownId?: string; // delivery destination
  discoverTownId?: string; // cartography "discover X"
  reward: { sats?: number; rep: number; title?: string; unlocks?: string };
}

/** The keeper quest catalogue. */
export const QUESTS: QuestDef[] = [
  {
    key: "rest_cull",
    townId: "rest",
    type: "bounty",
    title: "Cull the Roads",
    desc: "Slay 3 monsters — the trade roads aren't safe.",
    target: 3,
    minLevel: 1,
    reward: { sats: 120, rep: 1 },
  },
  {
    key: "rest_invoice",
    townId: "rest",
    type: "delivery",
    title: "Invoice Run",
    desc: "Carry Hodlnaur's invoices to Jaipur. Time is sats.",
    target: 1,
    destTownId: "jaipur",
    reward: { sats: 150, rep: 2 },
  },
  {
    key: "jaipur_map",
    townId: "jaipur",
    type: "cartography",
    title: "Map the Monsoon",
    desc: "Chart 120 tiles of the eastern realm for Ravi.",
    target: 120,
    reward: { sats: 180, rep: 2, title: "Cartographer of Jaipur" },
  },
  {
    key: "jaipur_tiger",
    townId: "jaipur",
    type: "bounty",
    title: "Tiger Trouble",
    desc: "Slay 3 monsters of level 3+. Earn Ravi's trust — and his finest steel.",
    target: 3,
    minLevel: 3,
    reward: { sats: 100, rep: 3, unlocks: "Maharaja Blade" },
  },
  {
    key: "dustfall_find_frost",
    townId: "dustfall",
    type: "cartography",
    title: "Where's the Cold Bit?",
    desc: "Dougal swears there's a frozen town somewhere. Go find Frosthold.",
    target: 1,
    discoverTownId: "frosthold",
    reward: { sats: 250, rep: 2 }, // he overpays
  },
  {
    key: "frosthold_tribute",
    townId: "frosthold",
    type: "tribute",
    title: "Pay to Stay Warm",
    desc: "Donate 300 sats. Greta might even tolerate you.",
    target: 300,
    reward: { rep: 4 },
  },
  {
    key: "frosthold_wyrm",
    townId: "frosthold",
    type: "bounty",
    title: "Wyrm Contract",
    desc: "Slay 2 monsters of level 6+. Mercenary work pays.",
    target: 2,
    minLevel: 6,
    reward: { sats: 400, rep: 3, title: "Greta's Mercenary" },
  },
];

export const QUEST_BY_KEY = new Map(QUESTS.map((q) => [q.key, q]));

/* ─────────── reputation ─────────── */

export function repDiscountMul(rep: number): number {
  return Math.max(0.5, 1 - rep * 0.05); // 5% off per rep point, floored at -50%
}

export async function getRep(discordId: string, townId: string): Promise<number> {
  const { data } = await supabase
    .from("sat_keeper_rep")
    .select("rep")
    .eq("discord_id", discordId)
    .eq("town_id", townId)
    .maybeSingle();
  return data?.rep ?? 0;
}

async function addRep(discordId: string, townId: string, n: number): Promise<void> {
  const cur = await getRep(discordId, townId);
  await supabase
    .from("sat_keeper_rep")
    .upsert({ discord_id: discordId, town_id: townId, rep: cur + n }, { onConflict: "discord_id,town_id" });
}

/* ─────────── progress state ─────────── */

interface QuestRow {
  quest_key: string;
  status: "active" | "claimable" | "claimed";
  progress: number;
  progress_base: number;
}

async function getQuestRows(discordId: string): Promise<Map<string, QuestRow>> {
  const { data } = await supabase
    .from("sat_player_quests")
    .select("quest_key, status, progress, progress_base")
    .eq("discord_id", discordId);
  return new Map((data ?? []).map((r) => [r.quest_key as string, r as QuestRow]));
}

export async function getExploredCount(_discordId: string): Promise<number> {
  const { count } = await supabase
    .from("sat_world_explored")
    .select("*", { count: "exact", head: true });
  return count ?? 0;
}

export interface QuestView {
  def: QuestDef;
  status: "available" | "active" | "claimable" | "claimed";
  progress: number;
}

/** Quests offered by this town + the player's status on each, plus any other claimable quests. */
export async function questBoard(discordId: string, townId: string): Promise<{ offered: QuestView[]; carry: QuestView[] }> {
  const rows = await getQuestRows(discordId);
  const explored = await getExploredCount(discordId);

  const toView = (def: QuestDef): QuestView => {
    const row = rows.get(def.key);
    if (!row) return { def, status: "available", progress: 0 };
    let progress = row.progress;
    let status = row.status;
    if (def.type === "cartography" && def.target > 1 && status === "active") {
      progress = Math.min(def.target, explored - row.progress_base);
      if (progress >= def.target) status = "claimable";
    }
    return { def, status, progress };
  };

  const offered = QUESTS.filter((q) => q.townId === townId).map(toView);
  // active/claimable quests from *other* keepers, so you can claim deliveries etc. anywhere
  const carry = QUESTS.filter((q) => q.townId !== townId && rows.has(q.key))
    .map(toView)
    .filter((v) => v.status === "active" || v.status === "claimable");
  return { offered, carry };
}

/* ─────────── actions ─────────── */

export async function acceptQuest(discordId: string, key: string): Promise<{ ok: boolean; note: string }> {
  const def = QUEST_BY_KEY.get(key);
  if (!def) return { ok: false, note: "No such quest." };
  const rows = await getQuestRows(discordId);
  if (rows.has(key)) return { ok: false, note: "You're already on that quest." };
  const base = def.type === "cartography" && def.target > 1 ? await getExploredCount(discordId) : 0;
  await supabase.from("sat_player_quests").insert({ discord_id: discordId, quest_key: key, status: "active", progress: 0, progress_base: base });
  const extra = def.type === "delivery" ? " 📦 Deliver it by reaching the destination town." : "";
  return { ok: true, note: `📜 Accepted **${def.title}**.${extra}` };
}

export async function claimQuest(discordId: string, key: string): Promise<{ ok: boolean; note: string }> {
  const def = QUEST_BY_KEY.get(key);
  if (!def) return { ok: false, note: "No such quest." };
  const rows = await getQuestRows(discordId);
  const row = rows.get(key);
  if (!row) return { ok: false, note: "You haven't taken that quest." };

  // re-evaluate cartography-by-count at claim time
  let claimable = row.status === "claimable";
  if (def.type === "cartography" && def.target > 1 && row.status === "active") {
    claimable = (await getExploredCount(discordId)) - row.progress_base >= def.target;
  }
  if (!claimable) return { ok: false, note: "That quest isn't finished yet." };

  let granted = 0;
  if (def.reward.sats) granted = await payoutFromPool(discordId, def.reward.sats);
  await addRep(discordId, def.townId, def.reward.rep);
  await supabase.from("sat_player_quests").update({ status: "claimed" }).eq("discord_id", discordId).eq("quest_key", key);

  const bits = [granted > 0 ? `**${granted} sats**` : null, `+${def.reward.rep} rep`, def.reward.title ? `title *${def.reward.title}*` : null, def.reward.unlocks ? `unlocked **${def.reward.unlocks}**` : null].filter(Boolean);
  return { ok: true, note: `🏆 Completed **${def.title}** — ${bits.join(", ")}.` };
}

export async function payTribute(discordId: string, key: string): Promise<{ ok: boolean; note: string }> {
  const def = QUEST_BY_KEY.get(key);
  if (!def || def.type !== "tribute") return { ok: false, note: "No tribute to pay." };
  const rows = await getQuestRows(discordId);
  if (rows.get(key)?.status === "claimed") return { ok: false, note: "You've already paid tribute." };
  const paid = await subtractBalance(discordId, def.target);
  if (!paid) return { ok: false, note: `You need ${def.target} sats to pay tribute.` };
  await addToPool(def.target);
  await addRep(discordId, def.townId, def.reward.rep);
  await supabase
    .from("sat_player_quests")
    .upsert({ discord_id: discordId, quest_key: key, status: "claimed", progress: def.target, progress_base: 0 }, { onConflict: "discord_id,quest_key" });
  return { ok: true, note: `💰 Paid ${def.target} sats. +${def.reward.rep} rep with ${TOWN_BY_ID.get(def.townId)?.keeper.name}.` };
}

/* ─────────── event hooks (called from game.ts) ─────────── */

/** Advance bounty quests on a combat win. */
export async function onCombatWin(discordId: string, monsterLevel: number): Promise<void> {
  const rows = await getQuestRows(discordId);
  for (const def of QUESTS) {
    if (def.type !== "bounty") continue;
    const row = rows.get(def.key);
    if (!row || row.status !== "active") continue;
    if (monsterLevel < (def.minLevel ?? 1)) continue;
    const progress = row.progress + 1;
    const status = progress >= def.target ? "claimable" : "active";
    await supabase.from("sat_player_quests").update({ progress, status }).eq("discord_id", discordId).eq("quest_key", def.key);
  }
}

/** Complete delivery / discover quests on arriving in a town. */
export async function onArriveTown(discordId: string, town: Town): Promise<void> {
  const rows = await getQuestRows(discordId);
  for (const def of QUESTS) {
    const row = rows.get(def.key);
    if (!row || row.status !== "active") continue;
    const done =
      (def.type === "delivery" && def.destTownId === town.id) ||
      (def.type === "cartography" && def.discoverTownId === town.id);
    if (done) {
      await supabase.from("sat_player_quests").update({ status: "claimable", progress: def.target }).eq("discord_id", discordId).eq("quest_key", def.key);
    }
  }
}

/** Titles the player has earned from claimed quests. */
export async function titlesFor(discordId: string): Promise<string[]> {
  const { data } = await supabase.from("sat_player_quests").select("quest_key").eq("discord_id", discordId).eq("status", "claimed");
  return (data ?? [])
    .map((r) => QUEST_BY_KEY.get(r.quest_key as string)?.reward.title)
    .filter((t): t is string => !!t);
}
