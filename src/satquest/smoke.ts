/**
 * SatQuest economy smoke test — runs the real game functions against the real
 * Supabase DB (and the SQL RPCs), asserting the core invariants hold:
 *
 *   • sats are conserved: player balance + prize pool stays constant
 *   • balance never goes negative
 *   • a chest/monster never pays out more than the pool holds
 *   • faint warps to town (0,0), restores hunger, and clears combat
 *
 * It uses a throwaway player + a far-off world region, then restores the global
 * prize pool and deletes everything it created, so it's safe to re-run and
 * leaves no trace on a shared dev DB.
 *
 * HOW TO RUN (from the repo root, with your normal .env in place):
 *
 *     npx tsx src/satquest/smoke.ts
 *
 * Exit code 0 = all green, 1 = at least one assertion failed.
 *
 * NOTE: run this against a DEV database, and ideally when no one is actively
 * playing — the conservation check assumes this player is the only thing moving
 * sats in/out of the shared pool during the run.
 */
import { supabase } from "../db.js";
import { addBalance, getBalance, getOrCreateUser } from "../balance.js";
import { SAT, biomeAt, ensureEntityAt } from "./engine.js";
import {
  attack,
  chargeBuyIn,
  eat,
  faint,
  flee,
  move,
} from "./game.js";
import { getCombat, getPlayer, startRun, updatePlayer } from "./db.js";

const TEST_ID = `smoke-${Date.now()}`;
const START_BALANCE = 1000;
const REGION_X = 10000; // far outside town; scanned for spawns, cleaned up after

let passes = 0;
let failures = 0;

function ok(cond: boolean, msg: string) {
  if (cond) {
    passes++;
    console.log(`  ✓ ${msg}`);
  } else {
    failures++;
    console.error(`  ✗ ${msg}`);
  }
}

async function readPool(): Promise<number> {
  const { data } = await supabase.from("sat_prize_pool").select("balance_sats").eq("id", 1).single();
  return data?.balance_sats ?? 0;
}

/** Assert player balance + pool equals the invariant total (sats conserved). */
async function conserved(total: number, label: string) {
  const [bal, pool] = await Promise.all([getBalance(TEST_ID), readPool()]);
  ok(Math.abs(bal + pool - total) < 1e-6, `${label}: balance+pool conserved (${bal} + ${pool} == ${total})`);
  ok(bal >= 0, `${label}: balance is non-negative (${bal})`);
}

async function findSpawn(want: "monster" | "chest"): Promise<{ x: number; y: number } | null> {
  for (let i = 0; i < 600; i++) {
    const x = REGION_X + i;
    const y = 0;
    if (biomeAt(x, y) === "town") continue;
    const e = await ensureEntityAt(x, y);
    if (e && e.entity_type === want) return { x, y };
  }
  return null;
}

async function main() {
  console.log(`\nSatQuest smoke test — player ${TEST_ID}\n`);

  // ── setup ──────────────────────────────────────────────────────────────
  await getOrCreateUser(TEST_ID);
  await addBalance(TEST_ID, START_BALANCE);
  const poolBefore = await readPool();
  const TOTAL = START_BALANCE + poolBefore; // invariant for this player + pool
  console.log(`Setup: balance=${START_BALANCE}, pool=${poolBefore}, invariant total=${TOTAL}\n`);

  // ── buy-in ─────────────────────────────────────────────────────────────
  console.log("1. Buy-in / join");
  const paid = await chargeBuyIn(TEST_ID);
  ok(paid, "chargeBuyIn returned true");
  ok((await getBalance(TEST_ID)) === START_BALANCE - SAT.BUYIN_SATS, `balance debited by buy-in (${SAT.BUYIN_SATS})`);
  ok((await readPool()) === poolBefore + SAT.BUYIN_SATS, "buy-in seeded the pool");
  await startRun(TEST_ID);
  await conserved(TOTAL, "after buy-in");

  // ── plain move (town, no entity) ─────────────────────────────────────────
  console.log("\n2. Move within town");
  await updatePlayer(TEST_ID, { x_coord: 0, y_coord: 0, hunger: 100, state: "idle" });
  const balBeforeMove = await getBalance(TEST_ID);
  await move(TEST_ID, "up");
  let p = await getPlayer(TEST_ID);
  ok(p?.y_coord === -1 && p?.x_coord === 0, "moved up to (0,-1)");
  ok(p?.hunger === 99, "hunger dropped by 1");
  ok((await getBalance(TEST_ID)) === balBeforeMove, "balance unchanged while fed");
  await conserved(TOTAL, "after move");

  // ── starvation (hunger 0 → step burns 1 sat to pool) ─────────────────────
  console.log("\n3. Starvation");
  await updatePlayer(TEST_ID, { x_coord: 0, y_coord: 0, hunger: 0, state: "idle" });
  const balBeforeStarve = await getBalance(TEST_ID);
  await move(TEST_ID, "down");
  ok((await getBalance(TEST_ID)) === balBeforeStarve - 1, "starving step burned 1 sat");
  await conserved(TOTAL, "after starvation");

  // ── eat (costs sats → pool, restores hunger only) ────────────────────────
  console.log("\n4. Eat bread");
  await updatePlayer(TEST_ID, { hunger: 10 });
  const balBeforeEat = await getBalance(TEST_ID);
  const eatRes = await eat(TEST_ID);
  ok(eatRes.ok, "eat succeeded");
  p = await getPlayer(TEST_ID);
  ok((p?.hunger ?? 0) > 10, "hunger restored");
  ok((await getBalance(TEST_ID)) === balBeforeEat - 1, "bread cost 1 sat (HP not minted)");
  await conserved(TOTAL, "after eat");

  // ── combat (monster drains sats to pool; win pays from pool) ─────────────
  console.log("\n5. Combat");
  const monster = await findSpawn("monster");
  if (!monster) {
    ok(false, "could not find a monster spawn to test combat");
  } else {
    await updatePlayer(TEST_ID, { x_coord: monster.x - 1, y_coord: monster.y, hunger: 100, state: "idle" });
    await move(TEST_ID, "right"); // step onto the monster tile
    p = await getPlayer(TEST_ID);
    const combat = await getCombat(TEST_ID);
    ok(p?.state === "combat" && !!combat, `combat started vs ${combat?.monster_name ?? "?"}`);
    await conserved(TOTAL, "combat start");

    let guard = 0;
    while ((await getCombat(TEST_ID)) && guard++ < 100) {
      await attack(TEST_ID);
      await conserved(TOTAL, `combat round ${guard}`);
      if ((await getBalance(TEST_ID)) <= 0) break;
    }
    p = await getPlayer(TEST_ID);
    if (p?.state === "combat") await flee(TEST_ID); // safety net if it ran long
    ok((await getCombat(TEST_ID)) === null, "combat session resolved");
    ok((await getPlayer(TEST_ID))?.state === "idle", "player returned to idle after combat");
  }

  // ── chest (payout capped to pool) ────────────────────────────────────────
  console.log("\n6. Chest");
  const chest = await findSpawn("chest");
  if (!chest) {
    ok(false, "could not find a chest spawn to test loot");
  } else {
    const pool = await readPool();
    await updatePlayer(TEST_ID, { x_coord: chest.x - 1, y_coord: chest.y, hunger: 100, state: "idle" });
    const balBeforeChest = await getBalance(TEST_ID);
    await move(TEST_ID, "right"); // step onto the chest
    const gained = (await getBalance(TEST_ID)) - balBeforeChest;
    ok(gained >= 0 && gained <= pool, `chest payout (${gained}) did not exceed pool (${pool})`);
    ok((await ensureEntityAt(chest.x, chest.y)) === null, "chest tile cleared (no respawn)");
    await conserved(TOTAL, "after chest");
  }

  // ── faint (fixed penalty → pool, warp to town) ───────────────────────────
  console.log("\n7. Faint");
  await updatePlayer(TEST_ID, { x_coord: 42, y_coord: 42, hunger: 30 });
  await faint(TEST_ID);
  p = await getPlayer(TEST_ID);
  ok(p?.x_coord === 0 && p?.y_coord === 0, "warped to town (0,0)");
  ok(p?.hunger === 100, "hunger restored on faint");
  ok(p?.state === "idle", "state reset to idle");
  ok((await getCombat(TEST_ID)) === null, "no lingering combat after faint");
  await conserved(TOTAL, "after faint");

  // ── cleanup ──────────────────────────────────────────────────────────────
  console.log("\nCleanup");
  await supabase.from("sat_world_entities").delete().gte("x", REGION_X).lt("x", REGION_X + 600);
  await supabase.from("sat_prize_pool").update({ balance_sats: poolBefore }).eq("id", 1); // restore global pool
  await supabase.from("users").delete().eq("discord_id", TEST_ID); // cascades to sat_* rows
  console.log("  restored prize pool and removed test data");

  // ── summary ────────────────────────────────────────────────────────────
  console.log(`\n${failures === 0 ? "✅ PASS" : "❌ FAIL"} — ${passes} passed, ${failures} failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\n💥 smoke test crashed:", err);
  process.exit(1);
});
