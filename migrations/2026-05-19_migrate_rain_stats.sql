-- Migration: Update user_rain_stats view
-- Changes the user_rain_stats view to aggregate solely from the rains table,
-- as all historical drop claims have been migrated and future claims/rains populate there.

CREATE OR REPLACE VIEW user_rain_stats AS
SELECT 
  sender_id AS discord_id,
  SUM(amount_sats) AS total_rained_sats
FROM rains
GROUP BY sender_id;
