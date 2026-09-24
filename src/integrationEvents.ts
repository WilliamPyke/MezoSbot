import { isGameEvent, type GameEvent } from "@mezosbot/contracts";
import { supabase } from "./db.js";

type EventRow = {
  id: string;
  payload: unknown;
  created_at: string;
};

const POLL_INTERVAL_MS = 2_000;
const PURGE_INTERVAL_MS = 60 * 60_000;
const PURGE_BATCH_SIZE = 5000;
const PURGE_MAX_BATCHES = 50;

/**
 * Outbox consumer. Delivery is poll-only: claim_integration_events_v1 locks a
 * batch with FOR UPDATE SKIP LOCKED, so several bot replicas can poll safely.
 * integration_events is intentionally NOT in the supabase_realtime publication
 * (see migrations/2026-08-12_modular_runtime.sql). Failed events back off and
 * are dead-lettered by the database after 10 attempts, including events whose
 * lock expired because the consumer crashed mid-delivery.
 */
export function startIntegrationEventConsumer(handler: (event: GameEvent) => Promise<void>): () => void {
  const workerId = `bot:${process.env.NORTHFLANK_SERVICE_ID ?? process.pid}:${crypto.randomUUID()}`;
  let polling = false;
  let stopped = false;

  const poll = async () => {
    if (polling || stopped) return;
    polling = true;
    try {
      const { data, error } = await supabase.rpc("claim_integration_events_v1", {
        p_worker_id: workerId,
        p_limit: 25,
        p_lock_seconds: 30,
      });
      if (error) throw error;
      for (const row of (data ?? []) as EventRow[]) {
        let success = false;
        let failure = "invalid_event";
        try {
          if (!isGameEvent(row.payload)) throw new Error("Payload does not match GameEvent v1");
          await handler(row.payload);
          success = true;
          failure = "";
          console.log(JSON.stringify({
            level: "info", service: "bot", metric: "integration_event_lag_ms",
            eventType: row.payload.type, value: Date.now() - Date.parse(row.created_at),
          }));
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
        }
        const { error: completeError } = await supabase.rpc("complete_integration_event_v1", {
          p_event_id: row.id,
          p_worker_id: workerId,
          p_success: success,
          p_error: failure || null,
        });
        if (completeError) console.warn("[Outbox] complete failed:", completeError.message);
      }
    } catch (error) {
      console.warn("[Outbox] poll failed:", error instanceof Error ? error.message : error);
    } finally {
      polling = false;
    }
  };

  // Housekeeping (expired idempotency rows, spent nonces, old delivered
  // events). Lease-guarded so only one replica purges per interval.
  const purge = async () => {
    if (stopped) return;
    try {
      const { data: leased, error: leaseError } = await supabase.rpc("acquire_service_lease_v1", {
        p_lease_name: "integration.purge",
        p_holder_id: workerId,
        p_ttl_seconds: Math.floor(PURGE_INTERVAL_MS / 1000) - 60,
      });
      if (leaseError) throw leaseError;
      if (leased !== true) return;
      // Keep deleting full batches so high-volume emulator rounds cannot outgrow
      // one batch per interval; capped so a run stays well inside the lease.
      for (let batch = 0; batch < PURGE_MAX_BATCHES && !stopped; batch++) {
        const { data, error } = await supabase.rpc("purge_integration_state_v1", { p_batch: PURGE_BATCH_SIZE });
        if (error) throw error;
        const counts = (data ?? {}) as Record<string, number>;
        console.log(JSON.stringify({ level: "info", service: "bot", metric: "integration_purge", batch, ...counts }));
        if (!Object.values(counts).some((count) => typeof count === "number" && count >= PURGE_BATCH_SIZE)) break;
      }
    } catch (error) {
      console.warn("[Outbox] purge failed:", error instanceof Error ? error.message : error);
    }
  };

  const timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
  timer.unref();
  const purgeTimer = setInterval(() => void purge(), PURGE_INTERVAL_MS);
  purgeTimer.unref();
  void poll();

  return () => {
    stopped = true;
    clearInterval(timer);
    clearInterval(purgeTimer);
  };
}
