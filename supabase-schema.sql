-- MezoSbot: Supabase Postgres Schema
-- Paste this into your Supabase SQL Editor and run it.

CREATE TABLE IF NOT EXISTS users (
  discord_id TEXT PRIMARY KEY,
  wallet_address TEXT UNIQUE,
  balance_sats DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;

CREATE TABLE IF NOT EXISTS links (
  id BIGSERIAL PRIMARY KEY,
  discord_id TEXT NOT NULL,
  wallet_address TEXT NOT NULL UNIQUE,
  linked_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(discord_id, wallet_address)
);

CREATE TABLE IF NOT EXISTS deposits (
  id BIGSERIAL PRIMARY KEY,
  discord_id TEXT NOT NULL,
  tx_hash TEXT NOT NULL UNIQUE,
  amount_sats DOUBLE PRECISION NOT NULL,
  block_number INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id BIGSERIAL PRIMARY KEY,
  discord_id TEXT NOT NULL,
  tx_hash TEXT,
  amount_sats DOUBLE PRECISION NOT NULL,
  to_address TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  status TEXT DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS drops (
  id BIGSERIAL PRIMARY KEY,
  channel_id TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  message_id TEXT,
  eligible_role_id TEXT,
  total_sats DOUBLE PRECISION NOT NULL,
  per_claim_sats DOUBLE PRECISION NOT NULL,
  max_claims INTEGER NOT NULL,
  claims_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE drops ADD COLUMN IF NOT EXISTS eligible_role_id TEXT;

CREATE TABLE IF NOT EXISTS drop_claims (
  id BIGSERIAL PRIMARY KEY,
  drop_id BIGINT NOT NULL REFERENCES drops(id),
  claimant_id TEXT NOT NULL,
  amount_sats DOUBLE PRECISION NOT NULL,
  claimed_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(drop_id, claimant_id)
);

CREATE TABLE IF NOT EXISTS rain_banned_terms (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  term TEXT NOT NULL,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(guild_id, term),
  CHECK (length(term) > 0),
  CHECK (length(term) <= 100)
);

CREATE INDEX IF NOT EXISTS idx_rain_banned_terms_guild
  ON rain_banned_terms(guild_id);

CREATE TABLE IF NOT EXISTS event_quests (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  creator_id TEXT NOT NULL,
  scheduled_event_id TEXT NOT NULL,
  event_name TEXT NOT NULL,
  event_channel_id TEXT NOT NULL,
  reward_sats DOUBLE PRECISION NOT NULL,
  min_minutes INTEGER NOT NULL,
  max_rewards INTEGER,
  rewards_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  scheduled_start_at TIMESTAMPTZ,
  scheduled_end_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

ALTER TABLE event_quests ADD COLUMN IF NOT EXISTS message_id TEXT;

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

CREATE TABLE IF NOT EXISTS deposit_addresses (
  discord_id TEXT PRIMARY KEY,
  address TEXT NOT NULL UNIQUE,
  last_checked_balance TEXT DEFAULT '0'
);

CREATE TABLE IF NOT EXISTS wallet_verification_challenges (
  id BIGSERIAL PRIMARY KEY,
  discord_id TEXT NOT NULL,
  deposit_address TEXT NOT NULL,
  challenge_sats DOUBLE PRECISION NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  tx_hash TEXT,
  wallet_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours'),
  verified_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS verified_wallets (
  id BIGSERIAL PRIMARY KEY,
  discord_id TEXT NOT NULL,
  wallet_address TEXT NOT NULL UNIQUE,
  chain_id INTEGER NOT NULL,
  verification_tx_hash TEXT NOT NULL UNIQUE,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS quests (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  creator_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
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

CREATE TABLE IF NOT EXISTS quest_task_attendance (
  quest_id BIGINT NOT NULL REFERENCES quests(id) ON DELETE CASCADE,
  task_id BIGINT NOT NULL REFERENCES quest_tasks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  joined_at TIMESTAMPTZ,
  accumulated_seconds INTEGER NOT NULL DEFAULT 0,
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(task_id, user_id)
);

CREATE TABLE IF NOT EXISTS quest_task_window_claims (
  task_id BIGINT NOT NULL REFERENCES quest_tasks(id) ON DELETE CASCADE,
  window_start TIMESTAMPTZ NOT NULL,
  user_id TEXT NOT NULL,
  proof JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(task_id, window_start)
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

-- RPC functions for atomic balance updates
CREATE OR REPLACE FUNCTION add_balance(p_discord_id TEXT, p_amount DOUBLE PRECISION)
RETURNS void AS $$
BEGIN
  UPDATE users
  SET balance_sats = balance_sats + p_amount, updated_at = now()
  WHERE discord_id = p_discord_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION subtract_balance(p_discord_id TEXT, p_amount DOUBLE PRECISION)
RETURNS void AS $$
BEGIN
  UPDATE users
  SET balance_sats = balance_sats - p_amount, updated_at = now()
  WHERE discord_id = p_discord_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION subtract_balance_if_sufficient(
  p_discord_id TEXT,
  p_amount     DOUBLE PRECISION
)
RETURNS boolean AS $func$
DECLARE
  rows_updated INTEGER;
BEGIN
  UPDATE users
  SET balance_sats = balance_sats - p_amount,
      updated_at   = now()
  WHERE discord_id  = p_discord_id
    AND balance_sats >= p_amount;

  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  RETURN rows_updated > 0;
END;
$func$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION subtract_balances_batch(p_debits JSONB)
RETURNS void AS $$
BEGIN
  WITH debits AS (
    SELECT
      discord_id,
      SUM(amount) AS amount
    FROM jsonb_to_recordset(p_debits) AS x(discord_id TEXT, amount DOUBLE PRECISION)
    WHERE discord_id IS NOT NULL
      AND amount > 0
    GROUP BY discord_id
  )
  UPDATE users u
  SET balance_sats = u.balance_sats - d.amount,
      updated_at = now()
  FROM debits d
  WHERE u.discord_id = d.discord_id
    AND u.balance_sats >= d.amount;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION update_deposit_address_balances(p_updates JSONB)
RETURNS void AS $$
BEGIN
  WITH updates AS (
    SELECT DISTINCT ON (discord_id)
      discord_id,
      last_checked_balance
    FROM jsonb_to_recordset(p_updates) AS x(discord_id TEXT, last_checked_balance TEXT)
    WHERE discord_id IS NOT NULL
      AND last_checked_balance IS NOT NULL
    ORDER BY discord_id
  )
  UPDATE deposit_addresses d
  SET last_checked_balance = u.last_checked_balance
  FROM updates u
  WHERE d.discord_id = u.discord_id
    AND d.last_checked_balance IS DISTINCT FROM u.last_checked_balance;
END;
$$ LANGUAGE plpgsql;

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

  SELECT COALESCE(paid_sats, 0) INTO previous_paid
  FROM quest_user_rewards
  WHERE quest_id = p_quest_id AND user_id = p_user_id
  FOR UPDATE;

  reward_delta := tier_reward - COALESCE(previous_paid, 0);
  IF reward_delta < 0 THEN reward_delta := 0; END IF;

  INSERT INTO users (discord_id) VALUES (q.creator_id), (p_user_id)
  ON CONFLICT (discord_id) DO NOTHING;

  IF reward_delta > 0 THEN
    UPDATE users
    SET balance_sats = balance_sats - reward_delta, updated_at = now()
    WHERE discord_id = q.creator_id AND balance_sats >= reward_delta;
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
      RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_creator_balance', 'insertedCompletion', inserted_completion, 'completedTaskCount', completion_count, 'tierRewardSats', tier_reward, 'previousPaidSats', COALESCE(previous_paid, 0), 'rewardDeltaSats', reward_delta);
    END IF;

    UPDATE users SET balance_sats = balance_sats + reward_delta, updated_at = now()
    WHERE discord_id = p_user_id;
  END IF;

  INSERT INTO quest_user_rewards (quest_id, user_id, completed_task_count, total_reward_sats, paid_sats, last_paid_at, updated_at)
  VALUES (p_quest_id, p_user_id, completion_count, tier_reward, COALESCE(previous_paid, 0) + reward_delta, CASE WHEN reward_delta > 0 THEN now() ELSE NULL END, now())
  ON CONFLICT (quest_id, user_id) DO UPDATE
  SET completed_task_count = EXCLUDED.completed_task_count,
      total_reward_sats = EXCLUDED.total_reward_sats,
      paid_sats = EXCLUDED.paid_sats,
      last_paid_at = COALESCE(EXCLUDED.last_paid_at, quest_user_rewards.last_paid_at),
      updated_at = now();

  IF reward_delta > 0 THEN
    INSERT INTO quest_reward_events (quest_id, user_id, reward_delta_sats, total_paid_sats, completed_task_count, reason)
    VALUES (p_quest_id, p_user_id, reward_delta, COALESCE(previous_paid, 0) + reward_delta, completion_count, 'tier_delta');
  END IF;

  RETURN jsonb_build_object('ok', true, 'insertedCompletion', inserted_completion, 'completedTaskCount', completion_count, 'tierRewardSats', tier_reward, 'previousPaidSats', COALESCE(previous_paid, 0), 'rewardDeltaSats', reward_delta, 'totalPaidSats', COALESCE(previous_paid, 0) + reward_delta);
END;
$quest_engine$ LANGUAGE plpgsql;

-- NOTE: the PL/pgSQL variable must not be named `reward_sats` — it would be
-- ambiguous with quest_reward_tiers.reward_sats and make every call fail
-- with 42702 (see migrations/2026-07-11_fix_repeatable_reward_ambiguous_column.sql).
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

CREATE TABLE IF NOT EXISTS game_saves (
  rom_name   TEXT PRIMARY KEY,
  save_data  TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Slice Arcade PvP — block puzzle head-to-head
CREATE TABLE IF NOT EXISTS arcade_matches (
  id BIGSERIAL PRIMARY KEY,
  seed TEXT NOT NULL,
  mode TEXT NOT NULL,                          -- 'practice' | 'free_pvp' | 'staked_pvp' | 'tipfight'
  status TEXT NOT NULL DEFAULT 'waiting',      -- waiting | active | submitted | completed | cancelled
  channel_id TEXT,
  message_id TEXT,
  stake_amount_sats DOUBLE PRECISION,
  gross_pot_sats DOUBLE PRECISION,
  platform_rake_bps INTEGER NOT NULL DEFAULT 1000,
  rake_amount_sats DOUBLE PRECISION,
  winner_payout_sats DOUBLE PRECISION,
  created_by_id TEXT NOT NULL,
  target_player_id TEXT,
  player_a_id TEXT NOT NULL,
  player_b_id TEXT,
  player_a_score DOUBLE PRECISION,
  player_b_score DOUBLE PRECISION,
  player_a_submitted BOOLEAN NOT NULL DEFAULT FALSE,
  player_b_submitted BOOLEAN NOT NULL DEFAULT FALSE,
  player_a_ready BOOLEAN NOT NULL DEFAULT FALSE,
  player_b_ready BOOLEAN NOT NULL DEFAULT FALSE,
  winner_id TEXT,
  escrow_status TEXT NOT NULL DEFAULT 'none',  -- none | pending | funded | released | refunded
  duration_seconds INTEGER NOT NULL DEFAULT 180,
  started_at TIMESTAMPTZ,
  countdown_started_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

ALTER TABLE arcade_matches
  ADD COLUMN IF NOT EXISTS duration_seconds INTEGER NOT NULL DEFAULT 180;
ALTER TABLE arcade_matches
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE arcade_matches
  ADD COLUMN IF NOT EXISTS countdown_started_at TIMESTAMPTZ;
ALTER TABLE arcade_matches
  ADD COLUMN IF NOT EXISTS player_a_ready BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE arcade_matches
  ADD COLUMN IF NOT EXISTS player_b_ready BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE arcade_matches
  ADD COLUMN IF NOT EXISTS target_player_id TEXT;
UPDATE arcade_matches
  SET started_at = created_at
  WHERE started_at IS NULL
    AND status IN ('active', 'submitted', 'completed');

-- Rematch chains and session score
ALTER TABLE arcade_matches
  ADD COLUMN IF NOT EXISTS rematch_of_match_id BIGINT REFERENCES arcade_matches(id);
ALTER TABLE arcade_matches
  ADD COLUMN IF NOT EXISTS series_root_id BIGINT;
ALTER TABLE arcade_matches
  ADD COLUMN IF NOT EXISTS rematch_requested_by_a BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE arcade_matches
  ADD COLUMN IF NOT EXISTS rematch_requested_by_b BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE arcade_matches
  ADD COLUMN IF NOT EXISTS next_match_id BIGINT REFERENCES arcade_matches(id);
ALTER TABLE arcade_matches
  ADD COLUMN IF NOT EXISTS next_session_id TEXT;
UPDATE arcade_matches SET series_root_id = id WHERE series_root_id IS NULL;

CREATE TABLE IF NOT EXISTS arcade_submissions (
  id BIGSERIAL PRIMARY KEY,
  match_id BIGINT NOT NULL REFERENCES arcade_matches(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  move_log JSONB NOT NULL,
  claimed_score DOUBLE PRECISION NOT NULL,
  validated_score DOUBLE PRECISION,
  valid BOOLEAN,
  validation_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(match_id, user_id)
);

CREATE TABLE IF NOT EXISTS arcade_escrow (
  id BIGSERIAL PRIMARY KEY,
  match_id BIGINT NOT NULL REFERENCES arcade_matches(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  amount_sats DOUBLE PRECISION NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',      -- pending | funded | refunded | released
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(match_id, user_id)
);

CREATE TABLE IF NOT EXISTS arcade_fees (
  id BIGSERIAL PRIMARY KEY,
  match_id BIGINT NOT NULL UNIQUE REFERENCES arcade_matches(id) ON DELETE CASCADE,
  rake_amount_sats DOUBLE PRECISION NOT NULL,
  platform_rake_bps INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'collected',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE VIEW arcade_fee_totals AS
SELECT
  COALESCE(SUM(rake_amount_sats), 0)::DOUBLE PRECISION AS total_collected_sats,
  COUNT(*)::BIGINT AS collected_match_count
FROM arcade_fees
WHERE status = 'collected';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_links_discord ON links(discord_id);
CREATE INDEX IF NOT EXISTS idx_links_wallet ON links(wallet_address);
CREATE INDEX IF NOT EXISTS idx_deposits_tx ON deposits(tx_hash);
CREATE INDEX IF NOT EXISTS idx_deposits_discord ON deposits(discord_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_discord ON withdrawals(discord_id);
CREATE INDEX IF NOT EXISTS idx_drops_channel ON drops(channel_id);
CREATE INDEX IF NOT EXISTS idx_wallet_verification_pending ON wallet_verification_challenges(discord_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_verified_wallets_discord ON verified_wallets(discord_id);
CREATE INDEX IF NOT EXISTS idx_quests_active_guild ON quests(guild_id, status, starts_at, ends_at);
CREATE INDEX IF NOT EXISTS idx_quest_tasks_quest_order ON quest_tasks(quest_id, sort_order, id);
CREATE INDEX IF NOT EXISTS idx_quest_tasks_type ON quest_tasks(type, status);
CREATE INDEX IF NOT EXISTS idx_quest_completions_user ON quest_task_completions(quest_id, user_id);
CREATE INDEX IF NOT EXISTS idx_quest_task_attendance_joined ON quest_task_attendance(task_id, joined_at) WHERE joined_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_quest_task_window_claims_user ON quest_task_window_claims(user_id, task_id);
CREATE INDEX IF NOT EXISTS idx_quest_rewards_user ON quest_user_rewards(user_id, quest_id);
CREATE INDEX IF NOT EXISTS idx_event_quests_active_channel ON event_quests(status, guild_id, event_channel_id);
CREATE INDEX IF NOT EXISTS idx_event_quest_attendance_joined ON event_quest_attendance(quest_id, joined_at) WHERE rewarded_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_arcade_matches_status ON arcade_matches(status);
CREATE INDEX IF NOT EXISTS idx_arcade_matches_player_a ON arcade_matches(player_a_id);
CREATE INDEX IF NOT EXISTS idx_arcade_matches_player_b ON arcade_matches(player_b_id);
CREATE INDEX IF NOT EXISTS idx_arcade_matches_target ON arcade_matches(target_player_id);
CREATE INDEX IF NOT EXISTS idx_arcade_matches_open_offers ON arcade_matches(status, created_at) WHERE target_player_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_arcade_matches_series_root ON arcade_matches(series_root_id);
CREATE INDEX IF NOT EXISTS idx_arcade_matches_rematch_of ON arcade_matches(rematch_of_match_id);
CREATE INDEX IF NOT EXISTS idx_arcade_submissions_match ON arcade_submissions(match_id);
CREATE INDEX IF NOT EXISTS idx_arcade_escrow_match ON arcade_escrow(match_id);

-- Wallet-first Mallard Arcade sessions. These are intentionally separate from
-- Discord arcade tables so Discord sessions remain independent.
CREATE TABLE IF NOT EXISTS web_auth_nonces (
  nonce TEXT PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  message TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS web_arcade_sessions (
  id TEXT PRIMARY KEY,                           -- bytes32 hex session id
  seed TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',          -- draft | created | active | submitted | completed | refunded | cancelled | settlement_failed
  chain_id INTEGER NOT NULL,
  escrow_contract_address TEXT NOT NULL,
  asset_symbol TEXT NOT NULL,
  asset_address TEXT NOT NULL,
  stake_amount_units TEXT NOT NULL,              -- raw token units as decimal string
  platform_fee_bps INTEGER NOT NULL DEFAULT 1000,
  player_a_address TEXT NOT NULL,
  player_b_address TEXT,
  invited_player_address TEXT,
  winner_address TEXT,
  player_a_score DOUBLE PRECISION,
  player_b_score DOUBLE PRECISION,
  player_a_submitted BOOLEAN NOT NULL DEFAULT FALSE,
  player_b_submitted BOOLEAN NOT NULL DEFAULT FALSE,
  player_a_ready BOOLEAN NOT NULL DEFAULT FALSE,
  player_b_ready BOOLEAN NOT NULL DEFAULT FALSE,
  create_tx_hash TEXT,
  join_tx_hash TEXT,
  settlement_tx_hash TEXT,
  result_hash TEXT,
  join_deadline TIMESTAMPTZ NOT NULL,
  play_deadline TIMESTAMPTZ NOT NULL,
  countdown_started_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS web_arcade_submissions (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES web_arcade_sessions(id) ON DELETE CASCADE,
  wallet_address TEXT NOT NULL,
  move_log JSONB NOT NULL DEFAULT '[]'::jsonb,
  claimed_score DOUBLE PRECISION NOT NULL DEFAULT 0,
  validated_score DOUBLE PRECISION,
  valid BOOLEAN,
  submitted BOOLEAN NOT NULL DEFAULT FALSE,
  validation_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(session_id, wallet_address)
);

CREATE TABLE IF NOT EXISTS web_arcade_escrow_events (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES web_arcade_sessions(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  tx_hash TEXT,
  log_index INTEGER,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tx_hash, log_index)
);

CREATE TABLE IF NOT EXISTS web_arcade_settlement_attempts (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES web_arcade_sessions(id) ON DELETE CASCADE,
  action TEXT NOT NULL,                          -- settle | refund
  result_hash TEXT NOT NULL,
  tx_hash TEXT,
  status TEXT NOT NULL,                          -- pending | submitted | confirmed | failed | skipped
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_web_auth_nonces_wallet ON web_auth_nonces(wallet_address);
CREATE INDEX IF NOT EXISTS idx_web_arcade_sessions_status ON web_arcade_sessions(status);
CREATE INDEX IF NOT EXISTS idx_web_arcade_sessions_player_a ON web_arcade_sessions(player_a_address);
CREATE INDEX IF NOT EXISTS idx_web_arcade_sessions_player_b ON web_arcade_sessions(player_b_address);
CREATE INDEX IF NOT EXISTS idx_web_arcade_sessions_invited ON web_arcade_sessions(invited_player_address);
CREATE INDEX IF NOT EXISTS idx_web_arcade_sessions_deadline ON web_arcade_sessions(play_deadline);

-- Wallet rematch chain
ALTER TABLE web_arcade_sessions
  ADD COLUMN IF NOT EXISTS rematch_of_session_id TEXT REFERENCES web_arcade_sessions(id);
ALTER TABLE web_arcade_sessions
  ADD COLUMN IF NOT EXISTS series_root_session_id TEXT;
ALTER TABLE web_arcade_sessions
  ADD COLUMN IF NOT EXISTS rematch_requested_by_a BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE web_arcade_sessions
  ADD COLUMN IF NOT EXISTS rematch_requested_by_b BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE web_arcade_sessions
  ADD COLUMN IF NOT EXISTS next_session_id TEXT REFERENCES web_arcade_sessions(id);
ALTER TABLE web_arcade_sessions
  ADD COLUMN IF NOT EXISTS countdown_started_at TIMESTAMPTZ;
ALTER TABLE web_arcade_sessions
  ADD COLUMN IF NOT EXISTS player_a_ready BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE web_arcade_sessions
  ADD COLUMN IF NOT EXISTS player_b_ready BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE web_arcade_sessions SET series_root_session_id = id WHERE series_root_session_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_web_arcade_sessions_series_root ON web_arcade_sessions(series_root_session_id);
CREATE INDEX IF NOT EXISTS idx_web_arcade_submissions_session ON web_arcade_submissions(session_id);
CREATE INDEX IF NOT EXISTS idx_web_arcade_settlement_attempts_session ON web_arcade_settlement_attempts(session_id);

-- Global matchmaking queue. One row per pending match request from either
-- surface. user_id holds a Discord snowflake for surface='discord' and a
-- lowercase wallet address for surface='wallet'. Pairing only happens within
-- the same surface — Discord-vs-Discord and wallet-vs-wallet — so no
-- bridging between internal sats and on-chain stakes is needed.
CREATE TABLE IF NOT EXISTS arcade_queue (
  id BIGSERIAL PRIMARY KEY,
  surface TEXT NOT NULL,                          -- 'discord' | 'wallet'
  user_id TEXT NOT NULL,                          -- discord id OR lowercase wallet address
  status TEXT NOT NULL DEFAULT 'waiting',         -- waiting | paired | cancelled | expired
  -- Discord-only:
  duration_seconds INTEGER,
  -- Wallet-only:
  chain_id INTEGER,
  asset_address TEXT,
  stake_amount_units TEXT,
  -- Result:
  match_id BIGINT,                                -- arcade_matches.id  (discord)
  session_id TEXT,                                -- web_arcade_sessions.id (wallet)
  paired_with TEXT,                               -- the other queue user_id
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paired_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL
);

-- A user can only have one waiting entry per surface at a time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_arcade_queue_active
  ON arcade_queue (surface, user_id) WHERE status = 'waiting';

-- Pairing scans the oldest waiting entries within a bucket. For Discord that's
-- just (surface='discord'); for wallet it's (surface, chain_id, asset_address,
-- stake_amount_units). Both fit this composite index.
CREATE INDEX IF NOT EXISTS idx_arcade_queue_waiting
  ON arcade_queue (surface, chain_id, asset_address, stake_amount_units, joined_at)
  WHERE status = 'waiting';

-- Race-safe Discord pairing: atomically pick the oldest waiting Discord entry
-- (excluding the caller) and mark it 'paired' in one statement. Without this
-- two simultaneous matchmake calls could both think they paired with the
-- same row.
CREATE OR REPLACE FUNCTION claim_oldest_discord_queue_entry(p_exclude_user_id TEXT)
RETURNS SETOF arcade_queue AS $$
  UPDATE arcade_queue
  SET status = 'paired',
      paired_at = now()
  WHERE id = (
    SELECT id FROM arcade_queue
    WHERE surface = 'discord'
      AND status = 'waiting'
      AND user_id <> p_exclude_user_id
      AND expires_at >= now()
    ORDER BY joined_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
$$ LANGUAGE sql;

-- Badges and Leaderboards tables and views
CREATE TABLE IF NOT EXISTS tips (
  id BIGSERIAL PRIMARY KEY,
  sender_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  amount_sats DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tips_sender ON tips(sender_id);
CREATE INDEX IF NOT EXISTS idx_tips_recipient ON tips(recipient_id);

CREATE TABLE IF NOT EXISTS rains (
  id BIGSERIAL PRIMARY KEY,
  sender_id TEXT NOT NULL,
  amount_sats DOUBLE PRECISION NOT NULL,
  recipient_count INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rains_sender ON rains(sender_id);

CREATE TABLE IF NOT EXISTS badge_roles (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  badge_type TEXT NOT NULL,          -- 'tipper' | 'rainer'
  stage_name TEXT NOT NULL,          -- 'Generous' | 'Big' | 'Massive' | 'Gigantic' | 'Colossal' | 'Legendary'
  threshold_sats DOUBLE PRECISION NOT NULL,
  role_id TEXT,                      -- Discord role ID
  UNIQUE(guild_id, badge_type, threshold_sats)
);
CREATE INDEX IF NOT EXISTS idx_badge_roles_guild ON badge_roles(guild_id);

CREATE OR REPLACE VIEW user_rain_stats AS
SELECT 
  sender_id AS discord_id,
  SUM(amount_sats) AS total_rained_sats
FROM rains
GROUP BY sender_id;

CREATE OR REPLACE VIEW user_tip_stats AS
SELECT 
  sender_id AS discord_id,
  SUM(amount_sats) AS total_tipped_sats
FROM tips
GROUP BY sender_id;

CREATE TABLE IF NOT EXISTS bot_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id BIGSERIAL PRIMARY KEY,
  transaction_id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  amount_sats DOUBLE PRECISION NOT NULL,
  sender_id TEXT,
  receiver_id TEXT,
  sender_balance_sats DOUBLE PRECISION,
  receiver_balance_sats DOUBLE PRECISION,
  guild_id TEXT,
  reference_type TEXT,
  reference_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ledger_entries_type ON ledger_entries(type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_sender ON ledger_entries(sender_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_receiver ON ledger_entries(receiver_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_guild ON ledger_entries(guild_id, created_at DESC);

