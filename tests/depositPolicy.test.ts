import assert from "node:assert/strict";
import test from "node:test";
import {
  meetsPublicDepositMinimum,
  hasAllowedDepositRole,
  nextSweepTime,
  preservesGasReserve,
  withdrawalGasFundingShortfall,
} from "../src/depositPolicy.js";

test("public minimums accumulate while admins can test smaller deposits", () => {
  assert.equal(meetsPublicDepositMinimum(99n, 100n, false), false);
  assert.equal(meetsPublicDepositMinimum(100n, 100n, false), true);
  assert.equal(meetsPublicDepositMinimum(1n, 100n, true), true);
});

test("gas operations cannot consume backing or the protected reserve", () => {
  assert.equal(preservesGasReserve(1_200n, 100n, 1_000n, 100n), true);
  assert.equal(preservesGasReserve(1_199n, 100n, 1_000n, 100n), false);
});

test("sweep delay is deterministic and clamps negative configuration", () => {
  assert.equal(nextSweepTime(1_000, 300_000), 301_000);
  assert.equal(nextSweepTime(1_000, -1), 1_000);
});

test("deposit access accepts any configured role and fails closed otherwise", () => {
  const allowed = ["g4", "g5", "g6"];
  assert.equal(hasAllowedDepositRole(["other", "g5"], allowed), true);
  assert.equal(hasAllowedDepositRole(["other"], allowed), false);
  assert.equal(hasAllowedDepositRole([], allowed), false);
});

test("withdrawal sponsor funds only a real spendable-gas shortfall", () => {
  assert.equal(withdrawalGasFundingShortfall(1_100n, 100n), 0n);
  assert.equal(withdrawalGasFundingShortfall(100n, 100n), 0n);
  assert.equal(withdrawalGasFundingShortfall(60n, 100n), 40n);
});

test("withdrawal gas does not make the sponsor repair historical under-backing", () => {
  const treasuryBalance = 227_597n;
  const protectedBacking = 275_758n;
  const gasCost = 17n;

  assert.ok(treasuryBalance < protectedBacking);
  assert.equal(withdrawalGasFundingShortfall(treasuryBalance, gasCost), 0n);
});
