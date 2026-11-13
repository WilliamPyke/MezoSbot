import assert from "node:assert/strict";
import test from "node:test";
import {
  SCAN_CHUNK,
  SCAN_MIN_CHUNK,
  SCAN_RETRY_MS,
  createBalanceScanner,
  decodeScan,
  encodeScan,
} from "../src/custody/balanceScan.js";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const word = (n: bigint) => n.toString(16).padStart(64, "0");
const TOKENS = [address(0xaaa), address(0xbbb)];
const holdersTo = (count: number) => Array.from({ length: count }, (_, i) => address(i + 1));

/** A node that answers a scan of at most `limit` holders; holder n has native n, and n*10 and n*100 of the two tokens. */
function fakeNode(limit: number) {
  const sizes: number[] = [];
  const call = async (data: string) => {
    const tokens = parseInt(data.slice(2, 4), 16);
    const holdersAt = 4 + tokens * 40;
    const holders = (data.length - holdersAt) / 40;
    sizes.push(holders);
    if (holders > limit) throw Object.assign(new Error("out of gas"), { rpcError: true });
    let out = "0x";
    for (let h = 0; h < holders; h++) {
      const n = BigInt(`0x${data.slice(holdersAt + h * 40, holdersAt + (h + 1) * 40)}`);
      out += word(n) + word(n * 10n) + word(n * 100n);
    }
    return out;
  };
  return { call, sizes };
}

const nodeAnswered = (error: unknown) => !!(error as { rpcError?: boolean })?.rpcError;

test("encodeScan packs the token count, tokens and holders", () => {
  assert.equal(
    encodeScan([address(1), address(2)], ["0x00000000000000000000000000000000000000Ab"]),
    `0x01${address(0xab).slice(2)}${address(1).slice(2)}${address(2).slice(2)}`,
  );
  assert.equal(encodeScan([], []), "0x00");
  assert.throws(() => encodeScan(["0x1234"], []), /not an address/);
});

test("decodeScan returns one row per holder and rejects any other length", () => {
  assert.deepEqual(decodeScan(`0x${word(1n)}${word(2n)}${word(3n)}${word(4n)}`, 2, 1), [[1n, 2n], [3n, 4n]]);
  assert.deepEqual(decodeScan("0x", 0, 3), []);
  assert.throws(() => decodeScan("0x", 1, 0), /returned 0 bytes for 1 values/);
  assert.throws(() => decodeScan(`0x${word(1n)}`, 1, 1));
  assert.throws(() => decodeScan(null, 1, 0));
});

test("a scan reads every holder in chunks", async () => {
  const node = fakeNode(1000);
  const scan = createBalanceScanner({ call: node.call, nodeAnswered, warn: assert.fail });
  const holders = holdersTo(SCAN_CHUNK * 2 + 3);
  const rows = await scan(holders, TOKENS);
  assert.deepEqual(node.sizes, [SCAN_CHUNK, SCAN_CHUNK, 3]);
  assert.deepEqual(rows[0], [1n, 10n, 100n]);
  assert.deepEqual(rows.at(-1), [BigInt(holders.length), BigInt(holders.length) * 10n, BigInt(holders.length) * 100n]);
});

test("a refused chunk is halved, and the smaller size is kept", async () => {
  const node = fakeNode(SCAN_CHUNK / 2);
  const scan = createBalanceScanner({ call: node.call, nodeAnswered, warn: assert.fail });
  const holders = holdersTo(SCAN_CHUNK);
  assert.ok((await scan(holders, TOKENS)).every((row, i) => row?.[0] === BigInt(i + 1)));
  assert.deepEqual(node.sizes, [SCAN_CHUNK, SCAN_CHUNK / 2, SCAN_CHUNK / 2]);
  node.sizes.length = 0;
  await scan(holders, TOKENS);
  assert.deepEqual(node.sizes, [SCAN_CHUNK / 2, SCAN_CHUNK / 2]);
});

test("a node that cannot scan is left alone for SCAN_RETRY_MS, then tried again at full size", async () => {
  let clock = 1_000;
  let broken = true;
  const node = fakeNode(1000);
  const warnings: string[] = [];
  const scan = createBalanceScanner({
    // "0x" is what a node that ignores the state override returns.
    call: async (data) => (broken ? (node.sizes.push(-1), "0x") : node.call(data)),
    nodeAnswered,
    warn: (message) => warnings.push(message),
    now: () => clock,
  });
  const holders = holdersTo(SCAN_CHUNK);

  assert.ok((await scan(holders, TOKENS)).every((row) => row === null));
  assert.equal(node.sizes.length, Math.log2(SCAN_CHUNK / SCAN_MIN_CHUNK) + 1);
  assert.equal(warnings.length, 1);

  node.sizes.length = 0;
  broken = false;
  clock += SCAN_RETRY_MS - 1;
  assert.ok((await scan(holders, TOKENS)).every((row) => row === null));
  assert.deepEqual(node.sizes, []);

  clock += 1;
  assert.ok((await scan(holders, TOKENS)).every((row) => row !== null));
  assert.deepEqual(node.sizes, [SCAN_CHUNK]);
});

test("with no answer from the node, holders already read are kept and the chunk size stays", async () => {
  const node = fakeNode(1000);
  let calls = 0;
  const warnings: string[] = [];
  const scan = createBalanceScanner({
    call: (data) => (++calls === 2 ? Promise.reject(new Error("fetch failed")) : node.call(data)),
    nodeAnswered,
    warn: (message) => warnings.push(message),
  });
  const rows = await scan(holdersTo(SCAN_CHUNK + 2), TOKENS);
  assert.equal(rows.filter((row) => row !== null).length, SCAN_CHUNK);
  assert.equal(rows.at(-1), null);
  assert.equal(warnings.length, 1);

  node.sizes.length = 0;
  await scan(holdersTo(SCAN_CHUNK), TOKENS);
  assert.deepEqual(node.sizes, [SCAN_CHUNK]);
});
