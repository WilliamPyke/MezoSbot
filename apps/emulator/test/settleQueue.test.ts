import assert from "node:assert/strict";
import { test } from "node:test";
import { SettlementQueue, defaultBackoffMs, type SettleOutcome } from "../src/settleQueue.ts";

type Round = { id: number };
const noSleep = async () => {};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

test("settles serially and applies buttons in round order even when later settles are faster", async () => {
  const applied: number[] = [];
  let active = 0;
  let maxConcurrent = 0;
  const queue = new SettlementQueue<Round>({
    settle: async (round) => {
      active += 1;
      maxConcurrent = Math.max(maxConcurrent, active);
      await new Promise((resolve) => setTimeout(resolve, round.id === 1 ? 20 : 0));
      active -= 1;
      return { kind: "settled", apply: true };
    },
    apply: (round) => applied.push(round.id),
    onFatal: () => assert.fail("not fatal"),
    sleep: noSleep,
  });
  for (const id of [1, 2, 3, 4]) assert.equal(queue.enqueue({ id }), true);
  assert.equal(await queue.drain(1_000), true);
  assert.deepEqual(applied, [1, 2, 3, 4]);
  assert.equal(maxConcurrent, 1);
});

test("retries the same round after a lost response and applies it exactly once", async () => {
  const attempts: Array<[number, number]> = [];
  const applied: number[] = [];
  const delays: number[] = [];
  const queue = new SettlementQueue<Round>({
    settle: async (round, attempt) => {
      attempts.push([round.id, attempt]);
      if (round.id === 1 && attempt < 3) throw new Error("fetch failed");
      return { kind: "settled", apply: true };
    },
    apply: (round) => applied.push(round.id),
    onFatal: () => assert.fail("not fatal"),
    sleep: async (ms) => { delays.push(ms); },
  });
  queue.enqueue({ id: 1 });
  queue.enqueue({ id: 2 });
  await queue.drain(1_000);
  assert.deepEqual(attempts, [[1, 1], [1, 2], [1, 3], [2, 1]]);
  assert.deepEqual(applied, [1, 2]);
  assert.deepEqual(delays, [250, 500]);
});

test("does not apply rounds where every voter was skipped, and continues after rejections", async () => {
  const outcomes: SettleOutcome[] = [
    { kind: "settled", apply: false },
    { kind: "rejected", reason: "bad_button" },
    { kind: "settled", apply: true },
  ];
  const applied: number[] = [];
  const events: string[] = [];
  const queue = new SettlementQueue<Round>({
    settle: async () => outcomes.shift()!,
    apply: (round) => applied.push(round.id),
    onFatal: () => assert.fail("not fatal"),
    onEvent: (event) => events.push(event),
    sleep: noSleep,
  });
  [1, 2, 3].forEach((id) => queue.enqueue({ id }));
  await queue.drain(1_000);
  assert.deepEqual(applied, [3]);
  assert.deepEqual(events, ["round_rejected"]);
});

test("fencing halts the queue, reports fatal, and refuses further rounds", async () => {
  const applied: number[] = [];
  const fatal: string[] = [];
  const settled: number[] = [];
  const queue = new SettlementQueue<Round>({
    settle: async (round) => {
      settled.push(round.id);
      return round.id === 2 ? { kind: "fenced", reason: "not_lease_holder" } : { kind: "settled", apply: true };
    },
    apply: (round) => applied.push(round.id),
    onFatal: (reason) => fatal.push(reason),
    sleep: noSleep,
  });
  [1, 2, 3].forEach((id) => queue.enqueue({ id }));
  await queue.drain(1_000);
  assert.deepEqual(settled, [1, 2]);
  assert.deepEqual(applied, [1]);
  assert.deepEqual(fatal, ["not_lease_holder"]);
  assert.equal(queue.enqueue({ id: 4 }), false);
});

test("halt during a retry stops without applying", async () => {
  const gate = deferred<void>();
  const applied: number[] = [];
  let calls = 0;
  const queue = new SettlementQueue<Round>({
    settle: async () => { calls += 1; throw new Error("down"); },
    apply: (round) => applied.push(round.id),
    onFatal: () => assert.fail("not fatal"),
    sleep: () => gate.promise,
  });
  queue.enqueue({ id: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  queue.halt();
  gate.resolve();
  await queue.drain(1_000);
  assert.equal(calls, 1);
  assert.deepEqual(applied, []);
});

test("close stops intake but drains queued rounds; drain times out on a stuck settle", async () => {
  const applied: number[] = [];
  const stuck = deferred<SettleOutcome>();
  const queue = new SettlementQueue<Round>({
    settle: (round) => (round.id === 1 ? Promise.resolve<SettleOutcome>({ kind: "settled", apply: true }) : stuck.promise),
    apply: (round) => applied.push(round.id),
    onFatal: () => assert.fail("not fatal"),
    sleep: noSleep,
  });
  queue.enqueue({ id: 1 });
  queue.enqueue({ id: 2 });
  queue.close();
  assert.equal(queue.enqueue({ id: 3 }), false);
  assert.equal(await queue.drain(20), false);
  stuck.resolve({ kind: "settled", apply: true });
  assert.equal(await queue.drain(1_000), true);
  assert.deepEqual(applied, [1, 2]);
});

test("backlog cap drops new rounds unsettled", () => {
  const events: string[] = [];
  const never = new Promise<SettleOutcome>(() => {});
  const queue = new SettlementQueue<Round>({
    settle: () => never,
    apply: () => {},
    onFatal: () => {},
    onEvent: (event) => events.push(event),
    maxPending: 2,
  });
  assert.equal(queue.enqueue({ id: 1 }), true);
  assert.equal(queue.enqueue({ id: 2 }), true);
  assert.equal(queue.enqueue({ id: 3 }), false);
  assert.deepEqual(events, ["round_dropped_backlog"]);
  queue.halt();
});

test("default backoff is exponential and capped", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 10].map(defaultBackoffMs), [250, 500, 1_000, 2_000, 4_000, 5_000, 5_000]);
});
