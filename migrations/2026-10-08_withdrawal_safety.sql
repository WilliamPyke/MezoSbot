-- Withdrawal safety (additive, re-runnable). Apply BEFORE deploying the bot
-- build that uses it: the bot relies on these columns and functions and fails
-- closed (nothing debited, nothing refunded) while they are missing.
--
-- Columns:
-- 1. nonce / signed_at: the treasury nonce and signing time of the withdrawal
--    tx, written with tx_hash BEFORE broadcast. A tx with no receipt is
--    refunded only once the treasury's mined nonce has moved past it and it
--    was signed at least two minutes earlier.
-- 2. raw_tx: the signed transaction, so recovery can rebroadcast the exact same
--    tx (same hash, idempotent) when the node has lost it.
-- 3. gas_reserved_sats: the SATS network fee reserved for an ERC-20 withdrawal.
-- 4. pipeline_version: 2 for rows created by reserve_withdrawal_v2. Older code
--    wrote tx_hash only after ~2 minutes of polling, so a hashless pending row
--    proves "never broadcast" only when pipeline_version >= 2.
--
-- Functions (each one transaction, idempotent by status, so a lost response
-- can be retried safely):
--   reserve_withdrawal_v2  debit + insert the 'pending' row
--   complete_withdrawal_v2 pending -> completed, returning unused ERC-20 gas
--   refund_withdrawal_v2   pending -> failed, crediting amount (+ ERC-20 gas)
-- Status lifecycle: pending -> completed | failed.

ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS nonce BIGINT;
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS raw_tx TEXT;
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS gas_reserved_sats DOUBLE PRECISION;
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS pipeline_version SMALLINT;
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS signed_at TIMESTAMPTZ;

-- Recovery and the solvency check select in-flight rows by status.
CREATE INDEX IF NOT EXISTS idx_withdrawals_status_created
  ON withdrawals(status, created_at);

-- Debit the user and create the pending row together. Returns
-- {status: ok, id, created_at} | {status: insufficient_token | insufficient_sats}.
CREATE OR REPLACE FUNCTION reserve_withdrawal_v2(
  p_discord_id TEXT,
  p_to_address TEXT,
  p_token TEXT,
  p_amount DOUBLE PRECISION,
  p_gas_sats DOUBLE PRECISION DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reserved TEXT;
  v_id BIGINT;
  v_created_at TIMESTAMPTZ;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0
     OR p_to_address IS NULL OR p_to_address !~ '^0x[0-9a-f]{40}$'
     OR p_token IS NULL OR p_token NOT IN ('SATS', 'MUSD', 'MEZO', 'MUSDC') THEN
    RAISE EXCEPTION 'invalid withdrawal reservation';
  END IF;

  IF p_token = 'SATS' THEN
    IF NOT subtract_balance_if_sufficient(p_discord_id, p_amount) THEN
      RETURN jsonb_build_object('status', 'insufficient_token');
    END IF;
  ELSE
    -- Debits the token and its SATS gas reservation, or neither.
    v_reserved := reserve_token_withdrawal(p_discord_id, p_token, p_amount, p_gas_sats);
    IF v_reserved IS DISTINCT FROM 'ok' THEN
      RETURN jsonb_build_object('status', v_reserved);
    END IF;
  END IF;

  INSERT INTO withdrawals(discord_id, amount_sats, to_address, status, token, gas_reserved_sats, pipeline_version)
  VALUES (
    p_discord_id, p_amount, p_to_address, 'pending', p_token,
    CASE WHEN p_token = 'SATS' THEN NULL ELSE p_gas_sats END,
    2
  )
  RETURNING id, created_at INTO v_id, v_created_at;

  RETURN jsonb_build_object('status', 'ok', 'id', v_id, 'created_at', v_created_at);
END;
$$;

-- Mark a confirmed withdrawal completed and return the unused part of an
-- ERC-20 gas reservation. p_fallback_gas_sats covers rows that predate
-- gas_reserved_sats. Returns {status: completed, unused_gas_sats} |
-- {status: not_pending, current} | {status: not_found}.
CREATE OR REPLACE FUNCTION complete_withdrawal_v2(
  p_withdrawal_id BIGINT,
  p_actual_gas_sats DOUBLE PRECISION DEFAULT NULL,
  p_fallback_gas_sats DOUBLE PRECISION DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row withdrawals%ROWTYPE;
  v_unused DOUBLE PRECISION := 0;
BEGIN
  SELECT * INTO v_row FROM withdrawals WHERE id = p_withdrawal_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  IF v_row.status IS DISTINCT FROM 'pending' THEN
    RETURN jsonb_build_object('status', 'not_pending', 'current', v_row.status);
  END IF;

  IF COALESCE(v_row.token, 'SATS') <> 'SATS' AND p_actual_gas_sats IS NOT NULL THEN
    v_unused := round(GREATEST(
      COALESCE(v_row.gas_reserved_sats, p_fallback_gas_sats, 0) - p_actual_gas_sats, 0
    )::numeric, 10)::double precision;
    IF v_unused > 0 THEN
      INSERT INTO users(discord_id) VALUES (v_row.discord_id) ON CONFLICT (discord_id) DO NOTHING;
      PERFORM add_balance(v_row.discord_id, v_unused);
    END IF;
  END IF;

  UPDATE withdrawals SET status = 'completed' WHERE id = p_withdrawal_id;
  RETURN jsonb_build_object('status', 'completed', 'unused_gas_sats', v_unused);
END;
$$;

-- Refund a withdrawal proven unable to land. p_require_no_hash is set for a
-- "never broadcast" refund: the row must still be hashless and come from the
-- persist-before-broadcast pipeline. Returns {status: refunded, token, amount,
-- gas_sats} | {status: not_pending, current} | {status: has_hash} |
-- {status: legacy_row} | {status: not_found}.
CREATE OR REPLACE FUNCTION refund_withdrawal_v2(
  p_withdrawal_id BIGINT,
  p_require_no_hash BOOLEAN DEFAULT FALSE,
  p_fallback_gas_sats DOUBLE PRECISION DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row withdrawals%ROWTYPE;
  v_token TEXT;
  v_gas DOUBLE PRECISION := 0;
BEGIN
  SELECT * INTO v_row FROM withdrawals WHERE id = p_withdrawal_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  IF v_row.status IS DISTINCT FROM 'pending' THEN
    RETURN jsonb_build_object('status', 'not_pending', 'current', v_row.status);
  END IF;
  IF p_require_no_hash AND v_row.tx_hash IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'has_hash');
  END IF;
  IF p_require_no_hash AND COALESCE(v_row.pipeline_version, 0) < 2 THEN
    RETURN jsonb_build_object('status', 'legacy_row');
  END IF;

  v_token := COALESCE(v_row.token, 'SATS');
  INSERT INTO users(discord_id) VALUES (v_row.discord_id) ON CONFLICT (discord_id) DO NOTHING;
  IF v_token = 'SATS' THEN
    PERFORM add_balance(v_row.discord_id, v_row.amount_sats);
  ELSE
    PERFORM add_token_balance(v_row.discord_id, v_token, v_row.amount_sats);
    v_gas := COALESCE(v_row.gas_reserved_sats, p_fallback_gas_sats, 0);
    IF v_gas > 0 THEN
      PERFORM add_balance(v_row.discord_id, v_gas);
    END IF;
  END IF;

  UPDATE withdrawals SET status = 'failed' WHERE id = p_withdrawal_id;
  RETURN jsonb_build_object(
    'status', 'refunded', 'token', v_token, 'amount', v_row.amount_sats, 'gas_sats', v_gas
  );
END;
$$;

-- Privileges: service_role only. Supabase's default privileges grant EXECUTE
-- on new functions to anon/authenticated, and the modular_runtime grant loop
-- only matches *_v1 names, so these are revoked and granted explicitly (role
-- checks keep plain Postgres/CI without those roles working).
DO $$
DECLARE
  v_sig TEXT;
  v_role TEXT;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'reserve_withdrawal_v2(text, text, text, double precision, double precision)',
    'complete_withdrawal_v2(bigint, double precision, double precision)',
    'refund_withdrawal_v2(bigint, boolean, double precision)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_sig);
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', v_sig, v_role);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_sig);
    END IF;
  END LOOP;
END;
$$;
