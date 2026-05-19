-- Migration: Badges and Leaderboards
-- Creates tables for tips, rains, and badge configurations, plus views for aggregates.

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
  role_id TEXT,                      -- Discord role ID (nullable)
  UNIQUE(guild_id, badge_type, threshold_sats)
);
CREATE INDEX IF NOT EXISTS idx_badge_roles_guild ON badge_roles(guild_id);

CREATE OR REPLACE VIEW user_rain_stats AS
SELECT 
  creator_id AS discord_id,
  SUM(amount_sats) AS total_rained_sats
FROM (
  SELECT sender_id AS creator_id, amount_sats FROM rains
  UNION ALL
  SELECT d.creator_id, dc.amount_sats FROM drops d JOIN drop_claims dc ON d.id = dc.drop_id
) AS combined
GROUP BY creator_id;

CREATE OR REPLACE VIEW user_tip_stats AS
SELECT 
  sender_id AS discord_id,
  SUM(amount_sats) AS total_tipped_sats
FROM tips
GROUP BY sender_id;
