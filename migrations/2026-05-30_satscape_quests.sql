-- SatScape: keeper quests + reputation.
--
-- Quest definitions live in code (src/satscape/quests.ts). We persist only each
-- player's accepted-quest progress and their per-keeper reputation. Reputation
-- drives shop discounts and gear unlocks; titles are derived from claimed
-- quests, so they need no storage.

CREATE TABLE IF NOT EXISTS sat_player_quests (
  discord_id    TEXT NOT NULL REFERENCES sat_players(discord_id) ON DELETE CASCADE,
  quest_key     TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active', -- active | claimable | claimed
  progress      INTEGER NOT NULL DEFAULT 0,
  progress_base INTEGER NOT NULL DEFAULT 0,     -- baseline for cartography (explored-tile count at accept)
  accepted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (discord_id, quest_key)
);

CREATE TABLE IF NOT EXISTS sat_keeper_rep (
  discord_id TEXT NOT NULL REFERENCES sat_players(discord_id) ON DELETE CASCADE,
  town_id    TEXT NOT NULL,
  rep        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (discord_id, town_id)
);
