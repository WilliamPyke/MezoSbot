-- SatScape shared fog of war.
--
-- Discovery is now co-op: once any player reveals a tile, that tile stays
-- revealed for everyone, including the public web map.

CREATE TABLE IF NOT EXISTS sat_world_explored (
  x             INTEGER NOT NULL,
  y             INTEGER NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (x, y)
);

-- Preserve discoveries made under the original per-player fog table.
INSERT INTO sat_world_explored (x, y)
SELECT DISTINCT x, y
FROM sat_explored
ON CONFLICT (x, y) DO NOTHING;
