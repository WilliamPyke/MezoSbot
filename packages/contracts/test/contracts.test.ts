import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSignedHeaders,
  isArcadeCommand,
  isEmulatorVote,
  verifySignedRequest,
} from "../src/index.js";

test("validates discriminated commands and rejects malformed payloads", () => {
  assert.equal(isArcadeCommand({ version: 1, domain: "arcade", action: "status", actorId: "1", matchId: 7 }), true);
  assert.equal(isArcadeCommand({ version: 1, domain: "arcade", action: "unknown", actorId: "1" }), false);
  assert.equal(isEmulatorVote({ version: 1, domain: "emulator", actorId: "1", button: "A", amountSats: 1 }), true);
  assert.equal(isEmulatorVote({ version: 1, domain: "emulator", actorId: "1", button: "X", amountSats: 1 }), false);
});

test("signs the full request envelope and detects tampering", async () => {
  const url = new URL("https://emulator.mallard.sh/internal/v1/emulator/votes");
  const body = JSON.stringify({ version: 1, domain: "emulator", actorId: "1", button: "A", amountSats: 1 });
  const headers = await buildSignedHeaders({ secret: "test-secret", method: "POST", url, body, timestampMs: 1_000, nonce: "nonce", requestId: "request", idempotencyKey: "idem" });
  assert.equal((await verifySignedRequest({ secret: "test-secret", method: "POST", url, body, headers, nowMs: 1_000 })).ok, true);
  assert.equal((await verifySignedRequest({ secret: "test-secret", method: "POST", url, body: body + " ", headers, nowMs: 1_000 })).ok, false);
});
