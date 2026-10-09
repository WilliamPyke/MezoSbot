-- Database checks for migrations/2026-10-10_custody_v2.sql. Needs
-- supabase-schema.sql, 2026-07-12_multi_token_support.sql,
-- 2026-07-13_imgnai_katana.sql, 2026-07-13_imgnai_atomic_musd.sql and the
-- custody migration applied, plus the anon / authenticated / service_role
-- roles. The CI step seeds one v1 user ('legacy-user') with a pending wallet
-- challenge BEFORE applying the migration, to prove retirement. Everything
-- else runs in a rolled-back transaction:
--   psql -v ON_ERROR_STOP=1 -f tests/custody-db.sql

BEGIN;
DO $$
DECLARE
  r JSONB;
  c_native CONSTANT TEXT := '0x0000000000000000000000000000000000000000';
  c_vault CONSTANT TEXT := '0x' || repeat('11', 20);
  c_other_vault CONSTANT TEXT := '0x' || repeat('22', 20);
  c_musd CONSTANT TEXT := '0xdd468a1ddc392dcdbef6db6e34e89aa338f9f186';
  c_musdc CONSTANT TEXT := '0x04671c72aab5ac02a03c1098314b1bb6b560c197';
  c_mezo CONSTANT TEXT := '0x7b7c000000000000000000000000000000000001';
  v_alice_addr TEXT := '0x' || repeat('a1', 20);
  v_alice_salt TEXT := '0x' || repeat('a1', 32);
  v_bob_addr TEXT := '0x' || repeat('b2', 20);
  v_bob_salt TEXT := '0x' || repeat('b2', 32);
  v_unknown_salt TEXT := '0x' || repeat('ee', 32);
  v_bal DOUBLE PRECISION;
  v_atomic NUMERIC;
  v_rows INT;
  v_deposits INT;
  v_problems TEXT[];
  v_fresh BIGINT;
  v_read_once BIGINT;
  v_verified BIGINT;
  v_acked BIGINT;
  v_no_ref BIGINT;
  v_candidates BIGINT[];
BEGIN
  -- Seeded v1 row was retired by the migration and its challenge expired.
  ASSERT (SELECT address IS NULL AND legacy_address = '0x' || repeat('0c', 20) AND address_version = 1
            FROM deposit_addresses WHERE discord_id = 'legacy-user'), 'v1 address retired to legacy_address';
  ASSERT (SELECT status FROM wallet_verification_challenges WHERE discord_id = 'legacy-user') = 'expired',
    'challenge on a retired address expired';

  /* ─────────── Registration ─────────── */

  -- A v1 user moves to v2; the old address is kept, deposits stay enabled.
  INSERT INTO users(discord_id, balance_sats) VALUES ('alice', 100);
  INSERT INTO deposit_addresses(discord_id, address, deposits_enabled, last_checked_balance)
  VALUES ('alice', '0x' || repeat('0a', 20), TRUE, '777');
  r := register_forwarder_address_v1('alice', upper(v_alice_addr), v_alice_salt, FALSE);
  ASSERT r->>'status' = 'ok' AND (r->>'deposits_enabled')::BOOLEAN, r::TEXT;
  ASSERT (SELECT address = v_alice_addr AND address_version = 2 AND salt = v_alice_salt
                 AND legacy_address = '0x' || repeat('0a', 20) AND last_checked_balance = '0'
            FROM deposit_addresses WHERE discord_id = 'alice'), 'alice upgraded with legacy kept';
  -- Idempotent; a different address or salt for a v2 row is refused.
  r := register_forwarder_address_v1('alice', v_alice_addr, v_alice_salt, TRUE);
  ASSERT r->>'status' = 'ok', r::TEXT;
  r := register_forwarder_address_v1('alice', v_bob_addr, v_alice_salt, TRUE);
  ASSERT r->>'status' = 'conflict', r::TEXT;
  ASSERT (SELECT address FROM deposit_addresses WHERE discord_id = 'alice') = v_alice_addr, 'conflict left the row alone';

  -- A new user: registered disabled, enabled later.
  r := register_forwarder_address_v1('bob', v_bob_addr, v_bob_salt, FALSE);
  ASSERT r->>'status' = 'ok' AND NOT (r->>'deposits_enabled')::BOOLEAN, r::TEXT;

  BEGIN
    PERFORM register_forwarder_address_v1('carol', 'not-an-address', v_alice_salt, TRUE);
    RAISE EXCEPTION 'expected invalid registration to fail';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'invalid forwarder registration' THEN RAISE; END IF;
  END;

  /* ─────────── Credits ─────────── */

  SELECT count(*) INTO v_deposits FROM deposits;

  -- SATS: 10^10 wei per sat, 10 decimals.
  r := credit_forwarder_deposit_v1('0x' || repeat('01', 32), 0, 100, v_alice_salt, c_native, 'SATS', 18,
    123456789012345678, c_vault, c_vault);
  ASSERT r->>'status' = 'credited' AND r->>'discord_id' = 'alice' AND r->>'token' = 'SATS', r::TEXT;
  ASSERT r->>'deposit_ref' = '0x' || repeat('01', 32) || ':0', r::TEXT;
  SELECT balance_sats INTO v_bal FROM users WHERE discord_id = 'alice';
  ASSERT abs(v_bal::NUMERIC - 12345778.9012345678) < 0.000001, format('alice balance %s', v_bal);
  ASSERT (SELECT count(*) FROM deposits) = v_deposits + 1, 'one deposits row';
  ASSERT (SELECT token = 'SATS' AND block_number = 100 FROM deposits WHERE tx_hash = '0x' || repeat('01', 32) || ':0'),
    'deposits row keyed by tx:log';

  -- Same event again (re-scanned chunk, or a second scanner): no double credit.
  r := credit_forwarder_deposit_v1('0x' || repeat('01', 32), 0, 100, v_alice_salt, c_native, 'SATS', 18,
    123456789012345678, c_vault, c_vault);
  ASSERT r->>'status' = 'duplicate', r::TEXT;
  ASSERT (SELECT balance_sats FROM users WHERE discord_id = 'alice') = v_bal, 'not credited twice';
  ASSERT (SELECT count(*) FROM deposits) = v_deposits + 1, 'no second deposits row';
  -- Upper-case hex is the same event.
  r := credit_forwarder_deposit_v1('0x' || repeat('01', 32), 0, 100, upper(v_alice_salt), c_native, 'SATS', 18,
    123456789012345678, upper(c_vault), c_vault);
  ASSERT r->>'status' = 'duplicate', r::TEXT;

  -- The key is (tx, salt, token). The same amount reported under another log
  -- index is the same event (a duplicate); another amount is never a second
  -- credit: it goes to review.
  r := credit_forwarder_deposit_v1('0x' || repeat('01', 32), 7, 100, v_alice_salt, c_native, 'SATS', 18,
    123456789012345678, c_vault, c_vault);
  ASSERT r->>'status' = 'duplicate' AND r->>'deposit_ref' = '0x' || repeat('01', 32) || ':0', r::TEXT;
  r := credit_forwarder_deposit_v1('0x' || repeat('01', 32), 0, 100, v_alice_salt, c_native, 'SATS', 18,
    999, c_vault, c_vault);
  ASSERT r->>'status' = 'conflicting_event' AND NOT (r->>'already_recorded')::BOOLEAN AND r->>'discord_id' = 'alice', r::TEXT;
  r := credit_forwarder_deposit_v1('0x' || repeat('01', 32), 5, 100, v_alice_salt, c_native, 'SATS', 18,
    777, c_vault, c_vault);
  ASSERT r->>'status' = 'conflicting_event' AND (r->>'already_recorded')::BOOLEAN, r::TEXT;
  ASSERT (SELECT balance_sats FROM users WHERE discord_id = 'alice') = v_bal, 'conflicting events not credited';
  ASSERT (SELECT count(*) FROM deposits) = v_deposits + 1, 'no deposits row for a conflicting event';
  ASSERT (SELECT reason FROM custody_sweep_reviews WHERE tx_hash = '0x' || repeat('01', 32)) = 'conflicting_event', 'in review';
  -- The identical event is still just a duplicate.
  r := credit_forwarder_deposit_v1('0x' || repeat('01', 32), 0, 100, v_alice_salt, c_native, 'SATS', 18,
    123456789012345678, c_vault, c_vault);
  ASSERT r->>'status' = 'duplicate' AND r->>'deposit_ref' = '0x' || repeat('01', 32) || ':0', r::TEXT;

  -- Another token in the same tx is a separate credit.
  r := credit_forwarder_deposit_v1('0x' || repeat('01', 32), 1, 100, v_alice_salt, c_musd, 'MUSD', 18, 5, c_vault, c_vault);
  ASSERT r->>'status' = 'credited' AND r->>'token' = 'MUSD', r::TEXT;
  -- One wei is 1e-10 sats.
  r := credit_forwarder_deposit_v1('0x' || repeat('10', 32), 0, 100, v_alice_salt, c_native, 'SATS', 18, 1, c_vault, c_vault);
  ASSERT r->>'status' = 'credited', r::TEXT;
  ASSERT (SELECT credited_amount FROM custody_forwarder_credits WHERE tx_hash = '0x' || repeat('10', 32))
    = 0.0000000001::DOUBLE PRECISION, 'one wei is 1e-10 sats';

  -- Rounding: whole and half sats are exact.
  UPDATE users SET balance_sats = 0 WHERE discord_id = 'alice';
  r := credit_forwarder_deposit_v1('0x' || repeat('02', 32), 0, 101, v_alice_salt, c_native, 'SATS', 18,
    15000000000, c_vault, c_vault);
  ASSERT (r->>'amount')::NUMERIC = 1.5, r::TEXT;
  r := credit_forwarder_deposit_v1('0x' || repeat('03', 32), 0, 101, v_alice_salt, c_native, 'SATS', 18,
    25000000000, c_vault, c_vault);
  ASSERT (SELECT balance_sats FROM users WHERE discord_id = 'alice') = 4, 'balance rounded to 10 decimals';

  -- MUSD is exact in atomic units.
  r := credit_forwarder_deposit_v1('0x' || repeat('04', 32), 0, 102, v_alice_salt, c_musd, 'MUSD', 18,
    1234567890123456789, c_vault, c_vault);
  ASSERT r->>'status' = 'credited' AND r->>'token' = 'MUSD', r::TEXT;
  SELECT balance_atomic INTO v_atomic FROM user_token_balances WHERE discord_id = 'alice' AND token = 'MUSD';
  ASSERT v_atomic = 1234567890123456794, format('musd atomic %s', v_atomic);
  r := credit_forwarder_deposit_v1('0x' || repeat('05', 32), 0, 102, v_alice_salt, c_musd, 'MUSD', 18,
    1, c_vault, c_vault);
  ASSERT (SELECT balance_atomic FROM user_token_balances WHERE discord_id = 'alice' AND token = 'MUSD')
    = 1234567890123456795, 'musd adds exactly';

  -- MUSDC (6 decimals) and MEZO (18 decimals).
  r := credit_forwarder_deposit_v1('0x' || repeat('06', 32), 0, 103, v_alice_salt, c_musdc, 'MUSDC', 6,
    2500000, c_vault, c_vault);
  ASSERT r->>'status' = 'credited', r::TEXT;
  ASSERT (SELECT balance FROM user_token_balances WHERE discord_id = 'alice' AND token = 'MUSDC') = 2.5, 'musdc';
  r := credit_forwarder_deposit_v1('0x' || repeat('07', 32), 0, 103, v_alice_salt, c_mezo, 'MEZO', 18,
    3000000000000000000, c_vault, c_vault);
  ASSERT (SELECT balance FROM user_token_balances WHERE discord_id = 'alice' AND token = 'MEZO') = 3, 'mezo';

  /* ─────────── Review, never credit ─────────── */

  SELECT count(*) INTO v_rows FROM custody_forwarder_credits;
  SELECT balance_sats INTO v_bal FROM users WHERE discord_id = 'alice';

  r := credit_forwarder_deposit_v1('0x' || repeat('08', 32), 0, 104, v_unknown_salt, c_native, 'SATS', 18,
    50000000000, c_vault, c_vault);
  ASSERT r->>'status' = 'unknown_salt' AND NOT (r->>'already_recorded')::BOOLEAN, r::TEXT;
  r := credit_forwarder_deposit_v1('0x' || repeat('08', 32), 0, 104, v_unknown_salt, c_native, 'SATS', 18,
    50000000000, c_vault, c_vault);
  ASSERT r->>'status' = 'unknown_salt' AND (r->>'already_recorded')::BOOLEAN, r::TEXT;

  r := credit_forwarder_deposit_v1('0x' || repeat('09', 32), 0, 104, v_alice_salt, c_native, 'SATS', 18,
    50000000000, c_other_vault, c_vault);
  ASSERT r->>'status' = 'wrong_vault', r::TEXT;

  r := credit_forwarder_deposit_v1('0x' || repeat('0b', 32), 0, 104, v_alice_salt, '0x' || repeat('99', 20), NULL, NULL,
    50000000000, c_vault, c_vault);
  ASSERT r->>'status' = 'unknown_token', r::TEXT;
  -- SATS must be the native token and 18 decimals; MUSD must be 18 decimals.
  r := credit_forwarder_deposit_v1('0x' || repeat('0c', 32), 0, 104, v_alice_salt, c_musd, 'SATS', 18,
    50000000000, c_vault, c_vault);
  ASSERT r->>'status' = 'unknown_token', r::TEXT;
  r := credit_forwarder_deposit_v1('0x' || repeat('0d', 32), 0, 104, v_alice_salt, c_musd, 'MUSD', 6,
    50000000000, c_vault, c_vault);
  ASSERT r->>'status' = 'unknown_token', r::TEXT;

  ASSERT (SELECT count(*) FROM custody_forwarder_credits) = v_rows, 'nothing credited for review events';
  ASSERT (SELECT balance_sats FROM users WHERE discord_id = 'alice') = v_bal, 'balance untouched by review events';
  ASSERT (SELECT count(*) FROM custody_sweep_reviews) = 6, 'six review rows (one conflicting event)';
  ASSERT (SELECT discord_id IS NULL FROM custody_sweep_reviews WHERE tx_hash = '0x' || repeat('08', 32)), 'unknown salt names no user';

  -- A registered salt is credited even while its deposits are not enabled:
  -- the funds are already in the vault; deposits_enabled only gates showing addresses.
  ASSERT NOT (SELECT deposits_enabled FROM deposit_addresses WHERE discord_id = 'bob'), 'bob not enabled';
  r := credit_forwarder_deposit_v1('0x' || repeat('0a', 32), 0, 104, v_bob_salt, c_native, 'SATS', 18,
    50000000000, c_vault, c_vault);
  ASSERT r->>'status' = 'credited' AND r->>'discord_id' = 'bob', r::TEXT;
  ASSERT (SELECT balance_sats FROM users WHERE discord_id = 'bob') = 5, 'bob credited 5 sats';
  r := register_forwarder_address_v1('bob', v_bob_addr, v_bob_salt, TRUE);
  ASSERT (r->>'deposits_enabled')::BOOLEAN, r::TEXT;
  r := credit_forwarder_deposit_v1('0x' || repeat('0e', 32), 0, 105, v_bob_salt, c_native, 'SATS', 18,
    50000000000, c_vault, c_vault);
  ASSERT r->>'status' = 'credited' AND r->>'discord_id' = 'bob', r::TEXT;
  ASSERT (SELECT balance_sats FROM users WHERE discord_id = 'bob') = 10, 'bob credited 10 sats';

  -- Malformed input is an error, not a credit.
  BEGIN
    PERFORM credit_forwarder_deposit_v1('0xnothash', 0, 1, v_alice_salt, c_native, 'SATS', 18, 1, c_vault, c_vault);
    RAISE EXCEPTION 'expected invalid deposit to fail';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'invalid forwarder deposit' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM credit_forwarder_deposit_v1('0x' || repeat('0f', 32), 0, 1, v_alice_salt, c_native, 'SATS', 18, 0, c_vault, c_vault);
    RAISE EXCEPTION 'expected zero amount to fail';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'invalid forwarder deposit' THEN RAISE; END IF;
  END;

  /* ─────────── Withdrawal refs and signed txs ─────────── */

  INSERT INTO withdrawals(discord_id, amount_sats, to_address, status, payout_ref)
  VALUES ('alice', 1, '0x' || repeat('ab', 20), 'pending', '0x' || repeat('aa', 32));
  BEGIN
    INSERT INTO withdrawals(discord_id, amount_sats, to_address, status, payout_ref)
    VALUES ('bob', 1, '0x' || repeat('ab', 20), 'pending', '0x' || repeat('aa', 32));
    RAISE EXCEPTION 'expected duplicate payout_ref to fail';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  INSERT INTO custody_signed_txs(signer, nonce, tx_hash, purpose, ref)
  VALUES ('0x' || repeat('cc', 20), 0, '0x' || repeat('dd', 32), 'withdrawal', '0x' || repeat('aa', 32));
  -- Re-signing a nonce keeps both hashes (the watchdog checks receipts for them).
  INSERT INTO custody_signed_txs(signer, nonce, tx_hash, purpose, ref)
  VALUES ('0x' || repeat('cc', 20), 0, '0x' || repeat('de', 32), 'withdrawal', '0x' || repeat('aa', 32));
  ASSERT (SELECT count(*) FROM custody_signed_txs WHERE signer = '0x' || repeat('cc', 20) AND nonce = 0) = 2, 'history kept';
  BEGIN
    INSERT INTO custody_signed_txs(signer, nonce, tx_hash, purpose)
    VALUES ('0x' || repeat('cc', 20), 5, '0x' || repeat('dd', 32), 'withdrawal');
    RAISE EXCEPTION 'expected a duplicate signer/tx_hash to fail';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO custody_signed_txs(signer, nonce, tx_hash, purpose)
    VALUES ('0x' || repeat('cc', 20), 1, '0x' || repeat('dd', 32), 'transfer');
    RAISE EXCEPTION 'expected an unknown purpose to fail';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  /* ─────────── Privileges ─────────── */

  ASSERT NOT has_function_privilege('anon',
    'credit_forwarder_deposit_v1(text, integer, bigint, text, text, text, integer, numeric, text, text)', 'EXECUTE'), 'anon credit';
  ASSERT NOT has_function_privilege('authenticated', 'register_forwarder_address_v1(text, text, text, boolean)', 'EXECUTE'), 'auth register';
  ASSERT has_function_privilege('service_role',
    'credit_forwarder_deposit_v1(text, integer, bigint, text, text, text, integer, numeric, text, text)', 'EXECUTE'), 'service credit';
  ASSERT has_function_privilege('service_role', 'register_forwarder_address_v1(text, text, text, boolean)', 'EXECUTE'), 'service register';
  ASSERT NOT has_function_privilege('anon', 'register_forwarder_address_v1(text, text, text, boolean)', 'EXECUTE'), 'anon register';
  ASSERT (SELECT bool_and(c.relrowsecurity) FROM pg_class c
           WHERE c.oid IN ('public.custody_cursors'::regclass, 'public.custody_signed_txs'::regclass,
                           'public.custody_forwarder_credits'::regclass, 'public.custody_sweep_reviews'::regclass)),
    'RLS on custody tables';
  ASSERT NOT has_table_privilege('anon', 'custody_signed_txs', 'SELECT'), 'anon signed txs';
  ASSERT NOT has_table_privilege('authenticated', 'custody_sweep_reviews', 'INSERT'), 'auth reviews';
  ASSERT NOT has_table_privilege('anon', 'custody_cursors', 'UPDATE'), 'anon cursors';
  ASSERT has_table_privilege('service_role', 'custody_forwarder_credits', 'INSERT'), 'service credits table';
  ASSERT has_column_privilege('anon', 'deposit_addresses', 'address', 'SELECT'), 'deposit page reads the address';
  ASSERT NOT has_column_privilege('anon', 'deposit_addresses', 'legacy_address', 'SELECT'), 'anon cannot read legacy_address';
  ASSERT NOT has_column_privilege('anon', 'deposit_addresses', 'salt', 'SELECT'), 'anon cannot read salt';
  ASSERT NOT has_table_privilege('anon', 'deposit_addresses', 'UPDATE'), 'anon cannot write deposit_addresses';

  /* ─────────── Refund re-check candidates ─────────── */

  INSERT INTO withdrawals(discord_id, amount_sats, to_address, status, payout_ref)
  VALUES ('alice', 1, '0x' || repeat('ab', 20), 'failed', '0x' || repeat('f1', 32)) RETURNING id INTO v_fresh;
  INSERT INTO withdrawals(discord_id, amount_sats, to_address, status, payout_ref)
  VALUES ('alice', 1, '0x' || repeat('ab', 20), 'failed', '0x' || repeat('f2', 32)) RETURNING id INTO v_read_once;
  INSERT INTO withdrawals(discord_id, amount_sats, to_address, status, payout_ref)
  VALUES ('alice', 1, '0x' || repeat('ab', 20), 'failed', '0x' || repeat('f3', 32)) RETURNING id INTO v_verified;
  INSERT INTO withdrawals(discord_id, amount_sats, to_address, status, payout_ref)
  VALUES ('alice', 1, '0x' || repeat('ab', 20), 'failed', '0x' || repeat('f4', 32)) RETURNING id INTO v_acked;
  INSERT INTO withdrawals(discord_id, amount_sats, to_address, status)
  VALUES ('alice', 1, '0x' || repeat('ab', 20), 'failed') RETURNING id INTO v_no_ref;
  INSERT INTO custody_refund_checks(withdrawal_id, payout_ref, false_reads, first_false_at, last_read_at)
  VALUES (v_read_once, '0x' || repeat('f2', 32), 1, now() - interval '10 minutes', now() - interval '10 minutes');
  INSERT INTO custody_refund_checks(withdrawal_id, payout_ref, false_reads, first_false_at, last_read_at, verified_at)
  VALUES (v_verified, '0x' || repeat('f3', 32), 3, now() - interval '2 hours', now(), now());
  INSERT INTO custody_acknowledgements(key, reason, actor_id) VALUES ('withdrawal:' || v_acked, 'double payment', 'admin');
  -- Unread rows first, then least recently read; verified, acknowledged and non-HotPayout rows never.
  SELECT array_agg(c.withdrawal_id ORDER BY c.ord) INTO v_candidates
    FROM custody_refund_candidates_v1(1000) WITH ORDINALITY AS c(withdrawal_id, payout_ref, false_reads, first_false_at, ord)
   WHERE c.withdrawal_id IN (v_fresh, v_read_once, v_verified, v_acked, v_no_ref);
  ASSERT v_candidates = ARRAY[v_fresh, v_read_once], v_candidates::TEXT;
  ASSERT (SELECT false_reads = 1 AND first_false_at IS NOT NULL AND payout_ref = '0x' || repeat('f2', 32)
            FROM custody_refund_candidates_v1(1000) WHERE withdrawal_id = v_read_once), 'read state returned';
  ASSERT (SELECT false_reads = 0 AND first_false_at IS NULL
            FROM custody_refund_candidates_v1(1000) WHERE withdrawal_id = v_fresh), 'unread row starts at zero';
  ASSERT (SELECT count(*) FROM custody_refund_candidates_v1(0)) = 0, 'limit respected';
  -- The bot's upsert of a verified read.
  INSERT INTO custody_refund_checks(withdrawal_id, payout_ref, false_reads, first_false_at, last_read_at, verified_at)
  VALUES (v_read_once, '0x' || repeat('f2', 32), 3, now() - interval '61 minutes', now(), now())
  ON CONFLICT (withdrawal_id) DO UPDATE SET false_reads = EXCLUDED.false_reads, verified_at = EXCLUDED.verified_at;
  ASSERT NOT EXISTS (SELECT 1 FROM custody_refund_candidates_v1(1000) WHERE withdrawal_id = v_read_once), 'verified row dropped';
  BEGIN
    INSERT INTO custody_refund_checks(withdrawal_id, payout_ref, false_reads, verified_at)
    VALUES (v_fresh, '0x' || repeat('f1', 32), 0, now());
    RAISE EXCEPTION 'expected a verified row without reads to fail';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.custody_refund_checks'::regclass), 'RLS on refund checks';
  ASSERT NOT has_table_privilege('anon', 'custody_refund_checks', 'SELECT'), 'anon refund checks';
  ASSERT has_table_privilege('service_role', 'custody_refund_checks', 'UPDATE'), 'service refund checks';
  ASSERT NOT has_function_privilege('anon', 'custody_refund_candidates_v1(integer)', 'EXECUTE'), 'candidates closed to anon';
  ASSERT has_function_privilege('service_role', 'custody_refund_candidates_v1(integer)', 'EXECUTE'), 'candidates open to service_role';

  /* ─────────── Review reasons and acknowledgements ─────────── */

  ASSERT (SELECT pg_get_constraintdef(oid) LIKE '%conflicting_event%' AND pg_get_constraintdef(oid) LIKE '%unknown_salt%'
            FROM pg_constraint WHERE conname = 'custody_sweep_reviews_reason_check'), 'reason check lists every current reason';
  BEGIN
    INSERT INTO custody_sweep_reviews(tx_hash, log_index, block_number, salt, token_address, amount_atomic, vault, reason)
    VALUES ('0x' || repeat('77', 32), 0, 1, v_alice_salt, c_native, 1, c_vault, 'not_a_reason');
    RAISE EXCEPTION 'expected an unknown review reason to fail';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO custody_acknowledgements(key, reason, actor_id, note) VALUES ('withdrawal:1', 'test', 'admin', 'checked');
  BEGIN
    INSERT INTO custody_acknowledgements(key, reason, actor_id) VALUES ('withdrawal:1', 'again', 'admin');
    RAISE EXCEPTION 'expected a duplicate acknowledgement to fail';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.custody_acknowledgements'::regclass), 'RLS on acknowledgements';
  ASSERT NOT has_table_privilege('anon', 'custody_acknowledgements', 'SELECT'), 'anon acknowledgements';
  ASSERT has_table_privilege('service_role', 'custody_acknowledgements', 'INSERT'), 'service acknowledgements';

  /* ─────────── Key-design guard ─────────── */

  ASSERT cardinality(custody_v2_schema_problems()) = 0, 'schema matches the migration';
  EXECUTE 'CREATE UNIQUE INDEX custody_credit_log_test ON custody_forwarder_credits(tx_hash, log_index)';
  v_problems := custody_v2_schema_problems();
  ASSERT cardinality(v_problems) = 1 AND v_problems[1] LIKE 'custody_forwarder_credits has 1 unique index%', v_problems::TEXT;
  EXECUTE 'DROP INDEX custody_credit_log_test';
  DELETE FROM custody_signed_txs WHERE tx_hash = '0x' || repeat('de', 32);
  EXECUTE 'ALTER TABLE custody_signed_txs DROP CONSTRAINT custody_signed_txs_pkey';
  EXECUTE 'ALTER TABLE custody_signed_txs ADD PRIMARY KEY (signer, nonce)';
  v_problems := custody_v2_schema_problems();
  ASSERT v_problems = ARRAY['custody_signed_txs has primary key (signer, nonce), expected (signer, tx_hash)'], v_problems::TEXT;
  EXECUTE 'ALTER TABLE custody_refund_checks DROP CONSTRAINT custody_refund_checks_pkey';
  v_problems := custody_v2_schema_problems();
  ASSERT 'custody_refund_checks has primary key (none), expected (withdrawal_id)' = ANY (v_problems), v_problems::TEXT;
  ASSERT NOT has_function_privilege('anon', 'custody_v2_schema_problems()', 'EXECUTE'), 'guard closed to anon';

  RAISE NOTICE 'custody v2 database checks passed';
END;
$$;
ROLLBACK;
