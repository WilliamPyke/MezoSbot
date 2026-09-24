-- Run after loading production-like data. Inspect actual time, rows, heap fetches,
-- shared reads, and index choice; do not add another index without checking overlap.
EXPLAIN (ANALYZE, BUFFERS)
SELECT discord_id, x_coord, y_coord, state
FROM sat_players
WHERE active = TRUE AND state <> 'fainted'
  AND x_coord BETWEEN 100 AND 116 AND y_coord BETWEEN 100 AND 116;

EXPLAIN (ANALYZE, BUFFERS)
SELECT x, y FROM sat_world_entities
WHERE entity_type = 'cleared' AND x BETWEEN 100 AND 116 AND y BETWEEN 100 AND 116;

EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM integration_events
WHERE status = 'pending' AND available_at <= now()
ORDER BY available_at, created_at LIMIT 25;

EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM integration_events
WHERE status = 'processing' AND lock_expires_at < now();
