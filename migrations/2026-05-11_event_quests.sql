-- Event attendance quests: reward users for staying in a scheduled event's
-- voice/stage channel for a minimum duration.

CREATE TABLE IF NOT EXISTS event_quests (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  scheduled_event_id TEXT NOT NULL,
  event_name TEXT NOT NULL,
  event_channel_id TEXT NOT NULL,
  reward_sats DOUBLE PRECISION NOT NULL,
  min_minutes INTEGER NOT NULL,
  max_rewards INTEGER,
  rewards_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active', -- active | completed | exhausted | cancelled
  scheduled_start_at TIMESTAMPTZ,
  scheduled_end_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS event_quest_attendance (
  id BIGSERIAL PRIMARY KEY,
  quest_id BIGINT NOT NULL REFERENCES event_quests(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  joined_at TIMESTAMPTZ,
  accumulated_seconds INTEGER NOT NULL DEFAULT 0,
  last_seen_at TIMESTAMPTZ,
  reward_sats DOUBLE PRECISION,
  rewarded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(quest_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_event_quests_active_channel
  ON event_quests (status, guild_id, event_channel_id);
CREATE INDEX IF NOT EXISTS idx_event_quest_attendance_joined
  ON event_quest_attendance (quest_id, joined_at)
  WHERE rewarded_at IS NULL;

CREATE OR REPLACE FUNCTION claim_event_quest_reward(
  p_quest_id BIGINT,
  p_user_id TEXT
)
RETURNS boolean AS $$
DECLARE
  q event_quests%ROWTYPE;
  a event_quest_attendance%ROWTYPE;
  rows_updated INTEGER;
BEGIN
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

  SELECT * INTO a
  FROM event_quest_attendance
  WHERE quest_id = p_quest_id
    AND user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND OR a.rewarded_at IS NOT NULL OR a.accumulated_seconds < (q.min_minutes * 60) THEN
    RETURN false;
  END IF;

  INSERT INTO users (discord_id)
  VALUES (q.creator_id), (p_user_id)
  ON CONFLICT (discord_id) DO NOTHING;

  UPDATE users
  SET balance_sats = balance_sats - q.reward_sats,
      updated_at = now()
  WHERE discord_id = q.creator_id
    AND balance_sats >= q.reward_sats;

  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  IF rows_updated = 0 THEN
    UPDATE event_quests
    SET status = 'exhausted', completed_at = COALESCE(completed_at, now())
    WHERE id = p_quest_id;
    RETURN false;
  END IF;

  UPDATE users
  SET balance_sats = balance_sats + q.reward_sats,
      updated_at = now()
  WHERE discord_id = p_user_id;

  UPDATE event_quest_attendance
  SET rewarded_at = now(),
      reward_sats = q.reward_sats,
      last_seen_at = now()
  WHERE quest_id = p_quest_id
    AND user_id = p_user_id;

  UPDATE event_quests
  SET rewards_count = rewards_count + 1,
      status = CASE
        WHEN max_rewards IS NOT NULL AND rewards_count + 1 >= max_rewards THEN 'completed'
        ELSE status
      END,
      completed_at = CASE
        WHEN max_rewards IS NOT NULL AND rewards_count + 1 >= max_rewards THEN now()
        ELSE completed_at
      END
  WHERE id = p_quest_id;

  RETURN true;
END;
$$ LANGUAGE plpgsql;
