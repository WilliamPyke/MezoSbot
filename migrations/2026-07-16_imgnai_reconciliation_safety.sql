-- Keep refunded image jobs terminal and exclude them from protocol liabilities.
-- Apply after 2026-07-13_protocol_operations.sql.

BEGIN;

-- Normalize any row affected by a worker/refund race. The refund itself has
-- already been applied when refunded_at is populated, so this changes status
-- only and never credits a user twice.
UPDATE imgnai_generation_jobs
SET status = 'refunded', next_retry_at = NULL, updated_at = now()
WHERE refunded_at IS NOT NULL
  AND status <> 'refunded';

UPDATE imgnai_generation_jobs
SET next_retry_at = NULL, updated_at = now()
WHERE status IN ('completed', 'refunded', 'policy_failed')
  AND next_retry_at IS NOT NULL;

CREATE OR REPLACE FUNCTION refund_imgnai_generation(p_job_id UUID, p_reason TEXT)
RETURNS BOOLEAN AS $$
DECLARE job imgnai_generation_jobs%ROWTYPE;
BEGIN
  SELECT * INTO job FROM imgnai_generation_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND OR job.refunded_at IS NOT NULL OR job.status = 'completed' THEN RETURN FALSE; END IF;
  INSERT INTO user_token_balances(discord_id, token, balance_atomic)
    VALUES(job.discord_id, 'MUSD', job.quoted_musd_atomic)
    ON CONFLICT(discord_id, token) DO UPDATE
      SET balance_atomic = user_token_balances.balance_atomic + EXCLUDED.balance_atomic,
          updated_at = now();
  UPDATE imgnai_generation_jobs SET
    status = 'refunded',
    refunded_at = now(),
    next_retry_at = NULL,
    error_message = COALESCE(p_reason, error_message),
    updated_at = now()
    WHERE id = p_job_id;
  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION get_protocol_operational_snapshot()
RETURNS JSONB AS $$
DECLARE
  user_sats NUMERIC;
  pool_sats NUMERIC;
  user_musd NUMERIC;
  unswept_musd NUMERIC;
  pending_musd NUMERIC;
  pending_sweeps BIGINT;
  sweep_errors BIGINT;
BEGIN
  SELECT COALESCE(SUM(balance_sats::numeric), 0) INTO user_sats FROM users;
  SELECT COALESCE(SUM(balance_sats::numeric), 0) INTO pool_sats FROM sat_prize_pool;
  SELECT COALESCE(SUM(balance_atomic), 0) INTO user_musd
    FROM user_token_balances WHERE token = 'MUSD';
  SELECT COALESCE(SUM(last_checked_balance::numeric), 0) INTO unswept_musd
    FROM deposit_token_balances WHERE token = 'MUSD';
  SELECT COALESCE(SUM(quoted_musd_atomic), 0) INTO pending_musd
    FROM imgnai_generation_jobs
    WHERE status IN ('reserved','funding','refund_pending','inconclusive')
      AND refunded_at IS NULL;
  SELECT COUNT(*) INTO pending_sweeps
    FROM deposit_token_balances WHERE sweep_after IS NOT NULL;
  SELECT COUNT(*) INTO sweep_errors
    FROM deposit_token_balances WHERE last_sweep_error IS NOT NULL;

  RETURN jsonb_build_object(
    'user_sats_liability', user_sats::text,
    'pool_sats_liability', pool_sats::text,
    'user_musd_atomic', user_musd::text,
    'unswept_musd_atomic', unswept_musd::text,
    'pending_musd_atomic', pending_musd::text,
    'pending_sweeps', pending_sweeps,
    'sweep_errors', sweep_errors
  );
END;
$$ LANGUAGE plpgsql STABLE;

DO $$ BEGIN
  ALTER TABLE imgnai_generation_jobs
    ADD CONSTRAINT imgnai_jobs_refund_status_consistent
    CHECK (refunded_at IS NULL OR status = 'refunded');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMIT;
