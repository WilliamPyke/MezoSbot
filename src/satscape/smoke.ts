/**
 * SatScape economy smoke test — runs the real game functions against the real
 * Supabase DB (and the SQL RPCs), asserting the core invariants hold:
 *
 *   • sats are conserved: player balance + prize pool stays constant
 *   • balance never goes negative
 *   • a chest/monster never pays out more than the pool holds
 *   • faint warps to town (0,0), restores stamina, and clears combat
 *   • fast travel charges the estimated bread cost and lands you on the tile
 *
 * It uses a throwaway player + a far-off world region, then restores the global
 * prize pool and deletes everything it created, so it's safe to re-run and
 * leaves no trace.
 *
 * HOW TO RUN (from the repo root, with your normal .env in place):
 *
 *     npm run satscape:smoke
 *
 * Exit code 0 = all green, 1 = at least one assertion failed.
 *
 * NOTE: run when no one else is actively playing — the conservation check
 * assumes this player is the only thing moving sats in/out of the shared pool.
 */
import { supabase } from "../db.js";
import { addBalance, getBalance, getOrCreateUser } from "../balance.js";
import { SAT, biomeAt, entityAt } from "./engine.js";
import { attack, chargeBuyIn, eat, estimateTravel, faint, flee, move, travelTo } from "./game.js";
import { getCombat, getPlayer, isTileCleared, startRun, updatePlayer } from "./db.js";

const TEST_ID = `smoke-${Date.now()}`;
const START_BALANCE = 1000;
const REGION_X = 10000; // far outside town; cleaned up after

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

async function conserved(total: number, label: string) {
  const [bal, pool] = await Promise.all([getBalance(TEST_ID), readPool()]);
  ok(Math.abs(bal + pool - total) < 1e-6, `${label}: balance+pool conserved (${bal} + ${pool} == ${total})`);
  ok(bal >= 0, `${label}: balance is non-negative (${bal})`);
}

/** Deterministic scan for a tile of the wanted kind (or empty), skipping cleared/town. */
async function findTile(want: "monster" | "chest" | "empty", y: number): Promise<{ x: number; y: number } | null> {
  for (let i = 0; i < 800; i++) {
    const x = REGION_X + i;
    if (biomeAt(x, y) === "town") continue;
    if (await isTileCleared(x, y)) continue;
    const e = entityAt(x, y);
    if (want === "empty" ? e === null : e?.type === want) return { x, y };
  }
  return null;
}

async function main() {
  console.log(`\nSatScape smoke test — player ${TEST_ID}\n`);

  await getOrCreateUser(TEST_ID);
  await addBalance(TEST_ID, START_BALANCE);
  const poolBefore = await readPool();
  const TOTAL = START_BALANCE + poolBefore;
  console.log(`Setup: balance=${START_BALANCE}, pool=${poolBefore}, invariant total=${TOTAL}\n`);

  // 1. Buy-in
  console.log("1. Buy-in / join");
  ok(await chargeBuyIn(TEST_ID), "chargeBuyIn returned true");
  ok((await getBalance(TEST_ID)) === START_BALANCE - SAT.BUYIN_SATS, `balance debited by buy-in (${SAT.BUYIN_SATS})`);
  ok((await readPool()) === poolBefore + SAT.BUYIN_SATS, "buy-in seeded the pool");
  await startRun(TEST_ID);
  await conserved(TOTAL, "after buy-in");

  // 2. Move within town
  console.log("\n2. Move within town");
  await updatePlayer(TEST_ID, { x_coord: 0, y_coord: 0, hunger: 100, state: "idle" });
  const balBeforeMove = await getBalance(TEST_ID);
  await move(TEST_ID, "up");
  let p = await getPlayer(TEST_ID);
  ok(p?.y_coord === -1 && p?.x_coord === 0, "moved up to (0,-1)");
  ok(p?.hunger === 99, "stamina dropped by 1");
  ok((await getBalance(TEST_ID)) === balBeforeMove, "balance unchanged while rested");
  await conserved(TOTAL, "after move");

  // 3. Exhaustion
  console.log("\n3. Exhaustion (stamina 0)");
  await updatePlayer(TEST_ID, { x_coord: 0, y_coord: 0, hunger: 0, state: "idle" });
  const balBeforeStarve = await getBalance(TEST_ID);
  await move(TEST_ID, "down");
  ok((await getBalance(TEST_ID)) === balBeforeStarve - 1, "exhausted step burned 1 sat");
  await conserved(TOTAL, "after exhaustion");

  // 4. Eat
  console.log("\n4. Eat bread");
  await updatePlayer(TEST_ID, { hunger: 10 });
  const balBeforeEat = await getBalance(TEST_ID);
  ok((await eat(TEST_ID)).ok, "eat succeeded");
  p = await getPlayer(TEST_ID);
  ok((p?.hunger ?? 0) > 10, "stamina restored");
  ok((await getBalance(TEST_ID)) === balBeforeEat - 1, "bread cost 1 sat (HP not minted)");
  await conserved(TOTAL, "after eat");

  // 5. Combat
  console.log("\n5. Combat");
  const monster = await findTile("monster", 0);
  if (!monster) {
    ok(false, "could not find a monster spawn");
  } else {
    await updatePlayer(TEST_ID, { x_coord: monster.x - 1, y_coord: monster.y, hunger: 100, state: "idle" });
    await move(TEST_ID, "right");
    const combat = await getCombat(TEST_ID);
    ok((await getPlayer(TEST_ID))?.state === "combat" && !!combat, `combat started vs ${combat?.monster_name ?? "?"}`);
    await conserved(TOTAL, "combat start");
    let guard = 0;
    while ((await getCombat(TEST_ID)) && guard++ < 100) {
      await attack(TEST_ID);
      await conserved(TOTAL, `combat round ${guard}`);
      if ((await getBalance(TEST_ID)) <= 0) break;
    }
    if ((await getPlayer(TEST_ID))?.state === "combat") await flee(TEST_ID);
    ok((await getCombat(TEST_ID)) === null, "combat session resolved");
    ok((await getPlayer(TEST_ID))?.state === "idle", "player idle after combat");
    ok(await isTileCleared(monster.x, monster.y), "slain monster tile cleared (no respawn)");
  }

  // 6. Chest
  console.log("\n6. Chest");
  const chest = await findTile("chest", 0);
  if (!chest) {
    ok(false, "could not find a chest spawn");
  } else {
    const pool = await readPool();
    await updatePlayer(TEST_ID, { x_coord: chest.x - 1, y_coord: chest.y, hunger: 100, state: "idle" });
    const before = await getBalance(TEST_ID);
    await move(TEST_ID, "right");
    const gained = (await getBalance(TEST_ID)) - before;
    ok(gained >= 0 && gained <= pool, `chest payout (${gained}) did not exceed pool (${pool})`);
    ok(await isTileCleared(chest.x, chest.y), "chest tile cleared (no respawn)");
    await conserved(TOTAL, "after chest");
  }

  // 7. Fast travel (bread-funded)
  console.log("\n7. Fast travel");
  const dest = await findTile("empty", 500);
  if (!dest) {
    ok(false, "could not find an empty destination tile");
  } else {
    await updatePlayer(TEST_ID, { x_coord: dest.x - 30, y_coord: dest.y, hunger: 5, state: "idle" });
    const player = (await getPlayer(TEST_ID))!;
    const est = estimateTravel(player, dest.x, dest.y);
    ok(est.steps === 30, `estimate: 30 steps (got ${est.steps})`);
    ok(est.breadNeeded === Math.ceil((30 - 5) / SAT.BREAD_STAMINA), `estimate: ${est.breadNeeded} bread for the overflow`);
    const before = await getBalance(TEST_ID);
    const poolBeforeTravel = await readPool();
    await travelTo(TEST_ID, dest.x, dest.y);
    p = await getPlayer(TEST_ID);
    ok(p?.x_coord === dest.x && p?.y_coord === dest.y, "arrived at destination");
    ok((await getBalance(TEST_ID)) === before - est.satCost, `charged the bread cost (${est.satCost} sats)`);
    ok((await readPool()) === poolBeforeTravel + est.satCost, "travel cost flowed to the pool");
    await conserved(TOTAL, "after travel");
  }

  // 8. Faint
  console.log("\n8. Faint");
  await updatePlayer(TEST_ID, { x_coord: 42, y_coord: 42, hunger: 30 });
  await faint(TEST_ID);
  p = await getPlayer(TEST_ID);
  ok(p?.x_coord === 0 && p?.y_coord === 0, "warped to town (0,0)");
  ok(p?.hunger === 100, "stamina restored on faint");
  ok(p?.state === "idle", "state reset to idle");
  ok((await getCombat(TEST_ID)) === null, "no lingering combat after faint");
  await conserved(TOTAL, "after faint");

  // Cleanup
  console.log("\nCleanup");
  await supabase.from("sat_world_entities").delete().gte("x", REGION_X).lt("x", REGION_X + 800);
  await supabase.from("sat_prize_pool").update({ balance_sats: poolBefore }).eq("id", 1);
  await supabase.from("users").delete().eq("discord_id", TEST_ID);
  console.log("  restored prize pool and removed test data");

  console.log(`\n${failures === 0 ? "✅ PASS" : "❌ FAIL"} — ${passes} passed, ${failures} failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\n💥 smoke test crashed:", err);
  process.exit(1);
});
