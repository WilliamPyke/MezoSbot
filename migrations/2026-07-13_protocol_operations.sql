-- Public-deposit operations: durable delayed sweeps, gas sponsorship audit, and
-- protocol solvency metrics. Apply after the Katana atomic-MUSD migration.

ALTER TABLE deposit_token_balances
  ADD COLUMN IF NOT EXISTS sweep_after TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_sweep_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_sweep_error TEXT;

CREATE INDEX IF NOT EXISTS idx_deposit_token_sweeps
  ON deposit_token_balances(sweep_after)
  WHERE sweep_after IS NOT NULL;

CREATE TABLE IF NOT EXISTS protocol_gas_operations (
  id UUID PRIMARY KEY,
  operation_type TEXT NOT NULL CHECK (operation_type IN ('erc20_sweep_funding')),
  discord_id TEXT,
  token TEXT,
  sponsor_address TEXT NOT NULL,
  recipient_address TEXT NOT NULL,
  amount_wei NUMERIC(78, 0) NOT NULL CHECK (amount_wei >= 0),
  tx_hash TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','completed','failed')),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_protocol_gas_operations_recent
  ON protocol_gas_operations(created_at DESC);

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
    WHERE status IN ('reserved','funding','refund_pending','inconclusive');
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
