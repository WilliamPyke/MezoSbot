-- Database checks for migrations/2026-11-13_atomic_tips_and_drops.sql. Needs
-- supabase-schema.sql and 2026-07-12_multi_token_support.sql applied first.
-- Everything runs in a rolled-back transaction:
--   psql -v ON_ERROR_STOP=1 -f tests/tips-drops-db.sql

BEGIN;
DO $$
DECLARE
  v_drop BIGINT;
  v_refund DOUBLE PRECISION;
  v_claim JSONB;
BEGIN
  INSERT INTO users(discord_id, balance_sats) VALUES ('t_alice', 1000), ('t_bob', 50);
  INSERT INTO user_token_balances(discord_id, token, balance) VALUES ('t_alice', 'MEZO', 10);

  -- Tip: both sides move together.
  ASSERT transfer_balance_v1('t_alice', 't_bob', 'SATS', 300), 'tip ok';
  ASSERT (SELECT balance_sats FROM users WHERE discord_id = 't_alice') = 700, 'sender debited';
  ASSERT (SELECT balance_sats FROM users WHERE discord_id = 't_bob') = 350, 'recipient credited';

  -- Insufficient: nothing moves.
  ASSERT NOT transfer_balance_v1('t_alice', 't_bob', 'SATS', 701), 'overdraw refused';
  ASSERT (SELECT balance_sats FROM users WHERE discord_id = 't_alice') = 700, 'sender untouched';
  ASSERT (SELECT balance_sats FROM users WHERE discord_id = 't_bob') = 350, 'recipient untouched';

  -- Self, zero and negative amounts are refused.
  ASSERT NOT transfer_balance_v1('t_alice', 't_alice', 'SATS', 1), 'self tip refused';
  ASSERT NOT transfer_balance_v1('t_alice', 't_bob', 'SATS', 0), 'zero refused';
  ASSERT NOT transfer_balance_v1('t_alice', 't_bob', 'SATS', -5), 'negative refused';
  ASSERT (SELECT balance_sats FROM users WHERE discord_id = 't_alice') = 700, 'still 700';

  -- A brand-new recipient gets a row.
  ASSERT transfer_balance_v1('t_alice', 't_carol', 'SATS', 100), 'new recipient';
  ASSERT (SELECT balance_sats FROM users WHERE discord_id = 't_carol') = 100, 'carol credited';

  -- Tokens use the token balances.
  ASSERT transfer_balance_v1('t_alice', 't_bob', 'MEZO', 4), 'token tip';
  ASSERT (SELECT balance FROM user_token_balances WHERE discord_id = 't_alice' AND token = 'MEZO') = 6, 'token debit';
  ASSERT (SELECT balance FROM user_token_balances WHERE discord_id = 't_bob' AND token = 'MEZO') = 4, 'token credit';
  ASSERT NOT transfer_balance_v1('t_alice', 't_bob', 'MEZO', 7), 'token overdraw refused';
  ASSERT (SELECT balance FROM user_token_balances WHERE discord_id = 't_bob' AND token = 'MEZO') = 4, 'no token credit';

  -- Funded drop: debit and row together.
  v_drop := create_drop_funded_v1('t_chan', 't_alice', 'SATS', 500, 50, 10, NULL);
  ASSERT v_drop IS NOT NULL, 'drop created';
  ASSERT (SELECT balance_sats FROM users WHERE discord_id = 't_alice') = 100, 'creator debited';
  ASSERT (SELECT status FROM drops WHERE id = v_drop) = 'active', 'drop active';

  -- Unaffordable drop: no debit, no row.
  ASSERT create_drop_funded_v1('t_chan', 't_alice', 'SATS', 500, 50, 10, NULL) IS NULL, 'unaffordable drop';
  ASSERT (SELECT count(*) FROM drops WHERE creator_id = 't_alice') = 1, 'no extra drop';
  ASSERT (SELECT balance_sats FROM users WHERE discord_id = 't_alice') = 100, 'no extra debit';

  -- Cancel after one claim refunds only the unclaimed part, once.
  v_claim := claim_drop_atomic(v_drop, 't_bob', ARRAY[]::TEXT[], 1, FALSE);
  ASSERT (v_claim->>'ok')::boolean, v_claim::text;
  v_refund := cancel_drop_refund_v1(v_drop);
  ASSERT v_refund = 450, 'refund is total minus claims';
  ASSERT (SELECT balance_sats FROM users WHERE discord_id = 't_alice') = 550, 'creator refunded';
  ASSERT (SELECT status FROM drops WHERE id = v_drop) = 'cancelled', 'drop cancelled';
  ASSERT cancel_drop_refund_v1(v_drop) IS NULL, 'second cancel is a no-op';
  ASSERT (SELECT balance_sats FROM users WHERE discord_id = 't_alice') = 550, 'no double refund';

  -- A cancelled drop cannot be claimed.
  v_claim := claim_drop_atomic(v_drop, 't_carol', ARRAY[]::TEXT[], 1, FALSE);
  ASSERT NOT (v_claim->>'ok')::boolean, v_claim::text;
  ASSERT (SELECT balance_sats FROM users WHERE discord_id = 't_carol') = 100, 'carol not paid';

  -- Token drop round trip.
  v_drop := create_drop_funded_v1('t_chan', 't_alice', 'MEZO', 6, 1, 6, NULL);
  ASSERT (SELECT balance FROM user_token_balances WHERE discord_id = 't_alice' AND token = 'MEZO') = 0, 'token drop debit';
  ASSERT cancel_drop_refund_v1(v_drop) = 6, 'token drop refund';
  ASSERT (SELECT balance FROM user_token_balances WHERE discord_id = 't_alice' AND token = 'MEZO') = 6, 'token refunded';

  RAISE NOTICE 'tips-drops-db ok';
END;
$$;
ROLLBACK;
