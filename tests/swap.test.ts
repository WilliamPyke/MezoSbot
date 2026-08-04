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
import { buildSwapRoutes, isSwappableToken, MEZO_BTC_TOKEN } from "../src/swap/routes.js";
import { amountOutFromTransferLogs } from "../src/swap/router.js";
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

test("route builder covers known Mezo pairs and rejects MEZO", () => {
  assert.equal(isSwappableToken("SATS"), true);
  assert.equal(isSwappableToken("MEZO"), false);

  const btcMusd = buildSwapRoutes("SATS", "MUSD");
  assert.equal(btcMusd.length, 1);
  assert.equal(btcMusd[0]!.from.toLowerCase(), MEZO_BTC_TOKEN.toLowerCase());
  assert.equal(btcMusd[0]!.stable, false);

  const stable = buildSwapRoutes("MUSD", "MUSDC");
  assert.equal(stable[0]!.stable, true);

  const multi = buildSwapRoutes("SATS", "MUSDC");
  assert.equal(multi.length, 2);

  assert.throws(() => buildSwapRoutes("SATS", "MEZO"));
  assert.throws(() => buildSwapRoutes("SATS", "SATS"));
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
