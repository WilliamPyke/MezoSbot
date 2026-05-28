-- SatScape tactical monster battles.
--
-- enemy_x/enemy_y remain the monster's world tile. These columns track the
-- temporary 8x8 arena positions used while a combat session is active.

ALTER TABLE sat_combat_sessions ADD COLUMN IF NOT EXISTS player_battle_x  INTEGER NOT NULL DEFAULT 3;
ALTER TABLE sat_combat_sessions ADD COLUMN IF NOT EXISTS player_battle_y  INTEGER NOT NULL DEFAULT 6;
ALTER TABLE sat_combat_sessions ADD COLUMN IF NOT EXISTS monster_battle_x INTEGER NOT NULL DEFAULT 4;
ALTER TABLE sat_combat_sessions ADD COLUMN IF NOT EXISTS monster_battle_y INTEGER NOT NULL DEFAULT 1;
