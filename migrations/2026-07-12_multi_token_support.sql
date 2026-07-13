-- Multi-token balances and token-aware transactional records.
CREATE TABLE IF NOT EXISTS user_token_balances (
  discord_id TEXT NOT NULL REFERENCES users(discord_id) ON DELETE CASCADE,
  token TEXT NOT NULL CHECK (token IN ('MUSD', 'MEZO', 'MUSDC')),
  balance DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (discord_id, token)
);

CREATE TABLE IF NOT EXISTS deposit_token_balances (
  discord_id TEXT NOT NULL REFERENCES deposit_addresses(discord_id) ON DELETE CASCADE,
  token TEXT NOT NULL CHECK (token IN ('MUSD', 'MEZO', 'MUSDC')),
  last_checked_balance TEXT NOT NULL DEFAULT '0',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (discord_id, token)
);

CREATE OR REPLACE FUNCTION add_token_balance(p_discord_id TEXT, p_token TEXT, p_amount DOUBLE PRECISION)
RETURNS VOID AS $$
BEGIN
  IF p_token NOT IN ('MUSD', 'MEZO', 'MUSDC') OR p_amount <= 0 THEN RAISE EXCEPTION 'invalid token or amount'; END IF;
  INSERT INTO users(discord_id) VALUES (p_discord_id) ON CONFLICT (discord_id) DO NOTHING;
  INSERT INTO user_token_balances(discord_id, token, balance)
  VALUES (p_discord_id, p_token, p_amount)
  ON CONFLICT (discord_id, token) DO UPDATE
    SET balance = user_token_balances.balance + EXCLUDED.balance, updated_at = now();
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION subtract_token_balance_if_sufficient(p_discord_id TEXT, p_token TEXT, p_amount DOUBLE PRECISION)
RETURNS BOOLEAN AS $$
DECLARE changed INTEGER;
BEGIN
  IF p_token NOT IN ('MUSD', 'MEZO', 'MUSDC') OR p_amount <= 0 THEN RETURN FALSE; END IF;
  UPDATE user_token_balances SET balance = balance - p_amount, updated_at = now()
  WHERE discord_id = p_discord_id AND token = p_token AND balance >= p_amount;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION credit_token_deposit(
  p_discord_id TEXT, p_token TEXT, p_expected_balance TEXT, p_observed_balance TEXT,
  p_amount DOUBLE PRECISION, p_tx_hash TEXT
) RETURNS BOOLEAN AS $$
DECLARE changed INTEGER;
BEGIN
  IF p_token NOT IN ('MUSD', 'MEZO', 'MUSDC') OR p_amount <= 0 THEN RETURN FALSE; END IF;
  INSERT INTO users(discord_id) VALUES(p_discord_id) ON CONFLICT(discord_id) DO NOTHING;
  INSERT INTO deposit_token_balances(discord_id,token,last_checked_balance)
  VALUES(p_discord_id,p_token,'0') ON CONFLICT(discord_id,token) DO NOTHING;
  UPDATE deposit_token_balances SET last_checked_balance=p_observed_balance,updated_at=now()
  WHERE discord_id=p_discord_id AND token=p_token AND last_checked_balance=p_expected_balance;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN RETURN FALSE; END IF;
  INSERT INTO deposits(discord_id,tx_hash,amount_sats,block_number,token)
  VALUES(p_discord_id,p_tx_hash,p_amount,0,p_token);
  PERFORM add_token_balance(p_discord_id,p_token,p_amount);
  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE deposits ADD COLUMN IF NOT EXISTS token TEXT NOT NULL DEFAULT 'SATS';
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS token TEXT NOT NULL DEFAULT 'SATS';
ALTER TABLE tips ADD COLUMN IF NOT EXISTS token TEXT NOT NULL DEFAULT 'SATS';
ALTER TABLE rains ADD COLUMN IF NOT EXISTS token TEXT NOT NULL DEFAULT 'SATS';
ALTER TABLE drops ADD COLUMN IF NOT EXISTS token TEXT NOT NULL DEFAULT 'SATS';
ALTER TABLE drop_claims ADD COLUMN IF NOT EXISTS token TEXT NOT NULL DEFAULT 'SATS';
ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS token TEXT NOT NULL DEFAULT 'SATS';
ALTER TABLE event_quests ADD COLUMN IF NOT EXISTS token TEXT NOT NULL DEFAULT 'SATS';
ALTER TABLE quests ADD COLUMN IF NOT EXISTS token TEXT NOT NULL DEFAULT 'SATS';

CREATE INDEX IF NOT EXISTS idx_user_token_balances_user ON user_token_balances(discord_id);
CREATE INDEX IF NOT EXISTS idx_deposit_token_balances_user ON deposit_token_balances(discord_id);

-- Existing achievements are denominated in sats; other token activity must not
-- be interpreted as a sats amount when calculating badge thresholds.
CREATE OR REPLACE VIEW user_rain_stats AS
SELECT sender_id AS discord_id, SUM(amount_sats) AS total_rained_sats
FROM rains WHERE token = 'SATS' GROUP BY sender_id;

CREATE OR REPLACE VIEW user_tip_stats AS
SELECT sender_id AS discord_id, SUM(amount_sats) AS total_tipped_sats
FROM tips WHERE token = 'SATS' GROUP BY sender_id;

CREATE OR REPLACE FUNCTION claim_drop_atomic(
  p_drop_id BIGINT, p_claimant_id TEXT,
  p_claimant_role_ids TEXT[] DEFAULT ARRAY[]::TEXT[],
  p_claimant_multiplier INTEGER DEFAULT 1,
  p_creator_allows_multi BOOLEAN DEFAULT FALSE
) RETURNS JSONB AS $claim_drop_atomic$
DECLARE
  d drops%ROWTYPE; inserted_claim_id BIGINT; new_count INTEGER;
  claim_units INTEGER := 1; claim_amount DOUBLE PRECISION := 0;
BEGIN
  SELECT * INTO d FROM drops WHERE id = p_drop_id FOR UPDATE;
  IF NOT FOUND OR d.status <> 'active' OR d.claims_count >= d.max_claims THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'drop_inactive');
  END IF;
  IF d.creator_id = p_claimant_id THEN RETURN jsonb_build_object('ok', false, 'reason', 'own_drop'); END IF;
  IF d.eligible_role_id IS NOT NULL AND NOT (d.eligible_role_id = ANY(COALESCE(p_claimant_role_ids, ARRAY[]::TEXT[]))) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'ineligible_role', 'eligible_role_id', d.eligible_role_id);
  END IF;
  claim_units := CASE WHEN p_creator_allows_multi AND p_claimant_multiplier >= 2 THEN 2 ELSE 1 END;
  IF d.claims_count + claim_units > d.max_claims THEN RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_remaining'); END IF;
  claim_amount := d.per_claim_sats * claim_units;
  INSERT INTO drop_claims(drop_id, claimant_id, amount_sats, token)
  VALUES (p_drop_id, p_claimant_id, claim_amount, d.token)
  ON CONFLICT (drop_id, claimant_id) DO NOTHING RETURNING id INTO inserted_claim_id;
  IF inserted_claim_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'already_claimed'); END IF;
  new_count := d.claims_count + claim_units;
  UPDATE drops SET claims_count = new_count, status = CASE WHEN new_count >= max_claims THEN 'completed' ELSE status END WHERE id = p_drop_id;
  INSERT INTO users(discord_id) VALUES (p_claimant_id) ON CONFLICT (discord_id) DO NOTHING;
  IF d.token = 'SATS' THEN
    UPDATE users SET balance_sats = balance_sats + claim_amount, updated_at = now() WHERE discord_id = p_claimant_id;
  ELSE
    INSERT INTO user_token_balances(discord_id, token, balance) VALUES (p_claimant_id, d.token, claim_amount)
    ON CONFLICT (discord_id, token) DO UPDATE SET balance = user_token_balances.balance + EXCLUDED.balance, updated_at = now();
  END IF;
  INSERT INTO rains(sender_id, amount_sats, recipient_count, token) VALUES (d.creator_id, claim_amount, 1, d.token);
  RETURN jsonb_build_object('ok', true, 'claim_id', inserted_claim_id, 'new_count', new_count,
    'remaining', GREATEST(d.max_claims - new_count, 0), 'completed', new_count >= d.max_claims,
    'amount_sats', claim_amount, 'claim_units', claim_units, 'creator_id', d.creator_id, 'token', d.token);
END;
$claim_drop_atomic$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION claim_event_quest_reward_token(
  p_quest_id BIGINT, p_user_id TEXT, p_reward_multiplier INTEGER DEFAULT 1
) RETURNS BOOLEAN AS $$
DECLARE q event_quests%ROWTYPE; a event_quest_attendance%ROWTYPE; payout DOUBLE PRECISION;
BEGIN
  SELECT * INTO q FROM event_quests WHERE id = p_quest_id FOR UPDATE;
  IF NOT FOUND OR q.status <> 'active' OR q.token = 'SATS' THEN RETURN FALSE; END IF;
  SELECT * INTO a FROM event_quest_attendance WHERE quest_id = p_quest_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND OR a.rewarded_at IS NOT NULL OR a.qualified_at IS NULL THEN RETURN FALSE; END IF;
  IF q.max_rewards IS NOT NULL AND q.rewards_count >= q.max_rewards THEN RETURN FALSE; END IF;
  payout := q.reward_sats * CASE WHEN p_reward_multiplier >= 2 THEN 2 ELSE 1 END;
  IF NOT subtract_token_balance_if_sufficient(q.creator_id, q.token, payout) THEN
    UPDATE event_quests SET status = 'exhausted', completed_at = COALESCE(completed_at, now()) WHERE id = p_quest_id;
    RETURN FALSE;
  END IF;
  PERFORM add_token_balance(p_user_id, q.token, payout);
  UPDATE event_quest_attendance SET rewarded_at = now(), reward_sats = payout WHERE quest_id = p_quest_id AND user_id = p_user_id;
  UPDATE event_quests SET rewards_count = rewards_count + 1,
    status = CASE WHEN max_rewards IS NOT NULL AND rewards_count + 1 >= max_rewards THEN 'completed' ELSE status END,
    completed_at = CASE WHEN max_rewards IS NOT NULL AND rewards_count + 1 >= max_rewards THEN now() ELSE completed_at END
  WHERE id = p_quest_id;
  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION complete_quest_task_and_pay_delta_token(
  p_quest_id BIGINT, p_task_id BIGINT, p_user_id TEXT, p_proof JSONB DEFAULT '{}'::jsonb,
  p_reward_multiplier INTEGER DEFAULT 1
) RETURNS JSONB AS $$
DECLARE q quests%ROWTYPE; inserted_completion BOOLEAN := FALSE; inserted_count INTEGER := 0; completion_count INTEGER := 0;
  tier_reward DOUBLE PRECISION := 0; previous_tier_reward DOUBLE PRECISION := 0; previous_paid DOUBLE PRECISION := 0; reward_delta DOUBLE PRECISION := 0;
  payout DOUBLE PRECISION := 0;
BEGIN
  SELECT * INTO q FROM quests WHERE id = p_quest_id FOR UPDATE;
  IF NOT FOUND OR q.status <> 'active' OR q.token = 'SATS' THEN RETURN jsonb_build_object('ok', false, 'reason', 'quest_inactive'); END IF;
  IF q.starts_at IS NOT NULL AND now() < q.starts_at THEN RETURN jsonb_build_object('ok', false, 'reason', 'quest_not_started'); END IF;
  IF q.ends_at IS NOT NULL AND now() > q.ends_at THEN
    UPDATE quests SET status='completed', completed_at=COALESCE(completed_at,now()), updated_at=now() WHERE id=q.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'quest_ended');
  END IF;
  IF NOT EXISTS(SELECT 1 FROM quest_tasks WHERE id=p_task_id AND quest_id=p_quest_id AND status='active') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'task_not_found');
  END IF;
  INSERT INTO quest_task_completions(quest_id,task_id,user_id,proof) VALUES(p_quest_id,p_task_id,p_user_id,COALESCE(p_proof,'{}'::jsonb))
  ON CONFLICT(task_id,user_id) DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  inserted_completion := inserted_count > 0;
  SELECT COUNT(*) INTO completion_count FROM quest_task_completions c JOIN quest_tasks t ON t.id=c.task_id
    WHERE c.quest_id=p_quest_id AND c.user_id=p_user_id AND t.status='active';
  SELECT COALESCE(MAX(reward_sats),0) INTO tier_reward FROM quest_reward_tiers
    WHERE quest_id=p_quest_id AND completed_task_count<=completion_count;
  SELECT COALESCE(paid_sats,0), COALESCE(total_reward_sats,0) INTO previous_paid, previous_tier_reward
    FROM quest_user_rewards WHERE quest_id=p_quest_id AND user_id=p_user_id FOR UPDATE;
  reward_delta := GREATEST(tier_reward-previous_tier_reward,0);
  payout := reward_delta * CASE WHEN p_reward_multiplier>=2 THEN 2 ELSE 1 END;
  IF payout > 0 AND NOT subtract_token_balance_if_sufficient(q.creator_id,q.token,payout) THEN
    UPDATE quests SET status='exhausted',completed_at=COALESCE(completed_at,now()),updated_at=now() WHERE id=q.id;
    RETURN jsonb_build_object('ok',false,'reason','insufficient_creator_balance','insertedCompletion',inserted_completion,
      'completedTaskCount',completion_count,'tierRewardSats',tier_reward,'previousPaidSats',previous_paid,'rewardDeltaSats',payout);
  END IF;
  IF payout > 0 THEN PERFORM add_token_balance(p_user_id,q.token,payout); END IF;
  INSERT INTO quest_user_rewards(quest_id,user_id,completed_task_count,total_reward_sats,paid_sats,last_paid_at,updated_at)
  VALUES(p_quest_id,p_user_id,completion_count,tier_reward,previous_paid+payout,CASE WHEN payout>0 THEN now() END,now())
  ON CONFLICT(quest_id,user_id) DO UPDATE SET completed_task_count=EXCLUDED.completed_task_count,
    total_reward_sats=EXCLUDED.total_reward_sats,paid_sats=EXCLUDED.paid_sats,
    last_paid_at=COALESCE(EXCLUDED.last_paid_at,quest_user_rewards.last_paid_at),updated_at=now();
  IF payout>0 THEN INSERT INTO quest_reward_events(quest_id,user_id,reward_delta_sats,total_paid_sats,completed_task_count,reason)
    VALUES(p_quest_id,p_user_id,payout,previous_paid+payout,completion_count,'tier_delta'); END IF;
  RETURN jsonb_build_object('ok',true,'insertedCompletion',inserted_completion,'completedTaskCount',completion_count,
    'tierRewardSats',tier_reward,'previousPaidSats',previous_paid,'rewardDeltaSats',payout,'totalPaidSats',previous_paid+payout);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION pay_repeatable_quest_task_reward_token(
  p_quest_id BIGINT,p_task_id BIGINT,p_user_id TEXT,p_proof JSONB DEFAULT '{}'::jsonb,p_reward_multiplier INTEGER DEFAULT 1
) RETURNS JSONB AS $$
DECLARE q quests%ROWTYPE; base_reward DOUBLE PRECISION := 0; payout DOUBLE PRECISION := 0; previous_paid DOUBLE PRECISION := 0;
BEGIN
  SELECT * INTO q FROM quests WHERE id=p_quest_id FOR UPDATE;
  IF NOT FOUND OR q.status<>'active' OR q.token='SATS' THEN RETURN jsonb_build_object('ok',false,'reason','quest_inactive'); END IF;
  IF NOT EXISTS(SELECT 1 FROM quest_tasks WHERE id=p_task_id AND quest_id=p_quest_id AND status='active') THEN RETURN jsonb_build_object('ok',false,'reason','task_not_found'); END IF;
  SELECT COALESCE(MAX(reward_sats),0) INTO base_reward FROM quest_reward_tiers WHERE quest_id=p_quest_id AND completed_task_count<=1;
  payout := base_reward * CASE WHEN p_reward_multiplier>=2 THEN 2 ELSE 1 END;
  SELECT COALESCE(paid_sats,0) INTO previous_paid FROM quest_user_rewards WHERE quest_id=p_quest_id AND user_id=p_user_id;
  SELECT previous_paid+COALESCE(SUM(reward_delta_sats),0) INTO previous_paid FROM quest_reward_events
    WHERE quest_id=p_quest_id AND user_id=p_user_id AND reason='repeatable_task';
  IF payout<=0 THEN RETURN jsonb_build_object('ok',false,'reason','reward_not_configured'); END IF;
  IF NOT subtract_token_balance_if_sufficient(q.creator_id,q.token,payout) THEN
    UPDATE quests SET status='exhausted',completed_at=COALESCE(completed_at,now()),updated_at=now() WHERE id=q.id;
    RETURN jsonb_build_object('ok',false,'reason','insufficient_creator_balance','rewardDeltaSats',payout);
  END IF;
  PERFORM add_token_balance(p_user_id,q.token,payout);
  INSERT INTO quest_reward_events(quest_id,user_id,reward_delta_sats,total_paid_sats,completed_task_count,reason)
    VALUES(p_quest_id,p_user_id,payout,previous_paid+payout,1,'repeatable_task');
  RETURN jsonb_build_object('ok',true,'insertedCompletion',false,'completedTaskCount',1,'tierRewardSats',base_reward,
    'previousPaidSats',previous_paid,'rewardDeltaSats',payout,'totalPaidSats',previous_paid+payout);
END;
$$ LANGUAGE plpgsql;
