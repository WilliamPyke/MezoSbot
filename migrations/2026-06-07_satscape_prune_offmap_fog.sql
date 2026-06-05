-- Prune stale fog-of-war tiles whose coordinates fall outside the current world.
--
-- Before the map migration the world had different dimensions, so older "discovered"
-- tiles now sit off-map (they showed up as stray dots on the right edge of the world
-- map, stretching its auto-fit bounds). The web server already filters these out of
-- what it ships (see loadExploredTiles → inWorldBounds), so this cleanup is OPTIONAL —
-- it just removes the dead rows so the table and explored counts stay accurate.
--
-- Current world is 380 × 335 tiles (src/satscape/world.json width/height). Update the
-- bounds here if the map is regenerated at a different size.

DELETE FROM sat_world_explored WHERE x < 0 OR x >= 380 OR y < 0 OR y >= 335;
DELETE FROM sat_explored        WHERE x < 0 OR x >= 380 OR y < 0 OR y >= 335;
