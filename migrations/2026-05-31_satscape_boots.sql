-- SatScape: boots equipment + configurable multi-step movement.
--
-- Boots are a 4th equipment slot (mobility-only, no gear-score). The catalogue
-- lives in code (towns.ts). steps_per_move is how many tiles a single
-- directional press moves, capped at 8 + boot bonus (≤15).

ALTER TABLE sat_players ADD COLUMN IF NOT EXISTS equipped_boots  TEXT;
ALTER TABLE sat_players ADD COLUMN IF NOT EXISTS steps_per_move  INTEGER NOT NULL DEFAULT 1;
