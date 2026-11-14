/**
 * Discord rate limits: fail fast on long waits, and log what Discord said.
 *
 * @discordjs/rest waits out every 429 and retries without counting the retry.
 * When Discord answers with a long Retry-After, every reply sent with an
 * interaction token (editReply, followUp) sits in that wait. On 2026-11-13
 * replies waited 15 to 50 minutes, then all went out at once with expired
 * tokens ("Invalid Webhook Token"), while "thinking..." acknowledgements, which
 * use a separate handler, still went through. A wait that long is never worth
 * it: an interaction token lasts 15 minutes, and a command stuck in the wait
 * holds up its own bookkeeping. Requests that would wait longer than
 * MAX_RATE_LIMIT_WAIT_MS throw a RateLimitError instead.
 */
import { RESTEvents, type Client, type RateLimitData } from "discord.js";

export const MAX_RATE_LIMIT_WAIT_MS = 30_000;
const LOG_EVERY_MS = 60_000;

/** The longest of the waits @discordjs/rest reports; a 429 without bucket headers only fills retryAfter. */
export function rateLimitWaitMs(info: Pick<RateLimitData, "timeToReset" | "retryAfter" | "sublimitTimeout">): number {
  return Math.max(info.timeToReset || 0, info.retryAfter || 0, info.sublimitTimeout || 0);
}

function throttledLogger(label: string) {
  let lastAt = 0;
  let skipped = 0;
  return (message: string) => {
    const now = Date.now();
    if (now - lastAt < LOG_EVERY_MS) {
      skipped += 1;
      return;
    }
    lastAt = now;
    console.warn(`${label} ${message}${skipped ? ` (+${skipped} more in the last minute)` : ""}`);
    skipped = 0;
  };
}

const logRejected = throttledLogger("[Discord] Rate limited:");

/** For the client's `rest.rejectOnRateLimit`: true makes the request throw instead of waiting. */
export function rejectLongRateLimit(info: RateLimitData): boolean {
  const waitMs = rateLimitWaitMs(info);
  if (waitMs <= MAX_RATE_LIMIT_WAIT_MS) return false;
  logRejected(
    `${info.method.toUpperCase()} ${info.route} would wait ${Math.round(waitMs / 1000)}s ` +
      `(global=${info.global}, scope=${info.scope}); failing it instead`,
  );
  return true;
}

/**
 * Logs each 429 Discord sends, at most once a minute: the headers say whether
 * it is the bot's global limit, a route limit, or a block on the host's IP
 * address (an HTML or plain-text body instead of Discord's JSON).
 */
export function watchDiscordRateLimits(client: Client): void {
  const log = throttledLogger("[Discord] 429");
  client.rest.on(RESTEvents.Response, (request, response) => {
    if (response.status !== 429) return;
    const headers = response.headers;
    const summary =
      // request.route has tokens and ids replaced; request.path would carry an interaction token.
      `${request.method.toUpperCase()} ${request.route}: retry-after=${headers.get("retry-after") ?? "none"}s ` +
      `global=${headers.has("x-ratelimit-global")} scope=${headers.get("x-ratelimit-scope") ?? "none"} ` +
      `bucket=${headers.has("x-ratelimit-bucket")} type=${headers.get("content-type") ?? "none"}`;
    const read = typeof response.text === "function" ? response.text() : Promise.resolve("");
    read
      .catch(() => "")
      .then((body) => log(`${summary} body=${JSON.stringify(String(body).replace(/\s+/g, " ").slice(0, 160))}`));
  });
}
