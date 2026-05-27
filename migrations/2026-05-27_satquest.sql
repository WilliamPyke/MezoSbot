-- SatQuest: procedurally-generated grid RPG.
--
-- HP *is* the player's withdrawable balance (users.balance_sats). There is no
-- separate game-HP. The economy is a closed loop over the real ledger — sats
-- are never minted:
--   buy-in / combat damage / starvation  --> sat_prize_pool
--   sat_prize_pool                        --> chest & monster rewards (capped)
-- Total sats are conserved end to end.

CREATE TABLE IF NOT EXISTS sat_players (
  discord_id      TEXT PRIMARY KEY REFERENCES users(discord_id) ON DELETE CASCADE,
  avatar_id       TEXT NOT NULL DEFAULT 'default_adventurer',
  x_coord         INTEGER NOT NULL DEFAULT 0,
  y_coord         INTEGER NOT NULL DEFAULT 0,
  hunger          INTEGER NOT NULL DEFAULT 100 CHECK (hunger BETWEEN 0 AND 100),
  display_max_hp  DOUBLE PRECISION NOT NULL DEFAULT 0, -- high-water mark, HP bar reference only
  state           TEXT NOT NULL DEFAULT 'idle',        -- idle | combat | fainted
  active          BOOLEAN NOT NULL DEFAULT false,      -- true once buy-in is paid
  last_move_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sat_players_coords ON sat_players (x_coord, y_coord);

CREATE TABLE IF NOT EXISTS sat_inventories (
  id         BIGSERIAL PRIMARY KEY,
  discord_id TEXT NOT NULL REFERENCES sat_players(discord_id) ON DELETE CASCADE,
  item_id    TEXT NOT NULL,
  quantity   INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  UNIQUE (discord_id, item_id)
);

-- One active fight per player (PK on discord_id).
CREATE TABLE IF NOT EXISTS sat_combat_sessions (
  discord_id         TEXT PRIMARY KEY REFERENCES sat_players(discord_id) ON DELETE CASCADE,
  monster_name       TEXT NOT NULL,
  monster_max_hp     INTEGER NOT NULL,
  monster_current_hp INTEGER NOT NULL,
  monster_attack     INTEGER NOT NULL,
  reward_sats        INTEGER NOT NULL, -- intended payout, clamped to pool on win
  enemy_x            INTEGER NOT NULL,
  enemy_y            INTEGER NOT NULL,
  turn_number        INTEGER NOT NULL DEFAULT 1,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Only CONSUMABLE entities are stored. Terrain/biome is computed deterministically
-- from coordinates and never persisted. A consumed tile keeps a 'cleared'
-- tombstone row so the deterministic spawn roll can't re-spawn it.
CREATE TABLE IF NOT EXISTS sat_world_entities (
  id          BIGSERIAL PRIMARY KEY,
  x           INTEGER NOT NULL,
  y           INTEGER NOT NULL,
  entity_type TEXT NOT NULL,            -- 'chest' | 'monster' | 'cleared'
  entity_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (x, y)
);

CREATE TABLE IF NOT EXISTS sat_prize_pool (
  id           INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  balance_sats DOUBLE PRECISION NOT NULL DEFAULT 0
);
INSERT INTO sat_prize_pool (id, balance_sats) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;

-- Atomic: drain up to p_dmg sats from a player into the prize pool. Row-locks
-- the user so concurrent fights / a racing withdrawal can't double-spend.
-- Returns the sats actually taken (<= balance, never makes balance negative).
CREATE OR REPLACE FUNCTION satquest_take_damage(p_discord_id TEXT, p_dmg INTEGER)
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE bal DOUBLE PRECISION; taken INTEGER;
BEGIN
  SELECT balance_sats INTO bal FROM users WHERE discord_id = p_discord_id FOR UPDATE;
  IF bal IS NULL THEN RETURN 0; END IF;
  taken := FLOOR(LEAST(p_dmg, GREATEST(bal, 0)))::INTEGER;
  IF taken > 0 THEN
    UPDATE users SET balance_sats = balance_sats - taken WHERE discord_id = p_discord_id;
    UPDATE sat_prize_pool SET balance_sats = balance_sats + taken WHERE id = 1;
  END IF;
  RETURN taken;
END $$;

-- Atomic: pay out up to p_requested sats from the pool to a player. Clamped to
-- the pool balance — closed loop, never overdraws, never mints.
CREATE OR REPLACE FUNCTION satquest_pool_payout(p_discord_id TEXT, p_requested INTEGER)
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE pool DOUBLE PRECISION; granted INTEGER;
BEGIN
  SELECT balance_sats INTO pool FROM sat_prize_pool WHERE id = 1 FOR UPDATE;
  granted := FLOOR(LEAST(p_requested, GREATEST(pool, 0)))::INTEGER;
  IF granted > 0 THEN
    UPDATE sat_prize_pool SET balance_sats = balance_sats - granted WHERE id = 1;
    PERFORM add_balance(p_discord_id, granted);
  END IF;
  RETURN granted;
END $$;

-- Seed the pool (used by the buy-in).
CREATE OR REPLACE FUNCTION satquest_pool_add(p_amount INTEGER)
RETURNS VOID LANGUAGE sql AS $$
  UPDATE sat_prize_pool SET balance_sats = balance_sats + p_amount WHERE id = 1;
$$;
