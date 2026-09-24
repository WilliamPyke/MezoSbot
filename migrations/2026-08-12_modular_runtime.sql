-- Modular runtime foundation. Additive and safe to apply while the legacy
-- single-process deployment is still serving traffic.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE sat_players
  ADD COLUMN IF NOT EXISTS state_version BIGINT NOT NULL DEFAULT 1;

ALTER TABLE arcade_matches
  ADD COLUMN IF NOT EXISTS state_version BIGINT NOT NULL DEFAULT 1;

ALTER TABLE web_arcade_sessions
  ADD COLUMN IF NOT EXISTS state_version BIGINT NOT NULL DEFAULT 1;

-- Which runtime owns a match end to end. Rows created by the legacy bot
-- process keep the 'legacy' default; create_arcade_match_v1 (and v1 rematch
-- children) set 'remote'. A match must only ever be settled by its owner:
-- legacy code refuses 'remote' rows and the *_v1 RPCs refuse 'legacy' rows,
-- so flipping ARCADE_REMOTE_ENABLED mid-match can never double-settle.
ALTER TABLE arcade_matches
  ADD COLUMN IF NOT EXISTS runtime TEXT NOT NULL DEFAULT 'legacy';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'arcade_matches_runtime_check'
      AND conrelid = 'arcade_matches'::regclass
  ) THEN
    ALTER TABLE arcade_matches
      ADD CONSTRAINT arcade_matches_runtime_check CHECK (runtime IN ('legacy', 'remote'));
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS integration_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  deduplication_key TEXT NOT NULL UNIQUE,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'delivered', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_by TEXT,
  lock_expires_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_integration_events_due
  ON integration_events (available_at, created_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_integration_events_recovery
  ON integration_events (lock_expires_at)
  WHERE status = 'processing';

CREATE TABLE IF NOT EXISTS integration_idempotency (
  service TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  response JSONB,
  request_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 days'),
  PRIMARY KEY (service, idempotency_key)
);

-- Re-runnable upgrades for databases that applied an earlier draft of this
-- file. request_hash binds a key to the request that first used it; a
-- mismatched reuse is rejected by idempotency_begin_v1. Retention is 30 days
-- and lookups ignore expires_at (only purge_integration_state_v1 removes rows),
-- so a key can never silently become reusable while its row still exists.
ALTER TABLE integration_idempotency ADD COLUMN IF NOT EXISTS request_hash TEXT;
ALTER TABLE integration_idempotency ALTER COLUMN expires_at SET DEFAULT (now() + interval '30 days');

CREATE INDEX IF NOT EXISTS idx_integration_idempotency_expiry
  ON integration_idempotency (expires_at);

CREATE TABLE IF NOT EXISTS integration_request_nonces (
  service TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (service, nonce)
);

CREATE INDEX IF NOT EXISTS idx_integration_request_nonces_expiry
  ON integration_request_nonces (expires_at);

CREATE TABLE IF NOT EXISTS service_leases (
  lease_name TEXT PRIMARY KEY,
  holder_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Integration tables are service-only. service_role bypasses RLS; with RLS on
-- and no policies, anon/authenticated (PostgREST + Realtime) see nothing.
ALTER TABLE integration_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_request_nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_leases ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_sat_players_active_coords
  ON sat_players (x_coord, y_coord, discord_id)
  WHERE active = TRUE AND state <> 'fainted';

CREATE INDEX IF NOT EXISTS idx_sat_world_entities_cleared_coords
  ON sat_world_entities (x, y)
  WHERE entity_type = 'cleared';

CREATE OR REPLACE FUNCTION consume_integration_nonce_v1(
  p_service TEXT,
  p_nonce TEXT,
  p_expires_at TIMESTAMPTZ
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM integration_request_nonces WHERE expires_at < now();
  INSERT INTO integration_request_nonces(service, nonce, expires_at)
  VALUES (p_service, p_nonce, p_expires_at)
  ON CONFLICT DO NOTHING;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION acquire_service_lease_v1(
  p_lease_name TEXT,
  p_holder_id TEXT,
  p_ttl_seconds INTEGER DEFAULT 30
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_holder TEXT;
BEGIN
  INSERT INTO service_leases(lease_name, holder_id, expires_at, updated_at)
  VALUES (p_lease_name, p_holder_id, now() + make_interval(secs => GREATEST(5, p_ttl_seconds)), now())
  ON CONFLICT (lease_name) DO UPDATE
    SET holder_id = EXCLUDED.holder_id,
        expires_at = EXCLUDED.expires_at,
        updated_at = now()
    WHERE service_leases.expires_at < now()
       OR service_leases.holder_id = EXCLUDED.holder_id
  RETURNING holder_id INTO v_holder;
  -- No row is returned when another holder's lease is still live; v_holder is
  -- then NULL and a bare comparison would return NULL instead of false.
  RETURN COALESCE(v_holder = p_holder_id, FALSE);
END;
$$;

CREATE OR REPLACE FUNCTION release_service_lease_v1(p_lease_name TEXT, p_holder_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH removed AS (
    DELETE FROM service_leases
    WHERE lease_name = p_lease_name AND holder_id = p_holder_id
    RETURNING 1
  )
  SELECT EXISTS(SELECT 1 FROM removed);
$$;

CREATE OR REPLACE FUNCTION claim_integration_events_v1(
  p_worker_id TEXT,
  p_limit INTEGER DEFAULT 25,
  p_lock_seconds INTEGER DEFAULT 30
)
RETURNS SETOF integration_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Recover events whose worker died (or hung) while holding the lock. The
  -- claim below already incremented attempts, so an event that keeps killing
  -- its consumer is dead-lettered after 10 tries instead of looping forever.
  -- Keep the threshold in sync with complete_integration_event_v1.
  UPDATE integration_events
     SET status = CASE WHEN attempts >= 10 THEN 'dead' ELSE 'pending' END,
         available_at = CASE WHEN attempts >= 10 THEN available_at
                             ELSE now() + make_interval(secs => LEAST(300, attempts * attempts * 2)) END,
         locked_by = NULL,
         lock_expires_at = NULL,
         last_error = left('lock expired (worker ' || COALESCE(locked_by, 'unknown') || ')'
                           || COALESCE('; previous: ' || last_error, ''), 1000)
   WHERE status = 'processing' AND lock_expires_at < now();

  RETURN QUERY
  WITH due AS (
    SELECT id
      FROM integration_events
     WHERE status = 'pending' AND available_at <= now()
     ORDER BY available_at, created_at
     FOR UPDATE SKIP LOCKED
     LIMIT LEAST(GREATEST(p_limit, 1), 100)
  )
  UPDATE integration_events event
     SET status = 'processing',
         attempts = event.attempts + 1,
         locked_by = p_worker_id,
         lock_expires_at = now() + make_interval(secs => GREATEST(p_lock_seconds, 5))
    FROM due
   WHERE event.id = due.id
  RETURNING event.*;
END;
$$;

CREATE OR REPLACE FUNCTION complete_integration_event_v1(
  p_event_id UUID,
  p_worker_id TEXT,
  p_success BOOLEAN,
  p_error TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE integration_events
     SET status = CASE WHEN p_success THEN 'delivered' WHEN attempts >= 10 THEN 'dead' ELSE 'pending' END,
         delivered_at = CASE WHEN p_success THEN now() ELSE NULL END,
         available_at = CASE WHEN p_success THEN available_at ELSE now() + make_interval(secs => LEAST(300, attempts * attempts * 2)) END,
         locked_by = NULL,
         lock_expires_at = NULL,
         last_error = CASE WHEN p_success THEN NULL ELSE left(COALESCE(p_error, 'unknown'), 1000) END
   WHERE id = p_event_id AND status = 'processing' AND locked_by = p_worker_id;
  RETURN FOUND;
END;
$$;

-- Idempotency helpers shared by every money-moving *_v1 RPC.
--
--   v_response := idempotency_begin_v1('arcade.fund', p_idempotency_key,
--                   jsonb_build_object('match_id', p_match_id, 'user_id', p_user_id, 'amount', p_amount_sats));
--   IF v_response IS NOT NULL THEN RETURN v_response; END IF;
--   ... do the work, build v_response ...
--   PERFORM idempotency_finish_v1('arcade.fund', p_idempotency_key, <same request jsonb>, v_response);
--
-- begin takes a transaction-scoped advisory lock on (service, key) so
-- concurrent retries serialize, then returns:
--   * NULL when the key is unused (caller proceeds);
--   * the stored response when the key was used by the same request;
--   * {"ok":false,"code":"idempotency_conflict","conflict":true} when the key
--     was used by a different request (hash mismatch). Callers return it as-is.
-- p_request NULL disables binding (legacy callers); rows stored without a
-- hash replay for any request. jsonb::text is canonical (sorted keys), so the
-- hash is stable for equal payloads.
CREATE OR REPLACE FUNCTION idempotency_request_hash_v1(p_request JSONB)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE WHEN p_request IS NULL THEN NULL
              ELSE encode(sha256(convert_to(p_request::text, 'UTF8')), 'hex') END;
$$;

CREATE OR REPLACE FUNCTION idempotency_begin_v1(
  p_service TEXT,
  p_key TEXT,
  p_request JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row integration_idempotency%ROWTYPE;
  v_hash TEXT := idempotency_request_hash_v1(p_request);
BEGIN
  IF p_key IS NULL OR length(p_key) = 0 THEN
    RAISE EXCEPTION 'idempotency key is required for %', p_service USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_service || ':' || p_key, 0));
  SELECT * INTO v_row FROM integration_idempotency
   WHERE service = p_service AND idempotency_key = p_key;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v_hash IS NOT NULL AND v_row.request_hash IS NOT NULL AND v_row.request_hash <> v_hash THEN
    RETURN jsonb_build_object('ok', false, 'code', 'idempotency_conflict', 'conflict', true,
      'message', 'Idempotency key was already used for a different request');
  END IF;
  RETURN v_row.response;
END;
$$;

CREATE OR REPLACE FUNCTION idempotency_finish_v1(
  p_service TEXT,
  p_key TEXT,
  p_request JSONB,
  p_response JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO integration_idempotency(service, idempotency_key, request_hash, response)
  VALUES (p_service, p_key, idempotency_request_hash_v1(p_request), p_response)
  ON CONFLICT (service, idempotency_key) DO NOTHING;
  RETURN p_response;
END;
$$;

-- Housekeeping, called by the bot's outbox consumer (lease-guarded, hourly).
-- Idempotency rows past retention, spent nonces, and delivered events older
-- than 7 days are removed. Dead events are kept for operator inspection.
CREATE OR REPLACE FUNCTION purge_integration_state_v1(p_batch INTEGER DEFAULT 5000)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_idem INTEGER;
  v_nonces INTEGER;
  v_events INTEGER;
  v_limit INTEGER := LEAST(GREATEST(COALESCE(p_batch, 5000), 1), 50000);
BEGIN
  DELETE FROM integration_idempotency
   WHERE ctid IN (SELECT ctid FROM integration_idempotency WHERE expires_at < now() LIMIT v_limit);
  GET DIAGNOSTICS v_idem = ROW_COUNT;
  DELETE FROM integration_request_nonces
   WHERE ctid IN (SELECT ctid FROM integration_request_nonces WHERE expires_at < now() LIMIT v_limit);
  GET DIAGNOSTICS v_nonces = ROW_COUNT;
  DELETE FROM integration_events
   WHERE ctid IN (SELECT ctid FROM integration_events
                   WHERE status = 'delivered' AND delivered_at < now() - interval '7 days' LIMIT v_limit);
  GET DIAGNOSTICS v_events = ROW_COUNT;
  RETURN jsonb_build_object('idempotency', v_idem, 'nonces', v_nonces, 'events', v_events);
END;
$$;

CREATE OR REPLACE FUNCTION get_satscape_view_v1(p_discord_id TEXT, p_radius INTEGER DEFAULT 8)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH player AS (
    SELECT p.*, u.balance_sats
      FROM sat_players p
      JOIN users u ON u.discord_id = p.discord_id
     WHERE p.discord_id = p_discord_id
  ), bounds AS (
    SELECT *, LEAST(GREATEST(p_radius, 1), 32) AS radius FROM player
  )
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM player) THEN NULL ELSE jsonb_build_object(
    'player', (SELECT to_jsonb(p) - 'balance_sats' FROM player p),
    'balance', (SELECT balance_sats FROM player),
    'combat', (SELECT to_jsonb(c) FROM sat_combat_sessions c WHERE c.discord_id = p_discord_id),
    'inventory', COALESCE((SELECT jsonb_agg(jsonb_build_object('item_id', i.item_id, 'quantity', i.quantity) ORDER BY i.item_id)
      FROM sat_inventories i WHERE i.discord_id = p_discord_id AND i.quantity > 0), '[]'::jsonb),
    'explored', COALESCE((SELECT jsonb_agg(jsonb_build_array(e.x, e.y))
      FROM sat_explored e, bounds b
      WHERE e.discord_id = p_discord_id
        AND e.x BETWEEN b.x_coord - b.radius AND b.x_coord + b.radius
        AND e.y BETWEEN b.y_coord - b.radius AND b.y_coord + b.radius), '[]'::jsonb),
    'cleared', COALESCE((SELECT jsonb_agg(jsonb_build_array(e.x, e.y))
      FROM sat_world_entities e, bounds b
      WHERE e.entity_type = 'cleared'
        AND e.x BETWEEN b.x_coord - b.radius AND b.x_coord + b.radius
        AND e.y BETWEEN b.y_coord - b.radius AND b.y_coord + b.radius), '[]'::jsonb),
    'nearby', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'discord_id', other.discord_id,
        'name', COALESCE(u.display_name, u.username, 'Adventurer'),
        'x', other.x_coord,
        'y', other.y_coord,
        'state', other.state
      ) ORDER BY other.discord_id)
      FROM sat_players other
      JOIN users u ON u.discord_id = other.discord_id
      CROSS JOIN bounds b
      WHERE other.active = TRUE
        AND other.state <> 'fainted'
        AND other.discord_id <> p_discord_id
        AND other.discord_id NOT LIKE 'god:%'
        AND other.x_coord BETWEEN b.x_coord - b.radius AND b.x_coord + b.radius
        AND other.y_coord BETWEEN b.y_coord - b.radius AND b.y_coord + b.radius), '[]'::jsonb)
  ) END;
$$;

CREATE OR REPLACE FUNCTION get_satscape_action_snapshot_v1(p_discord_id TEXT, p_radius INTEGER DEFAULT 8)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT get_satscape_view_v1(p_discord_id, p_radius);
$$;

-- Money helper mirroring the bot's roundSats() (src/format.ts, 10 decimals).
-- Internal: not a *_v1 RPC, so the grant loop below never exposes it.
CREATE OR REPLACE FUNCTION mezo_round_sats(p_amount DOUBLE PRECISION)
RETURNS DOUBLE PRECISION
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT round(p_amount::NUMERIC, 10)::DOUBLE PRECISION;
$$;

-- Buy-in parity with src/satscape/game.ts chargeBuyIn(): the buy-in leaves the
-- player's balance and seeds sat_prize_pool, so the ledger receiver is the pool.
CREATE OR REPLACE FUNCTION start_satscape_run_v1(
  p_discord_id TEXT,
  p_buyin_sats DOUBLE PRECISION DEFAULT 50,
  p_spawn_x INTEGER DEFAULT 127,
  p_spawn_y INTEGER DEFAULT 111
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance DOUBLE PRECISION;
  v_buyin DOUBLE PRECISION;
  v_player sat_players%ROWTYPE;
  v_ledger BIGINT;
BEGIN
  IF p_buyin_sats IS NULL OR p_buyin_sats = 'NaN'::DOUBLE PRECISION
     OR p_buyin_sats = 'Infinity'::DOUBLE PRECISION OR p_buyin_sats <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'bad_buyin');
  END IF;
  v_buyin := mezo_round_sats(p_buyin_sats);
  IF v_buyin <= 0 THEN RETURN jsonb_build_object('ok', false, 'code', 'bad_buyin'); END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('satscape.start:' || p_discord_id, 0));
  SELECT * INTO v_player FROM sat_players WHERE discord_id = p_discord_id FOR UPDATE;
  IF v_player.active THEN
    RETURN jsonb_build_object('ok', true, 'already_active', true, 'state_version', v_player.state_version);
  END IF;

  SELECT balance_sats INTO v_balance FROM users WHERE discord_id = p_discord_id FOR UPDATE;
  IF v_balance IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'user_not_found'); END IF;
  IF v_balance < v_buyin THEN RETURN jsonb_build_object('ok', false, 'code', 'insufficient_balance'); END IF;

  -- Deterministic per run: the next state_version identifies this activation.
  INSERT INTO ledger_entries(transaction_id, type, amount_sats, sender_id, receiver_id, reference_type, reference_id)
  VALUES ('satscape-buyin:' || p_discord_id || ':' || (COALESCE(v_player.state_version, 0) + 1)::text,
    'satscape_buyin', v_buyin, p_discord_id, 'sat_prize_pool', 'sat_players', p_discord_id)
  ON CONFLICT (transaction_id) DO NOTHING
  RETURNING id INTO v_ledger;
  IF v_ledger IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'buyin_conflict', 'conflict', true);
  END IF;
  UPDATE users SET balance_sats = mezo_round_sats(balance_sats - v_buyin), updated_at = now() WHERE discord_id = p_discord_id;
  UPDATE sat_prize_pool SET balance_sats = mezo_round_sats(balance_sats + v_buyin) WHERE id = 1;

  INSERT INTO sat_players(discord_id, x_coord, y_coord, hunger, state, active, hp, max_hp, last_move_at, state_version)
  VALUES (p_discord_id, p_spawn_x, p_spawn_y, 100, 'idle', TRUE,
    GREATEST(0, LEAST(v_balance - v_buyin, 250)), 250, now(), 1)
  ON CONFLICT (discord_id) DO UPDATE SET
    x_coord = EXCLUDED.x_coord, y_coord = EXCLUDED.y_coord, hunger = 100,
    state = 'idle', active = TRUE, hp = GREATEST(0, LEAST(v_balance - v_buyin, COALESCE(sat_players.max_hp, 250))),
    last_move_at = now(), state_version = sat_players.state_version + 1
  RETURNING * INTO v_player;

  INSERT INTO sat_explored(discord_id, x, y)
  SELECT p_discord_id, x, y
  FROM generate_series(p_spawn_x - 4, p_spawn_x + 4) x,
       generate_series(p_spawn_y - 4, p_spawn_y + 4) y
  ON CONFLICT DO NOTHING;

  RETURN jsonb_build_object('ok', true, 'already_active', false, 'state_version', v_player.state_version);
END;
$$;

CREATE OR REPLACE FUNCTION commit_satscape_action_v1(
  p_discord_id TEXT,
  p_expected_version BIGINT,
  p_player_patch JSONB DEFAULT '{}'::jsonb,
  p_combat_patch JSONB DEFAULT NULL,
  p_delete_combat BOOLEAN DEFAULT FALSE,
  p_inventory_deltas JSONB DEFAULT '[]'::jsonb,
  p_explored_tiles JSONB DEFAULT '[]'::jsonb,
  p_cleared_tiles JSONB DEFAULT '[]'::jsonb,
  p_event JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_player sat_players%ROWTYPE;
  v_max_hp DOUBLE PRECISION;
  v_hp DOUBLE PRECISION;
  v_short TEXT;
BEGIN
  -- Compare-and-set: nothing is written unless the version matches AND every
  -- inventory debit is covered; hp is clamped to [0, max_hp]. Conflicts are
  -- returned, never raised.
  SELECT * INTO v_player FROM sat_players
   WHERE discord_id = p_discord_id AND state_version = p_expected_version
   FOR UPDATE;
  IF v_player.discord_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'conflict', true);
  END IF;

  v_max_hp := COALESCE((p_player_patch->>'max_hp')::DOUBLE PRECISION, v_player.max_hp, 250);
  IF v_max_hp = 'NaN'::DOUBLE PRECISION OR v_max_hp <= 0 OR v_max_hp = 'Infinity'::DOUBLE PRECISION THEN
    RETURN jsonb_build_object('ok', false, 'conflict', false, 'code', 'bad_max_hp');
  END IF;
  IF p_player_patch ? 'hp' AND p_player_patch->'hp' <> 'null'::jsonb THEN
    v_hp := (p_player_patch->>'hp')::DOUBLE PRECISION;
    IF v_hp = 'NaN'::DOUBLE PRECISION THEN
      RETURN jsonb_build_object('ok', false, 'conflict', false, 'code', 'bad_hp');
    END IF;
    v_hp := GREATEST(0, LEAST(v_hp, v_max_hp));
  END IF;

  -- Lock the affected inventory rows and make sure every debit is covered.
  PERFORM 1 FROM sat_inventories
   WHERE discord_id = p_discord_id
     AND item_id IN (SELECT item_id FROM jsonb_to_recordset(p_inventory_deltas) AS delta(item_id TEXT, quantity INTEGER))
   FOR UPDATE;
  SELECT delta.item_id INTO v_short
    FROM (SELECT item_id, SUM(quantity) AS quantity
            FROM jsonb_to_recordset(p_inventory_deltas) AS d(item_id TEXT, quantity INTEGER)
           GROUP BY item_id) delta
    LEFT JOIN sat_inventories inv ON inv.discord_id = p_discord_id AND inv.item_id = delta.item_id
   WHERE delta.quantity < 0 AND COALESCE(inv.quantity, 0) + delta.quantity < 0
   LIMIT 1;
  IF v_short IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'conflict', true, 'code', 'inventory_conflict', 'item_id', v_short);
  END IF;

  UPDATE sat_players
     SET x_coord = COALESCE((p_player_patch->>'x_coord')::INTEGER, x_coord),
         y_coord = COALESCE((p_player_patch->>'y_coord')::INTEGER, y_coord),
         hunger = LEAST(100, GREATEST(0, COALESCE((p_player_patch->>'hunger')::INTEGER, hunger))),
         state = COALESCE(p_player_patch->>'state', state),
         active = COALESCE((p_player_patch->>'active')::BOOLEAN, active),
         hp = CASE WHEN p_player_patch ? 'hp' THEN v_hp
                   WHEN hp IS NOT NULL THEN GREATEST(0, LEAST(hp, v_max_hp))
                   ELSE hp END,
         max_hp = v_max_hp,
         equipped_weapon = CASE WHEN p_player_patch ? 'equipped_weapon' THEN p_player_patch->>'equipped_weapon' ELSE equipped_weapon END,
         equipped_armor = CASE WHEN p_player_patch ? 'equipped_armor' THEN p_player_patch->>'equipped_armor' ELSE equipped_armor END,
         equipped_accessory = CASE WHEN p_player_patch ? 'equipped_accessory' THEN p_player_patch->>'equipped_accessory' ELSE equipped_accessory END,
         equipped_boots = CASE WHEN p_player_patch ? 'equipped_boots' THEN p_player_patch->>'equipped_boots' ELSE equipped_boots END,
         steps_per_move = COALESCE((p_player_patch->>'steps_per_move')::INTEGER, steps_per_move),
         last_move_at = COALESCE((p_player_patch->>'last_move_at')::TIMESTAMPTZ, last_move_at),
         state_version = state_version + 1
   WHERE discord_id = p_discord_id
  RETURNING * INTO v_player;

  IF p_delete_combat THEN
    DELETE FROM sat_combat_sessions WHERE discord_id = p_discord_id;
  ELSIF p_combat_patch IS NOT NULL THEN
    UPDATE sat_combat_sessions
       SET monster_current_hp = COALESCE((p_combat_patch->>'monster_current_hp')::INTEGER, monster_current_hp),
           player_battle_x = COALESCE((p_combat_patch->>'player_battle_x')::INTEGER, player_battle_x),
           player_battle_y = COALESCE((p_combat_patch->>'player_battle_y')::INTEGER, player_battle_y),
           monster_battle_x = COALESCE((p_combat_patch->>'monster_battle_x')::INTEGER, monster_battle_x),
           monster_battle_y = COALESCE((p_combat_patch->>'monster_battle_y')::INTEGER, monster_battle_y),
           turn_number = COALESCE((p_combat_patch->>'turn_number')::INTEGER, turn_number),
           battle_plan = CASE WHEN p_combat_patch ? 'battle_plan' THEN p_combat_patch->>'battle_plan' ELSE battle_plan END,
           selected_battle_weapon = CASE WHEN p_combat_patch ? 'selected_battle_weapon' THEN p_combat_patch->>'selected_battle_weapon' ELSE selected_battle_weapon END,
           monsters = CASE WHEN p_combat_patch ? 'monsters' THEN p_combat_patch->>'monsters' ELSE monsters END,
           terrain = CASE WHEN p_combat_patch ? 'terrain' THEN p_combat_patch->>'terrain' ELSE terrain END
     WHERE discord_id = p_discord_id;
  END IF;

  INSERT INTO sat_inventories(discord_id, item_id, quantity)
  SELECT p_discord_id, item_id, SUM(quantity)
    FROM jsonb_to_recordset(p_inventory_deltas) AS delta(item_id TEXT, quantity INTEGER)
   GROUP BY item_id
  HAVING SUM(quantity) <> 0
  ON CONFLICT (discord_id, item_id) DO UPDATE
    SET quantity = sat_inventories.quantity + EXCLUDED.quantity;

  INSERT INTO sat_explored(discord_id, x, y)
  SELECT DISTINCT p_discord_id, x, y FROM jsonb_to_recordset(p_explored_tiles) AS tile(x INTEGER, y INTEGER)
  ON CONFLICT (discord_id, x, y) DO NOTHING;
  -- Shared fog parity with src/satscape/db.ts revealAround().
  INSERT INTO sat_world_explored(x, y)
  SELECT DISTINCT x, y FROM jsonb_to_recordset(p_explored_tiles) AS tile(x INTEGER, y INTEGER)
  ON CONFLICT (x, y) DO NOTHING;

  INSERT INTO sat_world_entities(x, y, entity_type, entity_data)
  SELECT DISTINCT x, y, 'cleared', '{}'::jsonb FROM jsonb_to_recordset(p_cleared_tiles) AS tile(x INTEGER, y INTEGER)
  ON CONFLICT (x, y) DO UPDATE SET entity_type = 'cleared', entity_data = '{}'::jsonb;

  IF p_event IS NOT NULL THEN
    INSERT INTO integration_events(event_type, aggregate_type, aggregate_id, deduplication_key, payload)
    VALUES (
      p_event->>'type',
      'satscape_player',
      p_discord_id,
      COALESCE(p_event->>'deduplication_key', 'satscape:' || p_discord_id || ':' || v_player.state_version),
      p_event
    ) ON CONFLICT (deduplication_key) DO NOTHING;
  END IF;

  RETURN jsonb_build_object('ok', true, 'conflict', false, 'state_version', v_player.state_version);
END;
$$;

-- ─────────── Arcade (runtime = 'remote') ───────────
-- Money invariants enforced below:
--   * a stake is debited only in the same transaction that seats the player
--     (create for player A, join for player B, mutual rematch for both), so a
--     user who loses a join race or fails validation is never charged;
--   * every balance change is gated on its ledger row actually inserting
--     (ON CONFLICT DO NOTHING RETURNING), so retries cannot double-move money;
--   * payout happens only when funded escrow from player_a/player_b equals the
--     gross pot, otherwise every funded a/b row is refunded;
--   * escrow rows only move funded -> refunded | released, never back.
-- Rake matches src/arcade/economics.ts: floor(gross * bps / 10000).

-- Seat time of player B (or of player A for practice/rematch). Used to expire
-- matches whose players never pressed Ready.
ALTER TABLE arcade_matches ADD COLUMN IF NOT EXISTS joined_at TIMESTAMPTZ;

-- Internal: debit a stake into escrow for a seated player. Caller holds the
-- match row lock. Returns 'ok' | 'already_funded' | 'insufficient_balance' |
-- 'escrow_closed'.
CREATE OR REPLACE FUNCTION arcade_debit_stake_internal(
  p_match_id BIGINT,
  p_user_id TEXT,
  p_amount_sats DOUBLE PRECISION,
  p_mode TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_escrow arcade_escrow%ROWTYPE;
  v_balance DOUBLE PRECISION;
  v_ledger BIGINT;
BEGIN
  IF p_amount_sats IS NULL OR p_amount_sats <= 0 OR p_amount_sats = 'NaN'::DOUBLE PRECISION THEN
    RETURN 'escrow_closed';
  END IF;
  SELECT * INTO v_escrow FROM arcade_escrow WHERE match_id = p_match_id AND user_id = p_user_id FOR UPDATE;
  IF FOUND THEN
    RETURN CASE WHEN v_escrow.status = 'funded' THEN 'already_funded' ELSE 'escrow_closed' END;
  END IF;
  SELECT balance_sats INTO v_balance FROM users WHERE discord_id = p_user_id FOR UPDATE;
  IF v_balance IS NULL OR v_balance < p_amount_sats THEN RETURN 'insufficient_balance'; END IF;
  INSERT INTO ledger_entries(transaction_id, type, amount_sats, sender_id, reference_type, reference_id, metadata)
  VALUES ('arcade-fund:' || p_match_id || ':' || p_user_id, 'arcade_stake', p_amount_sats, p_user_id,
    'arcade_matches', p_match_id::text, jsonb_build_object('mode', p_mode))
  ON CONFLICT (transaction_id) DO NOTHING
  RETURNING id INTO v_ledger;
  IF v_ledger IS NULL THEN RETURN 'escrow_closed'; END IF;
  UPDATE users SET balance_sats = mezo_round_sats(balance_sats - p_amount_sats), updated_at = now() WHERE discord_id = p_user_id;
  INSERT INTO arcade_escrow(match_id, user_id, amount_sats, status, updated_at)
  VALUES (p_match_id, p_user_id, p_amount_sats, 'funded', now());
  RETURN 'ok';
END;
$$;

-- Internal: refund every funded escrow row that belongs to player_a/player_b.
-- Caller holds the match row lock. Returns the total refunded.
CREATE OR REPLACE FUNCTION arcade_refund_escrow_internal(p_match_id BIGINT)
RETURNS DOUBLE PRECISION
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_match arcade_matches%ROWTYPE;
  v_row arcade_escrow%ROWTYPE;
  v_ledger BIGINT;
  v_total DOUBLE PRECISION := 0;
BEGIN
  SELECT * INTO v_match FROM arcade_matches WHERE id = p_match_id;
  FOR v_row IN
    SELECT * FROM arcade_escrow
     WHERE match_id = p_match_id AND status = 'funded'
       AND user_id IN (v_match.player_a_id, COALESCE(v_match.player_b_id, v_match.player_a_id))
     ORDER BY user_id
     FOR UPDATE
  LOOP
    v_ledger := NULL;
    INSERT INTO ledger_entries(transaction_id, type, amount_sats, sender_id, receiver_id, reference_type, reference_id)
    VALUES ('arcade-refund:' || p_match_id || ':' || v_row.user_id, 'arcade_refund', v_row.amount_sats,
      'platform', v_row.user_id, 'arcade_matches', p_match_id::text)
    ON CONFLICT (transaction_id) DO NOTHING
    RETURNING id INTO v_ledger;
    IF v_ledger IS NOT NULL THEN
      INSERT INTO users(discord_id, balance_sats) VALUES (v_row.user_id, mezo_round_sats(v_row.amount_sats))
        ON CONFLICT (discord_id) DO UPDATE SET balance_sats = mezo_round_sats(users.balance_sats + EXCLUDED.balance_sats), updated_at = now();
      v_total := v_total + v_row.amount_sats;
    END IF;
    UPDATE arcade_escrow SET status = 'refunded', updated_at = now() WHERE id = v_row.id;
  END LOOP;
  RETURN v_total;
END;
$$;

-- Internal: settle a locked match whose players have all submitted. Pays out
-- only against fully funded escrow; otherwise refunds. Returns the response.
CREATE OR REPLACE FUNCTION arcade_settle_internal(p_match_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_match arcade_matches%ROWTYPE;
  v_winner TEXT;
  v_tie BOOLEAN := FALSE;
  v_outcome TEXT;
  v_a_funded DOUBLE PRECISION;
  v_b_funded DOUBLE PRECISION;
  v_fully_funded BOOLEAN;
  v_ledger BIGINT;
  v_status TEXT := 'completed';
  v_escrow_status TEXT;
BEGIN
  SELECT * INTO v_match FROM arcade_matches WHERE id = p_match_id FOR UPDATE;
  IF v_match.status = 'completed' THEN
    RETURN jsonb_build_object('ok', true, 'status', CASE WHEN v_match.winner_id IS NULL AND v_match.mode <> 'practice' THEN 'tie' ELSE 'completed' END,
      'match_id', p_match_id, 'winner_id', v_match.winner_id, 'already_settled', true);
  END IF;

  IF v_match.mode = 'practice' THEN
    v_winner := v_match.player_a_id;
  ELSIF v_match.mode = 'tipfight' THEN
    -- Opponent (B) must strictly beat the challenger (A) to take the stake.
    v_winner := CASE WHEN COALESCE(v_match.player_b_score, 0) > COALESCE(v_match.player_a_score, 0) THEN v_match.player_b_id ELSE v_match.player_a_id END;
  ELSIF COALESCE(v_match.player_a_score, 0) = COALESCE(v_match.player_b_score, 0) THEN
    v_tie := TRUE;
  ELSE
    v_winner := CASE WHEN COALESCE(v_match.player_a_score, 0) > COALESCE(v_match.player_b_score, 0) THEN v_match.player_a_id ELSE v_match.player_b_id END;
  END IF;
  v_outcome := CASE WHEN v_tie THEN 'tie' ELSE 'winner' END;
  v_escrow_status := v_match.escrow_status;

  IF v_match.mode IN ('staked_pvp', 'tipfight') THEN
    PERFORM 1 FROM arcade_escrow
     WHERE match_id = p_match_id AND user_id IN (v_match.player_a_id, COALESCE(v_match.player_b_id, v_match.player_a_id))
     FOR UPDATE;
    SELECT COALESCE(SUM(amount_sats) FILTER (WHERE user_id = v_match.player_a_id AND status = 'funded'), 0),
           COALESCE(SUM(amount_sats) FILTER (WHERE user_id = v_match.player_b_id AND status = 'funded'), 0)
      INTO v_a_funded, v_b_funded
      FROM arcade_escrow WHERE match_id = p_match_id;
    v_fully_funded := COALESCE(v_match.gross_pot_sats, 0) > 0
      AND abs(v_a_funded - COALESCE(v_match.stake_amount_sats, 0)) < 0.000000001
      AND abs(v_a_funded + v_b_funded - v_match.gross_pot_sats) < 0.000000001
      AND (v_match.mode = 'tipfight' OR abs(v_b_funded - COALESCE(v_match.stake_amount_sats, 0)) < 0.000000001);

    IF NOT v_fully_funded THEN
      PERFORM arcade_refund_escrow_internal(p_match_id);
      v_status := 'cancelled';
      v_outcome := 'unfunded_refund';
      v_winner := NULL;
      v_escrow_status := 'refunded';
    ELSIF v_tie OR (v_match.mode = 'tipfight' AND v_winner = v_match.player_a_id) THEN
      PERFORM arcade_refund_escrow_internal(p_match_id);
      v_escrow_status := 'refunded';
    ELSE
      IF COALESCE(v_match.winner_payout_sats, 0) > 0 THEN
        INSERT INTO ledger_entries(transaction_id, type, amount_sats, sender_id, receiver_id, reference_type, reference_id, metadata)
        VALUES ('arcade-payout:' || p_match_id, 'arcade_payout', v_match.winner_payout_sats, 'platform', v_winner,
          'arcade_matches', p_match_id::text, jsonb_build_object('mode', v_match.mode))
        ON CONFLICT (transaction_id) DO NOTHING
        RETURNING id INTO v_ledger;
        IF v_ledger IS NOT NULL THEN
          INSERT INTO users(discord_id, balance_sats) VALUES (v_winner, mezo_round_sats(v_match.winner_payout_sats))
            ON CONFLICT (discord_id) DO UPDATE SET balance_sats = mezo_round_sats(users.balance_sats + EXCLUDED.balance_sats), updated_at = now();
        END IF;
      END IF;
      IF COALESCE(v_match.rake_amount_sats, 0) > 0 THEN
        INSERT INTO ledger_entries(transaction_id, type, amount_sats, sender_id, receiver_id, reference_type, reference_id, metadata)
        VALUES ('arcade-rake:' || p_match_id, 'arcade_rake', v_match.rake_amount_sats, 'platform', NULL,
          'arcade_matches', p_match_id::text, jsonb_build_object('mode', v_match.mode))
        ON CONFLICT (transaction_id) DO NOTHING;
      END IF;
      UPDATE arcade_escrow SET status = 'released', updated_at = now()
       WHERE match_id = p_match_id AND status = 'funded'
         AND user_id IN (v_match.player_a_id, v_match.player_b_id);
      INSERT INTO arcade_fees(match_id, rake_amount_sats, platform_rake_bps, status)
      VALUES (p_match_id, COALESCE(v_match.rake_amount_sats, 0), v_match.platform_rake_bps, 'collected')
      ON CONFLICT (match_id) DO NOTHING;
      v_escrow_status := 'released';
    END IF;
  END IF;

  UPDATE arcade_matches SET status = v_status,
    winner_id = CASE WHEN v_tie THEN NULL ELSE v_winner END,
    escrow_status = v_escrow_status,
    completed_at = now(), state_version = state_version + 1
  WHERE id = p_match_id;

  INSERT INTO integration_events(event_type, aggregate_type, aggregate_id, deduplication_key, payload)
  VALUES ('arcade.match_settled', 'arcade_match', p_match_id::text, 'arcade.match_settled:' || p_match_id,
    jsonb_build_object('version', 1, 'type', 'arcade.match_settled', 'eventId', gen_random_uuid()::text,
      'occurredAt', now(), 'matchId', p_match_id, 'winnerId', CASE WHEN v_tie THEN NULL ELSE v_winner END,
      'outcome', v_outcome, 'channelId', v_match.channel_id))
  ON CONFLICT (deduplication_key) DO NOTHING;

  RETURN jsonb_build_object('ok', true,
    'status', CASE WHEN v_status = 'cancelled' THEN 'refunded' WHEN v_tie THEN 'tie' ELSE 'completed' END,
    'match_id', p_match_id, 'winner_id', CASE WHEN v_tie THEN NULL ELSE v_winner END, 'outcome', v_outcome);
END;
$$;

DO $$
DECLARE
  v_sig TEXT;
  v_role TEXT;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'mezo_round_sats(DOUBLE PRECISION)',
    'arcade_debit_stake_internal(BIGINT, TEXT, DOUBLE PRECISION, TEXT)',
    'arcade_refund_escrow_internal(BIGINT)',
    'arcade_settle_internal(BIGINT)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_sig);
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', v_sig, v_role);
      END IF;
    END LOOP;
  END LOOP;
END;
$$;

-- Legacy entry point. Stakes are now debited atomically by create (player A)
-- and join (player B); this only tops up a seated player's missing escrow
-- while the match is still waiting, and never reopens refunded/released rows.
CREATE OR REPLACE FUNCTION fund_arcade_match_v1(
  p_match_id BIGINT,
  p_user_id TEXT,
  p_amount_sats DOUBLE PRECISION,
  p_idempotency_key TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_match arcade_matches%ROWTYPE;
  v_result TEXT;
  v_funded INTEGER;
  v_required INTEGER;
BEGIN
  SELECT * INTO v_match FROM arcade_matches WHERE id = p_match_id FOR UPDATE;
  IF v_match.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'match_not_found'); END IF;
  IF v_match.runtime <> 'remote' THEN RETURN jsonb_build_object('ok', false, 'code', 'wrong_runtime'); END IF;
  IF v_match.mode NOT IN ('staked_pvp', 'tipfight') THEN RETURN jsonb_build_object('ok', false, 'code', 'not_staked'); END IF;
  IF v_match.status <> 'waiting' THEN RETURN jsonb_build_object('ok', false, 'code', 'match_not_waiting'); END IF;
  IF p_user_id NOT IN (v_match.player_a_id, COALESCE(v_match.player_b_id, v_match.player_a_id))
     OR (v_match.mode = 'tipfight' AND p_user_id <> v_match.player_a_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_a_player');
  END IF;
  IF p_amount_sats IS NULL OR p_amount_sats <= 0 OR p_amount_sats = 'NaN'::DOUBLE PRECISION
     OR abs(COALESCE(v_match.stake_amount_sats, 0) - mezo_round_sats(p_amount_sats)) > 0.000000001 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'bad_stake');
  END IF;

  v_result := arcade_debit_stake_internal(p_match_id, p_user_id, v_match.stake_amount_sats, v_match.mode);
  IF v_result NOT IN ('ok', 'already_funded') THEN RETURN jsonb_build_object('ok', false, 'code', v_result); END IF;

  SELECT count(*) INTO v_funded FROM arcade_escrow
   WHERE match_id = p_match_id AND status = 'funded'
     AND user_id IN (v_match.player_a_id, COALESCE(v_match.player_b_id, v_match.player_a_id));
  v_required := CASE WHEN v_match.mode = 'tipfight' THEN 1 ELSE 2 END;
  IF v_funded >= v_required THEN
    UPDATE arcade_matches SET escrow_status = 'funded', state_version = state_version + 1 WHERE id = p_match_id;
  END IF;
  RETURN jsonb_build_object('ok', true, 'already_funded', v_result = 'already_funded', 'match_id', p_match_id);
END;
$$;

CREATE OR REPLACE FUNCTION create_arcade_match_v1(
  p_mode TEXT,
  p_created_by_id TEXT,
  p_target_player_id TEXT,
  p_stake_sats DOUBLE PRECISION,
  p_channel_id TEXT,
  p_duration_seconds INTEGER,
  p_idempotency_key TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_match arcade_matches%ROWTYPE;
  v_staked BOOLEAN := p_mode IN ('staked_pvp', 'tipfight');
  v_stake DOUBLE PRECISION;
  v_gross DOUBLE PRECISION;
  v_rake DOUBLE PRECISION;
  v_balance DOUBLE PRECISION;
  v_debit TEXT;
  v_request JSONB := jsonb_build_object('mode', p_mode, 'created_by_id', p_created_by_id,
    'target_player_id', p_target_player_id, 'stake_sats', p_stake_sats, 'channel_id', p_channel_id,
    'duration_seconds', p_duration_seconds);
  v_response JSONB;
BEGIN
  -- Creates the match and, for staked_pvp/tipfight, debits the creator's
  -- stake in the same transaction. Insufficient balance creates nothing.
  v_response := idempotency_begin_v1('arcade.create', p_idempotency_key, v_request);
  IF v_response IS NOT NULL THEN RETURN v_response; END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('practice', 'free_pvp', 'staked_pvp', 'tipfight') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'bad_mode');
  END IF;
  IF p_duration_seconds IS NULL OR p_duration_seconds NOT BETWEEN 60 AND 300 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'bad_duration');
  END IF;
  IF p_target_player_id IS NOT NULL AND p_target_player_id = p_created_by_id THEN
    RETURN jsonb_build_object('ok', false, 'code', 'self_target');
  END IF;
  IF v_staked THEN
    IF p_stake_sats IS NULL OR p_stake_sats = 'NaN'::DOUBLE PRECISION
       OR p_stake_sats = 'Infinity'::DOUBLE PRECISION OR p_stake_sats <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'bad_stake');
    END IF;
    v_stake := mezo_round_sats(p_stake_sats);
    IF v_stake <= 0 THEN RETURN jsonb_build_object('ok', false, 'code', 'bad_stake'); END IF;
    v_gross := CASE WHEN p_mode = 'tipfight' THEN v_stake ELSE mezo_round_sats(v_stake * 2) END;
    v_rake := floor(v_gross * 1000 / 10000);
    SELECT balance_sats INTO v_balance FROM users WHERE discord_id = p_created_by_id FOR UPDATE;
    IF v_balance IS NULL OR v_balance < v_stake THEN
      RETURN jsonb_build_object('ok', false, 'code', 'insufficient_balance');
    END IF;
  END IF;

  INSERT INTO arcade_matches(
    seed, mode, status, channel_id, stake_amount_sats, gross_pot_sats,
    platform_rake_bps, rake_amount_sats, winner_payout_sats, created_by_id,
    target_player_id, player_a_id, player_b_id, escrow_status,
    duration_seconds, started_at, joined_at, runtime
  ) VALUES (
    replace(gen_random_uuid()::text, '-', ''), p_mode, CASE WHEN p_mode = 'practice' THEN 'active' ELSE 'waiting' END,
    p_channel_id, v_stake, v_gross, CASE WHEN v_staked THEN 1000 ELSE 0 END, v_rake,
    CASE WHEN v_staked THEN mezo_round_sats(v_gross - v_rake) ELSE NULL END,
    p_created_by_id, p_target_player_id, p_created_by_id, NULL,
    CASE WHEN v_staked THEN 'pending' ELSE 'none' END,
    p_duration_seconds, CASE WHEN p_mode = 'practice' THEN now() ELSE NULL END,
    CASE WHEN p_mode = 'practice' THEN now() ELSE NULL END, 'remote'
  ) RETURNING * INTO v_match;

  IF v_staked THEN
    v_debit := arcade_debit_stake_internal(v_match.id, p_created_by_id, v_stake, p_mode);
    IF v_debit <> 'ok' THEN
      RAISE EXCEPTION 'arcade creator funding failed for new match %: %', v_match.id, v_debit USING ERRCODE = 'P0001';
    END IF;
  END IF;

  UPDATE arcade_matches
     SET series_root_id = v_match.id,
         escrow_status = CASE WHEN p_mode = 'tipfight' THEN 'funded' ELSE escrow_status END
   WHERE id = v_match.id RETURNING * INTO v_match;
  v_response := jsonb_build_object('ok', true, 'match', to_jsonb(v_match));
  RETURN idempotency_finish_v1('arcade.create', p_idempotency_key, v_request, v_response);
END;
$$;

CREATE OR REPLACE FUNCTION join_arcade_match_v1(p_match_id BIGINT, p_user_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_match arcade_matches%ROWTYPE;
  v_debit TEXT;
BEGIN
  -- Seats player B. For staked_pvp the joiner's stake is debited here, after
  -- every check (including the row-locked "still open" check), so the loser
  -- of an open-lobby race is never charged. Staked modes require the
  -- creator's escrow to be funded.
  SELECT * INTO v_match FROM arcade_matches WHERE id = p_match_id FOR UPDATE;
  IF v_match.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'match_not_found'); END IF;
  IF v_match.runtime <> 'remote' THEN RETURN jsonb_build_object('ok', false, 'code', 'wrong_runtime'); END IF;
  IF v_match.player_b_id = p_user_id AND v_match.status IN ('active', 'submitted') THEN
    RETURN jsonb_build_object('ok', true, 'already_joined', true, 'match', to_jsonb(v_match));
  END IF;
  IF v_match.status <> 'waiting' OR v_match.player_b_id IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'match_not_waiting'); END IF;
  IF v_match.player_a_id = p_user_id THEN RETURN jsonb_build_object('ok', false, 'code', 'self_join'); END IF;
  IF v_match.target_player_id IS NOT NULL AND v_match.target_player_id <> p_user_id THEN RETURN jsonb_build_object('ok', false, 'code', 'wrong_player'); END IF;

  IF v_match.mode IN ('staked_pvp', 'tipfight') THEN
    IF NOT EXISTS (
      SELECT 1 FROM arcade_escrow
       WHERE match_id = p_match_id AND user_id = v_match.player_a_id AND status = 'funded'
         AND abs(amount_sats - COALESCE(v_match.stake_amount_sats, 0)) < 0.000000001
    ) THEN RETURN jsonb_build_object('ok', false, 'code', 'creator_not_funded'); END IF;
  END IF;
  IF v_match.mode = 'staked_pvp' THEN
    v_debit := arcade_debit_stake_internal(p_match_id, p_user_id, v_match.stake_amount_sats, v_match.mode);
    IF v_debit NOT IN ('ok', 'already_funded') THEN RETURN jsonb_build_object('ok', false, 'code', v_debit); END IF;
  END IF;

  UPDATE arcade_matches SET player_b_id = p_user_id, status = 'active', started_at = NULL,
      countdown_started_at = NULL, player_a_ready = FALSE, player_b_ready = FALSE, joined_at = now(),
      escrow_status = CASE WHEN mode IN ('staked_pvp', 'tipfight') THEN 'funded' ELSE escrow_status END,
      state_version = state_version + 1
    WHERE id = p_match_id RETURNING * INTO v_match;
  RETURN jsonb_build_object('ok', true, 'already_joined', false, 'match', to_jsonb(v_match));
END;
$$;

CREATE OR REPLACE FUNCTION get_arcade_view_v1(p_match_id BIGINT, p_user_id TEXT)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN m.id IS NULL THEN NULL
    WHEN p_user_id NOT IN (m.player_a_id, COALESCE(m.player_b_id, '')) THEN jsonb_build_object('forbidden', true)
    ELSE jsonb_build_object(
      'match', to_jsonb(m),
      'server_now', now(),
      'deadline_at', m.started_at + make_interval(secs => m.duration_seconds),
      'submission', COALESCE((
        SELECT to_jsonb(s) FROM arcade_submissions s
        WHERE s.match_id = p_match_id AND s.user_id = p_user_id
      ), jsonb_build_object('move_log', '[]'::jsonb))
    )
  END
  FROM (SELECT * FROM arcade_matches WHERE id = p_match_id) m
  RIGHT JOIN (SELECT 1) present ON TRUE;
$$;

-- Compare-and-set draft save: p_expected_moves must equal the stored move
-- count and the new log must extend it by exactly one move. Rejected once
-- the player has submitted or the server-side clock (started_at +
-- duration_seconds + 5s grace) has run out.
DROP FUNCTION IF EXISTS save_arcade_draft_v1(BIGINT, TEXT, JSONB, DOUBLE PRECISION);
CREATE OR REPLACE FUNCTION save_arcade_draft_v1(
  p_match_id BIGINT,
  p_user_id TEXT,
  p_move_log JSONB,
  p_score DOUBLE PRECISION,
  p_expected_moves INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_match arcade_matches%ROWTYPE;
  v_current INTEGER;
  v_submitted BOOLEAN;
BEGIN
  SELECT * INTO v_match FROM arcade_matches WHERE id = p_match_id FOR UPDATE;
  IF v_match.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'match_not_found'); END IF;
  IF v_match.runtime <> 'remote' THEN RETURN jsonb_build_object('ok', false, 'code', 'wrong_runtime'); END IF;
  IF p_user_id NOT IN (v_match.player_a_id, COALESCE(v_match.player_b_id, '')) THEN RETURN jsonb_build_object('ok', false, 'code', 'not_a_player'); END IF;
  IF v_match.status NOT IN ('active', 'submitted') THEN RETURN jsonb_build_object('ok', false, 'code', 'match_not_active'); END IF;
  v_submitted := CASE WHEN p_user_id = v_match.player_a_id THEN v_match.player_a_submitted ELSE v_match.player_b_submitted END;
  IF v_submitted THEN RETURN jsonb_build_object('ok', false, 'code', 'already_submitted'); END IF;
  IF v_match.started_at IS NULL OR now() < v_match.started_at THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_started');
  END IF;
  IF now() > v_match.started_at + make_interval(secs => v_match.duration_seconds + 5) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'deadline_passed');
  END IF;
  IF p_expected_moves IS NULL OR p_expected_moves < 0 OR jsonb_typeof(p_move_log) <> 'array'
     OR jsonb_array_length(p_move_log) <> p_expected_moves + 1
     OR p_score IS NULL OR p_score = 'NaN'::DOUBLE PRECISION OR p_score < 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'bad_draft');
  END IF;

  SELECT jsonb_array_length(move_log) INTO v_current FROM arcade_submissions
   WHERE match_id = p_match_id AND user_id = p_user_id FOR UPDATE;
  IF COALESCE(v_current, 0) <> p_expected_moves THEN
    RETURN jsonb_build_object('ok', false, 'code', 'draft_conflict', 'conflict', true, 'current_moves', COALESCE(v_current, 0));
  END IF;
  INSERT INTO arcade_submissions(match_id, user_id, move_log, claimed_score, validated_score, valid, validation_error)
  VALUES (p_match_id, p_user_id, p_move_log, p_score, p_score, NULL, NULL)
  ON CONFLICT (match_id, user_id) DO UPDATE SET
    move_log = EXCLUDED.move_log, claimed_score = EXCLUDED.claimed_score,
    validated_score = EXCLUDED.validated_score, valid = NULL, validation_error = NULL;
  RETURN jsonb_build_object('ok', true, 'moves', p_expected_moves + 1);
END;
$$;

CREATE OR REPLACE FUNCTION mark_arcade_ready_v1(p_match_id BIGINT, p_user_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_match arcade_matches%ROWTYPE;
BEGIN
  SELECT * INTO v_match FROM arcade_matches WHERE id = p_match_id FOR UPDATE;
  IF v_match.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'match_not_found'); END IF;
  IF v_match.runtime <> 'remote' THEN RETURN jsonb_build_object('ok', false, 'code', 'wrong_runtime'); END IF;
  IF p_user_id NOT IN (v_match.player_a_id, COALESCE(v_match.player_b_id, '')) THEN RETURN jsonb_build_object('ok', false, 'code', 'not_a_player'); END IF;
  IF v_match.status <> 'active' THEN RETURN jsonb_build_object('ok', false, 'code', 'match_not_active'); END IF;
  -- The match clock (started_at) starts when the last required player readies.
  UPDATE arcade_matches SET
    player_a_ready = player_a_ready OR player_a_id IS NOT DISTINCT FROM p_user_id,
    player_b_ready = player_b_ready OR player_b_id IS NOT DISTINCT FROM p_user_id,
    countdown_started_at = CASE
      WHEN mode = 'practice' OR ((player_a_ready OR player_a_id IS NOT DISTINCT FROM p_user_id) AND (player_b_ready OR player_b_id IS NOT DISTINCT FROM p_user_id))
      THEN COALESCE(countdown_started_at, now()) ELSE countdown_started_at END,
    started_at = CASE
      WHEN mode = 'practice' OR ((player_a_ready OR player_a_id IS NOT DISTINCT FROM p_user_id) AND (player_b_ready OR player_b_id IS NOT DISTINCT FROM p_user_id))
      THEN COALESCE(started_at, now()) ELSE started_at END,
    state_version = state_version + 1
  WHERE id = p_match_id RETURNING * INTO v_match;
  RETURN jsonb_build_object('ok', true, 'match', to_jsonb(v_match));
END;
$$;

-- User-initiated cancel. Only a still-waiting match can be cancelled (and,
-- when p_actor_id is given, only by its creator); played matches are settled
-- by submit or expire_stale_arcade_matches_v1, never refunded from here.
-- Retries are idempotent by state (already_cancelled).
DROP FUNCTION IF EXISTS refund_arcade_match_v1(BIGINT, BOOLEAN, TEXT);
CREATE OR REPLACE FUNCTION refund_arcade_match_v1(
  p_match_id BIGINT,
  p_actor_id TEXT DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_match arcade_matches%ROWTYPE;
  v_refunded DOUBLE PRECISION;
BEGIN
  SELECT * INTO v_match FROM arcade_matches WHERE id = p_match_id FOR UPDATE;
  IF v_match.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'match_not_found'); END IF;
  IF v_match.runtime <> 'remote' THEN RETURN jsonb_build_object('ok', false, 'code', 'wrong_runtime'); END IF;
  IF p_actor_id IS NOT NULL AND p_actor_id <> v_match.created_by_id THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_creator');
  END IF;
  IF v_match.status = 'cancelled' THEN
    RETURN jsonb_build_object('ok', true, 'already_cancelled', true, 'match_id', p_match_id);
  END IF;
  IF v_match.status <> 'waiting' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'match_not_cancellable', 'status', v_match.status);
  END IF;
  v_refunded := arcade_refund_escrow_internal(p_match_id);
  UPDATE arcade_matches
     SET status = 'cancelled',
         escrow_status = CASE WHEN mode IN ('staked_pvp', 'tipfight') THEN 'refunded' ELSE escrow_status END,
         state_version = state_version + 1
   WHERE id = p_match_id;
  RETURN jsonb_build_object('ok', true, 'already_cancelled', false, 'match_id', p_match_id, 'refunded_sats', v_refunded);
END;
$$;

CREATE OR REPLACE FUNCTION submit_and_settle_arcade_match_v1(
  p_match_id BIGINT,
  p_user_id TEXT,
  p_move_log JSONB,
  p_claimed_score DOUBLE PRECISION,
  p_validated_score DOUBLE PRECISION,
  p_valid BOOLEAN,
  p_validation_error TEXT DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_match arcade_matches%ROWTYPE;
  v_submitted BOOLEAN;
  v_score DOUBLE PRECISION := CASE WHEN p_valid THEN COALESCE(p_validated_score, 0) ELSE 0 END;
BEGIN
  -- Submission is terminal per player. Accepted while status is active or
  -- submitted (legacy trySettleMatch bails on cancelled/settling), only after
  -- the clock started and until 60s past the deadline; later the cron settles
  -- from drafts. p_idempotency_key is kept for compatibility; retries are
  -- idempotent by state (already_submitted / already_settled).
  SELECT * INTO v_match FROM arcade_matches WHERE id = p_match_id FOR UPDATE;
  IF v_match.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'match_not_found'); END IF;
  IF v_match.runtime <> 'remote' THEN RETURN jsonb_build_object('ok', false, 'code', 'wrong_runtime'); END IF;
  IF p_user_id NOT IN (v_match.player_a_id, COALESCE(v_match.player_b_id, '')) THEN RETURN jsonb_build_object('ok', false, 'code', 'not_a_player'); END IF;
  IF v_match.status = 'completed' THEN
    RETURN jsonb_build_object('ok', true, 'status', CASE WHEN v_match.winner_id IS NULL AND v_match.mode <> 'practice' THEN 'tie' ELSE 'completed' END,
      'match_id', p_match_id, 'winner_id', v_match.winner_id, 'already_settled', true);
  END IF;
  IF v_match.status NOT IN ('active', 'submitted') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'match_not_active', 'status', v_match.status);
  END IF;
  v_submitted := CASE WHEN p_user_id = v_match.player_a_id THEN v_match.player_a_submitted ELSE v_match.player_b_submitted END;
  IF v_submitted THEN
    RETURN jsonb_build_object('ok', true, 'status', 'waiting', 'match_id', p_match_id, 'already_submitted', true);
  END IF;
  IF v_match.started_at IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'not_started'); END IF;
  IF now() > v_match.started_at + make_interval(secs => v_match.duration_seconds + 60) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'deadline_passed');
  END IF;
  IF v_score = 'NaN'::DOUBLE PRECISION OR v_score < 0 THEN v_score := 0; END IF;

  INSERT INTO arcade_submissions(match_id, user_id, move_log, claimed_score, validated_score, valid, validation_error)
  VALUES (p_match_id, p_user_id, COALESCE(p_move_log, '[]'::jsonb), COALESCE(p_claimed_score, 0), v_score, p_valid, p_validation_error)
  ON CONFLICT (match_id, user_id) DO UPDATE SET
    move_log = EXCLUDED.move_log, claimed_score = EXCLUDED.claimed_score,
    validated_score = EXCLUDED.validated_score, valid = EXCLUDED.valid,
    validation_error = EXCLUDED.validation_error;

  UPDATE arcade_matches SET
    player_a_score = CASE WHEN player_a_id = p_user_id THEN v_score ELSE player_a_score END,
    player_b_score = CASE WHEN player_b_id = p_user_id THEN v_score ELSE player_b_score END,
    player_a_submitted = player_a_submitted OR player_a_id IS NOT DISTINCT FROM p_user_id,
    player_b_submitted = player_b_submitted OR player_b_id IS NOT DISTINCT FROM p_user_id,
    status = 'submitted',
    state_version = state_version + 1
  WHERE id = p_match_id RETURNING * INTO v_match;

  IF v_match.mode <> 'practice' AND NOT (v_match.player_a_submitted AND v_match.player_b_submitted) THEN
    RETURN jsonb_build_object('ok', true, 'status', 'waiting', 'match_id', p_match_id);
  END IF;
  RETURN arcade_settle_internal(p_match_id);
END;
$$;

CREATE OR REPLACE FUNCTION request_arcade_rematch_v1(p_match_id BIGINT, p_user_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_parent arcade_matches%ROWTYPE;
  v_child arcade_matches%ROWTYPE;
  v_short TEXT;
  v_debit TEXT;
BEGIN
  -- Parity with src/arcade/db.ts requestRematch(): practice spawns at once,
  -- free_pvp when both ask, tipfight is unsupported, and staked_pvp debits
  -- BOTH stakes in the same transaction that creates the child (created
  -- already active + funded), so an unfunded staked rematch is never playable.
  SELECT * INTO v_parent FROM arcade_matches WHERE id = p_match_id FOR UPDATE;
  IF v_parent.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'match_not_found'); END IF;
  IF v_parent.runtime <> 'remote' THEN RETURN jsonb_build_object('ok', false, 'code', 'wrong_runtime'); END IF;
  IF v_parent.status <> 'completed' THEN RETURN jsonb_build_object('ok', false, 'code', 'match_not_completed'); END IF;
  IF v_parent.mode = 'tipfight' THEN RETURN jsonb_build_object('ok', false, 'code', 'rematch_unsupported'); END IF;
  IF p_user_id NOT IN (v_parent.player_a_id, COALESCE(v_parent.player_b_id, '')) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_a_player');
  END IF;
  IF v_parent.next_match_id IS NOT NULL THEN RETURN jsonb_build_object('ok', true, 'status', 'created', 'next_match_id', v_parent.next_match_id); END IF;

  UPDATE arcade_matches SET
    rematch_requested_by_a = rematch_requested_by_a OR player_a_id IS NOT DISTINCT FROM p_user_id OR mode = 'practice',
    rematch_requested_by_b = rematch_requested_by_b OR player_b_id IS NOT DISTINCT FROM p_user_id
  WHERE id = p_match_id RETURNING * INTO v_parent;
  IF v_parent.mode <> 'practice' AND NOT (v_parent.rematch_requested_by_a AND v_parent.rematch_requested_by_b) THEN
    RETURN jsonb_build_object('ok', true, 'status', 'pending');
  END IF;

  IF v_parent.mode = 'staked_pvp' THEN
    -- Lock both wallets in a stable order and require both stakes up front.
    PERFORM 1 FROM users WHERE discord_id IN (v_parent.player_a_id, v_parent.player_b_id) ORDER BY discord_id FOR UPDATE;
    SELECT id INTO v_short FROM (VALUES (v_parent.player_a_id), (v_parent.player_b_id)) AS p(id)
     WHERE COALESCE((SELECT balance_sats FROM users WHERE discord_id = p.id), 0) < COALESCE(v_parent.stake_amount_sats, 0)
     ORDER BY id LIMIT 1;
    IF v_short IS NOT NULL THEN
      -- Withdraw the underfunded player's request so a retry after a top-up works.
      UPDATE arcade_matches SET
        rematch_requested_by_a = rematch_requested_by_a AND player_a_id <> v_short,
        rematch_requested_by_b = rematch_requested_by_b AND player_b_id <> v_short
      WHERE id = p_match_id;
      RETURN jsonb_build_object('ok', false, 'code', 'insufficient_balance', 'user_id', v_short);
    END IF;
  END IF;

  INSERT INTO arcade_matches(seed, mode, status, channel_id, stake_amount_sats, gross_pot_sats, platform_rake_bps,
    rake_amount_sats, winner_payout_sats, created_by_id, target_player_id, player_a_id, player_b_id,
    escrow_status, duration_seconds, rematch_of_match_id, series_root_id, joined_at, started_at, runtime)
  VALUES (replace(gen_random_uuid()::text, '-', ''), v_parent.mode, 'active',
    v_parent.channel_id, v_parent.stake_amount_sats, v_parent.gross_pot_sats, v_parent.platform_rake_bps,
    v_parent.rake_amount_sats, v_parent.winner_payout_sats, v_parent.created_by_id, v_parent.player_b_id,
    v_parent.player_a_id, v_parent.player_b_id,
    CASE WHEN v_parent.mode = 'staked_pvp' THEN 'pending' ELSE 'none' END,
    v_parent.duration_seconds, v_parent.id, COALESCE(v_parent.series_root_id, v_parent.id), now(),
    CASE WHEN v_parent.mode = 'practice' THEN now() ELSE NULL END, 'remote')
  RETURNING * INTO v_child;

  IF v_parent.mode = 'staked_pvp' THEN
    v_debit := arcade_debit_stake_internal(v_child.id, v_parent.player_a_id, v_parent.stake_amount_sats, v_parent.mode);
    IF v_debit <> 'ok' THEN RAISE EXCEPTION 'rematch funding failed for %: %', v_parent.player_a_id, v_debit USING ERRCODE = 'P0001'; END IF;
    v_debit := arcade_debit_stake_internal(v_child.id, v_parent.player_b_id, v_parent.stake_amount_sats, v_parent.mode);
    IF v_debit <> 'ok' THEN RAISE EXCEPTION 'rematch funding failed for %: %', v_parent.player_b_id, v_debit USING ERRCODE = 'P0001'; END IF;
    UPDATE arcade_matches SET escrow_status = 'funded' WHERE id = v_child.id;
  END IF;
  UPDATE arcade_matches SET next_match_id = v_child.id, state_version = state_version + 1 WHERE id = p_match_id;
  RETURN jsonb_build_object('ok', true, 'status', 'created', 'next_match_id', v_child.id);
END;
$$;

-- Abandoned-match sweeper, called by the games Worker cron. Remote matches
-- only. Waiting matches older than p_waiting_minutes and seated matches whose
-- clock never started within p_waiting_minutes are cancelled and refunded.
-- Started matches past started_at + duration + p_grace_seconds are
-- auto-submitted from each player's server-validated draft (0 when none)
-- and settled.
CREATE OR REPLACE FUNCTION expire_stale_arcade_matches_v1(
  p_waiting_minutes INTEGER DEFAULT 30,
  p_grace_seconds INTEGER DEFAULT 60,
  p_limit INTEGER DEFAULT 50
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_match arcade_matches%ROWTYPE;
  v_cancelled INTEGER := 0;
  v_settled INTEGER := 0;
  v_wait INTERVAL := make_interval(mins => GREATEST(COALESCE(p_waiting_minutes, 30), 1));
  v_grace INTEGER := GREATEST(COALESCE(p_grace_seconds, 60), 5);
  v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 500);
BEGIN
  FOR v_match IN
    SELECT * FROM arcade_matches
     WHERE runtime = 'remote'
       AND ((status = 'waiting' AND created_at < now() - v_wait)
         OR (status = 'active' AND started_at IS NULL AND COALESCE(joined_at, created_at) < now() - v_wait))
     ORDER BY id
     LIMIT v_limit
     FOR UPDATE SKIP LOCKED
  LOOP
    PERFORM arcade_refund_escrow_internal(v_match.id);
    UPDATE arcade_matches
       SET status = 'cancelled',
           escrow_status = CASE WHEN mode IN ('staked_pvp', 'tipfight') THEN 'refunded' ELSE escrow_status END,
           state_version = state_version + 1
     WHERE id = v_match.id;
    v_cancelled := v_cancelled + 1;
  END LOOP;

  FOR v_match IN
    SELECT * FROM arcade_matches
     WHERE runtime = 'remote'
       AND status IN ('active', 'submitted')
       AND started_at IS NOT NULL
       AND started_at + make_interval(secs => duration_seconds + v_grace) < now()
     ORDER BY id
     LIMIT v_limit
     FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE arcade_submissions s
       SET valid = TRUE, validation_error = 'auto_submitted_at_deadline'
      FROM arcade_matches m
     WHERE m.id = v_match.id AND s.match_id = m.id
       AND ((s.user_id = m.player_a_id AND NOT m.player_a_submitted)
         OR (s.user_id = m.player_b_id AND NOT m.player_b_submitted));
    UPDATE arcade_matches m SET
      player_a_score = CASE WHEN m.player_a_submitted THEN m.player_a_score ELSE COALESCE((
        SELECT validated_score FROM arcade_submissions WHERE match_id = m.id AND user_id = m.player_a_id), 0) END,
      player_b_score = CASE WHEN m.player_b_submitted OR m.player_b_id IS NULL THEN m.player_b_score ELSE COALESCE((
        SELECT validated_score FROM arcade_submissions WHERE match_id = m.id AND user_id = m.player_b_id), 0) END,
      player_a_submitted = TRUE,
      player_b_submitted = m.player_b_id IS NOT NULL,
      status = 'submitted',
      state_version = m.state_version + 1
    WHERE m.id = v_match.id;
    PERFORM arcade_settle_internal(v_match.id);
    v_settled := v_settled + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'cancelled', v_cancelled, 'settled', v_settled);
END;
$$;

CREATE OR REPLACE FUNCTION transition_web_arcade_session_v1(
  p_session_id TEXT,
  p_allowed_statuses TEXT[],
  p_expected_version BIGINT,
  p_patch JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_row web_arcade_sessions%ROWTYPE;
BEGIN
  UPDATE web_arcade_sessions SET
    status = COALESCE(p_patch->>'status', status),
    player_b_address = CASE WHEN p_patch ? 'player_b_address' THEN p_patch->>'player_b_address' ELSE player_b_address END,
    winner_address = CASE WHEN p_patch ? 'winner_address' THEN p_patch->>'winner_address' ELSE winner_address END,
    player_a_score = CASE WHEN p_patch ? 'player_a_score' THEN (p_patch->>'player_a_score')::DOUBLE PRECISION ELSE player_a_score END,
    player_b_score = CASE WHEN p_patch ? 'player_b_score' THEN (p_patch->>'player_b_score')::DOUBLE PRECISION ELSE player_b_score END,
    player_a_submitted = COALESCE((p_patch->>'player_a_submitted')::BOOLEAN, player_a_submitted),
    player_b_submitted = COALESCE((p_patch->>'player_b_submitted')::BOOLEAN, player_b_submitted),
    player_a_ready = COALESCE((p_patch->>'player_a_ready')::BOOLEAN, player_a_ready),
    player_b_ready = COALESCE((p_patch->>'player_b_ready')::BOOLEAN, player_b_ready),
    countdown_started_at = CASE WHEN p_patch ? 'countdown_started_at' THEN (p_patch->>'countdown_started_at')::TIMESTAMPTZ ELSE countdown_started_at END,
    updated_at = now(), state_version = state_version + 1
  WHERE id = p_session_id AND status = ANY(p_allowed_statuses) AND state_version = p_expected_version
  RETURNING * INTO v_row;
  IF v_row.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'conflict', true); END IF;
  RETURN jsonb_build_object('ok', true, 'conflict', false, 'session', to_jsonb(v_row));
END;
$$;

-- Earlier drafts had no fencing argument; drop that overload so an unfenced
-- settle path cannot remain callable.
DROP FUNCTION IF EXISTS settle_emulator_round_v1(TEXT, TEXT, JSONB, TEXT);

-- Settles one emulator round. Idempotent per p_round_id (a retry after a lost
-- response returns the stored result). Only the current, unexpired holder of
-- the 'emulator' service lease may settle new rounds (fencing against a
-- deposed instance). Underfunded or unknown voters are skipped, never abort
-- the round; the caller applies the button only when `applied` is non-empty.
CREATE OR REPLACE FUNCTION settle_emulator_round_v1(
  p_round_id TEXT,
  p_holder_id TEXT,
  p_button TEXT,
  p_votes JSONB,
  p_channel_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_vote RECORD;
  v_balance DOUBLE PRECISION;
  v_ledger_id BIGINT;
  v_total DOUBLE PRECISION := 0;
  v_winners JSONB := '[]'::jsonb;
  v_skipped JSONB := '[]'::jsonb;
  v_response JSONB;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('emulator.round:' || p_round_id, 0));
  SELECT response INTO v_response FROM integration_idempotency
   WHERE service = 'emulator.round' AND idempotency_key = p_round_id AND expires_at > now();
  IF v_response IS NOT NULL THEN RETURN v_response; END IF;

  -- Fencing. FOR SHARE blocks a concurrent lease takeover (acquire's
  -- ON CONFLICT DO UPDATE) until this settlement commits.
  PERFORM 1 FROM service_leases
   WHERE lease_name = 'emulator' AND holder_id = p_holder_id AND expires_at > now()
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_lease_holder');
  END IF;

  IF p_button IS NULL OR p_button NOT IN ('A', 'B', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'START', 'SELECT') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'bad_button');
  END IF;
  IF p_votes IS NULL OR jsonb_typeof(p_votes) <> 'array' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'bad_votes');
  END IF;

  FOR v_vote IN
    SELECT user_id, SUM(amount_sats)::DOUBLE PRECISION AS amount_sats
      FROM jsonb_to_recordset(p_votes) AS vote(user_id TEXT, amount_sats DOUBLE PRECISION)
     WHERE user_id IS NOT NULL AND amount_sats > 0
     GROUP BY user_id ORDER BY user_id
  LOOP
    v_balance := NULL;
    SELECT balance_sats INTO v_balance FROM users WHERE discord_id = v_vote.user_id FOR UPDATE;
    -- A missing user or NULL balance counts as insufficient.
    IF v_balance IS NULL OR v_balance < v_vote.amount_sats THEN
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'user_id', v_vote.user_id, 'amount_sats', v_vote.amount_sats,
        'reason', CASE WHEN v_balance IS NULL THEN 'missing_user' ELSE 'insufficient_balance' END));
      CONTINUE;
    END IF;

    -- Debit only when this call actually wrote the ledger row.
    v_ledger_id := NULL;
    INSERT INTO ledger_entries(transaction_id, type, amount_sats, sender_id, receiver_id, guild_id, reference_type, reference_id, metadata)
    VALUES ('emulator-round:' || p_round_id || ':' || v_vote.user_id, 'gameboy_bid', v_vote.amount_sats,
      v_vote.user_id, 'platform', p_channel_id, 'emulator_round', p_round_id, jsonb_build_object('button', p_button))
    ON CONFLICT (transaction_id) DO NOTHING
    RETURNING id INTO v_ledger_id;
    IF v_ledger_id IS NOT NULL THEN
      UPDATE users SET balance_sats = balance_sats - v_vote.amount_sats, updated_at = now() WHERE discord_id = v_vote.user_id;
    END IF;
    -- Either debited now or already paid for this round by an earlier call.
    v_total := v_total + v_vote.amount_sats;
    v_winners := v_winners || jsonb_build_array(v_vote.user_id);
  END LOOP;

  IF jsonb_array_length(v_winners) > 0 THEN
    INSERT INTO integration_events(event_type, aggregate_type, aggregate_id, deduplication_key, payload)
    VALUES ('emulator.round_resolved', 'emulator_round', p_round_id, 'emulator.round_resolved:' || p_round_id,
      jsonb_build_object('version', 1, 'type', 'emulator.round_resolved', 'eventId', gen_random_uuid()::text,
        'occurredAt', now(), 'winningButton', p_button, 'winningSats', v_total, 'winnerIds', v_winners))
    ON CONFLICT (deduplication_key) DO NOTHING;
  END IF;
  v_response := jsonb_build_object('ok', true, 'round_id', p_round_id, 'button', p_button,
    'debited_sats', v_total, 'applied', v_winners, 'skipped', v_skipped);
  INSERT INTO integration_idempotency(service, idempotency_key, response) VALUES ('emulator.round', p_round_id, v_response) ON CONFLICT DO NOTHING;
  RETURN v_response;
END;
$$;

-- Privileges. Supabase grants EXECUTE on new functions to anon and
-- authenticated through default privileges, and REVOKE ... FROM PUBLIC does
-- not undo those role-specific grants. Every *_v1 function in public is
-- therefore revoked from PUBLIC, anon and authenticated (when those roles
-- exist, so plain Postgres/CI without them still works) and granted only to
-- service_role. The loop keys off the name pattern so signature changes in
-- this file cannot silently leave an overload exposed.
DO $$
DECLARE
  v_fn RECORD;
  v_role TEXT;
BEGIN
  FOR v_fn IN
    SELECT p.oid::regprocedure AS signature
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname LIKE '%\_v1' ESCAPE '\'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_fn.signature);
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', v_fn.signature, v_role);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn.signature);
    END IF;
  END LOOP;

  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE integration_events, integration_idempotency, integration_request_nonces, service_leases FROM %I', v_role);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON TABLE integration_events, integration_idempotency, integration_request_nonces, service_leases
      TO service_role;
  END IF;
END;
$$;

-- The bot consumes integration_events by polling claim_integration_events_v1
-- (FOR UPDATE SKIP LOCKED); it does not need Realtime. Keeping the table out
-- of supabase_realtime avoids broadcasting settlement payloads and WAL
-- decoding cost for ~2 emulator rounds/s. Removed here in case an earlier
-- draft of this migration added it.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'integration_events'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE integration_events;
  END IF;
END;
$$;
