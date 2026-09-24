/**
 * Database lease state machine for the single active emulator instance.
 *
 *   standby --acquire ok--> held --renew false / local deadline passed--> lost
 *      ^  |                   |
 *      +--+ acquire false     +-- renew error: retry until the local deadline
 *
 * `lost` is terminal: the process must stop the engine and exit so a fresh
 * process can rejoin as a standby. The local deadline is measured from the
 * start of the last successful acquire call minus a safety margin, so this
 * instance always believes the lease is gone before the database does.
 */

export type LeaseState = "standby" | "held" | "lost" | "stopped";

export interface LeaseOptions {
  /** Acquire or renew. Must resolve `true` only when this holder owns the lease. */
  acquire: () => Promise<unknown>;
  release: () => Promise<unknown>;
  ttlMs: number;
  renewEveryMs: number;
  standbyPollMs: number;
  /** Retry interval while renewals fail but the local deadline has not passed. */
  retryMs?: number;
  safetyMarginMs: number;
  onAcquired: () => void;
  onLost: (reason: string) => void;
  onError?: (error: unknown) => void;
  now?: () => number;
}

export class LeaseManager {
  state: LeaseState = "standby";
  private validUntil = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(private readonly options: LeaseOptions) {
    this.now = options.now ?? (() => performance.now());
    if (options.safetyMarginMs >= options.ttlMs) throw new Error("Lease safety margin must be below the TTL");
    if (options.renewEveryMs >= options.ttlMs - options.safetyMarginMs) throw new Error("Lease renewal interval must be below the effective TTL");
  }

  /** True only while held and inside the conservative local validity window. */
  isValid(): boolean {
    return this.state === "held" && this.now() < this.validUntil;
  }

  /**
   * One acquire/renew attempt plus the resulting transition.
   * Returns the delay before the next step, or -1 when the loop should end.
   */
  async step(): Promise<number> {
    if (this.isFinished()) return -1;
    const started = this.now();
    let owned: boolean | null;
    try {
      owned = (await this.options.acquire()) === true;
    } catch (error) {
      this.options.onError?.(error);
      owned = null;
    }
    // stop()/lose() may have run while the call was in flight.
    if (this.isFinished()) return -1;

    if (this.state === "standby") {
      if (!owned) return this.options.standbyPollMs;
      this.state = "held";
      this.validUntil = started + this.options.ttlMs - this.options.safetyMarginMs;
      this.options.onAcquired();
      return this.options.renewEveryMs;
    }

    // state === "held"
    if (owned === true) {
      this.validUntil = started + this.options.ttlMs - this.options.safetyMarginMs;
      return this.options.renewEveryMs;
    }
    if (owned === false) {
      this.lose("lease_taken");
      return -1;
    }
    if (this.checkDeadline()) return -1;
    return Math.max(0, Math.min(this.options.retryMs ?? 1_000, this.validUntil - this.now()));
  }

  /** Declares the lease lost if the local deadline has passed. Returns true when lost. */
  checkDeadline(): boolean {
    if (this.state === "held" && this.now() >= this.validUntil) {
      this.lose("lease_deadline_passed");
      return true;
    }
    return this.state === "lost";
  }

  start(): void {
    const run = async () => {
      this.timer = null;
      const delay = await this.step();
      if (delay >= 0 && !this.isFinished()) {
        this.timer = setTimeout(() => void run(), delay);
        this.timer.unref?.();
      }
    };
    // A hung renewal RPC must not keep us "held" past the deadline.
    this.watchdog = setInterval(() => this.checkDeadline(), 500);
    this.watchdog.unref?.();
    void run();
  }

  /** Stops the loop and releases the lease if this instance still holds it. */
  async stop(): Promise<void> {
    const wasHeld = this.state === "held";
    this.state = "stopped";
    this.clearTimers();
    if (wasHeld) await this.options.release();
  }

  private isFinished(): boolean {
    return this.state === "lost" || this.state === "stopped";
  }

  private lose(reason: string): void {
    if (this.state !== "held") return;
    this.state = "lost";
    this.clearTimers();
    this.options.onLost(reason);
  }

  private clearTimers(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.timer = null;
    this.watchdog = null;
  }
}
