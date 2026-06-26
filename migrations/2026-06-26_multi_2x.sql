-- Multi 2x role support for drops and quest rewards.

CREATE TABLE IF NOT EXISTS multi_drop_preferences (
  creator_id TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION claim_drop_atomic(
  p_drop_id BIGINT,
  p_claimant_id TEXT,
  p_claimant_role_ids TEXT[] DEFAULT ARRAY[]::TEXT[],
  p_claimant_multiplier INTEGER DEFAULT 1,
  p_creator_allows_multi BOOLEAN DEFAULT FALSE
)
RETURNS JSONB AS $claim_drop_atomic$
DECLARE
  d drops%ROWTYPE;
  inserted_claim_id BIGINT;
  new_count INTEGER;
  claim_units INTEGER := 1;
  claim_amount DOUBLE PRECISION := 0;
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

  claim_units := CASE WHEN p_creator_allows_multi IS TRUE AND p_claimant_multiplier >= 2 THEN 2 ELSE 1 END;

  IF d.claims_count + claim_units > d.max_claims THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_remaining');
  END IF;

  claim_amount := d.per_claim_sats * claim_units;

  INSERT INTO drop_claims (drop_id, claimant_id, amount_sats)
  VALUES (p_drop_id, p_claimant_id, claim_amount)
  ON CONFLICT (drop_id, claimant_id) DO NOTHING
  RETURNING id INTO inserted_claim_id;

  IF inserted_claim_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_claimed');
  END IF;

  new_count := d.claims_count + claim_units;

  UPDATE drops
  SET claims_count = new_count,
      status = CASE WHEN new_count >= max_claims THEN 'completed' ELSE status END
  WHERE id = p_drop_id;

  INSERT INTO users (discord_id)
  VALUES (p_claimant_id)
  ON CONFLICT (discord_id) DO NOTHING;

  UPDATE users
  SET balance_sats = balance_sats + claim_amount,
      updated_at = now()
  WHERE discord_id = p_claimant_id;

  INSERT INTO rains (sender_id, amount_sats, recipient_count)
  VALUES (d.creator_id, claim_amount, 1);

  RETURN jsonb_build_object(
    'ok', true,
    'claim_id', inserted_claim_id,
    'new_count', new_count,
    'remaining', GREATEST(d.max_claims - new_count, 0),
    'completed', new_count >= d.max_claims,
    'amount_sats', claim_amount,
    'claim_units', claim_units,
    'creator_id', d.creator_id
  );
END;
$claim_drop_atomic$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION claim_event_quest_reward(
  p_quest_id BIGINT,
  p_user_id TEXT,
  p_reward_multiplier INTEGER DEFAULT 1
)
RETURNS boolean AS $$
DECLARE
  q event_quests%ROWTYPE;
  a event_quest_attendance%ROWTYPE;
  rows_updated INTEGER;
  reward_units INTEGER := 1;
  reward_amount DOUBLE PRECISION := 0;
BEGIN
  reward_units := CASE WHEN p_reward_multiplier >= 2 THEN 2 ELSE 1 END;

  SELECT * INTO q
  FROM event_quests
  WHERE id = p_quest_id
  FOR UPDATE;

  IF NOT FOUND OR q.status <> 'active' THEN
    RETURN false;
  END IF;

  IF q.max_rewards IS NOT NULL AND q.rewards_count >= q.max_rewards THEN
    UPDATE event_quests
    SET status = 'completed', completed_at = COALESCE(completed_at, now())
    WHERE id = p_quest_id;
    RETURN false;
  END IF;

  IF q.max_rewards IS NOT NULL AND q.rewards_count + reward_units > q.max_rewards THEN
    RETURN false;
  END IF;

  SELECT * INTO a
  FROM event_quest_attendance
  WHERE quest_id = p_quest_id
    AND user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND OR a.rewarded_at IS NOT NULL OR a.accumulated_seconds < (q.min_minutes * 60) THEN
    RETURN false;
  END IF;

  reward_amount := q.reward_sats * reward_units;

  INSERT INTO users (discord_id)
  VALUES (q.creator_id), (p_user_id)
  ON CONFLICT (discord_id) DO NOTHING;

  UPDATE users
  SET balance_sats = balance_sats - reward_amount,
      updated_at = now()
  WHERE discord_id = q.creator_id
    AND balance_sats >= reward_amount;

  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  IF rows_updated = 0 THEN
    UPDATE event_quests
    SET status = 'exhausted', completed_at = COALESCE(completed_at, now())
    WHERE id = p_quest_id;
    RETURN false;
  END IF;

  UPDATE users
  SET balance_sats = balance_sats + reward_amount,
      updated_at = now()
  WHERE discord_id = p_user_id;

  UPDATE event_quest_attendance
  SET rewarded_at = now(),
      reward_sats = reward_amount,
      last_seen_at = now()
  WHERE quest_id = p_quest_id
    AND user_id = p_user_id;

  UPDATE event_quests
  SET rewards_count = rewards_count + reward_units,
      status = CASE
        WHEN max_rewards IS NOT NULL AND rewards_count + reward_units >= max_rewards THEN 'completed'
        ELSE status
      END,
      completed_at = CASE
        WHEN max_rewards IS NOT NULL AND rewards_count + reward_units >= max_rewards THEN now()
        ELSE completed_at
      END
  WHERE id = p_quest_id;

  RETURN true;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION complete_quest_task_and_pay_delta(
  p_quest_id BIGINT,
  p_task_id BIGINT,
  p_user_id TEXT,
  p_proof JSONB DEFAULT '{}'::jsonb,
  p_reward_multiplier INTEGER DEFAULT 1
)
RETURNS JSONB AS $quest_engine$
DECLARE
  q quests%ROWTYPE;
  t quest_tasks%ROWTYPE;
  inserted_completion BOOLEAN := false;
  completion_count INTEGER := 0;
  tier_reward DOUBLE PRECISION := 0;
  previous_tier_reward DOUBLE PRECISION := 0;
  previous_paid DOUBLE PRECISION := 0;
  reward_delta DOUBLE PRECISION := 0;
  payout_delta DOUBLE PRECISION := 0;
  multiplier INTEGER := 1;
  rows_updated INTEGER := 0;
BEGIN
  multiplier := CASE WHEN p_reward_multiplier >= 2 THEN 2 ELSE 1 END;

  SELECT * INTO q FROM quests WHERE id = p_quest_id FOR UPDATE;
  IF NOT FOUND OR q.status <> 'active' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'quest_inactive');
  END IF;
  IF q.starts_at IS NOT NULL AND now() < q.starts_at THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'quest_not_started');
  END IF;
  IF q.ends_at IS NOT NULL AND now() > q.ends_at THEN
    UPDATE quests SET status = 'completed', completed_at = COALESCE(completed_at, now()), updated_at = now() WHERE id = q.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'quest_ended');
  END IF;

  SELECT * INTO t FROM quest_tasks WHERE id = p_task_id AND quest_id = p_quest_id AND status = 'active';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'task_not_found');
  END IF;

  INSERT INTO quest_task_completions (quest_id, task_id, user_id, proof)
  VALUES (p_quest_id, p_task_id, p_user_id, COALESCE(p_proof, '{}'::jsonb))
  ON CONFLICT (task_id, user_id) DO NOTHING;
  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  inserted_completion := rows_updated > 0;

  SELECT COUNT(*)::INTEGER INTO completion_count
  FROM quest_task_completions c
  JOIN quest_tasks qt ON qt.id = c.task_id
  WHERE c.quest_id = p_quest_id AND c.user_id = p_user_id AND qt.status = 'active';

  SELECT COALESCE(MAX(reward_sats), 0)::DOUBLE PRECISION INTO tier_reward
  FROM quest_reward_tiers
  WHERE quest_id = p_quest_id AND completed_task_count <= completion_count;

  SELECT COALESCE(paid_sats, 0), COALESCE(total_reward_sats, 0)
  INTO previous_paid, previous_tier_reward
  FROM quest_user_rewards
  WHERE quest_id = p_quest_id AND user_id = p_user_id
  FOR UPDATE;

  reward_delta := tier_reward - COALESCE(previous_tier_reward, 0);
  IF reward_delta < 0 THEN reward_delta := 0; END IF;
  payout_delta := reward_delta * multiplier;

  INSERT INTO users (discord_id) VALUES (q.creator_id), (p_user_id)
  ON CONFLICT (discord_id) DO NOTHING;

  IF payout_delta > 0 THEN
    UPDATE users
    SET balance_sats = balance_sats - payout_delta, updated_at = now()
    WHERE discord_id = q.creator_id AND balance_sats >= payout_delta;
    GET DIAGNOSTICS rows_updated = ROW_COUNT;
    IF rows_updated = 0 THEN
      UPDATE quests SET status = 'exhausted', completed_at = COALESCE(completed_at, now()), updated_at = now()
      WHERE id = p_quest_id;
      INSERT INTO quest_user_rewards (quest_id, user_id, completed_task_count, total_reward_sats, paid_sats, updated_at)
      VALUES (p_quest_id, p_user_id, completion_count, tier_reward, COALESCE(previous_paid, 0), now())
      ON CONFLICT (quest_id, user_id) DO UPDATE
      SET completed_task_count = EXCLUDED.completed_task_count,
          total_reward_sats = EXCLUDED.total_reward_sats,
          updated_at = now();
      RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_creator_balance', 'insertedCompletion', inserted_completion, 'completedTaskCount', completion_count, 'tierRewardSats', tier_reward, 'previousPaidSats', COALESCE(previous_paid, 0), 'rewardDeltaSats', payout_delta);
    END IF;

    UPDATE users SET balance_sats = balance_sats + payout_delta, updated_at = now()
    WHERE discord_id = p_user_id;
  END IF;

  INSERT INTO quest_user_rewards (quest_id, user_id, completed_task_count, total_reward_sats, paid_sats, last_paid_at, updated_at)
  VALUES (p_quest_id, p_user_id, completion_count, tier_reward, COALESCE(previous_paid, 0) + payout_delta, CASE WHEN payout_delta > 0 THEN now() ELSE NULL END, now())
  ON CONFLICT (quest_id, user_id) DO UPDATE
  SET completed_task_count = EXCLUDED.completed_task_count,
      total_reward_sats = EXCLUDED.total_reward_sats,
      paid_sats = EXCLUDED.paid_sats,
      last_paid_at = COALESCE(EXCLUDED.last_paid_at, quest_user_rewards.last_paid_at),
      updated_at = now();

  IF payout_delta > 0 THEN
    INSERT INTO quest_reward_events (quest_id, user_id, reward_delta_sats, total_paid_sats, completed_task_count, reason)
    VALUES (p_quest_id, p_user_id, payout_delta, COALESCE(previous_paid, 0) + payout_delta, completion_count, 'tier_delta');
  END IF;

  RETURN jsonb_build_object('ok', true, 'insertedCompletion', inserted_completion, 'completedTaskCount', completion_count, 'tierRewardSats', tier_reward, 'previousPaidSats', COALESCE(previous_paid, 0), 'rewardDeltaSats', payout_delta, 'totalPaidSats', COALESCE(previous_paid, 0) + payout_delta);
END;
$quest_engine$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION pay_repeatable_quest_task_reward(
  p_quest_id BIGINT,
  p_task_id BIGINT,
  p_user_id TEXT,
  p_proof JSONB DEFAULT '{}'::jsonb,
  p_reward_multiplier INTEGER DEFAULT 1
)
RETURNS JSONB AS $repeatable_quest_reward$
DECLARE
  q quests%ROWTYPE;
  t quest_tasks%ROWTYPE;
  reward_sats DOUBLE PRECISION := 0;
  payout_sats DOUBLE PRECISION := 0;
  previous_paid DOUBLE PRECISION := 0;
  multiplier INTEGER := 1;
  rows_updated INTEGER := 0;
BEGIN
  multiplier := CASE WHEN p_reward_multiplier >= 2 THEN 2 ELSE 1 END;

  SELECT * INTO q FROM quests WHERE id = p_quest_id FOR UPDATE;
  IF NOT FOUND OR q.status <> 'active' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'quest_inactive');
  END IF;
  IF q.starts_at IS NOT NULL AND now() < q.starts_at THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'quest_not_started');
  END IF;
  IF q.ends_at IS NOT NULL AND now() > q.ends_at THEN
    UPDATE quests SET status = 'completed', completed_at = COALESCE(completed_at, now()), updated_at = now() WHERE id = q.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'quest_ended');
  END IF;

  SELECT * INTO t FROM quest_tasks WHERE id = p_task_id AND quest_id = p_quest_id AND status = 'active';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'task_not_found');
  END IF;

  SELECT COALESCE(MAX(reward_sats), 0)::DOUBLE PRECISION INTO reward_sats
  FROM quest_reward_tiers
  WHERE quest_id = p_quest_id AND completed_task_count <= 1;

  payout_sats := reward_sats * multiplier;

  IF payout_sats <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'reward_not_configured');
  END IF;

  SELECT COALESCE(paid_sats, 0) INTO previous_paid
  FROM quest_user_rewards
  WHERE quest_id = p_quest_id AND user_id = p_user_id
  FOR UPDATE;

  SELECT COALESCE(previous_paid, 0) + COALESCE(SUM(reward_delta_sats), 0)::DOUBLE PRECISION INTO previous_paid
  FROM quest_reward_events
  WHERE quest_id = p_quest_id AND user_id = p_user_id AND reason = 'repeatable_task';

  INSERT INTO users (discord_id) VALUES (q.creator_id), (p_user_id)
  ON CONFLICT (discord_id) DO NOTHING;

  UPDATE users
  SET balance_sats = balance_sats - payout_sats, updated_at = now()
  WHERE discord_id = q.creator_id AND balance_sats >= payout_sats;
  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  IF rows_updated = 0 THEN
    UPDATE quests SET status = 'exhausted', completed_at = COALESCE(completed_at, now()), updated_at = now()
    WHERE id = p_quest_id;
    RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_creator_balance', 'insertedCompletion', false, 'completedTaskCount', 1, 'tierRewardSats', reward_sats, 'previousPaidSats', COALESCE(previous_paid, 0), 'rewardDeltaSats', payout_sats);
  END IF;

  UPDATE users SET balance_sats = balance_sats + payout_sats, updated_at = now()
  WHERE discord_id = p_user_id;

  INSERT INTO quest_reward_events (quest_id, user_id, reward_delta_sats, total_paid_sats, completed_task_count, reason)
  VALUES (p_quest_id, p_user_id, payout_sats, COALESCE(previous_paid, 0) + payout_sats, 1, 'repeatable_task');

  RETURN jsonb_build_object('ok', true, 'insertedCompletion', false, 'completedTaskCount', 1, 'tierRewardSats', reward_sats, 'previousPaidSats', COALESCE(previous_paid, 0), 'rewardDeltaSats', payout_sats, 'totalPaidSats', COALESCE(previous_paid, 0) + payout_sats);
END;
$repeatable_quest_reward$ LANGUAGE plpgsql;
