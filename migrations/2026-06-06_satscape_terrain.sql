-- SatScape arena terrain.
--
-- Each fight rolls a small set of terrain features stored as a JSON array in
-- `terrain`:
--   [{ "x","y","kind" }, ...]   where kind is "pit" | "rock"
--
--   pit  — impassable; attacks fly OVER it (no line-of-sight block).
--   rock — impassable AND elevated: blocks line-of-sight, so ranged attacks
--          (arrows / fire-breath / bolts) stop at it. Standing behind one is cover.
--
-- Null/empty = an open arena. `readTerrain()` tolerates null, so fights created
-- before this migration is applied keep resolving on an empty board.
-- Non-destructive: pure additive column.

ALTER TABLE sat_combat_sessions ADD COLUMN IF NOT EXISTS terrain TEXT;
