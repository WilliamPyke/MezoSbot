-- Swap recovery hardening (additive, re-runnable).
-- Apply after 2026-08-03_token_swaps.sql, BEFORE deploying the matching bot build.
--
-- 1. New terminal-for-automation status 'needs_review': recovery stops touching
--    the row and alerts an operator. Funds stay escrowed, so every escrow /
--    liability sum now includes needs_review alongside reserved/submitted.
-- 2. Operators resolve a needs_review row by calling credit_swap_output (a leg
--    delivered the output) or refund_swap_reservation (nothing mined) — both now
--    accept needs_review. Recovery itself never calls them on needs_review rows.
-- 3. Recovery selects by updated_at (last progress), so index that.
--
-- Recovery bookkeeping (attempt counter, lease, per-leg nonces, inventory holds
-- for intermediate leg outputs) lives in swaps.metadata; no new columns.
-- Intermediate-token holds are subtracted in the app before p_onchain_to is
-- passed to execute_internal_swap.

ALTER TABLE swaps DROP CONSTRAINT IF EXISTS swaps_status_check;
ALTER TABLE swaps ADD CONSTRAINT swaps_status_check CHECK (status IN (
  'quoted', 'reserved', 'submitted', 'completed', 'failed', 'cancelled', 'needs_review'
));

CREATE INDEX IF NOT EXISTS idx_swaps_recovery_updated
  ON swaps(status, updated_at)
  WHERE status IN ('reserved', 'submitted');
CREATE INDEX IF NOT EXISTS idx_swaps_needs_review
  ON swaps(updated_at)
  WHERE status = 'needs_review';

-- Same as 2026-08-03 except escrow sums include needs_review.
CREATE OR REPLACE FUNCTION execute_internal_swap(
  p_quote_id UUID,
  p_discord_id TEXT,
  p_from_token TEXT,
  p_to_token TEXT,
  p_from_amount DOUBLE PRECISION,
  p_to_amount DOUBLE PRECISION,
  p_min_to_amount DOUBLE PRECISION,
  p_onchain_to DOUBLE PRECISION,
  p_gas_reserve_sats DOUBLE PRECISION,
  p_volume_sats_proxy DOUBLE PRECISION
) RETURNS TEXT AS $$
DECLARE
  swapped INTEGER;
  liabilities DOUBLE PRECISION;
  free_amt DOUBLE PRECISION;
  day_key DATE := (timezone('utc', now()))::date;
BEGIN
  IF p_from_token = p_to_token OR p_from_amount <= 0 OR p_to_amount <= 0 THEN
    RETURN 'invalid_args';
  END IF;
  IF p_to_amount + 1e-12 < p_min_to_amount THEN
    RETURN 'below_min_out';
  END IF;

  PERFORM pg_advisory_xact_lock(829401);

  UPDATE swaps
  SET status = 'reserved',
      mode = 'internal',
      quoted_to_amount = p_to_amount,
      min_to_amount = p_min_to_amount,
      updated_at = now()
  WHERE quote_id = p_quote_id
    AND discord_id = p_discord_id
    AND status = 'quoted'
    AND quote_expires_at > now();
  GET DIAGNOSTICS swapped = ROW_COUNT;
  IF swapped <> 1 THEN
    RETURN 'quote_unavailable';
  END IF;

  IF p_from_token = 'SATS' THEN
    UPDATE users
    SET balance_sats = balance_sats - p_from_amount, updated_at = now()
    WHERE discord_id = p_discord_id AND balance_sats >= p_from_amount;
    GET DIAGNOSTICS swapped = ROW_COUNT;
    IF swapped <> 1 THEN
      UPDATE swaps SET status = 'failed', error_message = 'insufficient_from', updated_at = now()
      WHERE quote_id = p_quote_id;
      RETURN 'insufficient_from';
    END IF;
  ELSE
    UPDATE user_token_balances
    SET balance = balance - p_from_amount, updated_at = now()
    WHERE discord_id = p_discord_id AND token = p_from_token AND balance >= p_from_amount;
    GET DIAGNOSTICS swapped = ROW_COUNT;
    IF swapped <> 1 THEN
      UPDATE swaps SET status = 'failed', error_message = 'insufficient_from', updated_at = now()
      WHERE quote_id = p_quote_id;
      RETURN 'insufficient_from';
    END IF;
  END IF;

  IF p_to_token = 'SATS' THEN
    SELECT COALESCE(SUM(balance_sats), 0) INTO liabilities FROM users;
    liabilities := liabilities + COALESCE((SELECT SUM(balance_sats) FROM sat_prize_pool), 0);
    liabilities := liabilities + COALESCE((
      SELECT SUM(from_amount) FROM swaps
      WHERE status IN ('reserved', 'submitted', 'needs_review') AND from_token = 'SATS'
    ), 0);
    liabilities := liabilities + COALESCE((
      SELECT SUM(GREATEST(gas_reserved_sats - COALESCE(gas_refunded_sats, 0), 0))
      FROM swaps WHERE status IN ('reserved', 'submitted', 'needs_review') AND NOT gas_settled
    ), 0);
    free_amt := p_onchain_to - liabilities - GREATEST(p_gas_reserve_sats, 0);
  ELSE
    SELECT COALESCE(SUM(balance), 0) INTO liabilities
    FROM user_token_balances WHERE token = p_to_token;
    liabilities := liabilities + COALESCE((
      SELECT SUM(from_amount) FROM swaps
      WHERE status IN ('reserved', 'submitted', 'needs_review') AND from_token = p_to_token
    ), 0);
    free_amt := p_onchain_to - liabilities;
  END IF;

  IF free_amt + 1e-12 < p_to_amount THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'insufficient_inventory';
  END IF;

  IF p_to_token = 'SATS' THEN
    UPDATE users
    SET balance_sats = balance_sats + p_to_amount, updated_at = now()
    WHERE discord_id = p_discord_id;
  ELSE
    INSERT INTO user_token_balances(discord_id, token, balance)
    VALUES (p_discord_id, p_to_token, p_to_amount)
    ON CONFLICT (discord_id, token) DO UPDATE
      SET balance = user_token_balances.balance + EXCLUDED.balance, updated_at = now();
  END IF;

  UPDATE swaps
  SET status = 'completed',
      received_to_amount = p_to_amount,
      to_credited = TRUE,
      gas_settled = TRUE,
      updated_at = now()
  WHERE quote_id = p_quote_id;

  INSERT INTO swap_daily_volume(discord_id, day, swap_count, volume_sats_proxy, updated_at)
  VALUES (p_discord_id, day_key, 1, GREATEST(p_volume_sats_proxy, 0), now())
  ON CONFLICT (discord_id, day) DO UPDATE
    SET swap_count = swap_daily_volume.swap_count + 1,
        volume_sats_proxy = swap_daily_volume.volume_sats_proxy + EXCLUDED.volume_sats_proxy,
        updated_at = now();

  INSERT INTO swap_inventory_snapshot(token, onchain_amount, liabilities_amount, free_amount, updated_at)
  VALUES (p_to_token, p_onchain_to, liabilities + p_to_amount, free_amt - p_to_amount, now())
  ON CONFLICT (token) DO UPDATE
    SET onchain_amount = EXCLUDED.onchain_amount,
        liabilities_amount = EXCLUDED.liabilities_amount,
        free_amount = EXCLUDED.free_amount,
        updated_at = now();

  RETURN 'ok';
EXCEPTION
  WHEN SQLSTATE 'P0001' THEN
    RETURN 'insufficient_inventory';
END;
$$ LANGUAGE plpgsql;

-- Same as 2026-08-03 except needs_review rows may be credited (operator resolution).
CREATE OR REPLACE FUNCTION credit_swap_output(
  p_quote_id UUID,
  p_to_amount DOUBLE PRECISION,
  p_gas_actual_sats DOUBLE PRECISION DEFAULT NULL,
  p_tx_hash TEXT DEFAULT NULL,
  p_volume_sats_proxy DOUBLE PRECISION DEFAULT 0
) RETURNS TEXT AS $$
DECLARE
  s swaps%ROWTYPE;
  day_key DATE := (timezone('utc', now()))::date;
  unused_gas DOUBLE PRECISION;
BEGIN
  PERFORM pg_advisory_xact_lock(829401);

  SELECT * INTO s FROM swaps WHERE quote_id = p_quote_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF s.to_credited THEN RETURN 'already_credited'; END IF;
  IF s.status NOT IN ('reserved', 'submitted', 'needs_review') THEN RETURN 'bad_status'; END IF;
  IF p_to_amount <= 0 THEN RETURN 'invalid_amount'; END IF;

  IF s.to_token = 'SATS' THEN
    UPDATE users
    SET balance_sats = balance_sats + p_to_amount, updated_at = now()
    WHERE discord_id = s.discord_id;
  ELSE
    INSERT INTO user_token_balances(discord_id, token, balance)
    VALUES (s.discord_id, s.to_token, p_to_amount)
    ON CONFLICT (discord_id, token) DO UPDATE
      SET balance = user_token_balances.balance + EXCLUDED.balance, updated_at = now();
  END IF;

  unused_gas := 0;
  IF p_gas_actual_sats IS NOT NULL AND s.gas_reserved_sats > p_gas_actual_sats THEN
    unused_gas := s.gas_reserved_sats - p_gas_actual_sats;
  END IF;

  IF unused_gas > 0 AND NOT s.gas_settled THEN
    UPDATE users
    SET balance_sats = balance_sats + unused_gas, updated_at = now()
    WHERE discord_id = s.discord_id;
  END IF;

  UPDATE swaps
  SET status = 'completed',
      received_to_amount = p_to_amount,
      to_credited = TRUE,
      gas_actual_sats = COALESCE(p_gas_actual_sats, gas_actual_sats),
      gas_refunded_sats = CASE WHEN unused_gas > 0 AND NOT gas_settled THEN unused_gas ELSE gas_refunded_sats END,
      gas_settled = TRUE,
      tx_hash = COALESCE(p_tx_hash, tx_hash),
      updated_at = now()
  WHERE quote_id = p_quote_id;

  INSERT INTO swap_daily_volume(discord_id, day, swap_count, volume_sats_proxy, updated_at)
  VALUES (s.discord_id, day_key, 1, GREATEST(p_volume_sats_proxy, 0), now())
  ON CONFLICT (discord_id, day) DO UPDATE
    SET swap_count = swap_daily_volume.swap_count + 1,
        volume_sats_proxy = swap_daily_volume.volume_sats_proxy + EXCLUDED.volume_sats_proxy,
        updated_at = now();

  IF unused_gas > 0 THEN
    RETURN 'ok_with_gas_refund';
  END IF;
  RETURN 'ok';
END;
$$ LANGUAGE plpgsql;

-- Same as 2026-08-03 except needs_review rows may be refunded (operator resolution
-- only — verify on-chain that no leg delivered output before calling).
CREATE OR REPLACE FUNCTION refund_swap_reservation(
  p_quote_id UUID,
  p_reason TEXT DEFAULT 'failed'
) RETURNS TEXT AS $$
DECLARE
  s swaps%ROWTYPE;
  gas_left DOUBLE PRECISION;
BEGIN
  PERFORM pg_advisory_xact_lock(829401);

  SELECT * INTO s FROM swaps WHERE quote_id = p_quote_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF s.status IN ('completed', 'cancelled') THEN RETURN 'terminal'; END IF;
  IF s.status NOT IN ('reserved', 'submitted', 'needs_review') THEN RETURN 'not_reserved'; END IF;
  IF s.to_credited THEN RETURN 'already_credited'; END IF;
  IF s.from_refunded AND s.gas_settled THEN RETURN 'already_refunded'; END IF;

  IF NOT s.from_refunded THEN
    IF s.from_token = 'SATS' THEN
      UPDATE users
      SET balance_sats = balance_sats + s.from_amount, updated_at = now()
      WHERE discord_id = s.discord_id;
    ELSE
      INSERT INTO user_token_balances(discord_id, token, balance)
      VALUES (s.discord_id, s.from_token, s.from_amount)
      ON CONFLICT (discord_id, token) DO UPDATE
        SET balance = user_token_balances.balance + EXCLUDED.balance, updated_at = now();
    END IF;
  END IF;

  gas_left := 0;
  IF NOT s.gas_settled THEN
    gas_left := GREATEST(s.gas_reserved_sats - COALESCE(s.gas_refunded_sats, 0), 0);
    IF gas_left > 0 THEN
      UPDATE users
      SET balance_sats = balance_sats + gas_left, updated_at = now()
      WHERE discord_id = s.discord_id;
    END IF;
  END IF;

  UPDATE swaps
  SET status = 'failed',
      from_refunded = TRUE,
      gas_refunded_sats = gas_refunded_sats + gas_left,
      gas_settled = TRUE,
      error_message = LEFT(COALESCE(p_reason, 'failed'), 500),
      updated_at = now()
  WHERE quote_id = p_quote_id;

  RETURN 'ok';
END;
$$ LANGUAGE plpgsql;

-- Same as 2026-08-03 except escrow sums include needs_review.
CREATE OR REPLACE FUNCTION get_token_liabilities()
RETURNS JSONB AS $$
DECLARE
  sats_users NUMERIC;
  sats_pool NUMERIC;
  musd NUMERIC;
  mezo NUMERIC;
  musdc NUMERIC;
  escrow_sats NUMERIC;
  escrow_musd NUMERIC;
  escrow_mezo NUMERIC;
  escrow_musdc NUMERIC;
  escrow_gas_sats NUMERIC;
BEGIN
  SELECT COALESCE(SUM(balance_sats::numeric), 0) INTO sats_users FROM users;
  SELECT COALESCE(SUM(balance_sats::numeric), 0) INTO sats_pool FROM sat_prize_pool;
  SELECT COALESCE(SUM(balance::numeric), 0) INTO musd FROM user_token_balances WHERE token = 'MUSD';
  SELECT COALESCE(SUM(balance::numeric), 0) INTO mezo FROM user_token_balances WHERE token = 'MEZO';
  SELECT COALESCE(SUM(balance::numeric), 0) INTO musdc FROM user_token_balances WHERE token = 'MUSDC';

  SELECT COALESCE(SUM(from_amount::numeric), 0) INTO escrow_sats
    FROM swaps WHERE status IN ('reserved', 'submitted', 'needs_review') AND from_token = 'SATS';
  SELECT COALESCE(SUM(from_amount::numeric), 0) INTO escrow_musd
    FROM swaps WHERE status IN ('reserved', 'submitted', 'needs_review') AND from_token = 'MUSD';
  SELECT COALESCE(SUM(from_amount::numeric), 0) INTO escrow_mezo
    FROM swaps WHERE status IN ('reserved', 'submitted', 'needs_review') AND from_token = 'MEZO';
  SELECT COALESCE(SUM(from_amount::numeric), 0) INTO escrow_musdc
    FROM swaps WHERE status IN ('reserved', 'submitted', 'needs_review') AND from_token = 'MUSDC';
  SELECT COALESCE(SUM(
    GREATEST(gas_reserved_sats - COALESCE(gas_refunded_sats, 0), 0)::numeric
  ), 0) INTO escrow_gas_sats
    FROM swaps
    WHERE status IN ('reserved', 'submitted', 'needs_review') AND NOT gas_settled;

  RETURN jsonb_build_object(
    'SATS', (sats_users + sats_pool + escrow_sats + escrow_gas_sats)::text,
    'MUSD', (musd + escrow_musd)::text,
    'MEZO', (mezo + escrow_mezo)::text,
    'MUSDC', (musdc + escrow_musdc)::text
  );
END;
$$ LANGUAGE plpgsql STABLE;
