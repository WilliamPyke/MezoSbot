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

CREATE TABLE IF NOT EXISTS deposit_addresses (
  discord_id TEXT PRIMARY KEY,
  address TEXT NOT NULL UNIQUE,
  last_checked_balance TEXT DEFAULT '0'
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

CREATE TABLE IF NOT EXISTS game_saves (
  rom_name   TEXT PRIMARY KEY,
  save_data  TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Slice Arcade PvP — block puzzle head-to-head
CREATE TABLE IF NOT EXISTS arcade_matches (
  id BIGSERIAL PRIMARY KEY,
  seed TEXT NOT NULL,
  mode TEXT NOT NULL,                          -- 'practice' | 'free_pvp' | 'staked_pvp'
  status TEXT NOT NULL DEFAULT 'waiting',      -- waiting | active | submitted | completed | cancelled
  channel_id TEXT,
  message_id TEXT,
  stake_amount_sats DOUBLE PRECISION,
  gross_pot_sats DOUBLE PRECISION,
  platform_rake_bps INTEGER NOT NULL DEFAULT 1000,
  rake_amount_sats DOUBLE PRECISION,
  winner_payout_sats DOUBLE PRECISION,
  created_by_id TEXT NOT NULL,
  player_a_id TEXT NOT NULL,
  player_b_id TEXT,
  player_a_score DOUBLE PRECISION,
  player_b_score DOUBLE PRECISION,
  player_a_submitted BOOLEAN NOT NULL DEFAULT FALSE,
  player_b_submitted BOOLEAN NOT NULL DEFAULT FALSE,
  winner_id TEXT,
  escrow_status TEXT NOT NULL DEFAULT 'none',  -- none | pending | funded | released | refunded
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

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

-- Indexes
CREATE INDEX IF NOT EXISTS idx_links_discord ON links(discord_id);
CREATE INDEX IF NOT EXISTS idx_links_wallet ON links(wallet_address);
CREATE INDEX IF NOT EXISTS idx_deposits_tx ON deposits(tx_hash);
CREATE INDEX IF NOT EXISTS idx_deposits_discord ON deposits(discord_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_discord ON withdrawals(discord_id);
CREATE INDEX IF NOT EXISTS idx_drops_channel ON drops(channel_id);
CREATE INDEX IF NOT EXISTS idx_arcade_matches_status ON arcade_matches(status);
CREATE INDEX IF NOT EXISTS idx_arcade_matches_player_a ON arcade_matches(player_a_id);
CREATE INDEX IF NOT EXISTS idx_arcade_matches_player_b ON arcade_matches(player_b_id);
CREATE INDEX IF NOT EXISTS idx_arcade_submissions_match ON arcade_submissions(match_id);
CREATE INDEX IF NOT EXISTS idx_arcade_escrow_match ON arcade_escrow(match_id);
