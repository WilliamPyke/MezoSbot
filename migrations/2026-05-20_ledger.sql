-- Bot-wide settings and transaction ledger.

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
