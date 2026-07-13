-- Durable imgnAI Katana model cache, per-guild controls, jobs, and x402 operations.
CREATE TABLE IF NOT EXISTS imgnai_models (
  model_key TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  creator TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL,
  is_legacy BOOLEAN NOT NULL DEFAULT FALSE,
  supports_uhd BOOLEAN NOT NULL DEFAULT FALSE,
  supported_aspect_ratios JSONB NOT NULL DEFAULT '[]'::jsonb,
  cost_musd DOUBLE PRECISION NOT NULL CHECK (cost_musd > 0),
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS guild_imgnai_disabled_models (
  guild_id TEXT NOT NULL,
  model_key TEXT NOT NULL,
  disabled_by TEXT,
  disabled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, model_key)
);

CREATE TABLE IF NOT EXISTS imgnai_generation_jobs (
  id UUID PRIMARY KEY,
  discord_id TEXT NOT NULL REFERENCES users(discord_id) ON DELETE RESTRICT,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  status_message_id TEXT,
  prompt TEXT,
  prompt_hash TEXT NOT NULL,
  model_key TEXT NOT NULL,
  model_display_name TEXT NOT NULL,
  aspect_ratio TEXT NOT NULL,
  quality TEXT NOT NULL CHECK (quality IN ('standard', 'uhd')),
  quoted_musd DOUBLE PRECISION NOT NULL CHECK (quoted_musd > 0),
  final_musd DOUBLE PRECISION,
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN (
    'reserved','funding','submitted','polling','delivery_pending','completed',
    'failed_unpaid','refund_pending','refunded','policy_failed','inconclusive'
  )),
  katana_request_id TEXT UNIQUE,
  settlement_tx TEXT,
  output_url TEXT,
  output_expires_at TIMESTAMPTZ,
  output_width INTEGER,
  output_height INTEGER,
  error_code TEXT,
  error_message TEXT,
  delivery_attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ,
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  refunded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_imgnai_jobs_recovery
  ON imgnai_generation_jobs(status, next_retry_at, updated_at);
CREATE INDEX IF NOT EXISTS idx_imgnai_jobs_user
  ON imgnai_generation_jobs(discord_id, created_at DESC);

CREATE TABLE IF NOT EXISTS imgnai_x402_operations (
  id UUID PRIMARY KEY,
  operation_type TEXT NOT NULL CHECK (operation_type IN ('topup','refund')),
  idempotency_key TEXT NOT NULL UNIQUE,
  amount_musd DOUBLE PRECISION NOT NULL CHECK (amount_musd >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending','completed','failed')),
  wallet_address TEXT,
  network TEXT,
  asset TEXT,
  transaction_id TEXT,
  error_message TEXT,
  response JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION reserve_imgnai_generation(
  p_job_id UUID, p_discord_id TEXT, p_guild_id TEXT, p_channel_id TEXT,
  p_prompt TEXT, p_prompt_hash TEXT, p_model_key TEXT, p_model_display_name TEXT,
  p_aspect_ratio TEXT, p_quality TEXT, p_amount DOUBLE PRECISION
) RETURNS BOOLEAN AS $$
DECLARE changed INTEGER;
BEGIN
  IF p_amount <= 0 OR p_quality NOT IN ('standard','uhd') THEN RETURN FALSE; END IF;
  INSERT INTO users(discord_id) VALUES (p_discord_id) ON CONFLICT(discord_id) DO NOTHING;
  UPDATE user_token_balances
    SET balance = balance - p_amount, updated_at = now()
    WHERE discord_id = p_discord_id AND token = 'MUSD' AND balance >= p_amount;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN RETURN FALSE; END IF;
  INSERT INTO imgnai_generation_jobs(
    id, discord_id, guild_id, channel_id, prompt, prompt_hash, model_key,
    model_display_name, aspect_ratio, quality, quoted_musd
  ) VALUES (
    p_job_id, p_discord_id, p_guild_id, p_channel_id, p_prompt, p_prompt_hash,
    p_model_key, p_model_display_name, p_aspect_ratio, p_quality, p_amount
  );
  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION refund_imgnai_generation(p_job_id UUID, p_reason TEXT)
RETURNS BOOLEAN AS $$
DECLARE job imgnai_generation_jobs%ROWTYPE;
BEGIN
  SELECT * INTO job FROM imgnai_generation_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND OR job.refunded_at IS NOT NULL OR job.status = 'completed' THEN RETURN FALSE; END IF;
  INSERT INTO user_token_balances(discord_id, token, balance)
    VALUES(job.discord_id, 'MUSD', job.quoted_musd)
    ON CONFLICT(discord_id, token) DO UPDATE
      SET balance = user_token_balances.balance + EXCLUDED.balance, updated_at = now();
  UPDATE imgnai_generation_jobs SET
    status = 'refunded', refunded_at = now(), error_message = COALESCE(p_reason, error_message), updated_at = now()
    WHERE id = p_job_id;
  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION complete_imgnai_generation(p_job_id UUID, p_final_musd DOUBLE PRECISION)
RETURNS BOOLEAN AS $$
DECLARE changed INTEGER;
BEGIN
  UPDATE imgnai_generation_jobs SET
    status = 'completed', final_musd = LEAST(p_final_musd, quoted_musd), completed_at = now(), updated_at = now()
    WHERE id = p_job_id AND status = 'delivery_pending' AND refunded_at IS NULL;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END;
$$ LANGUAGE plpgsql;
