-- SatScape: authored town territories + fog of war.
--
-- Towns, terrain palettes, keepers and item catalogues are all code-side
-- (src/satscape/towns.ts) and computed deterministically — nothing to store.
-- The only new persistent state is each player's revealed (explored) tiles.

CREATE TABLE IF NOT EXISTS sat_explored (
  discord_id TEXT NOT NULL REFERENCES sat_players(discord_id) ON DELETE CASCADE,
  x          INTEGER NOT NULL,
  y          INTEGER NOT NULL,
  PRIMARY KEY (discord_id, x, y)
);
-- PK already indexes (discord_id, x, y); add an index for box queries by player.
CREATE INDEX IF NOT EXISTS idx_sat_explored_player ON sat_explored (discord_id, x, y);
