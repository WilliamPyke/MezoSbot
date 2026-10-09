-- Custody v2 (deploy/CUSTODY.md). Additive and re-runnable; apply after
-- 2026-10-09_lockdown_public_access.sql and before the bot build that runs
-- custody v2.
--
-- Deposits: each user's deposit address becomes a keyless CREATE2 forwarder
-- that can only sweep to the vault (deposit_addresses.address_version = 2,
-- salt). Every v1 address, derived from the retired treasury key, moves to
-- legacy_address and address is cleared, so neither the bot nor the deposit
-- page shows one again; the bot writes the forwarder address the next time a
-- user needs it (register_forwarder_address_v1). Pending wallet-verification
-- challenges that point at a retired address are expired.
--
-- Credits come only from DepositFactory Swept events, through
-- credit_forwarder_deposit_v1, idempotent on the natural key
-- (tx_hash, salt, token): the same amount again is a duplicate (whatever its
-- log index), and a second event with that key but another amount goes to
-- review. A swept
-- registered salt is credited even if the user's deposits are not enabled
-- (the funds are already in the vault; deposits_enabled only gates showing
-- addresses). An event it cannot attribute (unknown salt, wrong vault,
-- unknown token) is recorded in custody_sweep_reviews and never credited.
--
-- Withdrawals: payout_ref / signer_address mark HotPayout payouts and are
-- written with tx_hash before broadcast. custody_signed_txs records every
-- signature by a custody key before broadcast, keeping every hash signed for
-- a nonce (the watchdog freezes custody on a spent nonce without a record or
-- without a receipt for a recorded hash); custody_cursors holds
-- scanner/watchdog positions; custody_acknowledgements lists anomalies an
-- admin accepted with /custody unfreeze, which never freeze custody again.
-- custody_refund_checks tracks the watchdog's paid(ref) re-reads of refunded
-- HotPayout withdrawals until each is verified unpaid
-- (custody_refund_candidates_v1 lists the ones still to read).
--
-- New tables: RLS on, no policies, service_role only; new functions are
-- service_role only. The deposit page's read of
-- deposit_addresses(discord_id, address) is granted again here, after the
-- retired addresses are cleared.

BEGIN;
SET LOCAL lock_timeout = '5s';

/* ─────────── Deposit addresses ─────────── */

ALTER TABLE deposit_addresses ADD COLUMN IF NOT EXISTS address_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE deposit_addresses ADD COLUMN IF NOT EXISTS salt TEXT;
ALTER TABLE deposit_addresses ADD COLUMN IF NOT EXISTS legacy_address TEXT;
ALTER TABLE deposit_addresses ALTER COLUMN address DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS deposit_addresses_salt_key ON deposit_addresses(salt);
CREATE INDEX IF NOT EXISTS idx_deposit_addresses_v2_enabled
  ON deposit_addresses(discord_id) WHERE address_version = 2 AND deposits_enabled = TRUE;

-- Retire every v1 address. Re-running only touches rows a legacy-mode
-- process has refilled since.
UPDATE deposit_addresses
   SET legacy_address = COALESCE(legacy_address, address),
       address = NULL
 WHERE address_version = 1
   AND address IS NOT NULL;

DO $$
BEGIN
  ALTER TABLE deposit_addresses ADD CONSTRAINT deposit_addresses_version_check CHECK (
    (address_version = 1 AND salt IS NULL)
    OR (address_version = 2 AND salt IS NOT NULL AND address IS NOT NULL)
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END;
$$;

UPDATE wallet_verification_challenges c
   SET status = 'expired'
 WHERE c.status = 'pending'
   AND EXISTS (
     SELECT 1 FROM deposit_addresses d
      WHERE d.legacy_address IS NOT NULL
        AND lower(d.legacy_address) = lower(c.deposit_address)
   );

/* ─────────── Custody bookkeeping ─────────── */

CREATE TABLE IF NOT EXISTS custody_cursors (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS custody_signed_txs (
  signer TEXT NOT NULL CHECK (signer ~ '^0x[0-9a-f]{40}$'),
  nonce BIGINT NOT NULL CHECK (nonce >= 0),
  tx_hash TEXT NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  purpose TEXT NOT NULL CHECK (purpose IN ('withdrawal', 'sweep_native', 'sweep_token', 'pause')),
  ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (signer, tx_hash)
);
CREATE INDEX IF NOT EXISTS idx_custody_signed_txs_nonce ON custody_signed_txs(signer, nonce);

CREATE TABLE IF NOT EXISTS custody_forwarder_credits (
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  block_number BIGINT NOT NULL,
  salt TEXT NOT NULL,
  discord_id TEXT NOT NULL,
  token TEXT NOT NULL CHECK (token IN ('SATS', 'MUSD', 'MEZO', 'MUSDC')),
  token_address TEXT NOT NULL,
  amount_atomic NUMERIC(78, 0) NOT NULL CHECK (amount_atomic > 0),
  credited_amount DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tx_hash, salt, token_address)
);
CREATE INDEX IF NOT EXISTS idx_custody_forwarder_credits_user
  ON custody_forwarder_credits(discord_id, created_at DESC);

CREATE TABLE IF NOT EXISTS custody_sweep_reviews (
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  block_number BIGINT NOT NULL,
  salt TEXT NOT NULL,
  token_address TEXT NOT NULL,
  amount_atomic NUMERIC(78, 0) NOT NULL,
  vault TEXT NOT NULL,
  reason TEXT NOT NULL,
  discord_id TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  PRIMARY KEY (tx_hash, salt, token_address)
);

-- The review reasons are (re)defined here so a table from an earlier draft
-- always accepts every current reason.
ALTER TABLE custody_sweep_reviews DROP CONSTRAINT IF EXISTS custody_sweep_reviews_reason_check;
ALTER TABLE custody_sweep_reviews ADD CONSTRAINT custody_sweep_reviews_reason_check
  CHECK (reason IN ('unknown_salt', 'wrong_vault', 'unknown_token', 'conflicting_event'));

CREATE TABLE IF NOT EXISTS custody_acknowledgements (
  key TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A refunded HotPayout withdrawal is re-read (paid(ref) must stay false)
-- until it read false at least 3 times over at least an hour; verified_at is
-- then set and the row is never re-read (a later Paid for its ref is still
-- caught by the watchdog's Paid scan).
CREATE TABLE IF NOT EXISTS custody_refund_checks (
  withdrawal_id BIGINT PRIMARY KEY,
  payout_ref TEXT NOT NULL,
  false_reads INTEGER NOT NULL DEFAULT 0 CHECK (false_reads >= 0),
  first_false_at TIMESTAMPTZ,
  last_read_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  CHECK (verified_at IS NULL OR (false_reads > 0 AND first_false_at IS NOT NULL))
);

-- The idempotency and nonce checks depend on these exact keys. A table left by
-- an earlier draft of this migration with other keys stops the migration
-- here (the transaction rolls back) instead of running with a silent mismatch.
CREATE OR REPLACE FUNCTION custody_v2_schema_problems()
RETURNS TEXT[]
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_problems TEXT[] := ARRAY[]::TEXT[];
  v_expected RECORD;
  v_pk TEXT[];
  v_extra INTEGER;
BEGIN
  FOR v_expected IN
    SELECT * FROM (VALUES
      ('custody_signed_txs', ARRAY['signer', 'tx_hash']),
      ('custody_forwarder_credits', ARRAY['tx_hash', 'salt', 'token_address']),
      ('custody_sweep_reviews', ARRAY['tx_hash', 'salt', 'token_address']),
      ('custody_refund_checks', ARRAY['withdrawal_id'])
    ) AS t(tbl, cols)
  LOOP
    IF to_regclass('public.' || v_expected.tbl) IS NULL THEN
      v_problems := v_problems || format('%s is missing', v_expected.tbl);
      CONTINUE;
    END IF;
    SELECT array_agg(a.attname::TEXT ORDER BY k.ord) INTO v_pk
      FROM pg_constraint c
      CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
     WHERE c.conrelid = ('public.' || v_expected.tbl)::regclass AND c.contype = 'p';
    IF v_pk IS DISTINCT FROM v_expected.cols THEN
      v_problems := v_problems || format('%s has primary key (%s), expected (%s)', v_expected.tbl,
        COALESCE(array_to_string(v_pk, ', '), 'none'), array_to_string(v_expected.cols, ', '));
    END IF;
    SELECT count(*) INTO v_extra FROM pg_index i
     WHERE i.indrelid = ('public.' || v_expected.tbl)::regclass AND i.indisunique AND NOT i.indisprimary;
    IF v_extra > 0 THEN
      v_problems := v_problems || format('%s has %s unique index(es) besides its primary key', v_expected.tbl, v_extra);
    END IF;
  END LOOP;
  RETURN v_problems;
END;
$$;

DO $$
DECLARE
  v_problems TEXT[] := custody_v2_schema_problems();
BEGIN
  IF cardinality(v_problems) > 0 THEN
    RAISE EXCEPTION 'custody v2 tables do not match this migration: %. Migrate or drop them deliberately, then re-run.',
      array_to_string(v_problems, '; ');
  END IF;
END;
$$;

ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS payout_ref TEXT;
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS signer_address TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_withdrawals_payout_ref
  ON withdrawals(payout_ref) WHERE payout_ref IS NOT NULL;

/* ─────────── Functions ─────────── */

-- Issue a user's v2 forwarder address. A v1 row keeps its old address in
-- legacy_address; a v2 row with a different address or salt is never
-- overwritten (a redeployed factory needs its own migration).
-- Returns {status: ok, address, deposits_enabled, last_checked_balance} | {status: conflict}.
CREATE OR REPLACE FUNCTION register_forwarder_address_v1(
  p_discord_id TEXT,
  p_address TEXT,
  p_salt TEXT,
  p_enable BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row deposit_addresses%ROWTYPE;
  v_address TEXT := lower(p_address);
  v_salt TEXT := lower(p_salt);
BEGIN
  IF p_discord_id IS NULL OR p_discord_id = ''
     OR v_address IS NULL OR v_address !~ '^0x[0-9a-f]{40}$'
     OR v_salt IS NULL OR v_salt !~ '^0x[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid forwarder registration';
  END IF;

  SELECT * INTO v_row FROM deposit_addresses WHERE discord_id = p_discord_id FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO deposit_addresses(discord_id, address, address_version, salt, deposits_enabled, last_checked_balance)
    VALUES (p_discord_id, v_address, 2, v_salt, COALESCE(p_enable, FALSE), '0')
    ON CONFLICT (discord_id) DO NOTHING
    RETURNING * INTO v_row;
    IF v_row.discord_id IS NULL THEN
      SELECT * INTO v_row FROM deposit_addresses WHERE discord_id = p_discord_id FOR UPDATE;
    END IF;
  END IF;

  IF v_row.address_version = 2 THEN
    IF v_row.address IS DISTINCT FROM v_address OR v_row.salt IS DISTINCT FROM v_salt THEN
      RETURN jsonb_build_object('status', 'conflict');
    END IF;
    IF COALESCE(p_enable, FALSE) AND NOT v_row.deposits_enabled THEN
      UPDATE deposit_addresses SET deposits_enabled = TRUE
       WHERE discord_id = p_discord_id
      RETURNING * INTO v_row;
    END IF;
  ELSE
    UPDATE deposit_addresses
       SET legacy_address = COALESCE(legacy_address, address),
           address = v_address,
           address_version = 2,
           salt = v_salt,
           deposits_enabled = deposits_enabled OR COALESCE(p_enable, FALSE),
           last_checked_balance = '0',
           native_sweep_tx_hash = NULL,
           native_sweep_balance = NULL,
           native_sweep_started_at = NULL
     WHERE discord_id = p_discord_id
    RETURNING * INTO v_row;
  END IF;

  RETURN jsonb_build_object(
    'status', 'ok',
    'address', v_row.address,
    'deposits_enabled', v_row.deposits_enabled,
    'last_checked_balance', v_row.last_checked_balance
  );
END;
$$;

-- Credit one DepositFactory Swept event. The bot maps the token address to
-- its symbol and decimals (p_token_symbol NULL when unknown). SATS converts
-- 10^10 wei per sat, rounded to 10 decimals like mezo_round_sats; MUSD is
-- credited in exact atomic units; MEZO/MUSDC through add_token_balance.
-- Idempotent on (tx_hash, salt, token); p_log_index is recorded as data.
-- Returns {status: credited | duplicate, discord_id, token, amount, deposit_ref}
-- | {status: unknown_salt | wrong_vault | unknown_token, already_recorded}.
CREATE OR REPLACE FUNCTION credit_forwarder_deposit_v1(
  p_tx_hash TEXT,
  p_log_index INTEGER,
  p_block_number BIGINT,
  p_salt TEXT,
  p_token_address TEXT,
  p_token_symbol TEXT,
  p_token_decimals INTEGER,
  p_amount_atomic NUMERIC,
  p_vault TEXT,
  p_expected_vault TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c_native CONSTANT TEXT := '0x0000000000000000000000000000000000000000';
  v_tx TEXT := lower(p_tx_hash);
  v_salt TEXT := lower(p_salt);
  v_token_address TEXT := lower(p_token_address);
  v_vault TEXT := lower(p_vault);
  v_expected TEXT := lower(p_expected_vault);
  v_ref TEXT;
  v_addr deposit_addresses%ROWTYPE;
  v_credit custody_forwarder_credits%ROWTYPE;
  v_review TEXT;
  v_sats NUMERIC;
  v_amount DOUBLE PRECISION;
  v_inserted INTEGER;
BEGIN
  IF v_tx IS NULL OR v_tx !~ '^0x[0-9a-f]{64}$'
     OR p_log_index IS NULL OR p_log_index < 0
     OR p_block_number IS NULL OR p_block_number < 0
     OR v_salt IS NULL OR v_salt !~ '^0x[0-9a-f]{64}$'
     OR v_token_address IS NULL OR v_token_address !~ '^0x[0-9a-f]{40}$'
     OR v_vault IS NULL OR v_vault !~ '^0x[0-9a-f]{40}$'
     OR v_expected IS NULL OR v_expected !~ '^0x[0-9a-f]{40}$'
     OR p_amount_atomic IS NULL OR p_amount_atomic <= 0 OR p_amount_atomic <> trunc(p_amount_atomic) THEN
    RAISE EXCEPTION 'invalid forwarder deposit';
  END IF;
  v_ref := v_tx || ':' || p_log_index;

  SELECT * INTO v_credit FROM custody_forwarder_credits
   WHERE tx_hash = v_tx AND salt = v_salt AND token_address = v_token_address;
  IF FOUND THEN
    -- The same amount again is the same event, whatever log index a node reports.
    IF v_credit.amount_atomic = p_amount_atomic THEN
      RETURN jsonb_build_object('status', 'duplicate', 'discord_id', v_credit.discord_id, 'token', v_credit.token,
        'amount', v_credit.credited_amount, 'deposit_ref', v_credit.tx_hash || ':' || v_credit.log_index);
    END IF;
    -- Same (tx, salt, token) as a credited event but another amount: never a
    -- second credit, never silently dropped.
    INSERT INTO custody_sweep_reviews(tx_hash, log_index, block_number, salt, token_address, amount_atomic, vault, reason, discord_id)
    VALUES (v_tx, p_log_index, p_block_number, v_salt, v_token_address, p_amount_atomic, v_vault, 'conflicting_event', v_credit.discord_id)
    ON CONFLICT (tx_hash, salt, token_address) DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    RETURN jsonb_build_object('status', 'conflicting_event', 'already_recorded', v_inserted = 0,
      'discord_id', v_credit.discord_id, 'deposit_ref', v_ref);
  END IF;
  SELECT reason INTO v_review FROM custody_sweep_reviews
   WHERE tx_hash = v_tx AND salt = v_salt AND token_address = v_token_address;
  IF FOUND THEN
    RETURN jsonb_build_object('status', v_review, 'already_recorded', TRUE, 'deposit_ref', v_ref);
  END IF;

  IF v_vault <> v_expected THEN
    v_review := 'wrong_vault';
  ELSE
    -- deposits_enabled is not checked: the funds are already in the vault.
    SELECT * INTO v_addr FROM deposit_addresses WHERE salt = v_salt AND address_version = 2 FOR UPDATE;
    IF NOT FOUND THEN
      v_review := 'unknown_salt';
    -- COALESCE: a NULL symbol or decimals (unknown token) must route to
    -- review, not fall through as NOT NULL.
    ELSIF NOT COALESCE(
      (p_token_symbol = 'SATS' AND v_token_address = c_native AND p_token_decimals = 18)
      OR (p_token_symbol = 'MUSD' AND v_token_address <> c_native AND p_token_decimals = 18)
      OR (p_token_symbol IN ('MEZO', 'MUSDC') AND v_token_address <> c_native AND p_token_decimals BETWEEN 0 AND 36),
      FALSE
    ) THEN
      v_review := 'unknown_token';
    END IF;
  END IF;

  IF v_review IS NOT NULL THEN
    INSERT INTO custody_sweep_reviews(tx_hash, log_index, block_number, salt, token_address, amount_atomic, vault, reason, discord_id)
    VALUES (v_tx, p_log_index, p_block_number, v_salt, v_token_address, p_amount_atomic, v_vault, v_review, v_addr.discord_id)
    ON CONFLICT (tx_hash, salt, token_address) DO NOTHING;
    RETURN jsonb_build_object('status', v_review, 'already_recorded', FALSE, 'discord_id', v_addr.discord_id, 'deposit_ref', v_ref);
  END IF;

  IF p_token_symbol = 'SATS' THEN
    v_sats := round(p_amount_atomic / 10000000000::NUMERIC, 10);
    v_amount := v_sats::DOUBLE PRECISION;
  ELSE
    v_amount := (p_amount_atomic / power(10::NUMERIC, p_token_decimals))::DOUBLE PRECISION;
  END IF;

  INSERT INTO custody_forwarder_credits(
    tx_hash, log_index, block_number, salt, discord_id, token, token_address, amount_atomic, credited_amount
  )
  VALUES (v_tx, p_log_index, p_block_number, v_salt, v_addr.discord_id, p_token_symbol, v_token_address, p_amount_atomic, v_amount)
  ON CONFLICT (tx_hash, salt, token_address) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN
    RETURN jsonb_build_object('status', 'duplicate', 'discord_id', v_addr.discord_id, 'token', p_token_symbol,
      'amount', v_amount, 'deposit_ref', v_ref);
  END IF;

  INSERT INTO users(discord_id) VALUES (v_addr.discord_id) ON CONFLICT (discord_id) DO NOTHING;
  IF p_token_symbol = 'SATS' THEN
    UPDATE users
       SET balance_sats = round(balance_sats::NUMERIC + v_sats, 10)::DOUBLE PRECISION,
           updated_at = now()
     WHERE discord_id = v_addr.discord_id;
  ELSIF p_token_symbol = 'MUSD' THEN
    INSERT INTO user_token_balances(discord_id, token, balance_atomic)
    VALUES (v_addr.discord_id, 'MUSD', p_amount_atomic)
    ON CONFLICT (discord_id, token) DO UPDATE
      SET balance_atomic = user_token_balances.balance_atomic + EXCLUDED.balance_atomic,
          updated_at = now();
  ELSE
    PERFORM add_token_balance(v_addr.discord_id, p_token_symbol, v_amount);
  END IF;

  INSERT INTO deposits(discord_id, tx_hash, amount_sats, block_number, token)
  VALUES (v_addr.discord_id, v_ref, v_amount, p_block_number, p_token_symbol);

  RETURN jsonb_build_object(
    'status', 'credited',
    'discord_id', v_addr.discord_id,
    'token', p_token_symbol,
    'amount', v_amount,
    'amount_atomic', p_amount_atomic::TEXT,
    'deposit_ref', v_ref
  );
END;
$$;

-- Refunded HotPayout withdrawals the watchdog still re-reads: not verified
-- unpaid and not acknowledged by an admin, least recently read first.
CREATE OR REPLACE FUNCTION custody_refund_candidates_v1(p_limit INTEGER)
RETURNS TABLE (withdrawal_id BIGINT, payout_ref TEXT, false_reads INTEGER, first_false_at TIMESTAMPTZ)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT w.id::BIGINT, w.payout_ref, COALESCE(c.false_reads, 0), c.first_false_at
    FROM withdrawals w
    LEFT JOIN custody_refund_checks c ON c.withdrawal_id = w.id
   WHERE w.status = 'failed'
     AND w.payout_ref IS NOT NULL
     AND c.verified_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM custody_acknowledgements a WHERE a.key = 'withdrawal:' || w.id::TEXT)
   ORDER BY c.last_read_at ASC NULLS FIRST, w.id
   LIMIT GREATEST(COALESCE(p_limit, 0), 0);
$$;

/* ─────────── Privileges ─────────── */

-- Supabase's default privileges grant anon/authenticated on new objects;
-- revoke explicitly and grant service_role only. Role checks keep plain
-- Postgres (CI) working.
DO $$
DECLARE
  v_obj TEXT;
  v_role TEXT;
BEGIN
  FOREACH v_obj IN ARRAY ARRAY[
    'custody_cursors', 'custody_signed_txs', 'custody_forwarder_credits', 'custody_sweep_reviews',
    'custody_acknowledgements', 'custody_refund_checks'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', v_obj);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', v_obj);
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
        EXECUTE format('REVOKE ALL ON TABLE %I FROM %I', v_obj, v_role);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO service_role', v_obj);
    END IF;
  END LOOP;

  FOREACH v_obj IN ARRAY ARRAY[
    'custody_v2_schema_problems()',
    'register_forwarder_address_v1(text, text, text, boolean)',
    'credit_forwarder_deposit_v1(text, integer, bigint, text, text, text, integer, numeric, text, text)',
    'custody_refund_candidates_v1(integer)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_obj);
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', v_obj, v_role);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_obj);
    END IF;
  END LOOP;

  -- The deposit page reads a user's address again: only (discord_id, address),
  -- never legacy_address or salt. This runs after the UPDATE above in the same
  -- transaction, so a retired v1 address is never readable; NULL means no
  -- safe address has been issued yet.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format('GRANT SELECT (discord_id, address) ON TABLE deposit_addresses TO %I', v_role);
    END IF;
  END LOOP;
  -- deposit_addresses has RLS on (lockdown migration); the page's read policy.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'deposit_addresses' AND policyname = 'anon_read_deposit_addresses'
  ) THEN
    CREATE POLICY anon_read_deposit_addresses ON deposit_addresses FOR SELECT USING (true);
  END IF;
END;
$$;

COMMIT;
