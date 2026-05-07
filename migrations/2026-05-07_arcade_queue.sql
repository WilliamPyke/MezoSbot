-- Migration: arcade_queue (global matchmaking)
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS arcade_queue (
  id BIGSERIAL PRIMARY KEY,
  surface TEXT NOT NULL,                          -- 'discord' | 'wallet'
  user_id TEXT NOT NULL,                          -- discord id OR lowercase wallet address
  status TEXT NOT NULL DEFAULT 'waiting',         -- waiting | paired | cancelled | expired
  duration_seconds INTEGER,
  chain_id INTEGER,
  asset_address TEXT,
  stake_amount_units TEXT,
  match_id BIGINT,
  session_id TEXT,
  paired_with TEXT,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paired_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_arcade_queue_active
  ON arcade_queue (surface, user_id) WHERE status = 'waiting';

CREATE INDEX IF NOT EXISTS idx_arcade_queue_waiting
  ON arcade_queue (surface, chain_id, asset_address, stake_amount_units, joined_at)
  WHERE status = 'waiting';

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
