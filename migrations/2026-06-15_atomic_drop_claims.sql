-- Race-safe drop claims. Lock the drop row, insert the claim, advance the
-- counter, and credit the claimant in one database transaction.

CREATE OR REPLACE FUNCTION claim_drop_atomic(
  p_drop_id BIGINT,
  p_claimant_id TEXT,
  p_claimant_role_ids TEXT[] DEFAULT ARRAY[]::TEXT[]
)
RETURNS JSONB AS $claim_drop_atomic$
DECLARE
  d drops%ROWTYPE;
  inserted_claim_id BIGINT;
  new_count INTEGER;
BEGIN
  SELECT * INTO d
  FROM drops
  WHERE id = p_drop_id
  FOR UPDATE;

  IF NOT FOUND OR d.status <> 'active' OR d.claims_count >= d.max_claims THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'drop_inactive');
  END IF;

  IF d.creator_id = p_claimant_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'own_drop');
  END IF;

  IF d.eligible_role_id IS NOT NULL
     AND NOT (d.eligible_role_id = ANY(COALESCE(p_claimant_role_ids, ARRAY[]::TEXT[]))) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'ineligible_role',
      'eligible_role_id', d.eligible_role_id
    );
  END IF;

  INSERT INTO drop_claims (drop_id, claimant_id, amount_sats)
  VALUES (p_drop_id, p_claimant_id, d.per_claim_sats)
  ON CONFLICT (drop_id, claimant_id) DO NOTHING
  RETURNING id INTO inserted_claim_id;

  IF inserted_claim_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_claimed');
  END IF;

  new_count := d.claims_count + 1;

  UPDATE drops
  SET claims_count = new_count,
      status = CASE WHEN new_count >= max_claims THEN 'completed' ELSE status END
  WHERE id = p_drop_id;

  INSERT INTO users (discord_id)
  VALUES (p_claimant_id)
  ON CONFLICT (discord_id) DO NOTHING;

  UPDATE users
  SET balance_sats = balance_sats + d.per_claim_sats,
      updated_at = now()
  WHERE discord_id = p_claimant_id;

  INSERT INTO rains (sender_id, amount_sats, recipient_count)
  VALUES (d.creator_id, d.per_claim_sats, 1);

  RETURN jsonb_build_object(
    'ok', true,
    'claim_id', inserted_claim_id,
    'new_count', new_count,
    'remaining', GREATEST(d.max_claims - new_count, 0),
    'completed', new_count >= d.max_claims,
    'amount_sats', d.per_claim_sats,
    'creator_id', d.creator_id
  );
END;
$claim_drop_atomic$ LANGUAGE plpgsql;
