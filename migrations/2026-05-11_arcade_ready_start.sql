-- Ready-gated arcade starts plus settlement lock state.

ALTER TABLE arcade_matches
  ADD COLUMN IF NOT EXISTS player_a_ready BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE arcade_matches
  ADD COLUMN IF NOT EXISTS player_b_ready BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE arcade_matches
  ADD COLUMN IF NOT EXISTS countdown_started_at TIMESTAMPTZ;

ALTER TABLE web_arcade_sessions
  ADD COLUMN IF NOT EXISTS player_a_ready BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE web_arcade_sessions
  ADD COLUMN IF NOT EXISTS player_b_ready BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE web_arcade_sessions
  ADD COLUMN IF NOT EXISTS countdown_started_at TIMESTAMPTZ;
