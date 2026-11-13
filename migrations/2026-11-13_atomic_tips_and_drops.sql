-- Tips and drops move funds in a single database transaction.
--
-- transfer_balance_v1   debit the sender and credit the recipient together.
-- create_drop_funded_v1 debit the creator and create the drop together.
-- cancel_drop_refund_v1 close an active drop and return what nobody claimed.
--
-- All three reuse the existing balance functions, so SATS, MUSD (atomic
-- units) and the other tokens keep exactly the rules they already have.
-- Idempotent: safe to run more than once.

BEGIN;

-- Returns FALSE (and changes nothing) when the sender cannot pay.
CREATE OR REPLACE FUNCTION transfer_balance_v1(
  p_sender_id TEXT,
  p_recipient_id TEXT,
  p_token TEXT,
  p_amount DOUBLE PRECISION
) RETURNS BOOLEAN AS $$
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 OR p_sender_id IS NULL OR p_recipient_id IS NULL
     OR p_sender_id = p_recipient_id THEN
    RETURN FALSE;
  END IF;

  INSERT INTO users(discord_id) VALUES (p_recipient_id) ON CONFLICT (discord_id) DO NOTHING;
  -- Lock both users in a fixed order so opposite tips between the same pair queue up
  -- instead of deadlocking.
  PERFORM 1 FROM users WHERE discord_id IN (p_sender_id, p_recipient_id)
    ORDER BY discord_id FOR UPDATE;

  IF COALESCE(p_token, 'SATS') = 'SATS' THEN
    IF NOT subtract_balance_if_sufficient(p_sender_id, p_amount) THEN RETURN FALSE; END IF;
    PERFORM add_balance(p_recipient_id, p_amount);
  ELSE
    IF NOT subtract_token_balance_if_sufficient(p_sender_id, p_token, p_amount) THEN RETURN FALSE; END IF;
    PERFORM add_token_balance(p_recipient_id, p_token, p_amount);
  END IF;
  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- Returns the new drop id, or NULL (and changes nothing) when the creator cannot pay.
CREATE OR REPLACE FUNCTION create_drop_funded_v1(
  p_channel_id TEXT,
  p_creator_id TEXT,
  p_token TEXT,
  p_total DOUBLE PRECISION,
  p_per_claim DOUBLE PRECISION,
  p_max_claims INTEGER,
  p_eligible_role_id TEXT
) RETURNS BIGINT AS $$
DECLARE
  v_token TEXT := COALESCE(p_token, 'SATS');
  v_paid BOOLEAN;
  v_id BIGINT;
BEGIN
  IF p_total IS NULL OR p_total <= 0 OR p_per_claim IS NULL OR p_per_claim <= 0
     OR p_max_claims IS NULL OR p_max_claims < 1 OR p_per_claim * p_max_claims > p_total THEN
    RAISE EXCEPTION 'invalid drop amounts';
  END IF;

  IF v_token = 'SATS' THEN
    v_paid := subtract_balance_if_sufficient(p_creator_id, p_total);
  ELSE
    v_paid := subtract_token_balance_if_sufficient(p_creator_id, v_token, p_total);
  END IF;
  IF NOT v_paid THEN RETURN NULL; END IF;

  INSERT INTO drops(channel_id, creator_id, total_sats, per_claim_sats, max_claims, eligible_role_id, token)
  VALUES (p_channel_id, p_creator_id, p_total, p_per_claim, p_max_claims, p_eligible_role_id, v_token)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql;

-- Marks an active drop 'cancelled' and credits its creator with total minus claims.
-- Returns the amount refunded, or NULL when the drop is missing or no longer active.
-- Locks the drop row like claim_drop_atomic, so a claim and a cancel never overlap.
CREATE OR REPLACE FUNCTION cancel_drop_refund_v1(p_drop_id BIGINT)
RETURNS DOUBLE PRECISION AS $$
DECLARE
  d drops%ROWTYPE;
  v_claimed DOUBLE PRECISION;
  v_refund DOUBLE PRECISION;
BEGIN
  SELECT * INTO d FROM drops WHERE id = p_drop_id FOR UPDATE;
  IF NOT FOUND OR d.status <> 'active' THEN RETURN NULL; END IF;

  SELECT COALESCE(SUM(amount_sats), 0) INTO v_claimed FROM drop_claims WHERE drop_id = p_drop_id;
  v_refund := GREATEST(d.total_sats - v_claimed, 0);
  UPDATE drops SET status = 'cancelled' WHERE id = p_drop_id;

  IF v_refund > 0 THEN
    IF COALESCE(d.token, 'SATS') = 'SATS' THEN
      PERFORM add_balance(d.creator_id, v_refund);
    ELSE
      PERFORM add_token_balance(d.creator_id, d.token, v_refund);
    END IF;
  END IF;
  RETURN v_refund;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  v_obj TEXT;
  v_role TEXT;
BEGIN
  FOREACH v_obj IN ARRAY ARRAY[
    'transfer_balance_v1(text, text, text, double precision)',
    'create_drop_funded_v1(text, text, text, double precision, double precision, integer, text)',
    'cancel_drop_refund_v1(bigint)'
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
