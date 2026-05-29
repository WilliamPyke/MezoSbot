-- Repeat-claimer fix for rotating-link quests.
--
-- Symptom: a user who won a link window in an earlier window does not receive
-- sats when they win a later window for the same quest.
--
-- Root cause: the repeat-payment path in the bot is reached only when
-- complete_quest_task_and_pay_delta() reports it did NOT insert a fresh
-- completion (the user already completed the task before). If a stale/older
-- version of that function is live and omits `insertedCompletion` from its
-- return payload, the bot can't tell a repeat win apart and skips payment.
--
-- This migration is idempotent (CREATE OR REPLACE). Re-running it makes the
-- live DB match the canonical definitions in:
--   migrations/2026-05-11_quest_engine.sql
--   migrations/2026-05-21_repeatable_link_window_rewards.sql
-- so both `insertedCompletion` is returned and pay_repeatable_quest_task_reward
-- exists. Safe to run repeatedly; no schema changes, functions only.

CREATE OR REPLACE FUNCTION complete_quest_task_and_pay_delta(
  p_quest_id BIGINT,
  p_task_id BIGINT,
  p_user_id TEXT,
  p_proof JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB AS $quest_engine$
DECLARE
  q quests%ROWTYPE;
  t quest_tasks%ROWTYPE;
  inserted_completion BOOLEAN := false;
  completion_count INTEGER := 0;
  tier_reward DOUBLE PRECISION := 0;
  previous_paid DOUBLE PRECISION := 0;
  reward_delta DOUBLE PRECISION := 0;
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

  INSERT INTO quest_task_completions (quest_id, task_id, user_id, proof)
  VALUES (p_quest_id, p_task_id, p_user_id, COALESCE(p_proof, '{}'::jsonb))
  ON CONFLICT (task_id, user_id) DO NOTHING;
  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  inserted_completion := rows_updated > 0;

  SELECT COUNT(*)::INTEGER INTO completion_count
  FROM quest_task_completions c
  JOIN quest_tasks qt ON qt.id = c.task_id
  WHERE c.quest_id = p_quest_id
    AND c.user_id = p_user_id
    AND qt.status = 'active';

  SELECT COALESCE(MAX(reward_sats), 0)::DOUBLE PRECISION INTO tier_reward
  FROM quest_reward_tiers
  WHERE quest_id = p_quest_id
    AND completed_task_count <= completion_count;

  SELECT COALESCE(paid_sats, 0) INTO previous_paid
  FROM quest_user_rewards
  WHERE quest_id = p_quest_id
    AND user_id = p_user_id
  FOR UPDATE;

  reward_delta := tier_reward - COALESCE(previous_paid, 0);
  IF reward_delta < 0 THEN
    reward_delta := 0;
  END IF;

  INSERT INTO users (discord_id)
  VALUES (q.creator_id), (p_user_id)
  ON CONFLICT (discord_id) DO NOTHING;

  IF reward_delta > 0 THEN
    UPDATE users
    SET balance_sats = balance_sats - reward_delta,
        updated_at = now()
    WHERE discord_id = q.creator_id
      AND balance_sats >= reward_delta;

    GET DIAGNOSTICS rows_updated = ROW_COUNT;
    IF rows_updated = 0 THEN
      UPDATE quests
      SET status = 'exhausted', completed_at = COALESCE(completed_at, now()), updated_at = now()
      WHERE id = p_quest_id;

      INSERT INTO quest_user_rewards (
        quest_id, user_id, completed_task_count, total_reward_sats, paid_sats, updated_at
      )
      VALUES (
        p_quest_id, p_user_id, completion_count, tier_reward, COALESCE(previous_paid, 0), now()
      )
      ON CONFLICT (quest_id, user_id) DO UPDATE
      SET completed_task_count = EXCLUDED.completed_task_count,
          total_reward_sats = EXCLUDED.total_reward_sats,
          updated_at = now();

      RETURN jsonb_build_object(
        'ok', false,
        'reason', 'insufficient_creator_balance',
        'insertedCompletion', inserted_completion,
        'completedTaskCount', completion_count,
        'tierRewardSats', tier_reward,
        'previousPaidSats', COALESCE(previous_paid, 0),
        'rewardDeltaSats', reward_delta
      );
    END IF;

    UPDATE users
    SET balance_sats = balance_sats + reward_delta,
        updated_at = now()
    WHERE discord_id = p_user_id;
  END IF;

  INSERT INTO quest_user_rewards (
    quest_id, user_id, completed_task_count, total_reward_sats, paid_sats, last_paid_at, updated_at
  )
  VALUES (
    p_quest_id,
    p_user_id,
    completion_count,
    tier_reward,
    COALESCE(previous_paid, 0) + reward_delta,
    CASE WHEN reward_delta > 0 THEN now() ELSE NULL END,
    now()
  )
  ON CONFLICT (quest_id, user_id) DO UPDATE
  SET completed_task_count = EXCLUDED.completed_task_count,
      total_reward_sats = EXCLUDED.total_reward_sats,
      paid_sats = EXCLUDED.paid_sats,
      last_paid_at = COALESCE(EXCLUDED.last_paid_at, quest_user_rewards.last_paid_at),
      updated_at = now();

  IF reward_delta > 0 THEN
    INSERT INTO quest_reward_events (
      quest_id, user_id, reward_delta_sats, total_paid_sats, completed_task_count, reason
    )
    VALUES (
      p_quest_id,
      p_user_id,
      reward_delta,
      COALESCE(previous_paid, 0) + reward_delta,
      completion_count,
      'tier_delta'
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'insertedCompletion', inserted_completion,
    'completedTaskCount', completion_count,
    'tierRewardSats', tier_reward,
    'previousPaidSats', COALESCE(previous_paid, 0),
    'rewardDeltaSats', reward_delta,
    'totalPaidSats', COALESCE(previous_paid, 0) + reward_delta
  );
END;
$quest_engine$ LANGUAGE plpgsql;

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
