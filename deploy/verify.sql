-- Post-migration verification for:
--   migrations/2026-09-21_developer_relay_channel_only.sql
--   migrations/2026-08-12_modular_runtime.sql
--   migrations/2026-09-24_swap_recovery.sql
--
-- READ-ONLY: only catalog lookups; the DO block switches its transaction to
-- read-only before checking anything. Safe to run in the Supabase SQL editor
-- or with psql. Every problem found is collected and raised together, e.g.
--   ERROR: verify FAILED (2 problems): missing function public.x_v1(...); ...
-- The last statement prints 'verify ok' only when the DO block succeeded,
-- even if psql is run without ON_ERROR_STOP.

SELECT set_config('mezo.verify_result', 'not run', false);

DO $$
DECLARE
  v_errors TEXT[] := ARRAY[]::TEXT[];
  v_sig TEXT;
  v_oid OID;
  v_fn RECORD;
  v_role TEXT;
  v_tbl TEXT;
  v_priv TEXT;
  v_rel OID;
  v_def TEXT;
  v_count INTEGER;
  v_exists INTEGER;
  -- Every *_v1 function created by 2026-08-12_modular_runtime.sql.
  v_expected TEXT[] := ARRAY[
    'acquire_service_lease_v1(text,text,integer)',
    'claim_integration_events_v1(text,integer,integer)',
    'commit_satscape_action_v1(text,bigint,jsonb,jsonb,boolean,jsonb,jsonb,jsonb,jsonb)',
    'complete_integration_event_v1(uuid,text,boolean,text)',
    'consume_integration_nonce_v1(text,text,timestamp with time zone)',
    'create_arcade_match_v1(text,text,text,double precision,text,integer,text)',
    'expire_stale_arcade_matches_v1(integer,integer,integer)',
    'fund_arcade_match_v1(bigint,text,double precision,text)',
    'get_arcade_view_v1(bigint,text)',
    'get_satscape_action_snapshot_v1(text,integer)',
    'get_satscape_view_v1(text,integer)',
    'idempotency_begin_v1(text,text,jsonb)',
    'idempotency_finish_v1(text,text,jsonb,jsonb)',
    'idempotency_request_hash_v1(jsonb)',
    'join_arcade_match_v1(bigint,text)',
    'mark_arcade_ready_v1(bigint,text)',
    'purge_integration_state_v1(integer)',
    'refund_arcade_match_v1(bigint,text,text)',
    'release_service_lease_v1(text,text)',
    'request_arcade_rematch_v1(bigint,text)',
    'save_arcade_draft_v1(bigint,text,jsonb,double precision,integer)',
    'settle_emulator_round_v1(text,text,text,jsonb,text)',
    'start_satscape_run_v1(text,double precision,integer,integer)',
    'submit_and_settle_arcade_match_v1(bigint,text,jsonb,double precision,double precision,boolean,text,text)',
    'transition_web_arcade_session_v1(text,text[],bigint,jsonb)'
  ];
  -- Earlier-draft overloads the migration drops; none may remain callable.
  v_stale TEXT[] := ARRAY[
    'save_arcade_draft_v1(bigint,text,jsonb,double precision)',
    'refund_arcade_match_v1(bigint,boolean,text)',
    'settle_emulator_round_v1(text,text,jsonb,text)'
  ];
  -- Internal helpers: callable only from the SECURITY DEFINER RPCs.
  v_internal TEXT[] := ARRAY[
    'mezo_round_sats(double precision)',
    'arcade_debit_stake_internal(bigint,text,double precision,text)',
    'arcade_refund_escrow_internal(bigint)',
    'arcade_settle_internal(bigint)'
  ];
BEGIN
  SET LOCAL transaction_read_only = on;

  -- Roles -------------------------------------------------------------------
  FOREACH v_role IN ARRAY ARRAY['service_role', 'anon', 'authenticated'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      v_errors := v_errors || format('role %s does not exist', v_role);
    END IF;
  END LOOP;
  IF cardinality(v_errors) > 0 THEN
    RAISE EXCEPTION 'verify FAILED (% problems): %', cardinality(v_errors), array_to_string(v_errors, '; ');
  END IF;

  -- *_v1 functions: present, service_role only ------------------------------
  FOREACH v_sig IN ARRAY v_expected LOOP
    v_oid := to_regprocedure('public.' || v_sig);
    IF v_oid IS NULL THEN
      v_errors := v_errors || format('missing function public.%s', v_sig);
    ELSIF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
      v_errors := v_errors || format('service_role cannot execute public.%s', v_sig);
    END IF;
  END LOOP;

  FOR v_fn IN
    SELECT p.oid, p.oid::regprocedure::text AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname LIKE '%\_v1' ESCAPE '\'
  LOOP
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_function_privilege(v_role, v_fn.oid, 'EXECUTE') THEN
        v_errors := v_errors || format('%s can execute %s', v_role, v_fn.sig);
      END IF;
    END LOOP;
  END LOOP;

  FOREACH v_sig IN ARRAY v_stale LOOP
    IF to_regprocedure('public.' || v_sig) IS NOT NULL THEN
      v_errors := v_errors || format('stale draft overload still exists: public.%s', v_sig);
    END IF;
  END LOOP;

  FOREACH v_sig IN ARRAY v_internal LOOP
    v_oid := to_regprocedure('public.' || v_sig);
    IF v_oid IS NULL THEN
      v_errors := v_errors || format('missing internal function public.%s', v_sig);
    ELSE
      FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
        IF has_function_privilege(v_role, v_oid, 'EXECUTE') THEN
          v_errors := v_errors || format('%s can execute internal public.%s', v_role, v_sig);
        END IF;
      END LOOP;
    END IF;
  END LOOP;

  -- Integration tables: RLS on, no anon/authenticated grants ---------------
  FOREACH v_tbl IN ARRAY ARRAY['integration_events', 'integration_idempotency', 'integration_request_nonces', 'service_leases'] LOOP
    v_rel := to_regclass('public.' || v_tbl);
    IF v_rel IS NULL THEN
      v_errors := v_errors || format('missing table public.%s', v_tbl);
      CONTINUE;
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = v_rel) THEN
      v_errors := v_errors || format('RLS is not enabled on public.%s', v_tbl);
    END IF;
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
        IF has_table_privilege(v_role, v_rel, v_priv) THEN
          v_errors := v_errors || format('%s has %s on public.%s', v_role, v_priv, v_tbl);
        END IF;
      END LOOP;
    END LOOP;
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      IF NOT has_table_privilege('service_role', v_rel, v_priv) THEN
        v_errors := v_errors || format('service_role lacks %s on public.%s', v_priv, v_tbl);
      END IF;
    END LOOP;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'integration_events'
  ) THEN
    v_errors := v_errors || 'integration_events is in the supabase_realtime publication'::TEXT;
  END IF;

  -- arcade_matches.runtime + state_version columns --------------------------
  SELECT pg_get_expr(d.adbin, d.adrelid), COUNT(*) FILTER (WHERE a.attnotnull)
    INTO v_def, v_count
    FROM pg_attribute a
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE a.attrelid = to_regclass('public.arcade_matches') AND a.attname = 'runtime' AND NOT a.attisdropped
   GROUP BY 1;
  IF NOT FOUND THEN
    v_errors := v_errors || 'arcade_matches.runtime does not exist'::TEXT;
  ELSE
    IF v_def IS DISTINCT FROM '''legacy''::text' THEN
      v_errors := v_errors || format('arcade_matches.runtime default is %s, expected ''legacy''', COALESCE(v_def, 'NULL'));
    END IF;
    IF v_count = 0 THEN
      v_errors := v_errors || 'arcade_matches.runtime is nullable'::TEXT;
    END IF;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = to_regclass('public.arcade_matches') AND conname = 'arcade_matches_runtime_check'
  ) THEN
    v_errors := v_errors || 'constraint arcade_matches_runtime_check is missing'::TEXT;
  END IF;
  FOREACH v_tbl IN ARRAY ARRAY['sat_players', 'arcade_matches', 'web_arcade_sessions'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_attribute
       WHERE attrelid = to_regclass('public.' || v_tbl) AND attname = 'state_version' AND NOT attisdropped
    ) THEN
      v_errors := v_errors || format('%s.state_version does not exist', v_tbl);
    END IF;
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = to_regclass('public.arcade_matches') AND attname = 'joined_at' AND NOT attisdropped
  ) THEN
    v_errors := v_errors || 'arcade_matches.joined_at does not exist'::TEXT;
  END IF;

  -- swaps: status CHECK allows needs_review; RPCs and indexes updated -------
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint
   WHERE conrelid = to_regclass('public.swaps') AND conname = 'swaps_status_check';
  IF v_def IS NULL THEN
    v_errors := v_errors || 'constraint swaps_status_check is missing'::TEXT;
  ELSIF position('''needs_review''' IN v_def) = 0 THEN
    v_errors := v_errors || format('swaps_status_check does not allow needs_review: %s', v_def);
  END IF;
  -- No other CHECK on swaps.status may still exclude needs_review.
  FOR v_fn IN
    SELECT c.conname, pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint c
     WHERE c.conrelid = to_regclass('public.swaps') AND c.contype = 'c'
       AND c.conname <> 'swaps_status_check'
       AND (SELECT attnum FROM pg_attribute WHERE attrelid = c.conrelid AND attname = 'status') = ANY (c.conkey)
       AND position('''needs_review''' IN pg_get_constraintdef(c.oid)) = 0
  LOOP
    v_errors := v_errors || format('extra CHECK %s on swaps.status excludes needs_review', v_fn.conname);
  END LOOP;
  FOREACH v_sig IN ARRAY ARRAY[
    'execute_internal_swap(uuid,text,text,text,double precision,double precision,double precision,double precision,double precision,double precision)',
    'credit_swap_output(uuid,double precision,double precision,text,double precision)',
    'refund_swap_reservation(uuid,text)',
    'get_token_liabilities()'
  ] LOOP
    v_oid := to_regprocedure('public.' || v_sig);
    IF v_oid IS NULL THEN
      v_errors := v_errors || format('missing swap function public.%s', v_sig);
    ELSIF position('needs_review' IN (SELECT prosrc FROM pg_proc WHERE oid = v_oid)) = 0 THEN
      v_errors := v_errors || format('public.%s was not updated for needs_review', v_sig);
    END IF;
  END LOOP;
  FOREACH v_tbl IN ARRAY ARRAY['idx_swaps_recovery_updated', 'idx_swaps_needs_review'] LOOP
    IF to_regclass('public.' || v_tbl) IS NULL THEN
      v_errors := v_errors || format('missing index %s', v_tbl);
    END IF;
  END LOOP;

  -- developer_relay_routes.private_thread_id nullable -----------------------
  SELECT COUNT(*) FILTER (WHERE attnotnull), COUNT(*) INTO v_count, v_exists
    FROM pg_attribute
   WHERE attrelid = to_regclass('public.developer_relay_routes') AND attname = 'private_thread_id' AND NOT attisdropped;
  IF v_exists = 0 THEN
    v_errors := v_errors || 'developer_relay_routes.private_thread_id does not exist'::TEXT;
  ELSIF v_count > 0 THEN
    v_errors := v_errors || 'developer_relay_routes.private_thread_id is still NOT NULL'::TEXT;
  END IF;

  IF cardinality(v_errors) > 0 THEN
    RAISE EXCEPTION 'verify FAILED (% problems): %', cardinality(v_errors), array_to_string(v_errors, '; ');
  END IF;
  PERFORM set_config('mezo.verify_result', 'ok', false);
END;
$$;

SELECT CASE WHEN current_setting('mezo.verify_result', true) = 'ok'
            THEN 'verify ok'
            ELSE 'verify FAILED (see error above)' END AS result;
