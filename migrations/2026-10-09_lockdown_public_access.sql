-- Lock the public schema down to service_role.
--
-- Before this migration most ledger tables (user_token_balances, withdrawals,
-- deposits, tips, ledger_entries, verified_wallets, bot_settings, ...) had RLS
-- off, and Supabase's default privileges gave anon and authenticated full
-- INSERT/UPDATE/DELETE on them. The anon key is public by design (it ships in
-- the deposit page bundle), so anyone could edit balances or withdrawal rows
-- through PostgREST. Every legacy balance function (add_balance,
-- add_token_balance, credit_*_deposit, ...) was also executable by anon.
--
-- This only removes access. service_role (used by the bot, the games Worker
-- and every script; it bypasses RLS) keeps exactly the privileges it had: if a
-- privilege it held came only through PUBLIC, it is re-granted directly, and
-- helpers deliberately closed to it (the *_internal functions) stay closed.
-- The only anon reads that stay open are the columns the deposit page
-- (sbot-deposit) selects, through the existing SELECT policies:
--   users(discord_id, username, display_name, avatar_url, balance_sats)
--   deposit_addresses(discord_id, address)
--
-- Re-runnable. Roles are checked for existence so plain Postgres (CI) works.

DO $$
DECLARE
  v_obj RECORD;
  v_role TEXT;
  v_priv TEXT;
  v_kept TEXT[];
  v_has_service BOOLEAN := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role');
  v_roles TEXT[] := ARRAY(
    SELECT rolname::TEXT FROM pg_roles WHERE rolname IN ('anon', 'authenticated')
  );
BEGIN
  -- Tables and views.
  FOR v_obj IN
    SELECT c.oid, c.oid::regclass AS rel, c.relkind
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
  LOOP
    v_kept := ARRAY[]::TEXT[];
    IF v_has_service THEN
      FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
        IF has_table_privilege('service_role', v_obj.oid, v_priv) THEN
          v_kept := v_kept || v_priv;
        END IF;
      END LOOP;
    END IF;

    IF v_obj.relkind IN ('r', 'p') THEN
      EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', v_obj.rel);
    END IF;
    EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC', v_obj.rel);
    FOREACH v_role IN ARRAY v_roles LOOP
      EXECUTE format('REVOKE ALL ON TABLE %s FROM %I', v_obj.rel, v_role);
    END LOOP;

    FOREACH v_priv IN ARRAY v_kept LOOP
      IF NOT has_table_privilege('service_role', v_obj.oid, v_priv) THEN
        EXECUTE format('GRANT %s ON TABLE %s TO service_role', v_priv, v_obj.rel);
      END IF;
    END LOOP;
  END LOOP;

  -- Sequences.
  FOR v_obj IN
    SELECT c.oid, c.oid::regclass AS rel
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'S'
  LOOP
    v_kept := ARRAY[]::TEXT[];
    IF v_has_service THEN
      FOREACH v_priv IN ARRAY ARRAY['USAGE', 'SELECT', 'UPDATE'] LOOP
        IF has_sequence_privilege('service_role', v_obj.oid, v_priv) THEN
          v_kept := v_kept || v_priv;
        END IF;
      END LOOP;
    END IF;
    EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM PUBLIC', v_obj.rel);
    FOREACH v_role IN ARRAY v_roles LOOP
      EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM %I', v_obj.rel, v_role);
    END LOOP;
    FOREACH v_priv IN ARRAY v_kept LOOP
      IF NOT has_sequence_privilege('service_role', v_obj.oid, v_priv) THEN
        EXECUTE format('GRANT %s ON SEQUENCE %s TO service_role', v_priv, v_obj.rel);
      END IF;
    END LOOP;
  END LOOP;

  -- Functions (extension-owned ones excluded). Trigger functions keep firing:
  -- EXECUTE is only checked when a trigger is created.
  FOR v_obj IN
    SELECT p.oid, p.oid::regprocedure AS fn
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND NOT EXISTS (
         SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e'
       )
  LOOP
    v_kept := CASE
      WHEN v_has_service AND has_function_privilege('service_role', v_obj.oid, 'EXECUTE')
        THEN ARRAY['EXECUTE'] ELSE ARRAY[]::TEXT[] END;
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_obj.fn);
    FOREACH v_role IN ARRAY v_roles LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', v_obj.fn, v_role);
    END LOOP;
    IF cardinality(v_kept) > 0 AND NOT has_function_privilege('service_role', v_obj.oid, 'EXECUTE') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_obj.fn);
    END IF;
  END LOOP;

  -- The deposit page's reads, column by column.
  FOREACH v_role IN ARRAY v_roles LOOP
    IF to_regclass('public.users') IS NOT NULL THEN
      EXECUTE format(
        'GRANT SELECT (discord_id, username, display_name, avatar_url, balance_sats) ON TABLE users TO %I',
        v_role
      );
    END IF;
    IF to_regclass('public.deposit_addresses') IS NOT NULL THEN
      EXECUTE format('GRANT SELECT (discord_id, address) ON TABLE deposit_addresses TO %I', v_role);
    END IF;
  END LOOP;

  -- Objects created later by this role must not inherit anon/authenticated
  -- grants either.
  FOREACH v_role IN ARRAY v_roles LOOP
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', v_role);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', v_role);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', v_role);
  END LOOP;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
END;
$$;

-- The policies the deposit page relies on (created in the dashboard; kept
-- here so a fresh database ends in the same state).
DO $$
BEGIN
  IF to_regclass('public.users') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'users' AND policyname = 'anon_read_users') THEN
    CREATE POLICY anon_read_users ON users FOR SELECT USING (true);
  END IF;
  IF to_regclass('public.deposit_addresses') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'deposit_addresses' AND policyname = 'anon_read_deposit_addresses') THEN
    CREATE POLICY anon_read_deposit_addresses ON deposit_addresses FOR SELECT USING (true);
  END IF;
END;
$$;
