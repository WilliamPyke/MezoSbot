-- Custody v3, bot side (deploy/CUSTODY.md). Additive and re-runnable; apply
-- after 2026-10-10_custody_v2.sql and before the bot build that uses it.
--
-- Deposits: update_deposit_address_balances is the v2 poller's batch write of
-- observed forwarder balances (same as in supabase-schema.sql; the bot falls
-- back to one update per row while it is missing).
--
-- Factory changes: retire_forwarder_addresses_v1 records every v2 forwarder
-- address in retired_deposit_addresses (the bot keeps refusing them as
-- withdrawal destinations) and clears it, leaving the row as an unissued
-- version 1 row (address and salt NULL, legacy_address untouched), so
-- register_forwarder_address_v1 issues the new factory's address the next
-- time the user needs one. register_forwarder_address_v1 now refuses a
-- retired address ('retired'), so a process still running with the old
-- factory cannot issue one again. Pending wallet-verification challenges
-- that point at a retired address are expired. Retire only after the old
-- factory's Swept events are all credited: the bot reads Swept logs of the
-- configured factory only.
--
-- Withdrawals: payout_ref is now a random HotPayout reference, stored once
-- on the row before the payout is planned or signed and kept for life
-- (unique where set, as before; its format is checked here).
-- custody_withdrawal_holds holds one user's on-chain withdrawals
-- (/custody hold). custody_reverted_payouts lists HotPayout payouts that
-- reverted on-chain because of their destination; the bot refuses that
-- destination for 7 days.
--
-- Vault actions: custody_expected_actions (/custody expect approvals) and
-- custody_admin_actions (every queued HotPayout action and what the bot did);
-- custody_signed_txs also accepts the guardian's 'cancel' and 'tighten'.
--
-- New tables: RLS on, no policies, service_role only; new and replaced
-- functions are service_role only.

BEGIN;
SET LOCAL lock_timeout = '5s';

/* ─────────── Withdrawals ─────────── */

ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS payout_ref TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_withdrawals_payout_ref
  ON withdrawals(payout_ref) WHERE payout_ref IS NOT NULL;

-- Added NOT VALID (no table scan under the exclusive lock), then validated
-- under a lighter lock.
DO $$
BEGIN
  ALTER TABLE withdrawals ADD CONSTRAINT withdrawals_payout_ref_format
    CHECK (payout_ref IS NULL OR payout_ref ~ '^0x[0-9a-f]{64}$') NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END;
$$;
ALTER TABLE withdrawals VALIDATE CONSTRAINT withdrawals_payout_ref_format;

CREATE TABLE IF NOT EXISTS custody_withdrawal_holds (
  discord_id TEXT PRIMARY KEY,
  note TEXT,
  actor_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS custody_reverted_payouts (
  withdrawal_id BIGINT PRIMARY KEY,
  to_address TEXT NOT NULL CHECK (to_address ~ '^0x[0-9a-f]{40}$'),
  tx_hash TEXT NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_custody_reverted_payouts_to
  ON custody_reverted_payouts(to_address, created_at DESC);

/* ─────────── Deposit addresses ─────────── */

CREATE TABLE IF NOT EXISTS retired_deposit_addresses (
  address TEXT PRIMARY KEY CHECK (address ~ '^0x[0-9a-f]{40}$'),
  discord_id TEXT,
  retired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  note TEXT
);

CREATE OR REPLACE FUNCTION update_deposit_address_balances(p_updates JSONB)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  WITH updates AS (
    SELECT DISTINCT ON (discord_id)
      discord_id,
      last_checked_balance
    FROM jsonb_to_recordset(p_updates) AS x(discord_id TEXT, last_checked_balance TEXT)
    WHERE discord_id IS NOT NULL
      AND last_checked_balance IS NOT NULL
    ORDER BY discord_id
  )
  UPDATE deposit_addresses d
  SET last_checked_balance = u.last_checked_balance
  FROM updates u
  WHERE d.discord_id = u.discord_id
    AND d.last_checked_balance IS DISTINCT FROM u.last_checked_balance;
END;
$$;

-- As in 2026-10-10_custody_v2.sql, plus: a retired address is never issued
-- again. Returns {status: ok, address, deposits_enabled, last_checked_balance}
-- | {status: conflict} | {status: retired}.
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

  IF EXISTS (SELECT 1 FROM retired_deposit_addresses WHERE address = v_address) THEN
    RETURN jsonb_build_object('status', 'retired');
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

-- Retire every issued v2 forwarder address (the DepositFactory is changing).
-- Each one is recorded in retired_deposit_addresses with p_note, then its row
-- goes back to an unissued version 1 row: address and salt NULL,
-- legacy_address (the v1 address, if any) and deposits_enabled kept.
-- Pending wallet-verification challenges on a retired address are expired.
-- Returns the number of addresses retired.
CREATE OR REPLACE FUNCTION retire_forwarder_addresses_v1(p_note TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  WITH targets AS (
    SELECT discord_id, lower(address) AS address
      FROM deposit_addresses
     WHERE address_version = 2 AND address IS NOT NULL
     FOR UPDATE
  ), recorded AS (
    INSERT INTO retired_deposit_addresses(address, discord_id, note)
    SELECT address, discord_id, p_note FROM targets
    ON CONFLICT (address) DO NOTHING
  ), cleared AS (
    UPDATE deposit_addresses d
       SET address = NULL,
           address_version = 1,
           salt = NULL,
           last_checked_balance = '0'
      FROM targets t
     WHERE d.discord_id = t.discord_id
    RETURNING d.discord_id
  )
  SELECT count(*) INTO v_count FROM cleared;

  UPDATE wallet_verification_challenges c
     SET status = 'expired'
   WHERE c.status = 'pending'
     AND EXISTS (SELECT 1 FROM retired_deposit_addresses r WHERE r.address = lower(c.deposit_address));

  RETURN v_count;
END;
$$;

-- Challenges on addresses retired earlier (re-runnable).
UPDATE wallet_verification_challenges c
   SET status = 'expired'
 WHERE c.status = 'pending'
   AND EXISTS (SELECT 1 FROM retired_deposit_addresses r WHERE r.address = lower(c.deposit_address));

/* ─────────── Queued vault actions ─────────── */

-- HotPayout queues every loosening vault action for 2 days. An admin approves
-- one exact action with /custody expect (custody_expected_actions, usable for
-- 24 hours); the watcher records every queued action (custody_admin_actions)
-- and has the guardian cancel any that no approval matches. The guardian's
-- cancel() and tightenCaps() calls are recorded like every custody signature.

CREATE TABLE IF NOT EXISTS custody_expected_actions (
  id BIGSERIAL PRIMARY KEY,
  action TEXT NOT NULL CHECK (action IN ('vault', 'operator', 'guardian', 'caps', 'recover')),
  subject TEXT NOT NULL CHECK (subject ~ '^0x[0-9a-f]{40}$'),
  value1 NUMERIC(78, 0) NOT NULL DEFAULT 0 CHECK (value1 >= 0),
  value2 NUMERIC(78, 0) NOT NULL DEFAULT 0 CHECK (value2 >= 0),
  actor_id TEXT NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_custody_expected_actions_open
  ON custody_expected_actions(action, expires_at) WHERE used_by IS NULL;

CREATE TABLE IF NOT EXISTS custody_admin_actions (
  tx_hash TEXT NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  log_index INTEGER NOT NULL CHECK (log_index >= 0),
  block_number BIGINT NOT NULL,
  payout TEXT NOT NULL CHECK (payout ~ '^0x[0-9a-f]{40}$'),
  action_id TEXT NOT NULL CHECK (action_id ~ '^0x[0-9a-f]{64}$'),
  action TEXT NOT NULL CHECK (action IN ('vault', 'operator', 'guardian', 'caps', 'recover')),
  subject TEXT NOT NULL CHECK (subject ~ '^0x[0-9a-f]{40}$'),
  value1 NUMERIC(78, 0) NOT NULL,
  value2 NUMERIC(78, 0) NOT NULL,
  eta TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('approved', 'unapproved', 'cancelling', 'cancelled', 'applied')),
  expectation_id BIGINT REFERENCES custody_expected_actions(id),
  cancel_tx TEXT CHECK (cancel_tx IS NULL OR cancel_tx ~ '^0x[0-9a-f]{64}$'),
  cancel_sent_at TIMESTAMPTZ,
  last_alert_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS idx_custody_admin_actions_open
  ON custody_admin_actions(payout, status, action_id);

ALTER TABLE custody_signed_txs DROP CONSTRAINT IF EXISTS custody_signed_txs_purpose_check;
ALTER TABLE custody_signed_txs ADD CONSTRAINT custody_signed_txs_purpose_check
  CHECK (purpose IN ('withdrawal', 'sweep_native', 'sweep_token', 'pause', 'cancel', 'tighten'));

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
    'custody_withdrawal_holds',
    'custody_reverted_payouts',
    'retired_deposit_addresses',
    'custody_expected_actions',
    'custody_admin_actions'
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

  -- custody_expected_actions.id's sequence: service_role only, like its table.
  REVOKE ALL ON SEQUENCE custody_expected_actions_id_seq FROM PUBLIC;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format('REVOKE ALL ON SEQUENCE custody_expected_actions_id_seq FROM %I', v_role);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT USAGE, SELECT ON SEQUENCE custody_expected_actions_id_seq TO service_role;
  END IF;

  FOREACH v_obj IN ARRAY ARRAY[
    'update_deposit_address_balances(jsonb)',
    'register_forwarder_address_v1(text, text, text, boolean)',
    'retire_forwarder_addresses_v1(text)'
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
END;
$$;

COMMIT;
