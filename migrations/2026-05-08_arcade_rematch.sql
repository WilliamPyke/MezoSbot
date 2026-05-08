-- Migration: arcade rematch chains + series score
-- Idempotent — safe to re-run.

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

-- Backfill series_root_id for existing rows: their root is themselves.
UPDATE arcade_matches
  SET series_root_id = id
  WHERE series_root_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_arcade_matches_series_root
  ON arcade_matches(series_root_id);

CREATE INDEX IF NOT EXISTS idx_arcade_matches_rematch_of
  ON arcade_matches(rematch_of_match_id);

-- Wallet sessions get the same rematch chain
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

UPDATE web_arcade_sessions
  SET series_root_session_id = id
  WHERE series_root_session_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_web_arcade_sessions_series_root
  ON web_arcade_sessions(series_root_session_id);

