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
