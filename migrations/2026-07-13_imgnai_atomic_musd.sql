-- Exact MUSD accounting for Katana and user balances.
-- MUSD uses 18 decimal atomic units. Legacy DOUBLE PRECISION columns remain as
-- display/compatibility mirrors while all Katana reservations use atomic values.

ALTER TABLE user_token_balances
  ADD COLUMN IF NOT EXISTS balance_atomic NUMERIC(78, 0);

UPDATE user_token_balances
SET balance_atomic = ROUND(balance::numeric * 1000000000000000000::numeric)
WHERE token = 'MUSD' AND balance_atomic IS NULL;

UPDATE user_token_balances
SET balance_atomic = 0
WHERE balance_atomic IS NULL;

ALTER TABLE user_token_balances
  ALTER COLUMN balance_atomic SET DEFAULT 0,
  ALTER COLUMN balance_atomic SET NOT NULL;

DO $$ BEGIN
  ALTER TABLE user_token_balances
    ADD CONSTRAINT user_token_balances_atomic_nonnegative CHECK (balance_atomic >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Keep legacy callers operational while making atomic MUSD authoritative for
-- payment code. Updating either representation updates the other in one row lock.
CREATE OR REPLACE FUNCTION sync_musd_balance_atomic()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.token <> 'MUSD' THEN RETURN NEW; END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.balance_atomic <> 0 OR NEW.balance = 0 THEN
      NEW.balance := (NEW.balance_atomic / 1000000000000000000::numeric)::double precision;
    ELSE
      NEW.balance_atomic := ROUND(NEW.balance::numeric * 1000000000000000000::numeric);
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.balance_atomic IS DISTINCT FROM OLD.balance_atomic
     AND NEW.balance IS NOT DISTINCT FROM OLD.balance THEN
    NEW.balance := (NEW.balance_atomic / 1000000000000000000::numeric)::double precision;
  ELSIF NEW.balance IS DISTINCT FROM OLD.balance
        AND NEW.balance_atomic IS NOT DISTINCT FROM OLD.balance_atomic THEN
    NEW.balance_atomic := ROUND(NEW.balance::numeric * 1000000000000000000::numeric);
  ELSIF NEW.balance_atomic IS DISTINCT FROM OLD.balance_atomic THEN
    -- If a new caller supplies both, atomic units win.
    NEW.balance := (NEW.balance_atomic / 1000000000000000000::numeric)::double precision;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_musd_balance_atomic ON user_token_balances;
CREATE TRIGGER trg_sync_musd_balance_atomic
BEFORE INSERT OR UPDATE ON user_token_balances
FOR EACH ROW EXECUTE FUNCTION sync_musd_balance_atomic();

-- Credit observed on-chain MUSD without converting its 18-decimal units through
-- JavaScript Number/DOUBLE PRECISION. The legacy deposits amount is a display mirror.
CREATE OR REPLACE FUNCTION credit_musd_deposit_atomic(
  p_discord_id TEXT, p_expected_balance TEXT, p_observed_balance TEXT,
  p_amount_atomic NUMERIC, p_tx_hash TEXT
) RETURNS BOOLEAN AS $$
DECLARE changed INTEGER;
BEGIN
  IF p_amount_atomic <= 0 OR p_amount_atomic <> TRUNC(p_amount_atomic) THEN RETURN FALSE; END IF;
  INSERT INTO users(discord_id) VALUES(p_discord_id) ON CONFLICT(discord_id) DO NOTHING;
  INSERT INTO deposit_token_balances(discord_id,token,last_checked_balance)
  VALUES(p_discord_id,'MUSD','0') ON CONFLICT(discord_id,token) DO NOTHING;
  UPDATE deposit_token_balances SET last_checked_balance=p_observed_balance,updated_at=now()
  WHERE discord_id=p_discord_id AND token='MUSD' AND last_checked_balance=p_expected_balance;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN RETURN FALSE; END IF;
  INSERT INTO deposits(discord_id,tx_hash,amount_sats,block_number,token)
  VALUES(
    p_discord_id, p_tx_hash,
    (p_amount_atomic / 1000000000000000000::numeric)::double precision,
    0, 'MUSD'
  );
  INSERT INTO user_token_balances(discord_id, token, balance_atomic)
  VALUES(p_discord_id, 'MUSD', p_amount_atomic)
  ON CONFLICT(discord_id, token) DO UPDATE
    SET balance_atomic = user_token_balances.balance_atomic + EXCLUDED.balance_atomic,
        updated_at = now();
  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE imgnai_models
  ADD COLUMN IF NOT EXISTS cost_musd_atomic NUMERIC(78, 0);
UPDATE imgnai_models
SET cost_musd_atomic = ROUND(cost_musd::numeric * 1000000000000000000::numeric)
WHERE cost_musd_atomic IS NULL;
ALTER TABLE imgnai_models ALTER COLUMN cost_musd_atomic SET NOT NULL;

ALTER TABLE imgnai_generation_jobs
  ADD COLUMN IF NOT EXISTS quoted_musd_atomic NUMERIC(78, 0),
  ADD COLUMN IF NOT EXISTS final_musd_atomic NUMERIC(78, 0);
UPDATE imgnai_generation_jobs
SET quoted_musd_atomic = ROUND(quoted_musd::numeric * 1000000000000000000::numeric),
    final_musd_atomic = CASE WHEN final_musd IS NULL THEN NULL
      ELSE ROUND(final_musd::numeric * 1000000000000000000::numeric) END
WHERE quoted_musd_atomic IS NULL;
ALTER TABLE imgnai_generation_jobs ALTER COLUMN quoted_musd_atomic SET NOT NULL;

ALTER TABLE imgnai_x402_operations
  ADD COLUMN IF NOT EXISTS amount_musd_atomic NUMERIC(78, 0);
UPDATE imgnai_x402_operations
SET amount_musd_atomic = ROUND(amount_musd::numeric * 1000000000000000000::numeric)
WHERE amount_musd_atomic IS NULL;
ALTER TABLE imgnai_x402_operations ALTER COLUMN amount_musd_atomic SET NOT NULL;

DO $$ BEGIN
  ALTER TABLE imgnai_generation_jobs
    ADD CONSTRAINT imgnai_jobs_atomic_positive CHECK (quoted_musd_atomic > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE imgnai_x402_operations
    ADD CONSTRAINT imgnai_operations_atomic_nonnegative CHECK (amount_musd_atomic >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION reserve_imgnai_generation(
  p_job_id UUID, p_discord_id TEXT, p_guild_id TEXT, p_channel_id TEXT,
  p_prompt TEXT, p_prompt_hash TEXT, p_model_key TEXT, p_model_display_name TEXT,
  p_aspect_ratio TEXT, p_quality TEXT, p_amount_atomic NUMERIC
) RETURNS BOOLEAN AS $$
DECLARE changed INTEGER;
BEGIN
  IF p_amount_atomic <= 0 OR p_amount_atomic <> TRUNC(p_amount_atomic)
     OR p_quality NOT IN ('standard','uhd') THEN RETURN FALSE; END IF;
  INSERT INTO users(discord_id) VALUES (p_discord_id) ON CONFLICT(discord_id) DO NOTHING;
  UPDATE user_token_balances
    SET balance_atomic = balance_atomic - p_amount_atomic, updated_at = now()
    WHERE discord_id = p_discord_id AND token = 'MUSD' AND balance_atomic >= p_amount_atomic;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN RETURN FALSE; END IF;
  INSERT INTO imgnai_generation_jobs(
    id, discord_id, guild_id, channel_id, prompt, prompt_hash, model_key,
    model_display_name, aspect_ratio, quality, quoted_musd, quoted_musd_atomic
  ) VALUES (
    p_job_id, p_discord_id, p_guild_id, p_channel_id, p_prompt, p_prompt_hash,
    p_model_key, p_model_display_name, p_aspect_ratio, p_quality,
    (p_amount_atomic / 1000000000000000000::numeric)::double precision,
    p_amount_atomic
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
  INSERT INTO user_token_balances(discord_id, token, balance_atomic)
    VALUES(job.discord_id, 'MUSD', job.quoted_musd_atomic)
    ON CONFLICT(discord_id, token) DO UPDATE
      SET balance_atomic = user_token_balances.balance_atomic + EXCLUDED.balance_atomic,
          updated_at = now();
  UPDATE imgnai_generation_jobs SET
    status = 'refunded', refunded_at = now(), error_message = COALESCE(p_reason, error_message), updated_at = now()
    WHERE id = p_job_id;
  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION complete_imgnai_generation(p_job_id UUID, p_final_musd_atomic NUMERIC)
RETURNS BOOLEAN AS $$
DECLARE changed INTEGER;
BEGIN
  IF p_final_musd_atomic < 0 OR p_final_musd_atomic <> TRUNC(p_final_musd_atomic) THEN RETURN FALSE; END IF;
  UPDATE imgnai_generation_jobs SET
    status = 'completed',
    final_musd_atomic = LEAST(p_final_musd_atomic, quoted_musd_atomic),
    final_musd = (LEAST(p_final_musd_atomic, quoted_musd_atomic) / 1000000000000000000::numeric)::double precision,
    completed_at = now(), updated_at = now()
    WHERE id = p_job_id AND status = 'delivery_pending' AND refunded_at IS NULL;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END;
$$ LANGUAGE plpgsql;
