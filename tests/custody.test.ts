import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { isCompromisedAddress } from "../src/custody/compromised.js";
import { cloneInitCode, depositSalt, predictForwarder, withdrawalRef } from "../src/custody/forwarder.js";
import { hmacSecret } from "../src/secrets.js";

test("the drained treasury address is recognised in any casing", () => {
  assert.equal(isCompromisedAddress("0xE05206Bd0b57f0D3382AEd6577391669c75Ce40A"), true);
  assert.equal(isCompromisedAddress(" 0xe05206bd0b57f0d3382aed6577391669c75ce40a "), true);
  assert.equal(isCompromisedAddress("0x0000000000000000000000000000000000000001"), false);
  assert.equal(isCompromisedAddress(""), false);
  assert.equal(isCompromisedAddress(null), false);
});

test("hmacSecret never returns a wallet key or a public default", () => {
  const previous = process.env.TREASURY_PRIVATE_KEY;
  const key = "0x" + "11".repeat(32);
  process.env.TREASURY_PRIVATE_KEY = key;
  try {
    assert.equal(hmacSecret("TEST_CONFIGURED", "dedicated-secret"), "dedicated-secret");

    const unset = hmacSecret("TEST_UNSET", "");
    assert.match(unset, /^[0-9a-f]{64}$/);
    assert.equal(hmacSecret("TEST_UNSET", ""), unset, "stable within a process");

    for (const reused of [key, key.slice(2), key.toUpperCase().replace("0X", "0x")]) {
      const secret = hmacSecret("TEST_REUSED", reused);
      assert.notEqual(secret.toLowerCase().replace(/^0x/, ""), key.slice(2));
    }
  } finally {
    if (previous === undefined) delete process.env.TREASURY_PRIVATE_KEY;
    else process.env.TREASURY_PRIVATE_KEY = previous;
  }
});

test("deposit salts are per-user, versioned and secret-free", () => {
  const a = depositSalt("111");
  assert.equal(a, ethers.keccak256(ethers.toUtf8Bytes("mezosbot-deposit-v2:111")));
  assert.notEqual(a, depositSalt("112"));
});

test("forwarder prediction matches the CREATE2 formula for EIP-1167 clones", () => {
  const factory = "0x00000000000000000000000000000000000000F1";
  const implementation = "0x00000000000000000000000000000000000000A1";
  const salt = depositSalt("123");
  const initCode = cloneInitCode(implementation);
  assert.equal(ethers.dataLength(initCode), 55);
  const expected = ethers.getAddress(
    "0x" + ethers.keccak256(ethers.concat(["0xff", factory, salt, ethers.keccak256(initCode)])).slice(26),
  );
  assert.equal(predictForwarder(factory, implementation, salt), expected);
});

test("withdrawal refs are unique per withdrawal id", () => {
  assert.notEqual(withdrawalRef(1), withdrawalRef(2));
  assert.equal(withdrawalRef(7), withdrawalRef(7n));
});
