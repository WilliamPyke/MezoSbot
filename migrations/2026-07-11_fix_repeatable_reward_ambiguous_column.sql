-- Fix: pay_repeatable_quest_task_reward always failed with
--   ERROR 42702: column reference "reward_sats" is ambiguous
-- because the PL/pgSQL variable `reward_sats` collided with the
-- quest_reward_tiers.reward_sats column in the tier lookup. Every repeat
-- link-window winner therefore silently earned nothing (the bot caught the
-- error and only logged a warning). Renames the variable to base_reward_sats.
--
-- Also drops the legacy 4-arg overload (which had the same bug); the bot
-- always calls the 5-arg form with p_reward_multiplier, and keeping a broken
-- overload around only invites PostgREST ambiguity.

DROP FUNCTION IF EXISTS pay_repeatable_quest_task_reward(BIGINT, BIGINT, TEXT, JSONB);

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
  base_reward_sats DOUBLE PRECISION := 0;
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

  SELECT COALESCE(MAX(qrt.reward_sats), 0)::DOUBLE PRECISION INTO base_reward_sats
  FROM quest_reward_tiers qrt
  WHERE qrt.quest_id = p_quest_id AND qrt.completed_task_count <= 1;

  payout_sats := base_reward_sats * multiplier;

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
    RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_creator_balance', 'insertedCompletion', false, 'completedTaskCount', 1, 'tierRewardSats', base_reward_sats, 'previousPaidSats', COALESCE(previous_paid, 0), 'rewardDeltaSats', payout_sats);
  END IF;

  UPDATE users SET balance_sats = balance_sats + payout_sats, updated_at = now()
  WHERE discord_id = p_user_id;

  INSERT INTO quest_reward_events (quest_id, user_id, reward_delta_sats, total_paid_sats, completed_task_count, reason)
  VALUES (p_quest_id, p_user_id, payout_sats, COALESCE(previous_paid, 0) + payout_sats, 1, 'repeatable_task');

  RETURN jsonb_build_object('ok', true, 'insertedCompletion', false, 'completedTaskCount', 1, 'tierRewardSats', base_reward_sats, 'previousPaidSats', COALESCE(previous_paid, 0), 'rewardDeltaSats', payout_sats, 'totalPaidSats', COALESCE(previous_paid, 0) + payout_sats);
END;
$repeatable_quest_reward$ LANGUAGE plpgsql;
