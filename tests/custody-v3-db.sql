-- Database checks for migrations/2026-10-15_custody_v3_bot.sql. Needs the same
-- setup as tests/custody-db.sql plus the v3 bot migration applied (twice, to
-- prove it re-runs). Everything runs in a rolled-back transaction:
--   psql -v ON_ERROR_STOP=1 -f tests/custody-v3-db.sql

BEGIN;
DO $$
DECLARE
  r JSONB;
  v_count INTEGER;
  v_old_addr TEXT := '0x' || repeat('c1', 20);
  v_new_addr TEXT := '0x' || repeat('c2', 20);
  v_salt TEXT := '0x' || repeat('c3', 32);
  v_dave_addr TEXT := '0x' || repeat('d1', 20);
  v_dave_salt TEXT := '0x' || repeat('d2', 32);
  v_fn TEXT;
  v_tbl TEXT;
BEGIN
  /* ─────────── Observed balances ─────────── */

  INSERT INTO deposit_addresses(discord_id, address, deposits_enabled, last_checked_balance)
  VALUES ('poll-a', '0x' || repeat('e1', 20), TRUE, '0'), ('poll-b', '0x' || repeat('e2', 20), TRUE, '5');
  PERFORM update_deposit_address_balances(
    '[{"discord_id": "poll-a", "last_checked_balance": "42"}, {"discord_id": "poll-b", "last_checked_balance": null},
      {"discord_id": "nobody", "last_checked_balance": "1"}]'::JSONB);
  ASSERT (SELECT last_checked_balance FROM deposit_addresses WHERE discord_id = 'poll-a') = '42', 'balance stored';
  ASSERT (SELECT last_checked_balance FROM deposit_addresses WHERE discord_id = 'poll-b') = '5', 'null balance ignored';

  /* ─────────── Retiring forwarder addresses ─────────── */

  -- carol moved from a v1 address to a v2 forwarder; dave only ever had a v2 forwarder.
  INSERT INTO deposit_addresses(discord_id, address, deposits_enabled)
  VALUES ('carol', '0x' || repeat('0c', 20), TRUE);
  r := register_forwarder_address_v1('carol', v_old_addr, v_salt, TRUE);
  ASSERT r->>'status' = 'ok', r::TEXT;
  r := register_forwarder_address_v1('dave', v_dave_addr, v_dave_salt, FALSE);
  ASSERT r->>'status' = 'ok', r::TEXT;
  INSERT INTO wallet_verification_challenges(discord_id, deposit_address, challenge_sats)
  VALUES ('carol', upper(v_old_addr), 10), ('carol-new', v_new_addr, 10);

  v_count := retire_forwarder_addresses_v1('factory change');
  ASSERT v_count >= 2, format('retired %s', v_count);
  ASSERT (SELECT address IS NULL AND salt IS NULL AND address_version = 1 AND deposits_enabled
                 AND legacy_address = '0x' || repeat('0c', 20)
            FROM deposit_addresses WHERE discord_id = 'carol'), 'carol cleared, v1 address kept';
  ASSERT (SELECT address IS NULL AND salt IS NULL AND address_version = 1 AND legacy_address IS NULL
            FROM deposit_addresses WHERE discord_id = 'dave'), 'dave cleared';
  ASSERT (SELECT discord_id = 'carol' AND note = 'factory change' AND retired_at IS NOT NULL
            FROM retired_deposit_addresses WHERE address = v_old_addr), 'carol''s forwarder recorded';
  ASSERT EXISTS (SELECT 1 FROM retired_deposit_addresses WHERE address = v_dave_addr), 'dave''s forwarder recorded';
  ASSERT (SELECT status FROM wallet_verification_challenges WHERE discord_id = 'carol') = 'expired',
    'challenge on a retired address expired';
  ASSERT (SELECT status FROM wallet_verification_challenges WHERE discord_id = 'carol-new') = 'pending',
    'other challenges untouched';
  ASSERT retire_forwarder_addresses_v1('again') = 0, 'nothing left to retire';
  ASSERT (SELECT note FROM retired_deposit_addresses WHERE address = v_old_addr) = 'factory change', 'first note kept';

  -- A retired address is never issued again; the new factory's address is.
  r := register_forwarder_address_v1('carol', upper(v_old_addr), v_salt, FALSE);
  ASSERT r->>'status' = 'retired', r::TEXT;
  ASSERT (SELECT address IS NULL FROM deposit_addresses WHERE discord_id = 'carol'), 'refusal left the row alone';
  r := register_forwarder_address_v1('carol', v_new_addr, v_salt, FALSE);
  ASSERT r->>'status' = 'ok' AND r->>'address' = v_new_addr AND (r->>'deposits_enabled')::BOOLEAN, r::TEXT;
  ASSERT (SELECT address = v_new_addr AND address_version = 2 AND salt = v_salt
                 AND legacy_address = '0x' || repeat('0c', 20) AND last_checked_balance = '0'
            FROM deposit_addresses WHERE discord_id = 'carol'), 'new address issued, v1 address kept';
  -- Swept events for the salt credit carol again.
  ASSERT (SELECT discord_id FROM deposit_addresses WHERE salt = v_salt AND address_version = 2) = 'carol', 'salt maps to carol';

  /* ─────────── Withdrawals ─────────── */

  INSERT INTO withdrawals(discord_id, amount_sats, to_address, payout_ref)
  VALUES ('carol', 1, v_new_addr, '0x' || repeat('ab', 32));
  BEGIN
    INSERT INTO withdrawals(discord_id, amount_sats, to_address, payout_ref)
    VALUES ('carol', 1, v_new_addr, '0x' || repeat('AB', 32));
    RAISE EXCEPTION 'expected a malformed payout_ref to be refused';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO withdrawals(discord_id, amount_sats, to_address, payout_ref)
    VALUES ('carol', 1, v_new_addr, '0x' || repeat('ab', 32));
    RAISE EXCEPTION 'expected a duplicate payout_ref to be refused';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  INSERT INTO custody_reverted_payouts(withdrawal_id, to_address, tx_hash, reason)
  VALUES (1, v_new_addr, '0x' || repeat('cd', 32), 'PayFailed');
  INSERT INTO custody_withdrawal_holds(discord_id, actor_id, note) VALUES ('carol', 'admin', 'checking');

  /* ─────────── Privileges ─────────── */

  FOREACH v_tbl IN ARRAY ARRAY['custody_withdrawal_holds', 'custody_reverted_payouts', 'retired_deposit_addresses'] LOOP
    ASSERT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || v_tbl)::regclass), format('RLS on %s', v_tbl);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      ASSERT NOT has_table_privilege('anon', 'public.' || v_tbl, 'SELECT'), format('anon reads %s', v_tbl);
      ASSERT NOT has_table_privilege('authenticated', 'public.' || v_tbl, 'INSERT'), format('authenticated writes %s', v_tbl);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      ASSERT has_table_privilege('service_role', 'public.' || v_tbl, 'SELECT')
        AND has_table_privilege('service_role', 'public.' || v_tbl, 'INSERT')
        AND has_table_privilege('service_role', 'public.' || v_tbl, 'UPDATE')
        AND has_table_privilege('service_role', 'public.' || v_tbl, 'DELETE'), format('service_role on %s', v_tbl);
    END IF;
  END LOOP;
  FOREACH v_fn IN ARRAY ARRAY[
    'update_deposit_address_balances(jsonb)',
    'register_forwarder_address_v1(text,text,text,boolean)',
    'retire_forwarder_addresses_v1(text)'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      ASSERT NOT has_function_privilege('anon', v_fn, 'EXECUTE')
        AND NOT has_function_privilege('authenticated', v_fn, 'EXECUTE'), format('anon executes %s', v_fn);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      ASSERT has_function_privilege('service_role', v_fn, 'EXECUTE'), format('service_role executes %s', v_fn);
    END IF;
  END LOOP;
END;
$$;
ROLLBACK;
