CREATE TABLE IF NOT EXISTS developer_relay_routes (
  guild_id TEXT NOT NULL,
  discord_id TEXT NOT NULL,
  developer_channel_id TEXT NOT NULL,
  private_thread_id TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, discord_id)
);

CREATE INDEX IF NOT EXISTS idx_developer_relay_routes_discord
  ON developer_relay_routes (discord_id)
  WHERE enabled = TRUE;

CREATE TABLE IF NOT EXISTS developer_relay_deliveries (
  source_message_id TEXT PRIMARY KEY,
  discord_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  destination_type TEXT NOT NULL CHECK (destination_type IN ('channel', 'thread')),
  destination_channel_id TEXT NOT NULL,
  forwarded_message_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_developer_relay_deliveries_user_created
  ON developer_relay_deliveries (discord_id, created_at DESC);
