-- Hybrid token swaps: internal inventory + on-chain Mezo Pools, with gas paid in sats.
-- Apply after multi-token and protocol operations migrations.

CREATE TABLE IF NOT EXISTS swaps (
  id BIGSERIAL PRIMARY KEY,
  quote_id UUID NOT NULL UNIQUE,
  discord_id TEXT NOT NULL REFERENCES users(discord_id),
  from_token TEXT NOT NULL CHECK (from_token IN ('SATS', 'MUSD', 'MEZO', 'MUSDC')),
  to_token TEXT NOT NULL CHECK (to_token IN ('SATS', 'MUSD', 'MEZO', 'MUSDC')),
  from_amount DOUBLE PRECISION NOT NULL CHECK (from_amount > 0),
  quoted_to_amount DOUBLE PRECISION NOT NULL CHECK (quoted_to_amount > 0),
  min_to_amount DOUBLE PRECISION NOT NULL CHECK (min_to_amount > 0),
  received_to_amount DOUBLE PRECISION,
  mode TEXT NOT NULL CHECK (mode IN ('internal', 'onchain')),
  status TEXT NOT NULL CHECK (status IN (
    'quoted', 'reserved', 'submitted', 'completed', 'failed', 'cancelled'
  )),
  gas_reserved_sats DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (gas_reserved_sats >= 0),
  gas_actual_sats DOUBLE PRECISION,
  gas_refunded_sats DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (gas_refunded_sats >= 0),
  to_credited BOOLEAN NOT NULL DEFAULT FALSE,
  from_refunded BOOLEAN NOT NULL DEFAULT FALSE,
  gas_settled BOOLEAN NOT NULL DEFAULT FALSE,
  tx_hash TEXT,
  route_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  quote_expires_at TIMESTAMPTZ NOT NULL,
  error_message TEXT,
  guild_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT swaps_distinct_tokens CHECK (from_token <> to_token)
);

CREATE INDEX IF NOT EXISTS idx_swaps_user_status ON swaps(discord_id, status);
CREATE INDEX IF NOT EXISTS idx_swaps_status_created ON swaps(status, created_at);
CREATE INDEX IF NOT EXISTS idx_swaps_pending_recovery
  ON swaps(status, created_at)
  WHERE status IN ('reserved', 'submitted');

CREATE TABLE IF NOT EXISTS swap_daily_volume (
  discord_id TEXT NOT NULL,
  day DATE NOT NULL,
  swap_count INTEGER NOT NULL DEFAULT 0 CHECK (swap_count >= 0),
  -- Approximate notional in sats (from-side converted at quote time).
  volume_sats_proxy DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (volume_sats_proxy >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (discord_id, day)
);

-- Snapshot of treasury free inventory used under advisory lock for internal swaps.
CREATE TABLE IF NOT EXISTS swap_inventory_snapshot (
  token TEXT PRIMARY KEY CHECK (token IN ('SATS', 'MUSD', 'MEZO', 'MUSDC')),
  onchain_amount DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (onchain_amount >= 0),
  liabilities_amount DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (liabilities_amount >= 0),
  free_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO swap_inventory_snapshot(token, onchain_amount, liabilities_amount, free_amount)
VALUES
  ('SATS', 0, 0, 0),
  ('MUSD', 0, 0, 0),
  ('MEZO', 0, 0, 0),
  ('MUSDC', 0, 0, 0)
ON CONFLICT (token) DO NOTHING;

-- Global swap serialization + liability-aware inventory claim for internal path.
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

  -- Serialize all internal inventory claims across app instances.
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

  -- Debit source token.
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

  -- Liabilities for output token = user balances + prize + in-flight swap escrow of this token.
  IF p_to_token = 'SATS' THEN
    SELECT COALESCE(SUM(balance_sats), 0) INTO liabilities FROM users;
    liabilities := liabilities + COALESCE((SELECT SUM(balance_sats) FROM sat_prize_pool), 0);
    liabilities := liabilities + COALESCE((
      SELECT SUM(from_amount) FROM swaps
      WHERE status IN ('reserved', 'submitted') AND from_token = 'SATS'
    ), 0);
    liabilities := liabilities + COALESCE((
      SELECT SUM(GREATEST(gas_reserved_sats - COALESCE(gas_refunded_sats, 0), 0))
      FROM swaps WHERE status IN ('reserved', 'submitted') AND NOT gas_settled
    ), 0);
    -- Protect operational gas reserve from being promised to users via inventory swaps.
    free_amt := p_onchain_to - liabilities - GREATEST(p_gas_reserve_sats, 0);
  ELSE
    SELECT COALESCE(SUM(balance), 0) INTO liabilities
    FROM user_token_balances WHERE token = p_to_token;
    liabilities := liabilities + COALESCE((
      SELECT SUM(from_amount) FROM swaps
      WHERE status IN ('reserved', 'submitted') AND from_token = p_to_token
    ), 0);
    free_amt := p_onchain_to - liabilities;
  END IF;

  IF free_amt + 1e-12 < p_to_amount THEN
    -- Roll back source debit via exception (transaction aborts).
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'insufficient_inventory';
  END IF;

  -- Credit destination.
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
    -- Insufficient inventory: mark failed; outer transaction rolls back balance debit.
    RETURN 'insufficient_inventory';
END;
$$ LANGUAGE plpgsql;

-- Reserve from-token + gas sats for an on-chain swap (idempotent on quote_id).
CREATE OR REPLACE FUNCTION reserve_onchain_swap(
  p_quote_id UUID,
  p_discord_id TEXT,
  p_from_token TEXT,
  p_from_amount DOUBLE PRECISION,
  p_gas_sats DOUBLE PRECISION,
  p_quoted_to DOUBLE PRECISION,
  p_min_to DOUBLE PRECISION
) RETURNS TEXT AS $$
DECLARE
  changed INTEGER;
BEGIN
  IF p_from_amount <= 0 OR p_gas_sats < 0 OR p_quoted_to <= 0 OR p_min_to <= 0 THEN
    RETURN 'invalid_args';
  END IF;

  PERFORM pg_advisory_xact_lock(829401);

  UPDATE swaps
  SET status = 'reserved',
      mode = 'onchain',
      quoted_to_amount = p_quoted_to,
      min_to_amount = p_min_to,
      gas_reserved_sats = p_gas_sats,
      updated_at = now()
  WHERE quote_id = p_quote_id
    AND discord_id = p_discord_id
    AND status = 'quoted'
    AND quote_expires_at > now();
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN
    RETURN 'quote_unavailable';
  END IF;

  IF p_from_token = 'SATS' THEN
    -- User must cover both the swap principal and gas from SATS.
    UPDATE users
    SET balance_sats = balance_sats - (p_from_amount + p_gas_sats), updated_at = now()
    WHERE discord_id = p_discord_id
      AND balance_sats >= (p_from_amount + p_gas_sats);
    GET DIAGNOSTICS changed = ROW_COUNT;
    IF changed <> 1 THEN
      UPDATE swaps SET status = 'failed', error_message = 'insufficient_from_or_gas', updated_at = now()
      WHERE quote_id = p_quote_id;
      RETURN 'insufficient_from_or_gas';
    END IF;
  ELSE
    UPDATE user_token_balances
    SET balance = balance - p_from_amount, updated_at = now()
    WHERE discord_id = p_discord_id AND token = p_from_token AND balance >= p_from_amount;
    GET DIAGNOSTICS changed = ROW_COUNT;
    IF changed <> 1 THEN
      UPDATE swaps SET status = 'failed', error_message = 'insufficient_from', updated_at = now()
      WHERE quote_id = p_quote_id;
      RETURN 'insufficient_from';
    END IF;

    IF p_gas_sats > 0 THEN
      UPDATE users
      SET balance_sats = balance_sats - p_gas_sats, updated_at = now()
      WHERE discord_id = p_discord_id AND balance_sats >= p_gas_sats;
      GET DIAGNOSTICS changed = ROW_COUNT;
      IF changed <> 1 THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'insufficient_sats';
      END IF;
    END IF;
  END IF;

  RETURN 'ok';
EXCEPTION
  WHEN SQLSTATE 'P0001' THEN
    RETURN 'insufficient_sats';
END;
$$ LANGUAGE plpgsql;

-- Credit swap output exactly once.
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
  IF s.status NOT IN ('reserved', 'submitted') THEN RETURN 'bad_status'; END IF;
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

-- Refund from-token + remaining gas exactly once (failed / dropped tx).
-- Only for rows that actually reserved funds (reserved/submitted) and never credited output.
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
  -- Never mint balances for quotes that never debited (quoted/failed-without-reserve).
  IF s.status NOT IN ('reserved', 'submitted') THEN RETURN 'not_reserved'; END IF;
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

CREATE OR REPLACE FUNCTION cancel_swap_quote(p_quote_id UUID, p_discord_id TEXT)
RETURNS TEXT AS $$
DECLARE changed INTEGER;
BEGIN
  UPDATE swaps
  SET status = 'cancelled', updated_at = now()
  WHERE quote_id = p_quote_id
    AND discord_id = p_discord_id
    AND status = 'quoted';
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed = 1 THEN RETURN 'ok'; END IF;
  RETURN 'unavailable';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION get_swap_daily_volume(p_discord_id TEXT, p_day DATE DEFAULT NULL)
RETURNS JSONB AS $$
DECLARE
  d DATE := COALESCE(p_day, (timezone('utc', now()))::date);
  row_count INTEGER := 0;
  vol DOUBLE PRECISION := 0;
BEGIN
  SELECT swap_count, volume_sats_proxy INTO row_count, vol
  FROM swap_daily_volume
  WHERE discord_id = p_discord_id AND day = d;
  RETURN jsonb_build_object(
    'day', d::text,
    'swap_count', COALESCE(row_count, 0),
    'volume_sats_proxy', COALESCE(vol, 0)
  );
END;
$$ LANGUAGE plpgsql STABLE;

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

  -- In-flight swaps debited user balances but still require refundable principal.
  -- Without this, free inventory inflates and internal fills can over-promise.
  SELECT COALESCE(SUM(from_amount::numeric), 0) INTO escrow_sats
    FROM swaps WHERE status IN ('reserved', 'submitted') AND from_token = 'SATS';
  SELECT COALESCE(SUM(from_amount::numeric), 0) INTO escrow_musd
    FROM swaps WHERE status IN ('reserved', 'submitted') AND from_token = 'MUSD';
  SELECT COALESCE(SUM(from_amount::numeric), 0) INTO escrow_mezo
    FROM swaps WHERE status IN ('reserved', 'submitted') AND from_token = 'MEZO';
  SELECT COALESCE(SUM(from_amount::numeric), 0) INTO escrow_musdc
    FROM swaps WHERE status IN ('reserved', 'submitted') AND from_token = 'MUSDC';
  SELECT COALESCE(SUM(
    GREATEST(gas_reserved_sats - COALESCE(gas_refunded_sats, 0), 0)::numeric
  ), 0) INTO escrow_gas_sats
    FROM swaps
    WHERE status IN ('reserved', 'submitted') AND NOT gas_settled;

  RETURN jsonb_build_object(
    'SATS', (sats_users + sats_pool + escrow_sats + escrow_gas_sats)::text,
    'MUSD', (musd + escrow_musd)::text,
    'MEZO', (mezo + escrow_mezo)::text,
    'MUSDC', (musdc + escrow_musdc)::text
  );
END;
$$ LANGUAGE plpgsql STABLE;
