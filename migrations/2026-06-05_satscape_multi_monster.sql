-- SatScape multi-monster (chess-like) combat.
--
-- A fight can now contain several monsters at once. They are stored as a JSON
-- array of BattleMonster objects in `monsters`:
--   [{ "id","name","level","maxHp","hp","x","y","attack","reward","status":[] }, ...]
--
-- The legacy singular monster_* columns are KEPT and mirror the "primary" monster
-- (index 0) so any in-flight fight and the Discord embed path keep resolving even
-- before this column is populated. `readMonsters()` falls back to those columns
-- when `monsters` is null/empty. Non-destructive: pure additive column.

ALTER TABLE sat_combat_sessions ADD COLUMN IF NOT EXISTS monsters TEXT;
