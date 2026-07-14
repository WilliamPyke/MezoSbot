import assert from "node:assert/strict";
import test from "node:test";
import {
  meetsPublicDepositMinimum,
  nextSweepTime,
  pollableDepositRows,
  preservesGasReserve,
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

test("admin-only polling ignores historical public deposit addresses", () => {
  const rows = [
    { discord_id: "admin", address: "0x1" },
    { discord_id: "legacy-user", address: "0x2" },
  ];
  assert.deepEqual(pollableDepositRows(rows, true, ["admin"]), [rows[0]]);
  assert.deepEqual(pollableDepositRows(rows, false, ["admin"]), rows);
});
