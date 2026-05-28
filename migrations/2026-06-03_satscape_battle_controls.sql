-- SatScape tactical battle controls.
--
-- Movement is now preview-first: arrows spend battle_move_points, then Attack
-- resolves the monster telegraph and the selected weapon.

ALTER TABLE sat_combat_sessions ADD COLUMN IF NOT EXISTS battle_move_points INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sat_combat_sessions ADD COLUMN IF NOT EXISTS selected_battle_weapon TEXT;
