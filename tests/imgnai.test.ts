import assert from "node:assert/strict";
import test from "node:test";
import {
  formatMusd,
  generationCost,
  generationPriceChanged,
  modelsForPage,
  type KatanaImageModel,
} from "../src/imgnai/types.js";
import { hasSufficientMusdBacking, musdToDecimal, parseMusd } from "../src/imgnai/musd.js";
import {
  IMGN_WORKER_IDLE_DELAY_MS,
  IMGN_WORKER_MIN_DELAY_MS,
  nextGenerationWorkerDelay,
} from "../src/imgnai/schedule.js";

const base: KatanaImageModel = {
  modelKey: "pink-image",
  displayName: "Pink Image",
  creator: "imgnAI",
  description: "",
  platform: "sfw",
  isLegacy: false,
  supportsUhd: true,
  aspectRatios: ["1:1", "16:9"],
  costMusdAtomic: parseMusd("0.0052"),
  fetchedAt: new Date(0).toISOString(),
};

test("generation cost uses exact standard price and doubles UHD", () => {
  assert.equal(generationCost(base, "standard"), 5_200_000_000_000_000n);
  assert.equal(generationCost(base, "uhd"), 10_400_000_000_000_000n);
  assert.equal(formatMusd(generationCost(base, "standard")), "0.0052 MUSD");
});

test("current and legacy model pages are disjoint", () => {
  const legacy = { ...base, modelKey: "legacy", isLegacy: true };
  assert.deepEqual(modelsForPage([base, legacy], "current").map((m) => m.modelKey), ["pink-image"]);
  assert.deepEqual(modelsForPage([base, legacy], "legacy").map((m) => m.modelKey), ["legacy"]);
});

test("price changes compare exact atomic amounts", () => {
  assert.equal(generationPriceChanged(parseMusd("0.0052"), parseMusd("0.0052")), false);
  assert.equal(generationPriceChanged(parseMusd("0.0052"), parseMusd("0.005200000000000001")), true);
  assert.equal(generationPriceChanged(parseMusd("0.0052"), parseMusd("0.006")), true);
});

test("MUSD decimal conversion is exact at 18 decimals", () => {
  const amount = parseMusd("123456789.000000000000000001");
  assert.equal(amount, 123456789000000000000000001n);
  assert.equal(musdToDecimal(amount), "123456789.000000000000000001");
});

test("MUSD solvency accepts legacy floating-point dust but rejects real deficits", () => {
  const assets = parseMusd("19.5888162638");
  assert.equal(hasSufficientMusdBacking(assets, assets + 2_831n), true);
  assert.equal(hasSufficientMusdBacking(assets, assets + 1_000_001n), false);
});

test("generation worker sleeps when idle and wakes at persisted retry times", () => {
  const now = Date.parse("2026-07-14T00:00:00.000Z");
  assert.equal(nextGenerationWorkerDelay([], now), IMGN_WORKER_IDLE_DELAY_MS);
  assert.equal(
    nextGenerationWorkerDelay([{ next_retry_at: new Date(now + 12_345).toISOString() }], now),
    12_345,
  );
  assert.equal(
    nextGenerationWorkerDelay([{ next_retry_at: null }], now),
    IMGN_WORKER_MIN_DELAY_MS,
  );
});
