import assert from "node:assert/strict";
import test from "node:test";
import type { RateLimitData } from "discord.js";
import { MAX_RATE_LIMIT_WAIT_MS, rateLimitWaitMs, rejectLongRateLimit } from "../src/discordRateLimits.js";

function info(waits: Partial<Pick<RateLimitData, "timeToReset" | "retryAfter" | "sublimitTimeout">>): RateLimitData {
  return {
    global: false,
    method: "patch",
    url: "https://discord.com/api/v10/webhooks/1/token/messages/@original",
    route: "/webhooks/:id/:token/messages/:id",
    majorParameter: "1/token",
    hash: "Global(PATCH:/webhooks/:id/:token/messages/:id)",
    limit: 5,
    timeToReset: 0,
    retryAfter: 0,
    sublimitTimeout: 0,
    scope: "user",
    ...waits,
  };
}

test("short rate limits are waited out", () => {
  assert.equal(rejectLongRateLimit(info({ timeToReset: 2_000, retryAfter: 2_000 })), false);
  assert.equal(rejectLongRateLimit(info({ timeToReset: MAX_RATE_LIMIT_WAIT_MS })), false);
});

test("a long Retry-After fails the request even without bucket headers", () => {
  // A 429 with no X-RateLimit headers reports timeToReset ~0 and the real wait in retryAfter.
  assert.equal(rateLimitWaitMs(info({ timeToReset: 0, retryAfter: 900_000, sublimitTimeout: 900_000 })), 900_000);
  assert.equal(rejectLongRateLimit(info({ timeToReset: 0, retryAfter: 900_000 })), true);
  assert.equal(rejectLongRateLimit(info({ global: true, timeToReset: 60_000 })), true);
});

test("the invalid-request tally counts 401/403/429 by route and resets each window", async () => {
  const { createInvalidRequestTally } = await import("../src/discordRateLimits.js");
  const tally = createInvalidRequestTally();
  assert.equal(tally.report(), null);
  tally.add("GET", "/channels/:id", 200);
  tally.add("POST", "/channels/:id/messages", 403);
  tally.add("POST", "/channels/:id/messages", 403);
  tally.add("GET", "/guilds/:id/scheduled-events/:id", 429);
  const line = tally.report();
  assert.match(line ?? "", /3 invalid request\(s\) \(401\/403\/429\) of 4 in the last 10 min/);
  assert.match(line ?? "", /403 POST \/channels\/:id\/messages x2, 429 GET/);
  tally.add("GET", "/channels/:id", 200);
  assert.equal(tally.report(), null);
});
