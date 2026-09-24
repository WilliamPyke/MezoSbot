import assert from "node:assert/strict";
import test from "node:test";
import {
  applyInternalHaircut,
  applySlippageMinOut,
  canFillInternally,
  computeFreeInventory,
  decideHybridMode,
  quoteNotExpired,
  shouldRebalance,
  withinDailyLimits,
} from "../src/swap/policy.js";
import {
  buildHardcodedBasicRoutes,
  candidateRoutesFromGraph,
  encodeClPath,
  graphRefreshBackoffMs,
  isAllowlistedBasicPool,
  isAllowlistedClPool,
  KNOWN_POOL_ALLOWLIST,
  pickBestQuotedRoute,
  symbolForPoolToken,
  groupSwapLegs,
  hopTokenIn,
  hopTokenOut,
  isSwappableToken,
  MEZO_BTC_TOKEN,
  parseRouteHops,
  poolTokenAddress,
  remainingHops,
  routesFromGraph,
  routeStableDefaultSlippageBps,
  type PoolGraph,
} from "../src/swap/routes.js";
import {
  allowanceNeedsUpdate,
  amountOutFromTransferLogs,
  approvalAmountFor,
  computeLegMinimums,
} from "../src/swap/router.js";
import {
  assessMissingReceipt,
  eligibleForRecovery,
  recoveryAttemptAllowed,
  recoverySnapshotUnchanged,
  RECOVERY_DROP_AFTER_MS,
  RECOVERY_FIRST_HOP_DROP_MS,
  RECOVERY_MAX_ATTEMPTS,
  RECOVERY_STALE_MS,
  sumInventoryHolds,
} from "../src/swap/recovery.js";
import {
  checkInternalFillPrice,
  MID_SAMPLE_MIN_INTERVAL_MS,
  MidPriceCache,
  withinPriceBand,
} from "../src/swap/priceGuard.js";
import {
  compressTick,
  computeSwapStep,
  getAmount0Delta,
  mulDiv,
  tickToSqrtPriceX96,
} from "../src/swap/clQuote.js";
import { ethers } from "ethers";

test("free inventory subtracts liabilities and sats gas reserve", () => {
  const snap = computeFreeInventory(10_000, 7_000, { token: "SATS", gasReserveSats: 1_000 });
  assert.equal(snap.free, 2_000);
  const musd = computeFreeInventory(100, 40, { token: "MUSD", gasReserveSats: 1_000 });
  assert.equal(musd.free, 60);
});

test("free inventory never goes negative", () => {
  const snap = computeFreeInventory(100, 500, { token: "SATS", gasReserveSats: 50 });
  assert.equal(snap.free, 0);
});

test("internal fill requires buffer and absolute cap", () => {
  assert.equal(canFillInternally(1000, 400, 0.5, 10_000), true); // 400 <= 500
  assert.equal(canFillInternally(1000, 501, 0.5, 10_000), false);
  assert.equal(canFillInternally(100_000, 50_000, 1, 10_000), false); // absolute cap
});

test("hybrid prefers internal when inventory allows", () => {
  const d = decideHybridMode({
    requiredOut: 100,
    freeInventory: 1_000,
    hasOnchainRoute: true,
    maxInternalFraction: 0.5,
    maxInternalAbsolute: 10_000,
  });
  assert.equal(d.preferredMode, "internal");
  assert.equal(d.canInternal, true);
  assert.equal(d.canOnchain, true);
});

test("hybrid falls back to on-chain when inventory is thin", () => {
  const d = decideHybridMode({
    requiredOut: 100,
    freeInventory: 50,
    hasOnchainRoute: true,
    maxInternalFraction: 0.5,
    maxInternalAbsolute: 10_000,
  });
  assert.equal(d.preferredMode, "onchain");
  assert.equal(d.canInternal, false);
  assert.equal(d.canOnchain, true);
});

test("force on-chain skips inventory path", () => {
  const d = decideHybridMode({
    requiredOut: 10,
    freeInventory: 1_000_000,
    hasOnchainRoute: true,
    maxInternalFraction: 1,
    maxInternalAbsolute: 1_000_000,
    forceOnchain: true,
  });
  assert.equal(d.preferredMode, "onchain");
  assert.equal(d.canInternal, false);
});

test("unfillable when no inventory and no route", () => {
  const d = decideHybridMode({
    requiredOut: 100,
    freeInventory: 0,
    hasOnchainRoute: false,
    maxInternalFraction: 0.5,
    maxInternalAbsolute: 10_000,
  });
  assert.equal(d.canInternal, false);
  assert.equal(d.canOnchain, false);
});

test("slippage and haircut reduce output safely", () => {
  assert.equal(applySlippageMinOut(100, 100), 99); // 1%
  assert.equal(applyInternalHaircut(100, 10), 99.9); // 10 bps
  assert.ok(applySlippageMinOut(100, 10_000) >= 0);
});

test("daily limits fail closed", () => {
  assert.equal(
    withinDailyLimits({
      swapCount: 25,
      volumeSatsProxy: 0,
      maxSwapsPerDay: 25,
      maxVolumeSatsPerDay: 1e12,
      nextVolumeSats: 1,
    }).ok,
    false,
  );
  assert.equal(
    withinDailyLimits({
      swapCount: 0,
      volumeSatsProxy: 100,
      maxSwapsPerDay: 25,
      maxVolumeSatsPerDay: 150,
      nextVolumeSats: 60,
    }).ok,
    false,
  );
  assert.equal(
    withinDailyLimits({
      swapCount: 1,
      volumeSatsProxy: 100,
      maxSwapsPerDay: 25,
      maxVolumeSatsPerDay: 1e12,
      nextVolumeSats: 60,
    }).ok,
    true,
  );
});

test("quote expiry", () => {
  assert.equal(quoteNotExpired(new Date(Date.now() + 10_000)), true);
  assert.equal(quoteNotExpired(new Date(Date.now() - 1_000)), false);
});

test("rebalance trigger", () => {
  assert.equal(
    shouldRebalance({ freeShort: 10, minFree: 50, freeLong: 200, minLongExcess: 100 }),
    true,
  );
  assert.equal(
    shouldRebalance({ freeShort: 60, minFree: 50, freeLong: 200, minLongExcess: 100 }),
    false,
  );
});

test("all ledger tokens are swappable", () => {
  assert.equal(isSwappableToken("SATS"), true);
  assert.equal(isSwappableToken("MUSD"), true);
  assert.equal(isSwappableToken("MUSDC"), true);
  assert.equal(isSwappableToken("MEZO"), true);
});

test("hardcoded basic routes still cover SATS/MUSD/mUSDC and reject MEZO", () => {
  const btcMusd = buildHardcodedBasicRoutes("SATS", "MUSD");
  assert.equal(btcMusd.length, 1);
  assert.equal(btcMusd[0]!.kind, "basic");
  if (btcMusd[0]!.kind !== "basic") throw new Error("expected basic hop");
  assert.equal(btcMusd[0].from.toLowerCase(), MEZO_BTC_TOKEN.toLowerCase());
  assert.equal(btcMusd[0].stable, false);

  const stable = buildHardcodedBasicRoutes("MUSD", "MUSDC");
  assert.equal(stable[0]!.kind, "basic");
  if (stable[0]!.kind !== "basic") throw new Error("expected basic hop");
  assert.equal(stable[0].stable, true);

  const multi = buildHardcodedBasicRoutes("SATS", "MUSDC");
  assert.equal(multi.length, 2);

  assert.throws(() => buildHardcodedBasicRoutes("SATS", "MEZO"));
  assert.throws(() => buildHardcodedBasicRoutes("SATS", "SATS"));
});

function sampleGraph(): PoolGraph {
  const sats = poolTokenAddress("SATS");
  const musd = poolTokenAddress("MUSD");
  const musdc = poolTokenAddress("MUSDC");
  const mezo = poolTokenAddress("MEZO");
  const basicFactory = "0x83FE469C636C4081b87bA5b3Ae9991c6Ed104248";
  const clFactory = "0xBB24AF5c6fB88F1d191FA76055e30BF881BeEb79";
  return {
    basic: [
      { tokenA: sats, tokenB: musd, stable: false, factory: basicFactory },
      { tokenA: musd, tokenB: musdc, stable: true, factory: basicFactory },
    ],
    cl: [
      {
        tokenA: mezo,
        tokenB: sats,
        tickSpacing: 2000,
        factory: clFactory,
        pool: "0x907d055978943c69cffd5ed969f5603af104acc5",
        liquidity: 1n,
      },
      {
        tokenA: mezo,
        tokenB: musd,
        tickSpacing: 200,
        factory: clFactory,
        pool: "0x1d6e8d24c133535f2d00676f66a0e824f84765ff",
        liquidity: 2n,
      },
    ],
  };
}

test("graph routes prefer direct basic, then CL, then mixed two-leg via MUSD", () => {
  const graph = sampleGraph();

  const btcMusd = routesFromGraph("SATS", "MUSD", graph);
  assert.equal(btcMusd.length, 1);
  assert.equal(btcMusd[0]!.kind, "basic");

  const mezoSats = routesFromGraph("MEZO", "SATS", graph);
  assert.equal(mezoSats.length, 1);
  assert.equal(mezoSats[0]!.kind, "cl");
  if (mezoSats[0]!.kind !== "cl") throw new Error("expected cl hop");
  assert.equal(mezoSats[0].tickSpacing, 2000);

  const mezoMusd = routesFromGraph("MEZO", "MUSD", graph);
  assert.equal(mezoMusd[0]!.kind, "cl");

  const mezoMusdc = routesFromGraph("MEZO", "MUSDC", graph);
  assert.equal(mezoMusdc.length, 2);
  assert.equal(mezoMusdc[0]!.kind, "cl");
  assert.equal(mezoMusdc[1]!.kind, "basic");
  assert.equal(hopTokenOut(mezoMusdc[0]!).toLowerCase(), poolTokenAddress("MUSD").toLowerCase());
  assert.equal(hopTokenIn(mezoMusdc[1]!).toLowerCase(), poolTokenAddress("MUSD").toLowerCase());

  const reverse = routesFromGraph("MUSDC", "MEZO", graph);
  assert.equal(reverse[0]!.kind, "basic");
  assert.equal(reverse[1]!.kind, "cl");

  const satsMusdc = routesFromGraph("SATS", "MUSDC", graph);
  assert.equal(satsMusdc.length, 2);
  assert.ok(satsMusdc.every((hop) => hop.kind === "basic"));

  assert.throws(() => routesFromGraph("SATS", "SATS", graph));
});

test("groupSwapLegs splits mixed CL+basic into two venue groups", () => {
  const hops = routesFromGraph("MEZO", "MUSDC", sampleGraph());
  const legs = groupSwapLegs(hops);
  assert.equal(legs.length, 2);
  assert.equal(legs[0]!.venue, "cl");
  assert.equal(legs[1]!.venue, "basic");
  assert.equal(remainingHops(hops, 1).length, 1);
  assert.equal(remainingHops(hops, 1)[0]!.kind, "basic");
});

test("parseRouteHops accepts legacy basic hops without kind", () => {
  const parsed = parseRouteHops([
    {
      from: MEZO_BTC_TOKEN,
      to: poolTokenAddress("MUSD"),
      stable: false,
      factory: "0x83FE469C636C4081b87bA5b3Ae9991c6Ed104248",
    },
  ]);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]!.kind, "basic");
});

test("CL path packing is token + int24 tickSpacing + token", () => {
  const hops = routesFromGraph("MEZO", "SATS", sampleGraph());
  assert.equal(hops[0]!.kind, "cl");
  if (hops[0]!.kind !== "cl") throw new Error("expected cl hop");
  const path = encodeClPath([hops[0]]);
  assert.equal(path.length, 2 + 40 + 6 + 40);
  assert.ok(path.startsWith("0x"));
});

test("volatile CL hops raise default slippage", () => {
  const hops = routesFromGraph("MEZO", "SATS", sampleGraph());
  assert.equal(routeStableDefaultSlippageBps(hops), 200);
  const stable = buildHardcodedBasicRoutes("MUSD", "MUSDC");
  assert.equal(routeStableDefaultSlippageBps(stable), 50);
});

test("CL math helpers are consistent", () => {
  assert.equal(mulDiv(100n, 3n, 2n), 150n);
  const sqrtA = tickToSqrtPriceX96(0);
  const sqrtB = tickToSqrtPriceX96(100);
  const delta = getAmount0Delta(sqrtA, sqrtB, 1_000_000n, true);
  assert.ok(delta > 0n);
  const step = computeSwapStep(sqrtB, sqrtA, 1_000_000_000_000n, 1_000_000n, 3000n);
  assert.ok(step.amountOut > 0n);
  assert.equal(compressTick(-201, 200), -2);
  assert.equal(compressTick(200, 200), 1);
});

test("amountOutFromTransferLogs sums transfers to treasury only", () => {
  const treasury = "0x1111111111111111111111111111111111111111";
  const token = "0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186";
  const other = "0x2222222222222222222222222222222222222222";
  const transferTopic = ethers.id("Transfer(address,address,uint256)");
  const pad = (addr: string) => "0x" + addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const logs = [
    {
      address: token,
      topics: [transferTopic, pad(other), pad(treasury)],
      data: "0x" + (100n).toString(16).padStart(64, "0"),
    },
    {
      address: token,
      topics: [transferTopic, pad(treasury), pad(other)],
      data: "0x" + (999n).toString(16).padStart(64, "0"),
    },
    {
      address: token,
      topics: [transferTopic, pad(other), pad(treasury)],
      data: "0x" + (50n).toString(16).padStart(64, "0"),
    },
  ];
  assert.equal(amountOutFromTransferLogs(logs, token, treasury), 150n);
  assert.equal(amountOutFromTransferLogs([], token, treasury), null);
});

test("per-leg minimums: intermediate legs use quoted out minus slippage, final uses user min", () => {
  const mins = computeLegMinimums([1_000_000n, 500_000n], 100, 490_000n);
  assert.deepEqual(mins, [990_000n, 490_000n]);
  // Without an explicit final min the same slippage rule applies to every leg.
  assert.deepEqual(computeLegMinimums([10_000n], 50), [9_950n]);
  // Dust quotes floor at 1 unit (never 0).
  assert.deepEqual(computeLegMinimums([1n, 5n], 100, 0n), [1n, 1n]);
  assert.ok(computeLegMinimums([1_000_000n, 1n], 100)[0]! > 1n);
  // Slippage is clamped to 50%.
  assert.deepEqual(computeLegMinimums([1_000n, 1_000n], 99_999), [500n, 500n]);
});

function swapRow(overrides: Record<string, unknown> = {}) {
  const old = new Date(Date.now() - RECOVERY_STALE_MS - 60_000).toISOString();
  return {
    status: "submitted" as const,
    created_at: old,
    updated_at: old,
    tx_hash: "0xaaa",
    metadata: { tx_hashes: ["0xaaa"], legs_completed: 0 } as Record<string, unknown>,
    ...overrides,
  };
}

test("recovery staleness uses updated_at / last progress, not created_at", () => {
  const now = Date.now();
  assert.equal(eligibleForRecovery(swapRow(), now), true);
  // Created long ago but the live path made progress a minute ago → not stale.
  const progressing = swapRow({
    metadata: { tx_hashes: ["0xaaa"], last_progress_at: new Date(now - 60_000).toISOString() },
  });
  assert.equal(eligibleForRecovery(progressing, now), false);
  const touched = swapRow({ updated_at: new Date(now - 30_000).toISOString() });
  assert.equal(eligibleForRecovery(touched, now), false);
});

test("recovery skips leased, needs_review and non-recoverable rows", () => {
  const now = Date.now();
  const leased = swapRow({
    metadata: { tx_hashes: ["0xaaa"], recovery_lease_until: new Date(now + 60_000).toISOString() },
  });
  assert.equal(eligibleForRecovery(leased, now), false);
  const expiredLease = swapRow({
    metadata: { tx_hashes: ["0xaaa"], recovery_lease_until: new Date(now - 1).toISOString() },
  });
  assert.equal(eligibleForRecovery(expiredLease, now), true);
  assert.equal(eligibleForRecovery(swapRow({ metadata: { needs_review: true } }), now), false);
  assert.equal(eligibleForRecovery(swapRow({ status: "needs_review" }), now), false);
  assert.equal(eligibleForRecovery(swapRow({ status: "completed" }), now), false);
});

test("recovery attempt limit", () => {
  assert.equal(recoveryAttemptAllowed(0), true);
  assert.equal(recoveryAttemptAllowed(RECOVERY_MAX_ATTEMPTS - 1), true);
  assert.equal(recoveryAttemptAllowed(RECOVERY_MAX_ATTEMPTS), false);
  assert.equal(recoveryAttemptAllowed(99, 3), false);
});

test("recovery claim aborts if the row progressed after claim", () => {
  const claimed = swapRow({ updated_at: "2026-09-24T10:00:00.123+00:00" });
  assert.equal(recoverySnapshotUnchanged(claimed, { ...claimed }), true);
  // Same instant in a different textual form is still unchanged.
  assert.equal(recoverySnapshotUnchanged(claimed, { ...claimed, updated_at: "2026-09-24T10:00:00.123Z" }), true);
  assert.equal(recoverySnapshotUnchanged(claimed, { ...claimed, updated_at: "2026-09-24T10:00:01Z" }), false);
  assert.equal(
    recoverySnapshotUnchanged(claimed, { ...claimed, metadata: { tx_hashes: ["0xaaa"], legs_completed: 1 } }),
    false,
  );
  assert.equal(
    recoverySnapshotUnchanged(claimed, { ...claimed, metadata: { tx_hashes: ["0xaaa", "0xbbb"], legs_completed: 0 } }),
    false,
  );
  assert.equal(recoverySnapshotUnchanged(claimed, { ...claimed, status: "failed" as never }), false);
});

test("dropped tx detection for first and later hops", () => {
  const base = { txKnown: false, txMined: false, txNonce: 7, latestNonce: 7, ageMs: 10 * 60_000 };
  // Nonce consumed by another tx → provably dropped (any hop).
  assert.equal(assessMissingReceipt({ ...base, latestNonce: 8, firstHop: false }), "dropped");
  assert.equal(assessMissingReceipt({ ...base, latestNonce: 8, firstHop: true }), "dropped");
  // Unknown, nonce not consumed: later hop → needs_review after the drop window.
  assert.equal(assessMissingReceipt({ ...base, firstHop: false }), "wait");
  assert.equal(assessMissingReceipt({ ...base, ageMs: RECOVERY_DROP_AFTER_MS, firstHop: false }), "needs_review");
  // First hop keeps the conservative refund window.
  assert.equal(assessMissingReceipt({ ...base, ageMs: RECOVERY_DROP_AFTER_MS, firstHop: true }), "wait");
  assert.equal(assessMissingReceipt({ ...base, ageMs: RECOVERY_FIRST_HOP_DROP_MS, firstHop: true }), "dropped");
  // Mined per node but receipt lagging → wait.
  assert.equal(assessMissingReceipt({ ...base, txKnown: true, txMined: true, latestNonce: 9, firstHop: false }), "wait");
  // Fresh nonce-consumed case waits out indexer lag.
  assert.equal(assessMissingReceipt({ ...base, latestNonce: 8, ageMs: 1_000, firstHop: false }), "wait");
});

test("inventory holds reserve intermediate outputs of in-flight swaps", () => {
  const rows = [
    { status: "submitted" as const, metadata: { held_token: "MUSD", held_amount: 12.5 } },
    { status: "needs_review" as const, metadata: { held_token: "MUSD", held_amount: 2 } },
    { status: "reserved" as const, metadata: { held_token: "SATS", held_amount: 1_000 } },
    { status: "completed" as const, metadata: { held_token: "MUSD", held_amount: 100 } },
    { status: "submitted" as const, metadata: {} },
  ];
  assert.equal(sumInventoryHolds(rows, "MUSD"), 14.5);
  assert.equal(sumInventoryHolds(rows, "SATS"), 1_000);
  assert.equal(sumInventoryHolds(rows, "MUSDC"), 0);
  // Free inventory after subtracting holds from on-chain balance.
  const free = computeFreeInventory(100 - sumInventoryHolds(rows, "MUSD"), 50, { token: "MUSD", gasReserveSats: 0 });
  assert.equal(free.free, 35.5);
});

test("pool allowlist pins CL by address and basic by pair/stable", () => {
  const sats = poolTokenAddress("SATS");
  const musd = poolTokenAddress("MUSD");
  const musdc = poolTokenAddress("MUSDC");
  assert.equal(isAllowlistedBasicPool(sats, musd, false, "0x0000000000000000000000000000000000000001"), true);
  assert.equal(isAllowlistedBasicPool(musd, sats, false, null), true);
  // A stable SATS/MUSD pool is not allowlisted (e.g. attacker-created).
  assert.equal(isAllowlistedBasicPool(sats, musd, true, "0x0000000000000000000000000000000000000002"), false);
  assert.equal(isAllowlistedBasicPool(sats, musdc, false, null), false);
  assert.equal(isAllowlistedClPool("0x907D055978943C69CFFD5ED969F5603AF104ACC5", KNOWN_POOL_ALLOWLIST, new Set()), true);
  assert.equal(isAllowlistedClPool("0x0000000000000000000000000000000000000bad", KNOWN_POOL_ALLOWLIST, new Set()), false);
  assert.equal(
    isAllowlistedClPool(
      "0x0000000000000000000000000000000000000bad",
      KNOWN_POOL_ALLOWLIST,
      new Set(["0x0000000000000000000000000000000000000bad"]),
    ),
    true,
  );
  assert.equal(symbolForPoolToken(musd.toLowerCase()), "MUSD");
  assert.equal(symbolForPoolToken("0x0000000000000000000000000000000000000bad"), null);
});

test("route selection is by quoted output, with a multi-leg advantage threshold", () => {
  const graph = sampleGraph();
  const sats = poolTokenAddress("SATS");
  const musd = poolTokenAddress("MUSD");
  graph.basic.push({ tokenA: sats, tokenB: musd, stable: true, factory: "0x83FE469C636C4081b87bA5b3Ae9991c6Ed104248" });
  const candidates = candidateRoutesFromGraph("SATS", "MUSD", graph);
  assert.ok(candidates.length >= 2);
  const isBasic = (r: typeof candidates[number], stable: boolean) =>
    r.length === 1 && r[0]!.kind === "basic" && r[0]!.stable === stable;
  const volatile = candidates.find((r) => isBasic(r, false))!;
  const stable = candidates.find((r) => isBasic(r, true))!;
  // Stable-first no longer wins by default: the better quote wins.
  const best = pickBestQuotedRoute([
    { routes: stable, amountOut: 900n },
    { routes: volatile, amountOut: 1_000n },
  ]);
  assert.equal(best?.routes, volatile);
  // Failed quotes are ignored.
  assert.equal(
    pickBestQuotedRoute([{ routes: stable, amountOut: null }, { routes: volatile, amountOut: 5n }])?.routes,
    volatile,
  );
  assert.equal(pickBestQuotedRoute([{ routes: stable, amountOut: null }]), null);

  const twoLeg = candidateRoutesFromGraph("MEZO", "MUSDC", sampleGraph())[0]!;
  assert.equal(groupSwapLegs(twoLeg).length, 2);
  const oneLeg = candidateRoutesFromGraph("SATS", "MUSD", sampleGraph())[0]!;
  // A 2-leg route must beat a 1-leg route by > 50 bps.
  assert.equal(
    pickBestQuotedRoute([{ routes: oneLeg, amountOut: 10_000n }, { routes: twoLeg, amountOut: 10_040n }])?.routes,
    oneLeg,
  );
  assert.equal(
    pickBestQuotedRoute([{ routes: oneLeg, amountOut: 10_000n }, { routes: twoLeg, amountOut: 10_060n }])?.routes,
    twoLeg,
  );
});

test("internal fill sanity band", () => {
  assert.equal(withinPriceBand(100, 100, 150), true);
  assert.equal(withinPriceBand(101.5, 100, 150), true);
  assert.equal(withinPriceBand(102, 100, 150), false);
  assert.equal(withinPriceBand(0, 100, 150), false);

  const basicRoute = buildHardcodedBasicRoutes("SATS", "MUSD");
  const cache = new MidPriceCache();
  const t0 = 1_000_000;
  // Cold cache → no reference → internal refused.
  const cold = checkInternalFillPrice({ fromToken: "SATS", toToken: "MUSD", routes: basicRoute, liveRate: 1, cache, now: t0 });
  assert.equal(cold.ok, false);
  for (let i = 1; i <= 6; i += 1) {
    cache.record("SATS", "MUSD", 1, t0 + i * MID_SAMPLE_MIN_INTERVAL_MS);
  }
  const later = t0 + 7 * MID_SAMPLE_MIN_INTERVAL_MS;
  assert.equal(
    checkInternalFillPrice({ fromToken: "SATS", toToken: "MUSD", routes: basicRoute, liveRate: 1.001, cache, now: later }).ok,
    true,
  );
  // Manipulated spot price (5% off the recent median) → refused.
  assert.equal(
    checkInternalFillPrice({ fromToken: "SATS", toToken: "MUSD", routes: basicRoute, liveRate: 1.05, cache, now: later + 1 }).ok,
    false,
  );
  // MEZO pairs and CL routes never fill internally.
  const clRoute = routesFromGraph("MEZO", "SATS", sampleGraph());
  assert.equal(
    checkInternalFillPrice({ fromToken: "MEZO", toToken: "SATS", routes: clRoute, liveRate: 1, cache, now: later }).ok,
    false,
  );
  assert.equal(
    checkInternalFillPrice({ fromToken: "SATS", toToken: "MUSD", routes: clRoute, liveRate: 1, cache, now: later }).ok,
    false,
  );
});

test("mid cache throttles samples so quote spam cannot flood the window", () => {
  const cache = new MidPriceCache();
  for (let i = 0; i < 50; i += 1) cache.record("MUSD", "SATS", 999, 1_000 + i);
  assert.equal(cache.reference("MUSD", "SATS", 2_000), null);
});

test("graph refresh backoff grows and caps", () => {
  assert.equal(graphRefreshBackoffMs(0), 0);
  assert.equal(graphRefreshBackoffMs(1), 60_000);
  assert.equal(graphRefreshBackoffMs(2), 120_000);
  assert.equal(graphRefreshBackoffMs(50), 15 * 60_000);
});

test("router approvals are exact, never infinite", () => {
  assert.equal(approvalAmountFor(123n), 123n);
  assert.notEqual(approvalAmountFor(1n), ethers.MaxUint256);
  assert.throws(() => approvalAmountFor(0n));
  assert.equal(allowanceNeedsUpdate(0n, 10n), true);
  assert.equal(allowanceNeedsUpdate(10n, 10n), false);
  assert.equal(allowanceNeedsUpdate(50n, 10n), false);
  // Legacy infinite approvals are revoked and replaced with exact ones.
  assert.equal(allowanceNeedsUpdate(ethers.MaxUint256, 10n), true);
});
