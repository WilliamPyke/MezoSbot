import assert from "node:assert/strict";
import { test } from "node:test";
import { LeaseManager } from "../src/lease.ts";

function harness(responses: Array<boolean | null | Error>) {
  let clock = 0;
  const events: string[] = [];
  const lease = new LeaseManager({
    acquire: async () => {
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    release: async () => { events.push("released"); },
    ttlMs: 30_000,
    renewEveryMs: 10_000,
    standbyPollMs: 5_000,
    retryMs: 1_000,
    safetyMarginMs: 5_000,
    onAcquired: () => events.push("acquired"),
    onLost: (reason) => events.push(`lost:${reason}`),
    now: () => clock,
  });
  return { lease, events, advance: (ms: number) => { clock += ms; } };
}

test("stays in standby while another holder owns the lease (NULL/false result)", async () => {
  const { lease, events } = harness([null, false]);
  assert.equal(await lease.step(), 5_000);
  assert.equal(await lease.step(), 5_000);
  assert.equal(lease.state, "standby");
  assert.equal(lease.isValid(), false);
  assert.deepEqual(events, []);
});

test("standby errors keep polling instead of crashing", async () => {
  const { lease } = harness([new Error("network")]);
  assert.equal(await lease.step(), 5_000);
  assert.equal(lease.state, "standby");
});

test("acquires, renews, and exposes a conservative validity window", async () => {
  const { lease, events, advance } = harness([true, true]);
  assert.equal(await lease.step(), 10_000);
  assert.deepEqual(events, ["acquired"]);
  assert.equal(lease.isValid(), true);
  advance(24_999);
  assert.equal(lease.isValid(), true);
  advance(1);
  assert.equal(lease.isValid(), false, "valid only until ttl - safety margin");
  advance(-15_000);
  assert.equal(await lease.step(), 10_000);
  assert.equal(lease.isValid(), true);
});

test("a renewal returning false is an immediate, terminal loss", async () => {
  const { lease, events } = harness([true, false, true]);
  await lease.step();
  assert.equal(await lease.step(), -1);
  assert.equal(lease.state, "lost");
  assert.equal(await lease.step(), -1, "lost is terminal");
  assert.deepEqual(events, ["acquired", "lost:lease_taken"]);
});

test("renewal errors retry until the local deadline, then lose the lease", async () => {
  const { lease, events, advance } = harness([true, new Error("timeout"), new Error("timeout")]);
  await lease.step();
  advance(10_000);
  assert.equal(await lease.step(), 1_000);
  assert.equal(lease.state, "held");
  advance(15_000);
  assert.equal(await lease.step(), -1);
  assert.deepEqual(events, ["acquired", "lost:lease_deadline_passed"]);
});

test("watchdog check catches a hung renewal", async () => {
  const { lease, events, advance } = harness([true]);
  await lease.step();
  advance(25_000);
  assert.equal(lease.checkDeadline(), true);
  assert.deepEqual(events, ["acquired", "lost:lease_deadline_passed"]);
});

test("stop releases only when held", async () => {
  const held = harness([true]);
  await held.lease.step();
  await held.lease.stop();
  assert.deepEqual(held.events, ["acquired", "released"]);
  assert.equal(held.lease.isValid(), false);

  const standby = harness([false]);
  await standby.lease.step();
  await standby.lease.stop();
  assert.deepEqual(standby.events, []);
});

test("rejects unsafe timing configuration", () => {
  const base = { acquire: async () => true, release: async () => true, onAcquired() {}, onLost() {}, standbyPollMs: 1 };
  assert.throws(() => new LeaseManager({ ...base, ttlMs: 30_000, safetyMarginMs: 30_000, renewEveryMs: 1 }));
  assert.throws(() => new LeaseManager({ ...base, ttlMs: 30_000, safetyMarginMs: 5_000, renewEveryMs: 25_000 }));
});
