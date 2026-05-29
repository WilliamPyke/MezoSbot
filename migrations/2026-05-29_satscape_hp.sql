-- SatScape: HP becomes a capped, sats-backed "at-risk" pool (default cap 250),
-- replacing the old model where HP literally was the player's full balance.
--
--   max_hp : HP-bar cap. Default 250; items may raise it later.
--   hp     : current HP — the at-risk slice of balance, 0..max_hp.
--            On load = min(balance, max_hp). NULL means "not yet armed" → derive it.
--
-- Getting hit still burns sats balance→pool (satquest_take_damage, unchanged) and
-- additionally lowers hp. Faint triggers at hp <= 0 (banked sats above the HP line
-- stay safe). HP refills only by re-exposing the player's own banked sats — balance
-- is unchanged, nothing is minted. Players with balance < max_hp behave exactly as
-- before (their whole balance is HP and the 250 cap is never reached).
--
-- Apply manually in the Supabase SQL editor (no migration runner in this project).

ALTER TABLE sat_players ADD COLUMN IF NOT EXISTS max_hp DOUBLE PRECISION NOT NULL DEFAULT 250;
ALTER TABLE sat_players ADD COLUMN IF NOT EXISTS hp     DOUBLE PRECISION; -- NULL => derive min(balance, max_hp)

-- Arm HP for any existing active players from their current balance (capped).
UPDATE sat_players p
   SET hp = LEAST(COALESCE(u.balance_sats, 0), p.max_hp)
  FROM users u
 WHERE u.discord_id = p.discord_id
   AND p.hp IS NULL;
