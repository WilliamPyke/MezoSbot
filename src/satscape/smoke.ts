/**
 * SatScape economy smoke test — runs the real game functions against the real
 * Supabase DB (and the SQL RPCs), asserting the core invariants hold:
 *
 *   • sats are conserved: player balance + prize pool stays constant
 *   • balance never goes negative
 *   • combat is a win-chance roll (gear vs level), not HP attrition
 *   • shop purchases & equipping shift the win chance; cost flows to the pool
 *   • chest/fast-travel/faint behave and stay within the closed loop
 *
 * Uses a throwaway player + a far-off world region, then restores the global
 * prize pool and deletes everything it created.
 *
 * HOW TO RUN (from the repo root, with your normal .env in place):
 *
 *     npm run satscape:smoke
 *
 * Exit code 0 = all green, 1 = at least one assertion failed.
 * Run when no one else is actively playing (shared-pool conservation check).
 */
import { supabase } from "../db.js";
import { addBalance, getBalance, getOrCreateUser } from "../balance.js";
import { SAT, biomeAt, entityAt } from "./engine.js";
import {
  buyItem,
  chargeBuyIn,
  eat,
  equipItem,
  estimateTravel,
  faint,
  fight,
  flee,
  move,
  travelCost,
  travelTo,
} from "./game.js";
import { getCombat, getPlayer, isTileCleared, startRun, updatePlayer } from "./db.js";
import { lossFor, winChance } from "./items.js";
import { gearScore, nearestTown } from "./towns.js";

const TEST_ID = `smoke-${Date.now()}`;
const START_BALANCE = 2000;
const REGION_X = 10000;

let passes = 0;
let failures = 0;

function ok(cond: boolean, msg: string) {
  if (cond) { passes++; console.log(`  ✓ ${msg}`); }
  else { failures++; console.error(`  ✗ ${msg}`); }
}

async function readPool(): Promise<number> {
  const { data } = await supabase.from("sat_prize_pool").select("balance_sats").eq("id", 1).single();
  return data?.balance_sats ?? 0;
}

async function conserved(total: number, label: string) {
  const [bal, pool] = await Promise.all([getBalance(TEST_ID), readPool()]);
  ok(Math.abs(bal + pool - total) < 1e-6, `${label}: balance+pool conserved (${bal} + ${pool} == ${total})`);
  ok(bal >= 0, `${label}: balance non-negative (${bal})`);
}

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
  const realRandom = Math.random;

  await getOrCreateUser(TEST_ID);
  await addBalance(TEST_ID, START_BALANCE);
  const poolBefore = await readPool();
  const TOTAL = START_BALANCE + poolBefore;
  console.log(`Setup: balance=${START_BALANCE}, pool=${poolBefore}, invariant total=${TOTAL}\n`);

  // 0. Win-chance math
  console.log("0. Combat math");
  ok(Math.abs(winChance(0, 1) - 0.45) < 1e-9, "winChance(0, lv1) == 45%");
  ok(winChance(1000, 1) === 0.95, "winChance clamps up to 95%");
  ok(winChance(0, 100) === 0.05, "winChance clamps down to 5%");
  ok(lossFor(3) === 34, "lossFor(3) == 34");

  // 1. Buy-in
  console.log("\n1. Buy-in / join");
  ok(await chargeBuyIn(TEST_ID), "chargeBuyIn returned true");
  ok((await readPool()) === poolBefore + SAT.BUYIN_SATS, "buy-in seeded the pool");
  await startRun(TEST_ID);
  await conserved(TOTAL, "after buy-in");

  // 2. Move + exhaustion
  console.log("\n2. Move & exhaustion");
  await updatePlayer(TEST_ID, { x_coord: 0, y_coord: 0, hunger: 1, state: "idle" });
  await move(TEST_ID, "up");
  ok((await getPlayer(TEST_ID))?.hunger === 0, "stamina drained to 0");
  const balPreStarve = await getBalance(TEST_ID);
  await move(TEST_ID, "down");
  ok((await getBalance(TEST_ID)) === balPreStarve - 1, "exhausted step burned 1 sat");
  await conserved(TOTAL, "after exhaustion");
  const { count: explored } = await supabase
    .from("sat_explored").select("*", { count: "exact", head: true }).eq("discord_id", TEST_ID);
  ok((explored ?? 0) > 0, `fog: ${explored} tiles revealed after moving`);

  // 3. Eat
  console.log("\n3. Eat bread");
  await updatePlayer(TEST_ID, { hunger: 10 });
  const balPreEat = await getBalance(TEST_ID);
  ok((await eat(TEST_ID)).ok, "eat succeeded");
  ok(((await getPlayer(TEST_ID))?.hunger ?? 0) > 10, "stamina restored");
  ok((await getBalance(TEST_ID)) === balPreEat - 1, "bread cost 1 sat");
  await conserved(TOTAL, "after eat");

  // 4. Shop & gear (town-exclusive, keeper pricing)
  console.log("\n4. Shop & gear");
  await updatePlayer(TEST_ID, { x_coord: 0, y_coord: 0, state: "idle", equipped_weapon: null });
  const balPreBuy = await getBalance(TEST_ID);
  const poolPreBuy = await readPool();
  const buy = await buyItem(TEST_ID, "rest_weapon"); // +3, base 40, business keeper x1.25 = 50
  ok(buy.ok, "bought rest_weapon in spawn town");
  ok((await getBalance(TEST_ID)) === balPreBuy - 50, "shop debited keeper price (50, marked up)");
  ok((await readPool()) === poolPreBuy + 50, "purchase flowed to the pool");
  ok((await equipItem(TEST_ID, "rest_weapon")).ok, "equipped rest_weapon");
  let p = await getPlayer(TEST_ID);
  ok(p?.equipped_weapon === "rest_weapon" && gearScore(p) === 3, "gear score is 3 after equip");
  ok(winChance(gearScore(p!), 1) > winChance(0, 1), "equipped gear raised win chance");
  ok(!(await buyItem(TEST_ID, "jaipur_weapon")).ok, "spawn keeper doesn't stock Jaipur gear (town-exclusive)");
  await updatePlayer(TEST_ID, { x_coord: REGION_X + 5, y_coord: 9999, state: "idle" }); // wilds
  ok(!(await buyItem(TEST_ID, "rest_weapon")).ok, "shop refused outside town");
  await conserved(TOTAL, "after shop");

  // 5. Combat — forced WIN then forced LOSS via deterministic RNG
  console.log("\n5. Combat");
  const mWin = await findTile("monster", 0);
  if (!mWin) {
    ok(false, "no monster tile for win test");
  } else {
    await updatePlayer(TEST_ID, { x_coord: mWin.x - 1, y_coord: mWin.y, hunger: 100, state: "idle" });
    await move(TEST_ID, "right");
    const c = await getCombat(TEST_ID);
    ok(!!c && c.monster_level >= 1, `combat started (lv ${c?.monster_level}) vs ${c?.monster_name}`);
    Math.random = () => 0; // always below win chance → win
    const before = await getBalance(TEST_ID);
    const pool = await readPool();
    const res = await fight(TEST_ID);
    Math.random = realRandom;
    const gained = (await getBalance(TEST_ID)) - before;
    ok(res.ok && (await getCombat(TEST_ID)) === null, "forced win cleared combat");
    ok((await getPlayer(TEST_ID))?.state === "idle", "idle after win");
    ok(await isTileCleared(mWin.x, mWin.y), "won monster tile cleared");
    ok(gained >= 0 && gained <= pool, `loot (${gained}) capped to pool (${pool})`);
    await conserved(TOTAL, "after win");
  }

  const mLose = await findTile("monster", 17);
  if (!mLose) {
    ok(false, "no monster tile for loss test");
  } else {
    await updatePlayer(TEST_ID, { x_coord: mLose.x - 1, y_coord: mLose.y, hunger: 100, state: "idle" });
    await move(TEST_ID, "right");
    const c = await getCombat(TEST_ID);
    Math.random = () => 0.999999; // above win chance → loss
    const before = await getBalance(TEST_ID);
    await fight(TEST_ID);
    Math.random = realRandom;
    ok((await getBalance(TEST_ID)) === before - lossFor(c!.monster_level), `loss cost ${lossFor(c!.monster_level)} sats`);
    ok((await getCombat(TEST_ID)) !== null, "monster stays after a loss");
    await conserved(TOTAL, "after loss");
    await flee(TEST_ID); // tidy up
  }

  // 6. Chest
  console.log("\n6. Chest");
  const chest = await findTile("chest", 0);
  if (!chest) {
    ok(false, "no chest tile");
  } else {
    const pool = await readPool();
    await updatePlayer(TEST_ID, { x_coord: chest.x - 1, y_coord: chest.y, hunger: 100, state: "idle" });
    const before = await getBalance(TEST_ID);
    await move(TEST_ID, "right");
    const gained = (await getBalance(TEST_ID)) - before;
    ok(gained >= 0 && gained <= pool, `chest payout (${gained}) capped to pool (${pool})`);
    ok(await isTileCleared(chest.x, chest.y), "chest tile cleared");
    await conserved(TOTAL, "after chest");
  }

  // 7. Fast travel
  console.log("\n7. Fast travel");
  const dest = await findTile("empty", 500);
  if (!dest) {
    ok(false, "no empty destination");
  } else {
    await updatePlayer(TEST_ID, { x_coord: dest.x - 30, y_coord: dest.y, hunger: 5, state: "idle" });
    const player = (await getPlayer(TEST_ID))!;
    const est = estimateTravel(player, dest.x, dest.y);
    ok(est.steps === 30, `estimate 30 steps (got ${est.steps})`);
    const before = await getBalance(TEST_ID);
    const poolBeforeTravel = await readPool();
    await travelTo(TEST_ID, dest.x, dest.y);
    p = await getPlayer(TEST_ID);
    ok(p?.x_coord === dest.x && p?.y_coord === dest.y, "arrived at destination");
    ok((await getBalance(TEST_ID)) === before - est.satCost, `charged the bread cost (${est.satCost} sats)`);
    ok((await readPool()) === poolBeforeTravel + est.satCost, "travel cost flowed to the pool");
    await conserved(TOTAL, "after travel");

    // road/portal: same trip back, discounted
    await updatePlayer(TEST_ID, { x_coord: dest.x - 30, y_coord: dest.y, hunger: 5, state: "idle" });
    const pl2 = (await getPlayer(TEST_ID))!;
    const est2 = estimateTravel(pl2, dest.x, dest.y);
    const discounted = travelCost(est2, SAT.PORTAL_DISCOUNT);
    ok(discounted === Math.ceil(est2.satCost * SAT.PORTAL_DISCOUNT), `road fare is ½ price (${discounted} vs ${est2.satCost})`);
    const before2 = await getBalance(TEST_ID);
    await travelTo(TEST_ID, dest.x, dest.y, { discountMul: SAT.PORTAL_DISCOUNT });
    ok((await getBalance(TEST_ID)) === before2 - discounted, `road charged discounted fare (${discounted})`);
    await conserved(TOTAL, "after road travel");
  }

  // 8. Faint → warp to nearest town
  console.log("\n8. Faint");
  await updatePlayer(TEST_ID, { x_coord: 42, y_coord: 42, hunger: 30 });
  await faint(TEST_ID);
  p = await getPlayer(TEST_ID);
  const home = nearestTown(42, 42).town;
  ok(p?.x_coord === home.cx && p?.y_coord === home.cy && p?.hunger === 100 && p?.state === "idle", `faint warped to ${home.name}`);
  await conserved(TOTAL, "after faint");

  // Cleanup
  console.log("\nCleanup");
  Math.random = realRandom;
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
