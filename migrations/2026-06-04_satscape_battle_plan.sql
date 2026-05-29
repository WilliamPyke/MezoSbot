-- SatScape telegraph & plan-3 combat.
--
-- Combat is now plan-ahead: the monster reveals its next 3 strikes (computed
-- deterministically), and the player queues up to 3 actions (move / strike /
-- wait) in `battle_plan`, then Resolve runs both queues interleaved.
--
-- `battle_move_points` is left in place (now unused) to avoid a destructive drop.

ALTER TABLE sat_combat_sessions ADD COLUMN IF NOT EXISTS battle_plan TEXT;
