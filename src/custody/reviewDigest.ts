/**
 * Admin alerts for Swept events held for review (custody_sweep_reviews). They
 * are queued and sent as one digest message at most every
 * REVIEW_DIGEST_INTERVAL_MS, never one DM per event, so the Swept scanner
 * never waits on Discord. A digest counts the events by status and lists a
 * few examples; an event flagged `belowMinimum` (an unknown-salt sweep below
 * the deposit minimum) is only counted.
 */

export type ReviewAlert = {
  status: string;
  txHash: string;
  logIndex: number;
  salt: string;
  /** Token address as emitted; `tokenLabel` is its symbol when the bot knows it. */
  token: string;
  tokenLabel: string | null;
  amount: bigint;
  /** Counted in the totals only, never listed as an example. */
  belowMinimum: boolean;
};

export const REVIEW_DIGEST_INTERVAL_MS = 10 * 60_000;
/** The first event after a quiet period waits this long so one scan pass lands in one digest. */
export const REVIEW_DIGEST_GATHER_MS = 60_000;
export const REVIEW_DIGEST_EXAMPLES = 5;
/** Below Discord's 2000-character message limit. */
export const REVIEW_DIGEST_MAX_LENGTH = 1800;

export type ReviewDigestBatch = {
  total: number;
  counts: Map<string, number>;
  /** Per status: events counted but not listed (below the deposit minimum). */
  belowMinimum: Map<string, number>;
  examples: ReviewAlert[];
};

function emptyBatch(): ReviewDigestBatch {
  return { total: 0, counts: new Map(), belowMinimum: new Map(), examples: [] };
}

/** Add one event to a batch: always counted, listed only while fewer than `maxExamples` are listed. */
export function addToBatch(batch: ReviewDigestBatch, alert: ReviewAlert, maxExamples = REVIEW_DIGEST_EXAMPLES): void {
  batch.total += 1;
  batch.counts.set(alert.status, (batch.counts.get(alert.status) ?? 0) + 1);
  if (alert.belowMinimum) {
    batch.belowMinimum.set(alert.status, (batch.belowMinimum.get(alert.status) ?? 0) + 1);
    return;
  }
  if (batch.examples.length < maxExamples) batch.examples.push(alert);
}

function exampleLine(alert: ReviewAlert): string {
  const token = alert.tokenLabel ? `${alert.tokenLabel} (${alert.token})` : alert.token;
  return `• ${alert.status}: tx ${alert.txHash}:${alert.logIndex}, salt ${alert.salt}, token ${token}, amount ${alert.amount} (atomic)`;
}

/** The digest message, at most `maxLength` characters (examples are dropped first). */
export function formatReviewDigest(batch: ReviewDigestBatch, maxLength = REVIEW_DIGEST_MAX_LENGTH): string {
  const header = [
    `🔎 **Deposits held for review**: ${batch.total} Swept event${batch.total === 1 ? " was" : "s were"} not credited ` +
      "and are in `custody_sweep_reviews` (status 'open').",
    ...[...batch.counts].sort(([a], [b]) => a.localeCompare(b)).map(([status, count]) => {
      const small = batch.belowMinimum.get(status) ?? 0;
      return `• ${status}: ${count}${small > 0 ? ` (${small} below the deposit minimum, not listed)` : ""}`;
    }),
  ];
  const footer = (listed: number) => {
    const unlisted = batch.total - listed;
    return listed > 0 && unlisted > 0 ? `…and ${unlisted} more; query \`custody_sweep_reviews\` for every one.` : "";
  };
  let examples = batch.examples.map(exampleLine);
  for (;;) {
    const lines = [...header, ...(examples.length > 0 ? ["Examples:", ...examples] : []), footer(examples.length)].filter(Boolean);
    const message = lines.join("\n");
    if (message.length <= maxLength) return message;
    if (examples.length === 0) return `${message.slice(0, Math.max(0, maxLength - 1))}…`;
    examples = examples.slice(0, -1);
  }
}

export type ReviewDigest = {
  queue(alert: ReviewAlert): void;
  /** Send what is queued now (also runs from the timer). Never throws. */
  flush(): Promise<void>;
  pending(): number;
};

export function createReviewDigest(options: {
  send: (message: string) => Promise<void>;
  now?: () => number;
  intervalMs?: number;
  gatherMs?: number;
  /** Runs `fn` after `ms`; the default is an unref'd setTimeout. */
  schedule?: (fn: () => void, ms: number) => void;
}): ReviewDigest {
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? REVIEW_DIGEST_INTERVAL_MS;
  const gatherMs = options.gatherMs ?? REVIEW_DIGEST_GATHER_MS;
  const schedule = options.schedule ?? ((fn: () => void, ms: number) => {
    setTimeout(fn, ms).unref?.();
  });
  let batch = emptyBatch();
  let lastSentAt = Number.NEGATIVE_INFINITY;
  let scheduled = false;

  async function flush(): Promise<void> {
    scheduled = false;
    if (batch.total === 0) return;
    const message = formatReviewDigest(batch);
    batch = emptyBatch();
    lastSentAt = now();
    await options.send(message).catch(() => {});
  }

  return {
    queue(alert) {
      addToBatch(batch, alert);
      if (scheduled) return;
      scheduled = true;
      schedule(() => {
        void flush();
      }, Math.max(gatherMs, lastSentAt + intervalMs - now()));
    },
    flush,
    pending: () => batch.total,
  };
}
