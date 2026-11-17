-- Prerequisite for a SQL login restricted to analytics.warehouse.
-- Run by Supabase support as the managed superuser (supabase_admin).
-- Project postgres cannot revoke PUBLIC's net-schema grant: the operation is a no-op.
-- Preserves the effective schema access of every existing role except the new reader.
-- New roles will subsequently need explicit schema USAGE grants.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
DO $$
DECLARE
  schema_name text;
  recipients text;
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'Managed superuser required to change the net schema ACL';
  END IF;
  SELECT string_agg(quote_ident(rolname), ', ' ORDER BY rolname) INTO recipients
  FROM pg_roles WHERE rolname NOT IN ('analytics_reader', 'warehouse_analytics_owner');

  FOREACH schema_name IN ARRAY ARRAY['public', 'net'] LOOP
    IF EXISTS (SELECT FROM pg_namespace n, LATERAL aclexplode(n.nspacl) a
      WHERE n.nspname = schema_name AND a.grantee = 0 AND a.privilege_type = 'USAGE') THEN
      EXECUTE format('GRANT USAGE ON SCHEMA %I TO %s', schema_name, recipients);
      EXECUTE format('REVOKE USAGE ON SCHEMA %I FROM PUBLIC', schema_name);
    END IF;
  END LOOP;
  GRANT USAGE ON SCHEMA public TO warehouse_analytics_owner;
  IF has_schema_privilege('analytics_reader', 'net', 'USAGE')
    OR has_schema_privilege('analytics_reader', 'public', 'USAGE') THEN
    RAISE EXCEPTION 'Reader still has inherited access outside analytics';
  END IF;
END $$;
COMMIT;
