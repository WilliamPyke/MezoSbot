-- Generic multistep quest engine.
-- Rewards are tiered in literal sats by completed task count:
-- 1 task => X sats total, 2 tasks => Y sats total, etc. Payouts are deltas.

CREATE TABLE IF NOT EXISTS quests (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  creator_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active', -- draft | active | completed | exhausted | cancelled
  reward_mode TEXT NOT NULL DEFAULT 'tiered_count',
  max_reward_sats DOUBLE PRECISION NOT NULL DEFAULT 0,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS quest_tasks (
  id BIGSERIAL PRIMARY KEY,
  quest_id BIGINT NOT NULL REFERENCES quests(id) ON DELETE CASCADE,
  task_key TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(quest_id, task_key)
);

CREATE TABLE IF NOT EXISTS quest_reward_tiers (
  id BIGSERIAL PRIMARY KEY,
  quest_id BIGINT NOT NULL REFERENCES quests(id) ON DELETE CASCADE,
  completed_task_count INTEGER NOT NULL,
  reward_sats DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(quest_id, completed_task_count)
);

CREATE TABLE IF NOT EXISTS quest_task_completions (
  id BIGSERIAL PRIMARY KEY,
  quest_id BIGINT NOT NULL REFERENCES quests(id) ON DELETE CASCADE,
  task_id BIGINT NOT NULL REFERENCES quest_tasks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  proof JSONB NOT NULL DEFAULT '{}'::jsonb,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(task_id, user_id)
);

CREATE TABLE IF NOT EXISTS quest_user_rewards (
  quest_id BIGINT NOT NULL REFERENCES quests(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  completed_task_count INTEGER NOT NULL DEFAULT 0,
  total_reward_sats DOUBLE PRECISION NOT NULL DEFAULT 0,
  paid_sats DOUBLE PRECISION NOT NULL DEFAULT 0,
  last_paid_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(quest_id, user_id)
);

CREATE TABLE IF NOT EXISTS quest_reward_events (
  id BIGSERIAL PRIMARY KEY,
  quest_id BIGINT NOT NULL REFERENCES quests(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  reward_delta_sats DOUBLE PRECISION NOT NULL,
  total_paid_sats DOUBLE PRECISION NOT NULL,
  completed_task_count INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quests_active_guild
  ON quests(guild_id, status, starts_at, ends_at);
CREATE INDEX IF NOT EXISTS idx_quest_tasks_quest_order
  ON quest_tasks(quest_id, sort_order, id);
CREATE INDEX IF NOT EXISTS idx_quest_tasks_type
  ON quest_tasks(type, status);
CREATE INDEX IF NOT EXISTS idx_quest_completions_user
  ON quest_task_completions(quest_id, user_id);
CREATE INDEX IF NOT EXISTS idx_quest_rewards_user
  ON quest_user_rewards(user_id, quest_id);

CREATE OR REPLACE FUNCTION complete_quest_task_and_pay_delta(
  p_quest_id BIGINT,
  p_task_id BIGINT,
  p_user_id TEXT,
  p_proof JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB AS $$
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
$$ LANGUAGE plpgsql;
