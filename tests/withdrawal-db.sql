-- Database checks for migrations/2026-10-08_withdrawal_safety.sql. Needs
-- supabase-schema.sql, 2026-07-12_multi_token_support.sql and
-- 2026-07-25_token_withdrawal_gas.sql applied first, plus the anon /
-- authenticated / service_role roles. Everything runs in a rolled-back
-- transaction:  psql -v ON_ERROR_STOP=1 -f tests/withdrawal-db.sql

BEGIN;
DO $$
DECLARE
  r JSONB;
  v_id BIGINT;
  v_bob BIGINT;
  v_legacy BIGINT;
  v_bal DOUBLE PRECISION;
  v_tok DOUBLE PRECISION;
  v_status TEXT;
  v_rows INT;
  addr TEXT := '0x' || repeat('ab', 20);
BEGIN
  INSERT INTO users(discord_id, balance_sats) VALUES ('alice', 1000), ('bob', 50);
  INSERT INTO user_token_balances(discord_id, token, balance) VALUES ('bob', 'MUSD', 100);

  -- SATS reserve: debit + pending row together.
  r := reserve_withdrawal_v2('alice', addr, 'SATS', 400, 0);
  ASSERT r->>'status' = 'ok', r::text;
  v_id := (r->>'id')::BIGINT;
  SELECT balance_sats INTO v_bal FROM users WHERE discord_id = 'alice';
  ASSERT v_bal = 600, 'alice debited';
  SELECT status INTO v_status FROM withdrawals WHERE id = v_id AND pipeline_version = 2 AND tx_hash IS NULL;
  ASSERT v_status = 'pending', 'pending pipeline-2 row';

  -- Insufficient: nothing debited, no row.
  SELECT count(*) INTO v_rows FROM withdrawals;
  r := reserve_withdrawal_v2('alice', addr, 'SATS', 700, 0);
  ASSERT r->>'status' = 'insufficient_token', r::text;
  ASSERT (SELECT count(*) FROM withdrawals) = v_rows, 'no row on insufficient';
  ASSERT (SELECT balance_sats FROM users WHERE discord_id = 'alice') = 600, 'no debit on insufficient';

  -- ERC-20 reserve debits token + gas sats.
  r := reserve_withdrawal_v2('bob', addr, 'MUSD', 10, 5);
  ASSERT r->>'status' = 'ok', r::text;
  v_bob := (r->>'id')::BIGINT;
  ASSERT (SELECT balance FROM user_token_balances WHERE discord_id = 'bob' AND token = 'MUSD') = 90, 'bob musd';
  ASSERT (SELECT balance_sats FROM users WHERE discord_id = 'bob') = 45, 'bob gas';
  ASSERT (SELECT gas_reserved_sats FROM withdrawals WHERE id = v_bob) = 5, 'gas recorded';

  -- Gas shortfall rolls back the token debit too.
  r := reserve_withdrawal_v2('bob', addr, 'MUSD', 10, 1000);
  ASSERT r->>'status' = 'insufficient_sats', r::text;
  ASSERT (SELECT balance FROM user_token_balances WHERE discord_id = 'bob' AND token = 'MUSD') = 90, 'musd untouched';

  -- Never-broadcast refund; second call is a no-op.
  r := refund_withdrawal_v2(v_id, TRUE, NULL);
  ASSERT r->>'status' = 'refunded', r::text;
  ASSERT (SELECT balance_sats FROM users WHERE discord_id = 'alice') = 1000, 'alice refunded';
  ASSERT (SELECT status FROM withdrawals WHERE id = v_id) = 'failed', 'marked failed';
  r := refund_withdrawal_v2(v_id, TRUE, NULL);
  ASSERT r->>'status' = 'not_pending' AND r->>'current' = 'failed', r::text;
  ASSERT (SELECT balance_sats FROM users WHERE discord_id = 'alice') = 1000, 'no double refund';
  r := complete_withdrawal_v2(v_id, NULL, NULL);
  ASSERT r->>'status' = 'not_pending', 'cannot complete a refunded row';

  -- A persisted hash blocks the never-broadcast refund; completion returns unused gas once.
  UPDATE withdrawals SET tx_hash = '0x' || repeat('cd', 32), nonce = 7 WHERE id = v_bob;
  r := refund_withdrawal_v2(v_bob, TRUE, NULL);
  ASSERT r->>'status' = 'has_hash', r::text;
  r := complete_withdrawal_v2(v_bob, 2, NULL);
  ASSERT r->>'status' = 'completed' AND (r->>'unused_gas_sats')::float = 3, r::text;
  ASSERT (SELECT balance_sats FROM users WHERE discord_id = 'bob') = 48, 'unused gas returned';
  r := complete_withdrawal_v2(v_bob, 2, NULL);
  ASSERT r->>'status' = 'not_pending', r::text;
  ASSERT (SELECT balance_sats FROM users WHERE discord_id = 'bob') = 48, 'unused gas returned once';
  r := refund_withdrawal_v2(v_bob, FALSE, NULL);
  ASSERT r->>'status' = 'not_pending', 'cannot refund a completed row';

  -- Legacy hashless rows are never refunded as never-broadcast.
  INSERT INTO withdrawals(discord_id, amount_sats, to_address, status, token)
  VALUES ('alice', 25, addr, 'pending', 'SATS') RETURNING id INTO v_legacy;
  r := refund_withdrawal_v2(v_legacy, TRUE, NULL);
  ASSERT r->>'status' = 'legacy_row', r::text;
  ASSERT (SELECT balance_sats FROM users WHERE discord_id = 'alice') = 1000, 'legacy not refunded';
  -- ...but a proven revert/drop refund still works for it.
  r := refund_withdrawal_v2(v_legacy, FALSE, NULL);
  ASSERT r->>'status' = 'refunded', r::text;
  ASSERT (SELECT balance_sats FROM users WHERE discord_id = 'alice') = 1025, 'legacy revert refunded';

  -- Legacy ERC-20 row: gas comes from the fallback.
  INSERT INTO withdrawals(discord_id, amount_sats, to_address, status, token, tx_hash)
  VALUES ('bob', 4, addr, 'pending', 'MUSD', '0xfeed') RETURNING id INTO v_legacy;
  r := refund_withdrawal_v2(v_legacy, FALSE, 7);
  ASSERT r->>'status' = 'refunded' AND (r->>'gas_sats')::float = 7, r::text;
  ASSERT (SELECT balance FROM user_token_balances WHERE discord_id = 'bob' AND token = 'MUSD') = 94, 'musd refunded';
  ASSERT (SELECT balance_sats FROM users WHERE discord_id = 'bob') = 55, 'fallback gas refunded';

  -- Missing row.
  r := refund_withdrawal_v2(-1, FALSE, NULL);
  ASSERT r->>'status' = 'not_found', r::text;

  -- Validation.
  BEGIN
    PERFORM reserve_withdrawal_v2('alice', 'not-an-address', 'SATS', 1, 0);
    RAISE EXCEPTION 'expected invalid address to fail';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'invalid withdrawal reservation' THEN RAISE; END IF;
  END;

  -- Privileges.
  ASSERT NOT has_function_privilege('anon', 'reserve_withdrawal_v2(text, text, text, double precision, double precision)', 'EXECUTE'), 'anon';
  ASSERT NOT has_function_privilege('authenticated', 'refund_withdrawal_v2(bigint, boolean, double precision)', 'EXECUTE'), 'authenticated';
  ASSERT has_function_privilege('service_role', 'complete_withdrawal_v2(bigint, double precision, double precision)', 'EXECUTE'), 'service_role';

  RAISE NOTICE 'withdrawal function checks passed';
END;
$$;
ROLLBACK;
