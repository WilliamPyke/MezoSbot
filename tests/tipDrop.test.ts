import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { supabase } from "../src/db.js";
import { execute as tip } from "../src/commands/tip.js";
import { execute as drop } from "../src/commands/drop.js";

type Call = [string, unknown?];

let log: Call[] = [];
let rpcResults: Record<string, { data: unknown; error: unknown }> = {};

// Every database call is answered locally; nothing reaches Supabase.
function chain(): unknown {
  const result = Promise.resolve({ data: null, error: null });
  const proxy: unknown = new Proxy(() => {}, {
    get: (_target, prop) => (prop === "then" ? result.then.bind(result) : () => proxy),
    apply: () => proxy,
  });
  return proxy;
}
(supabase as unknown as { rpc: unknown }).rpc = async (name: string, args: unknown) => {
  log.push([`rpc:${name}`, args]);
  return rpcResults[name] ?? { data: null, error: null };
};
(supabase as unknown as { from: unknown }).from = () => chain();

beforeEach(() => {
  log = [];
  rpcResults = {};
});

function interaction(options: Record<string, unknown>, behaviour: { deferFails?: boolean; editFails?: boolean } = {}) {
  const client = { users: { fetch: async () => { throw new Error("offline"); } }, channels: { fetch: async () => null } };
  const self = {
    id: "interaction-1",
    user: { id: "alice", tag: "alice#0" },
    channelId: "channel-1",
    guildId: null,
    deferred: false,
    replied: false,
    client,
    options: {
      getString: (name: string) => (options[name] as string | undefined) ?? null,
      getNumber: (name: string) => options[name] as number,
      getInteger: (name: string) => options[name] as number,
      getBoolean: (name: string) => (options[name] as boolean | undefined) ?? null,
      getRole: () => null,
      getUser: (name: string) => (options[name] as object | undefined) ?? null,
    },
    async reply(payload: unknown) { log.push(["reply", payload]); self.replied = true; },
    async deferReply(payload?: unknown) {
      log.push(["defer", payload]);
      if (behaviour.deferFails) {
        throw Object.assign(new Error("Interaction has already been acknowledged."), { code: 40060 });
      }
      self.deferred = true;
    },
    async editReply(payload: unknown) {
      log.push(["edit", payload]);
      if (behaviour.editFails) throw new Error("Unknown Webhook");
      return { id: "message-1" };
    },
    async followUp(payload: unknown) { log.push(["followUp", payload]); },
    async deleteReply() { log.push(["deleteReply"]); },
  };
  return self;
}

const bob = { id: "bob", bot: false };
const rpcNames = () => log.filter(([kind]) => kind.startsWith("rpc:")).map(([kind]) => kind);
const content = (kind: string) =>
  log.filter(([k]) => k === kind).map(([, payload]) => (payload as { content?: string })?.content ?? "");

test("a tip is acknowledged before funds move, in one transfer", async () => {
  rpcResults.transfer_balance_v1 = { data: true, error: null };
  await tip(interaction({ amount: 100, user: bob }) as never);
  const deferAt = log.findIndex(([kind]) => kind === "defer");
  const transferAt = log.findIndex(([kind]) => kind === "rpc:transfer_balance_v1");
  assert.ok(deferAt >= 0 && deferAt < transferAt, "deferReply comes first");
  assert.deepEqual(rpcNames(), ["rpc:transfer_balance_v1"]);
  assert.deepEqual(log[transferAt][1], { p_sender_id: "alice", p_recipient_id: "bob", p_token: "SATS", p_amount: 100 });
});

test("a second delivery of the same tip moves nothing", async () => {
  await assert.rejects(tip(interaction({ amount: 100, user: bob }, { deferFails: true }) as never));
  assert.deepEqual(rpcNames(), []);
});

test("an unaffordable tip reports insufficient balance privately", async () => {
  rpcResults.transfer_balance_v1 = { data: false, error: null };
  await tip(interaction({ amount: 100, user: bob }) as never);
  assert.deepEqual(rpcNames(), ["rpc:transfer_balance_v1"]);
  assert.match(content("followUp").join(), /Insufficient balance/);
});

test("a tip the database rejected says nothing was taken", async () => {
  rpcResults.transfer_balance_v1 = { data: null, error: { code: "40P01", message: "deadlock detected" } };
  await tip(interaction({ amount: 100, user: bob }) as never);
  assert.match(content("edit").join(), /nothing was taken/);
});

test("a tip whose outcome is unknown asks the sender not to resend", async () => {
  rpcResults.transfer_balance_v1 = { data: null, error: { message: "fetch failed" } };
  await tip(interaction({ amount: 100, user: bob }) as never);
  assert.match(content("edit").join(), /don't resend/);
});

test("a drop is acknowledged before the creator is debited", async () => {
  rpcResults.create_drop_funded_v1 = { data: 784, error: null };
  await drop(interaction({ total: 1000, per_claim: 100, max_claims: 10 }) as never);
  const deferAt = log.findIndex(([kind]) => kind === "defer");
  const createAt = log.findIndex(([kind]) => kind === "rpc:create_drop_funded_v1");
  assert.ok(deferAt >= 0 && deferAt < createAt, "deferReply comes first");
  assert.deepEqual(rpcNames(), ["rpc:create_drop_funded_v1"]);
});

test("a second delivery of the same drop debits nothing", async () => {
  await assert.rejects(drop(interaction({ total: 1000, per_claim: 100, max_claims: 10 }, { deferFails: true }) as never));
  assert.deepEqual(rpcNames(), []);
});

test("a drop that cannot be posted is cancelled and refunded", async () => {
  rpcResults.create_drop_funded_v1 = { data: 784, error: null };
  rpcResults.cancel_drop_refund_v1 = { data: 1000, error: null };
  await drop(interaction({ total: 1000, per_claim: 100, max_claims: 10 }, { editFails: true }) as never);
  assert.deepEqual(rpcNames(), ["rpc:create_drop_funded_v1", "rpc:cancel_drop_refund_v1"]);
  assert.deepEqual(log.find(([kind]) => kind === "rpc:cancel_drop_refund_v1")?.[1], { p_drop_id: 784 });
  assert.match(content("followUp").join(), /cancelled and 1,?000/);
});

test("an unaffordable drop creates nothing", async () => {
  rpcResults.create_drop_funded_v1 = { data: null, error: null };
  await drop(interaction({ total: 1000, per_claim: 100, max_claims: 10 }) as never);
  assert.deepEqual(rpcNames(), ["rpc:create_drop_funded_v1"]);
  assert.match(content("followUp").join(), /Insufficient balance/);
});
