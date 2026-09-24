/**
 * Serial settlement queue for emulator rounds.
 *
 * Money first, button second: a round's winning button is applied only after
 * the database confirms the debit. Rounds are settled strictly in order and a
 * transient failure (network error, lost response) retries the SAME round id
 * with backoff. settle_emulator_round_v1 is idempotent per round id, so a
 * retry after a lost response returns the original result instead of
 * debiting twice, and the button is still applied.
 */

export type SettleOutcome =
  | { kind: "settled"; apply: boolean }
  | { kind: "rejected"; reason: string }
  | { kind: "fenced"; reason: string };

export interface SettlementQueueOptions<R> {
  /** Settle one round. Throw for transient errors; return an outcome otherwise. */
  settle: (round: R, attempt: number) => Promise<SettleOutcome>;
  /** Apply the round's button to the engine. Called in round order. */
  apply: (round: R) => void;
  /** This instance may no longer settle (lease fencing). The queue halts. */
  onFatal: (reason: string) => void;
  onEvent?: (event: string, data: Record<string, unknown>) => void;
  backoffMs?: (attempt: number) => number;
  sleep?: (ms: number) => Promise<void>;
  /** Rounds beyond this backlog are dropped unsettled (never charged, never applied). */
  maxPending?: number;
}

export function defaultBackoffMs(attempt: number): number {
  return Math.min(250 * 2 ** Math.max(0, attempt - 1), 5_000);
}

export class SettlementQueue<R> {
  private readonly items: R[] = [];
  private running: Promise<void> | null = null;
  private closed = false;
  private halted = false;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly backoffMs: (attempt: number) => number;
  private readonly maxPending: number;

  constructor(private readonly options: SettlementQueueOptions<R>) {
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.backoffMs = options.backoffMs ?? defaultBackoffMs;
    this.maxPending = options.maxPending ?? 120;
  }

  get pending(): number {
    return this.items.length;
  }

  enqueue(round: R): boolean {
    if (this.closed || this.halted) return false;
    if (this.items.length >= this.maxPending) {
      this.options.onEvent?.("round_dropped_backlog", { pending: this.items.length });
      return false;
    }
    this.items.push(round);
    if (!this.running) this.running = this.process().finally(() => { this.running = null; });
    return true;
  }

  /** Stop accepting rounds. Already queued rounds keep settling. */
  close(): void {
    this.closed = true;
  }

  /** Stop immediately; the in-flight attempt finishes but is not retried or applied. */
  halt(): void {
    this.closed = true;
    this.halted = true;
  }

  /** Resolves true once the queue is empty, false on timeout. */
  async drain(timeoutMs: number): Promise<boolean> {
    if (!this.running) return this.items.length === 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
    const done = this.running.then(() => this.items.length === 0);
    try {
      return await Promise.race([done, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async process(): Promise<void> {
    while (this.items.length > 0 && !this.halted) {
      const round = this.items[0];
      const outcome = await this.settleWithRetry(round);
      if (this.halted || !outcome) return;
      this.items.shift();
      if (outcome.kind === "settled") {
        if (outcome.apply) this.options.apply(round);
      } else if (outcome.kind === "rejected") {
        this.options.onEvent?.("round_rejected", { reason: outcome.reason });
      } else {
        this.halt();
        this.options.onFatal(outcome.reason);
        return;
      }
    }
  }

  private async settleWithRetry(round: R): Promise<SettleOutcome | null> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.options.settle(round, attempt);
      } catch (error) {
        if (this.halted) return null;
        const delay = this.backoffMs(attempt);
        this.options.onEvent?.("round_settlement_retry", { attempt, delayMs: delay, error: error instanceof Error ? error.message : String(error) });
        await this.sleep(delay);
        if (this.halted) return null;
      }
    }
  }
}
