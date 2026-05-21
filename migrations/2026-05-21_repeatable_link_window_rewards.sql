-- Allow rotating-link window winners to receive a reward even when the same
-- user has already completed the link task in a previous window.

CREATE OR REPLACE FUNCTION pay_repeatable_quest_task_reward(
  p_quest_id BIGINT,
  p_task_id BIGINT,
  p_user_id TEXT,
  p_proof JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB AS $repeatable_quest_reward$
DECLARE
  q quests%ROWTYPE;
  t quest_tasks%ROWTYPE;
  reward_sats DOUBLE PRECISION := 0;
  previous_paid DOUBLE PRECISION := 0;
  rows_updated INTEGER := 0;
BEGIN
  SELECT * INTO q
  FROM quests
  WHERE id = p_quest_id
  FOR UPDATE;

  IF NOT FOUND OR q.status <> 'active' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'quest_inactive');
  END IF;

  IF q.starts_at IS NOT NULL AND now() < q.starts_at THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'quest_not_started');
  END IF;

  IF q.ends_at IS NOT NULL AND now() > q.ends_at THEN
    UPDATE quests
    SET status = 'completed', completed_at = COALESCE(completed_at, now()), updated_at = now()
    WHERE id = q.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'quest_ended');
  END IF;

  SELECT * INTO t
  FROM quest_tasks
  WHERE id = p_task_id
    AND quest_id = p_quest_id
    AND status = 'active';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'task_not_found');
  END IF;

  SELECT COALESCE(MAX(reward_sats), 0)::DOUBLE PRECISION INTO reward_sats
  FROM quest_reward_tiers
  WHERE quest_id = p_quest_id
    AND completed_task_count <= 1;

  IF reward_sats <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'reward_not_configured');
  END IF;

  SELECT COALESCE(paid_sats, 0) INTO previous_paid
  FROM quest_user_rewards
  WHERE quest_id = p_quest_id
    AND user_id = p_user_id
  FOR UPDATE;

  SELECT COALESCE(previous_paid, 0) + COALESCE(SUM(reward_delta_sats), 0)::DOUBLE PRECISION INTO previous_paid
  FROM quest_reward_events
  WHERE quest_id = p_quest_id
    AND user_id = p_user_id
    AND reason = 'repeatable_task';

  INSERT INTO users (discord_id)
  VALUES (q.creator_id), (p_user_id)
  ON CONFLICT (discord_id) DO NOTHING;

  UPDATE users
  SET balance_sats = balance_sats - reward_sats,
      updated_at = now()
  WHERE discord_id = q.creator_id
    AND balance_sats >= reward_sats;

  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  IF rows_updated = 0 THEN
    UPDATE quests
    SET status = 'exhausted', completed_at = COALESCE(completed_at, now()), updated_at = now()
    WHERE id = p_quest_id;

    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'insufficient_creator_balance',
      'insertedCompletion', false,
      'completedTaskCount', 1,
      'tierRewardSats', reward_sats,
      'previousPaidSats', COALESCE(previous_paid, 0),
      'rewardDeltaSats', reward_sats
    );
  END IF;

  UPDATE users
  SET balance_sats = balance_sats + reward_sats,
      updated_at = now()
  WHERE discord_id = p_user_id;

  INSERT INTO quest_reward_events (
    quest_id, user_id, reward_delta_sats, total_paid_sats, completed_task_count, reason
  )
  VALUES (
    p_quest_id,
    p_user_id,
    reward_sats,
    COALESCE(previous_paid, 0) + reward_sats,
    1,
    'repeatable_task'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'insertedCompletion', false,
    'completedTaskCount', 1,
    'tierRewardSats', reward_sats,
    'previousPaidSats', COALESCE(previous_paid, 0),
    'rewardDeltaSats', reward_sats,
    'totalPaidSats', COALESCE(previous_paid, 0) + reward_sats
  );
END;
$repeatable_quest_reward$ LANGUAGE plpgsql;
