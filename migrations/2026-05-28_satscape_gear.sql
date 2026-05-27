-- SatScape gear & probabilistic combat.
--
-- Combat is now a single win-chance roll (45% base) rather than HP attrition,
-- so a huge balance no longer guarantees victory. Equipment shifts the odds.

-- Manual equip slots (item ids reference the in-code catalogue in items.ts).
ALTER TABLE sat_players ADD COLUMN IF NOT EXISTS equipped_weapon    TEXT;
ALTER TABLE sat_players ADD COLUMN IF NOT EXISTS equipped_armor     TEXT;
ALTER TABLE sat_players ADD COLUMN IF NOT EXISTS equipped_accessory TEXT;

-- Monster challenge rating, snapshotted onto the active combat session.
ALTER TABLE sat_combat_sessions ADD COLUMN IF NOT EXISTS monster_level INTEGER NOT NULL DEFAULT 1;
