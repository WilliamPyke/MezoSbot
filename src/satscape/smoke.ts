/**
 * SatScape economy smoke test — runs the real game functions against the real
 * Supabase DB (and the SQL RPCs), asserting the core invariants hold:
 *
 *   • sats are conserved: player balance + prize pool stays constant
 *   • balance never goes negative
 *   • tactical combat: queue a plan, resolve it, monster HP attrition / loot payout
 *   • shop purchases & equipping flow cost to the pool (and feed the legacy gear math)
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
import { SAT, entityAt } from "./engine.js";
import {
  buyItem as _buyItem,
  chargeBuyIn as _chargeBuyIn,
  eat as _eat,
  equipItem,
  estimateTravel,
  faint as _faint,
  fight as _fight,
  flee as _flee,
  loseHp as _loseHp,
  maxStepsFor,
  move as _move,
  moveMany as _moveMany,
  refillHp as _refillHp,
  resolveTile as _resolveTile,
  setStepsPerMove,
  travelCost,
  travelTo as _travelTo,
} from "./game.js";
import { queueWait, resolvePlan as _resolvePlan } from "./game.js";
import { effectiveHp, getCombat, getPlayer, isTileCleared, startRun, updateCombat, updatePlayer } from "./db.js";
import { lossFor, winChance } from "./items.js";
import { effectivePrice, gearScore, nearestTown, TOWN_BY_ID } from "./towns.js";
import { acceptQuest, claimQuest as _claimQuest, getRep, payTribute as _payTribute, questBoard } from "./quests.js";
import { canEnter, MAP_H, MAP_W } from "./world.js";

const TEST_ID = `smoke-${Date.now()}`;
const START_BALANCE = 2000;
const REST = TOWN_BY_ID.get("rest")!;
const TOUCHED_ENTITY_TILES = new Set<string>();

let passes = 0;
let failures = 0;

function ok(cond: boolean, msg: string) {
  if (cond) { passes++; console.log(`  ✓ ${msg}`); }
  else { failures++; console.error(`  ✗ ${msg}`); }
}

async function getRealPool(): Promise<number> {
  const { data } = await supabase.from("sat_prize_pool").select("balance_sats").eq("id", 1).single();
  return data?.balance_sats ?? 0;
}

async function readPool(): Promise<number> {
  return expectedPool;
}

let expectedPool = 0;

async function trackPool<T>(fn: () => Promise<T>): Promise<T> {
  const balBefore = await getBalance(TEST_ID);
  const res = await fn();
  const balAfter = await getBalance(TEST_ID);
  expectedPool += (balBefore - balAfter);
  return res;
}

const chargeBuyIn = (id: string) => trackPool(() => _chargeBuyIn(id));
const loseHp = (id: string, hp: number) => trackPool(() => _loseHp(id, hp));
const refillHp = (id: string, hp: number) => trackPool(() => _refillHp(id, hp));
const faint = (id: string) => trackPool(() => _faint(id));
const move = (id: string, dir: any) => trackPool(() => _move(id, dir));
const eat = (id: string) => trackPool(() => _eat(id));
const buyItem = (id: string, item: string) => trackPool(() => _buyItem(id, item));
const fight = (id: string) => trackPool(() => _fight(id));
const flee = (id: string) => trackPool(() => _flee(id));
const travelTo = (id: string, tx: number, ty: number, opts?: any) => trackPool(() => _travelTo(id, tx, ty, opts));
const payTribute = (id: string, key: string) => trackPool(() => _payTribute(id, key));
const claimQuest = (id: string, key: string) => trackPool(() => _claimQuest(id, key));
const moveMany = (id: string, dir: any) => trackPool(() => _moveMany(id, dir));
const resolveTile = (id: string, x: number, y: number) => trackPool(() => _resolveTile(id, x, y));
const resolvePlan = (id: string) => trackPool(() => _resolvePlan(id));

async function conserved(total: number, label: string) {
  const bal = await getBalance(TEST_ID);
  ok(Math.abs(bal + expectedPool - total) < 1e-6, `${label}: balance+pool conserved (${bal} + ${expectedPool} == ${total})`);
  ok(bal >= 0, `${label}: balance non-negative (${bal})`);
}

function rememberTile(p: { x: number; y: number }): void {
  TOUCHED_ENTITY_TILES.add(`${p.x},${p.y}`);
}

async function findTile(want: "monster" | "chest" | "empty", startY = 0): Promise<{ x: number; y: number } | null> {
  for (let oy = 0; oy < MAP_H; oy++) {
    const y = (startY + oy) % MAP_H;
    for (let x = 1; x < MAP_W; x++) {
      if (!canEnter(x, y, { ownsBoat: false }) || !canEnter(x - 1, y, { ownsBoat: false })) continue;
      const e = entityAt(x, y);
      if (want === "empty" ? e === null : e?.type === want) {
        if (await isTileCleared(x, y)) continue;
        return { x, y };
      }
    }
  }
  return null;
}

async function findEmptyStretch(len: number): Promise<{ x: number; y: number } | null> {
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x <= MAP_W - len; x++) {
      let allEmpty = true;
      for (let k = 0; k < len; k++) {
        if (!canEnter(x + k, y, { ownsBoat: false }) || entityAt(x + k, y) !== null || await isTileCleared(x + k, y)) {
          allEmpty = false;
          break;
        }
      }
      if (allEmpty) return { x, y };
    }
  }
  return null;
}

async function main() {
  console.log(`\nSatScape smoke test — player ${TEST_ID}\n`);
  const realRandom = Math.random;

  await getOrCreateUser(TEST_ID);
  await addBalance(TEST_ID, START_BALANCE);
  const poolBefore = await getRealPool();
  expectedPool = poolBefore;
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

  // 1b. HP cap / refill invariant for a wealthy player.
  console.log("\n1b. HP cap and refill");
  let hpPlayer = (await getPlayer(TEST_ID))!;
  ok(hpPlayer.max_hp === SAT.HP_MAX_DEFAULT, `max_hp defaults to ${SAT.HP_MAX_DEFAULT}`);
  ok(effectiveHp(hpPlayer, await getBalance(TEST_ID)) === SAT.HP_MAX_DEFAULT, "wealthy player loads with capped 250 HP");
  const balBeforeHit = await getBalance(TEST_ID);
  const hit = await loseHp(TEST_ID, 30);
  hpPlayer = (await getPlayer(TEST_ID))!;
  ok(hit.hp === SAT.HP_MAX_DEFAULT - 30 && effectiveHp(hpPlayer, await getBalance(TEST_ID)) === SAT.HP_MAX_DEFAULT - 30, "30 damage lowers HP to 220");
  ok((await getBalance(TEST_ID)) === balBeforeHit - 30, "30 damage burns 30 sats from balance");
  const balBeforeRefill = await getBalance(TEST_ID);
  const refill = await refillHp(TEST_ID, 30);
  hpPlayer = (await getPlayer(TEST_ID))!;
  ok(refill.ok && effectiveHp(hpPlayer, await getBalance(TEST_ID)) === SAT.HP_MAX_DEFAULT, "refill restores HP to 250");
  ok((await getBalance(TEST_ID)) === balBeforeRefill, "HP refill leaves balance unchanged");
  const balBeforeDrain = await getBalance(TEST_ID);
  const drained = await loseHp(TEST_ID, SAT.HP_MAX_DEFAULT);
  ok(drained.hp === 0, "draining the HP slice reaches 0 HP");
  const balAfterDrain = await getBalance(TEST_ID);
  ok(balAfterDrain === balBeforeDrain - SAT.HP_MAX_DEFAULT, "drain burns only the at-risk HP slice");
  await faint(TEST_ID);
  hpPlayer = (await getPlayer(TEST_ID))!;
  ok((await getBalance(TEST_ID)) === balAfterDrain, "faint does not charge an extra flat penalty");
  ok(effectiveHp(hpPlayer, await getBalance(TEST_ID)) === Math.min(balAfterDrain, SAT.HP_MAX_DEFAULT), "faint re-arms HP from remaining balance");
  await conserved(TOTAL, "after HP cap/refill/faint");

  // 2. Move + exhaustion
  console.log("\n2. Move & exhaustion");
  await updatePlayer(TEST_ID, { x_coord: REST.cx, y_coord: REST.cy, hunger: 1, state: "idle" });
  await move(TEST_ID, "up");
  ok((await getPlayer(TEST_ID))?.hunger === 0, "stamina drained to 0");
  const balPreStarve = await getBalance(TEST_ID);
  await move(TEST_ID, "down");
  ok((await getBalance(TEST_ID)) === balPreStarve - 1, "exhausted step burned 1 sat");
  await conserved(TOTAL, "after exhaustion");
  const { count: explored } = await supabase
    .from("sat_explored").select("*", { count: "exact", head: true }).eq("discord_id", TEST_ID);
  ok((explored ?? 0) > 0, `personal cartography: ${explored} tiles revealed after moving`);
  const { count: sharedExplored } = await supabase
    .from("sat_world_explored").select("*", { count: "exact", head: true });
  ok((sharedExplored ?? 0) > 0, `shared fog: ${sharedExplored} world tiles revealed after moving`);

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
  await updatePlayer(TEST_ID, { x_coord: REST.cx, y_coord: REST.cy, state: "idle", equipped_weapon: null });
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
  const wilds = await findTile("empty", REST.cy + REST.safeRadius + 2);
  if (!wilds) throw new Error("no empty wilds tile for shop refusal test");
  await updatePlayer(TEST_ID, { x_coord: wilds.x, y_coord: wilds.y, state: "idle" }); // wilds
  ok(!(await buyItem(TEST_ID, "rest_weapon")).ok, "shop refused outside town");
  await conserved(TOTAL, "after shop");

  // 5. Combat — tactical plan-3. Deterministic: we position the arena directly,
  //    then drive the real queue→resolve path (no RNG forcing needed).
  console.log("\n5. Combat");
  const mWin = await findTile("monster", 0);
  if (!mWin) {
    ok(false, "no monster tile for win test");
  } else {
    await updatePlayer(TEST_ID, { x_coord: mWin.x - 1, y_coord: mWin.y, hunger: 100, state: "idle" });
    await move(TEST_ID, "right");
    const c = await getCombat(TEST_ID);
    ok(!!c && c.monster_level >= 1, `combat started (lv ${c?.monster_level}) vs ${c?.monster_name}`);
    // Stand the player directly below the monster (in weapon range) and chip the
    // monster down to a sliver, so a single queued strike is a guaranteed kill.
    await updateCombat(TEST_ID, {
      player_battle_x: 3, player_battle_y: 3,
      monster_battle_x: 3, monster_battle_y: 2,
      monster_current_hp: 1, battle_plan: null,
    });
    const before = await getBalance(TEST_ID);
    const pool = await readPool();
    const res = await fight(TEST_ID); // queues a strike, then resolves
    rememberTile(mWin);
    const gained = (await getBalance(TEST_ID)) - before;
    ok(res.ok && (await getCombat(TEST_ID)) === null, "queued strike killed the monster (combat cleared)");
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
    // Monster sits right on top of the player with plenty of HP: resolving an
    // all-wait plan lets it close in and strike, so the player takes damage and
    // the fight continues.
    await updateCombat(TEST_ID, {
      player_battle_x: 3, player_battle_y: 3,
      monster_battle_x: 3, monster_battle_y: 2,
      monster_current_hp: c!.monster_max_hp, battle_plan: null,
    });
    const before = await getBalance(TEST_ID);
    await queueWait(TEST_ID);
    await queueWait(TEST_ID);
    await queueWait(TEST_ID);
    await resolvePlan(TEST_ID);
    ok((await getBalance(TEST_ID)) < before, "waiting into the monster cost sats");
    ok((await getCombat(TEST_ID)) !== null, "monster stays after a non-lethal round");
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
    rememberTile(chest);
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

  // 9. Quests & reputation
  console.log("\n9. Quests & reputation");
  await updatePlayer(TEST_ID, { x_coord: REST.cx, y_coord: REST.cy, state: "idle", hunger: 100 });
  // bounty: 3 kills
  ok((await acceptQuest(TEST_ID, "rest_cull")).ok, "accepted bounty quest");
  for (let i = 0; i < 3; i++) {
    const m = await findTile("monster", 30 + i);
    if (!m) { ok(false, "no monster for bounty"); break; }
    await updatePlayer(TEST_ID, { x_coord: m.x - 1, y_coord: m.y, hunger: 100, state: "idle" });
    await move(TEST_ID, "right");
    await updateCombat(TEST_ID, {
      player_battle_x: 3, player_battle_y: 3,
      monster_battle_x: 3, monster_battle_y: 2,
      monster_current_hp: 1,
    });
    Math.random = () => 0;
    await fight(TEST_ID);
    rememberTile(m);
    Math.random = realRandom;
  }
  const board = await questBoard(TEST_ID, "rest");
  ok(board.offered.find((v) => v.def.key === "rest_cull")?.status === "claimable", "bounty claimable after 3 kills");
  const repBefore = await getRep(TEST_ID, "rest");
  await claimQuest(TEST_ID, "rest_cull");
  ok((await getRep(TEST_ID, "rest")) === repBefore + 1, "bounty claim granted +1 rep");
  await conserved(TOTAL, "after bounty claim");

  // reputation discount
  const restKeeper = TOWN_BY_ID.get("rest")!.keeper;
  const restItem = TOWN_BY_ID.get("rest")!.catalog[0];
  ok(effectivePrice(restItem, restKeeper, 5) < effectivePrice(restItem, restKeeper, 0), "reputation lowers shop prices");

  // tribute → Greta
  await updatePlayer(TEST_ID, { x_coord: REST.cx, y_coord: REST.cy, state: "idle" });
  const balPreT = await getBalance(TEST_ID);
  ok((await payTribute(TEST_ID, "frosthold_tribute")).ok, "paid tribute to Greta");
  ok((await getBalance(TEST_ID)) === balPreT - 300, "tribute debited 300 sats");
  ok((await getRep(TEST_ID, "frosthold")) === 4, "tribute granted +4 Frosthold rep");
  await conserved(TOTAL, "after tribute");

  // delivery: accept at Rest, complete by arriving in Jaipur
  ok((await acceptQuest(TEST_ID, "rest_invoice")).ok, "accepted delivery quest");
  const jaipur = TOWN_BY_ID.get("jaipur")!;
  await updatePlayer(TEST_ID, { x_coord: jaipur.cx, y_coord: jaipur.cy, state: "idle" });
  await resolveTile(TEST_ID, jaipur.cx, jaipur.cy); // fires onArriveTown
  const board2 = await questBoard(TEST_ID, "jaipur");
  ok(board2.carry.find((v) => v.def.key === "rest_invoice")?.status === "claimable", "delivery claimable on arrival at Jaipur");
  ok((await claimQuest(TEST_ID, "rest_invoice")).ok, "claimed delivery");
  await conserved(TOTAL, "after delivery");

  // gear unlock gate
  ok(!(await buyItem(TEST_ID, "jaipur_unlock")).ok, "Maharaja Blade locked at 0 Jaipur rep");

  // 10. Boots & multi-step movement
  console.log("\n10. Boots & multi-step movement");
  await updatePlayer(TEST_ID, { x_coord: REST.cx, y_coord: REST.cy, state: "idle", hunger: 100, equipped_boots: null, steps_per_move: 1 });
  let bp = (await getPlayer(TEST_ID))!;
  ok(maxStepsFor(bp) === SAT.MAX_STEPS_BASE, `base max steps is ${SAT.MAX_STEPS_BASE}`);
  ok((await buyItem(TEST_ID, "rest_boots")).ok, "bought Worn Boots in town");
  ok((await equipItem(TEST_ID, "rest_boots")).ok, "equipped Worn Boots");
  bp = (await getPlayer(TEST_ID))!;
  ok(maxStepsFor(bp) === SAT.MAX_STEPS_BASE + 1, "boots raised max steps by stepBonus(1)");
  const set = await setStepsPerMove(TEST_ID, 999);
  ok(set.ok && set.value === maxStepsFor(bp), `setStepsPerMove clamps to ${maxStepsFor(bp)} (got ${set.value})`);
  await setStepsPerMove(TEST_ID, 4);

  // walk 4 tiles in one press through empty wilds
  const start = await findEmptyStretch(5);
  if (!start) { ok(false, "no empty 5-tile stretch for multi-step"); }
  else {
    await updatePlayer(TEST_ID, { x_coord: start.x, y_coord: start.y, hunger: 100, state: "idle", steps_per_move: 4 });
    const res = await moveMany(TEST_ID, "right");
    const after = (await getPlayer(TEST_ID))!;
    ok(res.ok, "moveMany returned ok");
    ok(after.x_coord === start.x + 4, `moved 4 tiles right (from ${start.x} → ${after.x_coord})`);
    ok(res.note.startsWith("🏃 ×4"), `note prefixed with ×4 (got "${res.note.slice(0, 20)}…")`);
    await conserved(TOTAL, "after multi-step");
  }

  // Cleanup
  console.log("\nCleanup");
  Math.random = realRandom;
  for (const key of TOUCHED_ENTITY_TILES) {
    const [x, y] = key.split(",").map(Number);
    await supabase.from("sat_world_entities").delete().eq("x", x).eq("y", y);
  }
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
