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
