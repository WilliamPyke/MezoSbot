-- Pre-migration snapshot for:
--   1. migrations/2026-09-21_developer_relay_channel_only.sql
--   2. migrations/2026-08-12_modular_runtime.sql
--   3. migrations/2026-09-24_swap_recovery.sql
--
-- READ-ONLY: a single SELECT over catalogs, pg_stat_activity and count(*) of
-- the tables those migrations ALTER or index. It is one statement so the
-- Supabase SQL editor (which only shows the last result set) shows all of it.
-- Columns: section | item | value. Read top to bottom:
--   server     Postgres version and the timeouts this session would run with
--   extension  where pgcrypto lives (Supabase: extensions schema)
--   migration  which of the three migrations already appear applied
--   table      exact row counts / sizes of tables the migrations ALTER/index
--   v1_fn      existing public.*_v1 functions and whether each matches the
--              migration (a name/return mismatch makes CREATE OR REPLACE fail)
--   activity   transactions open > 30 s or idle in transaction (these would
--              block the ALTER TABLE ... ACCESS EXCLUSIVE locks)
--   lock       locks other sessions currently hold on the affected tables

WITH
expected_v1(proname, args, result) AS (
  VALUES
    ('acquire_service_lease_v1', 'p_lease_name text, p_holder_id text, p_ttl_seconds integer', 'boolean'),
    ('claim_integration_events_v1', 'p_worker_id text, p_limit integer, p_lock_seconds integer', 'SETOF integration_events'),
    ('commit_satscape_action_v1', 'p_discord_id text, p_expected_version bigint, p_player_patch jsonb, p_combat_patch jsonb, p_delete_combat boolean, p_inventory_deltas jsonb, p_explored_tiles jsonb, p_cleared_tiles jsonb, p_event jsonb', 'jsonb'),
    ('complete_integration_event_v1', 'p_event_id uuid, p_worker_id text, p_success boolean, p_error text', 'boolean'),
    ('consume_integration_nonce_v1', 'p_service text, p_nonce text, p_expires_at timestamp with time zone', 'boolean'),
    ('create_arcade_match_v1', 'p_mode text, p_created_by_id text, p_target_player_id text, p_stake_sats double precision, p_channel_id text, p_duration_seconds integer, p_idempotency_key text', 'jsonb'),
    ('expire_stale_arcade_matches_v1', 'p_waiting_minutes integer, p_grace_seconds integer, p_limit integer', 'jsonb'),
    ('fund_arcade_match_v1', 'p_match_id bigint, p_user_id text, p_amount_sats double precision, p_idempotency_key text', 'jsonb'),
    ('get_arcade_view_v1', 'p_match_id bigint, p_user_id text', 'jsonb'),
    ('get_satscape_action_snapshot_v1', 'p_discord_id text, p_radius integer', 'jsonb'),
    ('get_satscape_view_v1', 'p_discord_id text, p_radius integer', 'jsonb'),
    ('idempotency_begin_v1', 'p_service text, p_key text, p_request jsonb', 'jsonb'),
    ('idempotency_finish_v1', 'p_service text, p_key text, p_request jsonb, p_response jsonb', 'jsonb'),
    ('idempotency_request_hash_v1', 'p_request jsonb', 'text'),
    ('join_arcade_match_v1', 'p_match_id bigint, p_user_id text', 'jsonb'),
    ('mark_arcade_ready_v1', 'p_match_id bigint, p_user_id text', 'jsonb'),
    ('purge_integration_state_v1', 'p_batch integer', 'jsonb'),
    ('refund_arcade_match_v1', 'p_match_id bigint, p_actor_id text, p_idempotency_key text', 'jsonb'),
    ('release_service_lease_v1', 'p_lease_name text, p_holder_id text', 'boolean'),
    ('request_arcade_rematch_v1', 'p_match_id bigint, p_user_id text', 'jsonb'),
    ('save_arcade_draft_v1', 'p_match_id bigint, p_user_id text, p_move_log jsonb, p_score double precision, p_expected_moves integer', 'jsonb'),
    ('settle_emulator_round_v1', 'p_round_id text, p_holder_id text, p_button text, p_votes jsonb, p_channel_id text', 'jsonb'),
    ('start_satscape_run_v1', 'p_discord_id text, p_buyin_sats double precision, p_spawn_x integer, p_spawn_y integer', 'jsonb'),
    ('submit_and_settle_arcade_match_v1', 'p_match_id bigint, p_user_id text, p_move_log jsonb, p_claimed_score double precision, p_validated_score double precision, p_valid boolean, p_validation_error text, p_idempotency_key text', 'jsonb'),
    ('transition_web_arcade_session_v1', 'p_session_id text, p_allowed_statuses text[], p_expected_version bigint, p_patch jsonb', 'jsonb')
),
existing_v1 AS (
  SELECT p.oid, p.proname, p.oid::regprocedure::text AS sig,
         pg_get_function_identity_arguments(p.oid) AS args,
         pg_get_function_result(p.oid) AS result,
         p.prosecdef
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname LIKE '%\_v1' ESCAPE '\'
),
col AS (
  SELECT c.relname, a.attname, a.attnotnull, pg_get_expr(d.adbin, d.adrelid) AS default_expr
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE a.attnum > 0 AND NOT a.attisdropped
     AND (c.relname, a.attname) IN (
       ('developer_relay_routes', 'private_thread_id'),
       ('arcade_matches', 'runtime'), ('arcade_matches', 'state_version'), ('arcade_matches', 'joined_at'),
       ('sat_players', 'state_version'), ('web_arcade_sessions', 'state_version'))
),
modular AS (
  SELECT
    (SELECT count(*) FROM col WHERE (relname, attname) IN (('arcade_matches', 'runtime'), ('arcade_matches', 'state_version'),
       ('arcade_matches', 'joined_at'), ('sat_players', 'state_version'), ('web_arcade_sessions', 'state_version'))) AS cols,
    (SELECT count(*) FROM unnest(ARRAY['integration_events', 'integration_idempotency', 'integration_request_nonces', 'service_leases']) t
      WHERE to_regclass('public.' || t) IS NOT NULL) AS tables,
    (SELECT count(*) FROM expected_v1 e JOIN existing_v1 x ON x.proname = e.proname AND x.args = e.args AND x.result = e.result) AS fns,
    (SELECT count(*) FROM pg_constraint WHERE conname = 'arcade_matches_runtime_check') AS chk
),
swaprec AS (
  SELECT
    to_regclass('public.swaps') IS NOT NULL AS has_swaps,
    COALESCE((SELECT position('''needs_review''' IN pg_get_constraintdef(oid)) > 0 FROM pg_constraint
               WHERE conrelid = to_regclass('public.swaps') AND conname = 'swaps_status_check'), FALSE) AS check_ok,
    (SELECT count(*) FROM unnest(ARRAY['idx_swaps_recovery_updated', 'idx_swaps_needs_review']) i
      WHERE to_regclass('public.' || i) IS NOT NULL) AS idx,
    (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN ('execute_internal_swap', 'credit_swap_output', 'refund_swap_reservation', 'get_token_liabilities')
        AND position('needs_review' IN p.prosrc) > 0) AS fns
),
target_tables(relname) AS (
  VALUES ('developer_relay_routes'), ('sat_players'), ('arcade_matches'), ('web_arcade_sessions'),
         ('sat_world_entities'), ('swaps'), ('integration_events'), ('integration_idempotency'),
         ('integration_request_nonces'), ('service_leases')
),
rows AS (
  -- server -----------------------------------------------------------------
  SELECT 1 AS ord, 'server' AS section, 'version' AS item, version() AS value
  UNION ALL SELECT 1, 'server', 'server_version_num', current_setting('server_version_num')
  UNION ALL SELECT 1, 'server', 'current_user', current_user::text
  UNION ALL SELECT 1, 'server', 'lock_timeout', current_setting('lock_timeout')
  UNION ALL SELECT 1, 'server', 'statement_timeout', current_setting('statement_timeout')
  UNION ALL SELECT 1, 'server', 'roles present (service_role, anon, authenticated)',
    (SELECT string_agg(r, ', ' ORDER BY r) FROM unnest(ARRAY['service_role', 'anon', 'authenticated']) r
      WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r))
  UNION ALL SELECT 1, 'server', 'supabase_realtime publication',
    CASE WHEN EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN 'exists' ELSE 'absent' END

  -- extension ---------------------------------------------------------------
  UNION ALL SELECT 2, 'extension', 'pgcrypto',
    COALESCE((SELECT 'installed in schema ' || n.nspname || ' (v' || e.extversion || ')'
                FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
               WHERE e.extname = 'pgcrypto'),
             'NOT installed (migration will CREATE EXTENSION pgcrypto into the first schema on search_path)')
  UNION ALL SELECT 2, 'extension', 'pg_catalog.gen_random_uuid() available (PG13+)',
    CASE WHEN to_regprocedure('pg_catalog.gen_random_uuid()') IS NOT NULL THEN 'yes' ELSE 'NO' END
  UNION ALL SELECT 2, 'extension', 'uuid-ossp',
    COALESCE((SELECT 'installed in schema ' || n.nspname
                || CASE WHEN n.nspname = 'public' THEN ' (uuid_generate_v1() matches *_v1 and WILL be revoked from anon/authenticated)' ELSE '' END
                FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
               WHERE e.extname = 'uuid-ossp'), 'not installed')

  -- migration ---------------------------------------------------------------
  UNION ALL SELECT 3, 'migration', 'prereq 2026-07-28_developer_relay (developer_relay_routes)',
    CASE WHEN to_regclass('public.developer_relay_routes') IS NOT NULL THEN 'present' ELSE 'MISSING' END
  UNION ALL SELECT 3, 'migration', '1. 2026-09-21_developer_relay_channel_only',
    COALESCE((SELECT CASE WHEN attnotnull THEN 'NOT applied (private_thread_id is NOT NULL)'
                          ELSE 'applied (private_thread_id nullable)' END
                FROM col WHERE relname = 'developer_relay_routes' AND attname = 'private_thread_id'),
             'n/a: developer_relay_routes.private_thread_id missing')
  UNION ALL SELECT 3, 'migration', '2. 2026-08-12_modular_runtime',
    (SELECT CASE
              WHEN cols = 5 AND tables = 4 AND fns = 25 AND chk = 1 THEN 'applied'
              WHEN cols = 0 AND tables = 0 AND fns = 0 AND chk = 0 THEN 'NOT applied'
              ELSE 'PARTIAL'
            END || format(' (columns %s/5, tables %s/4, matching *_v1 fns %s/25, runtime check %s/1)', cols, tables, fns, chk)
       FROM modular)
  UNION ALL SELECT 3, 'migration', '   arcade_matches.runtime',
    COALESCE((SELECT format('exists, not null=%s, default=%s', attnotnull, default_expr)
                FROM col WHERE relname = 'arcade_matches' AND attname = 'runtime'), 'absent')
  UNION ALL SELECT 3, 'migration', 'prereq 2026-08-03_token_swaps (swaps)',
    CASE WHEN (SELECT has_swaps FROM swaprec) THEN 'present' ELSE 'MISSING (apply 2026-08-03 first)' END
  UNION ALL SELECT 3, 'migration', '3. 2026-09-24_swap_recovery',
    (SELECT CASE
              WHEN check_ok AND idx = 2 AND fns = 4 THEN 'applied'
              WHEN NOT check_ok AND idx = 0 AND fns = 0 THEN 'NOT applied'
              ELSE 'PARTIAL'
            END || format(' (status check allows needs_review=%s, indexes %s/2, swap fns updated %s/4)', check_ok, idx, fns)
       FROM swaprec)
  UNION ALL SELECT 3, 'migration', '   swaps_status_check',
    COALESCE((SELECT pg_get_constraintdef(oid) FROM pg_constraint
               WHERE conrelid = to_regclass('public.swaps') AND conname = 'swaps_status_check'), 'absent')

  -- table -------------------------------------------------------------------
  UNION ALL
  SELECT 4, 'table', t.relname,
    CASE WHEN to_regclass('public.' || t.relname) IS NULL THEN 'absent'
         ELSE format('rows=%s size=%s realtime=%s',
           (xpath('/row/n/text()',
              query_to_xml(format('SELECT count(*) AS n FROM public.%I', t.relname), false, true, '')))[1]::text,
           pg_size_pretty(pg_total_relation_size(to_regclass('public.' || t.relname))),
           EXISTS (SELECT 1 FROM pg_publication_tables pt
                    WHERE pt.pubname = 'supabase_realtime' AND pt.schemaname = 'public' AND pt.tablename = t.relname))
    END
    FROM target_tables t

  -- v1_fn -------------------------------------------------------------------
  UNION ALL
  SELECT 5, 'v1_fn', x.sig,
    CASE
      WHEN x.sig IN ('save_arcade_draft_v1(bigint,text,jsonb,double precision)',
                     'refund_arcade_match_v1(bigint,boolean,text)',
                     'settle_emulator_round_v1(text,text,jsonb,text)')
        THEN 'earlier-draft overload; the migration DROPs it'
      WHEN e.proname IS NULL AND NOT EXISTS (SELECT 1 FROM expected_v1 e2 WHERE e2.proname = x.proname)
        THEN 'NOT from this migration; will be revoked from PUBLIC/anon/authenticated'
      WHEN e.proname IS NULL
        THEN 'overload not in migration (stale draft?); will stay but be revoked; expected '
             || (SELECT string_agg(e2.args || ' -> ' || e2.result, ' | ') FROM expected_v1 e2 WHERE e2.proname = x.proname)
      WHEN x.args = e.args AND x.result = e.result THEN 'matches migration'
      ELSE format('DIFFERS: have (%s) -> %s, migration has (%s) -> %s; CREATE OR REPLACE will fail', x.args, x.result, e.args, e.result)
    END
    || format(' [secdef=%s anon=%s authenticated=%s service_role=%s]', x.prosecdef,
         CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN has_function_privilege('anon', x.oid, 'EXECUTE')::text ELSE 'n/a' END,
         CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN has_function_privilege('authenticated', x.oid, 'EXECUTE')::text ELSE 'n/a' END,
         CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN has_function_privilege('service_role', x.oid, 'EXECUTE')::text ELSE 'n/a' END)
    FROM existing_v1 x
    LEFT JOIN expected_v1 e
      ON e.proname = x.proname
     AND regexp_replace(e.args, '(^|, )p_[a-z_]+ ', '\1', 'g') = regexp_replace(x.args, '(^|, )p_[a-z_]+ ', '\1', 'g')
  UNION ALL
  SELECT 5, 'v1_fn', 'count of existing public.*_v1 functions', (SELECT count(*)::text FROM existing_v1)

  -- activity ----------------------------------------------------------------
  UNION ALL
  SELECT 6, 'activity', format('pid %s %s/%s', a.pid, a.usename, COALESCE(NULLIF(a.application_name, ''), a.backend_type)),
    format('state=%s xact_age=%s wait=%s:%s query=%s', a.state,
      date_trunc('second', now() - a.xact_start), a.wait_event_type, a.wait_event,
      left(regexp_replace(COALESCE(a.query, ''), '\s+', ' ', 'g'), 160))
    FROM pg_stat_activity a
   WHERE a.pid <> pg_backend_pid()
     AND a.xact_start IS NOT NULL
     AND (a.xact_start < now() - interval '30 seconds' OR a.state LIKE 'idle in transaction%')
  UNION ALL
  SELECT 6, 'activity', 'transactions open > 30 s or idle in transaction',
    (SELECT count(*)::text FROM pg_stat_activity a
      WHERE a.pid <> pg_backend_pid() AND a.xact_start IS NOT NULL
        AND (a.xact_start < now() - interval '30 seconds' OR a.state LIKE 'idle in transaction%'))

  -- lock --------------------------------------------------------------------
  UNION ALL
  SELECT 7, 'lock', format('%s pid %s', c.relname, l.pid),
    format('%s granted=%s', l.mode, l.granted)
    FROM pg_locks l
    JOIN pg_class c ON c.oid = l.relation
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    JOIN target_tables t ON t.relname = c.relname
   WHERE l.pid <> pg_backend_pid()
)
SELECT section, item, value FROM rows ORDER BY ord, section, item;
