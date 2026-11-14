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
  const tally = createInvalidRequestTally();
  setInterval(() => {
    const line = tally.report();
    if (line) console.warn(line);
  }, INVALID_WINDOW_MS).unref();
  client.rest.on(RESTEvents.Response, (request, response) => {
    tally.add(request.method.toUpperCase(), request.route, response.status);
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

/**
 * Discord blocks an IP address for about an hour (Cloudflare "error code: 1015")
 * once it sends 10,000 requests in 10 minutes that end in 401, 403 or 429.
 * Counting this bot's own invalid requests over the same window shows whether
 * the bot caused a block, or something else sharing the host's IP did.
 */
export const INVALID_WINDOW_MS = 10 * 60_000;
const INVALID_STATUSES = new Set([401, 403, 429]);

export function createInvalidRequestTally() {
  let total = 0;
  const invalid = new Map<string, number>();
  return {
    add(method: string, route: string, status: number): void {
      total += 1;
      if (!INVALID_STATUSES.has(status)) return;
      const key = `${status} ${method} ${route}`;
      invalid.set(key, (invalid.get(key) ?? 0) + 1);
    },
    /** One line for the window just ended, or null when it had no invalid requests; then starts a new window. */
    report(): string | null {
      const count = [...invalid.values()].reduce((sum, n) => sum + n, 0);
      const top = [...invalid.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([key, n]) => `${key} x${n}`);
      const line = count === 0
        ? null
        : `[Discord] ${count} invalid request(s) (401/403/429) of ${total} in the last 10 min; ` +
          `Discord blocks the IP at 10000: ${top.join(", ")}`;
      total = 0;
      invalid.clear();
      return line;
    },
  };
}
