-- Apply transactionally via provisionCrmAnalytics.cjs. Existing sync data is unchanged.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='crm_analytics_owner') THEN
    CREATE ROLE crm_analytics_owner NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    COMMENT ON ROLE crm_analytics_owner IS 'wareongo.crm-analytics.v1: masked CRM view owner';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='crm_analytics_reader') THEN
    CREATE ROLE crm_analytics_reader NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 15;
    COMMENT ON ROLE crm_analytics_reader IS 'wareongo.crm-analytics.v1: CRM analytics; inherited PUBLIC extension access must be reviewed';
  END IF;
END $$;
-- statement-breakpoint
-- Data Studio opens concurrent chart connections; five slots were exhausted by
-- pooled/idle sessions. Keep this bounded and consistent for existing roles.
ALTER ROLE crm_analytics_reader CONNECTION LIMIT 15;
-- statement-breakpoint
GRANT crm_analytics_owner,crm_analytics_reader TO postgres WITH INHERIT FALSE, SET TRUE;
-- statement-breakpoint
GRANT USAGE,CREATE ON SCHEMA analytics TO crm_analytics_owner;
-- statement-breakpoint
GRANT USAGE ON SCHEMA public TO crm_analytics_owner;
-- statement-breakpoint
GRANT USAGE ON SCHEMA analytics TO crm_analytics_reader;
-- statement-breakpoint
GRANT CONNECT ON DATABASE postgres TO crm_analytics_reader;
-- statement-breakpoint
ALTER ROLE crm_analytics_reader IN DATABASE postgres SET search_path=pg_catalog,analytics;
-- statement-breakpoint
ALTER ROLE crm_analytics_reader IN DATABASE postgres SET statement_timeout='60s';
-- statement-breakpoint
ALTER ROLE crm_analytics_reader IN DATABASE postgres SET idle_in_transaction_session_timeout='60s';
-- statement-breakpoint
ALTER ROLE crm_analytics_reader IN DATABASE postgres SET default_transaction_read_only=on;
-- statement-breakpoint
GRANT SELECT (opportunity_id,data,stage,assignee_email,name,priority,city,company_name,assigned_to,owner_id,
  last_contacted,next_follow_up,twenty_created_at,twenty_updated_at,deleted_at,stage_entered_at,
  last_meaningful_update_at,last_meaningful_update_kind,last_meaningful_update_by,last_note_at,last_note_text,
  last_task_at,first_seen_at,last_polled_at,closure_sent_at) ON public.opportunities TO crm_analytics_owner;
-- statement-breakpoint
GRANT SELECT (id,opportunity_id,from_stage,to_stage,changed_at,detected_at) ON public.stage_transitions TO crm_analytics_owner;
-- statement-breakpoint
GRANT SELECT ON public.crm_records TO crm_analytics_owner;
-- statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_policy WHERE polrelid='public.opportunities'::regclass AND polname='crm_analytics_owner_select') THEN
    CREATE POLICY crm_analytics_owner_select ON public.opportunities FOR SELECT TO crm_analytics_owner USING (true);
  END IF;
  IF NOT EXISTS (SELECT FROM pg_policy WHERE polrelid='public.stage_transitions'::regclass AND polname='crm_analytics_owner_select') THEN
    CREATE POLICY crm_analytics_owner_select ON public.stage_transitions FOR SELECT TO crm_analytics_owner USING (true);
  END IF;
  IF NOT EXISTS (SELECT FROM pg_policy WHERE polrelid='public.crm_records'::regclass AND polname='crm_analytics_owner_select') THEN
    CREATE POLICY crm_analytics_owner_select ON public.crm_records FOR SELECT TO crm_analytics_owner USING (true);
  END IF;
END $$;
-- statement-breakpoint
SET LOCAL ROLE crm_analytics_owner;
-- statement-breakpoint
CREATE OR REPLACE FUNCTION analytics.crm_mask_text(value text, mask_phone_patterns boolean DEFAULT true)
RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE masked text;
BEGIN
  masked := regexp_replace(value, '[A-Za-z0-9._%+!#$&''*/=?^`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '[REDACTED EMAIL]', 'g');
  IF mask_phone_patterns THEN
    masked := regexp_replace(masked, '(?<![[:alnum:]])\+?[0-9](?:[ .()-]*[0-9]){9,14}(?![[:alnum:]])', '[REDACTED PHONE]', 'g');
  END IF;
  RETURN masked;
END $$;
-- statement-breakpoint
CREATE OR REPLACE FUNCTION analytics.crm_mask_json(value jsonb, field_name text DEFAULT '', contact_field boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE STRICT SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE result jsonb; entry record; normalized text; sensitive boolean; text_value text;
BEGIN
  normalized := regexp_replace(lower(field_name), '[^a-z0-9]', '', 'g');
  -- These relations describe internal team members, not client contacts.
  IF normalized IN ('owner','createdby','updatedby','assignee','assignedto','secondaryassignee') THEN RETURN value; END IF;
  -- Preserve phone-country/calling metadata and flags while masking actual numbers.
  IF normalized IN ('primaryphonecountrycode','primaryphonecallingcode','countrycode','callingcode') THEN RETURN value; END IF;
  -- Twenty search vectors contain tokenized contacts, including email fragments.
  -- They are derived search indexes, so keep the key but mask non-empty values.
  IF normalized='searchvector' AND value NOT IN ('null'::jsonb,'""'::jsonb) THEN
    RETURN to_jsonb('[REDACTED CONTACT INDEX]'::text);
  END IF;
  sensitive := contact_field OR normalized ~ '(email|phone|mobile|whatsapp|contactnumber|contactno)';
  CASE jsonb_typeof(value)
    WHEN 'object' THEN
      result := '{}'::jsonb;
      FOR entry IN SELECT key,val FROM jsonb_each(value) AS x(key,val) LOOP
        result := result || jsonb_build_object(entry.key,analytics.crm_mask_json(entry.val,CASE WHEN entry.key IN ('before','after') THEN field_name ELSE entry.key END,sensitive));
      END LOOP;
      RETURN result;
    WHEN 'array' THEN
      SELECT COALESCE(jsonb_agg(analytics.crm_mask_json(element,field_name,sensitive) ORDER BY ordinality),'[]'::jsonb)
        INTO result FROM jsonb_array_elements(value) WITH ORDINALITY AS a(element,ordinality);
      RETURN result;
    WHEN 'null' THEN RETURN value;
    WHEN 'boolean' THEN RETURN value;
    ELSE
      text_value := value #>> '{}';
      IF sensitive AND NULLIF(btrim(text_value),'') IS NOT NULL THEN RETURN to_jsonb('[REDACTED]'::text); END IF;
      IF jsonb_typeof(value)<>'string' THEN RETURN value; END IF;
      -- Preserve UUIDs, ISO dates, typed amounts and coordinates exactly.
      -- Other raw strings are scanned, including rich-text JSON and attachment URLs.
      RETURN to_jsonb(analytics.crm_mask_text(text_value, NOT (
        normalized IN ('id','budget','amount','amountmicros','position','latitude','longitude','requirementinsft')
        OR normalized ~ 'id$'
        OR text_value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR text_value ~ '^\d{4}-\d{2}-\d{2}(T|$)'
      )));
  END CASE;
END $$;
-- statement-breakpoint
CREATE OR REPLACE VIEW analytics.crm_opportunities
WITH (security_barrier=true,security_invoker=false) AS
SELECT
  o.opportunity_id,
  analytics.crm_mask_json(o.data) AS data,
  o.stage,
  analytics.crm_mask_text(o.name) AS name,
  o.priority,
  o.city,
  analytics.crm_mask_text(o.company_name) AS company_name,
  o.assigned_to,
  o.assignee_email,
  o.owner_id,
  o.last_contacted,
  o.next_follow_up,
  o.twenty_created_at,
  o.twenty_updated_at,
  o.deleted_at,
  o.deleted_at IS NOT NULL AS is_deleted,
  o.first_seen_at,
  o.last_polled_at,
  o.stage_entered_at,
  o.last_meaningful_update_at,
  o.last_meaningful_update_kind,
  o.last_meaningful_update_by,
  o.last_note_at,
  analytics.crm_mask_text(o.last_note_text) AS last_note_text,
  o.last_task_at,
  o.closure_sent_at,
  CASE WHEN o.data ? 'updatedAt' THEN 'rest_snapshot' ELSE 'legacy_webhook' END AS snapshot_format,
  (NULLIF(btrim(o.data #>> '{pocPhoneNumber,primaryPhoneNumber}'),'') IS NOT NULL
    OR NULLIF(btrim(o.data #>> '{pointOfContact,phones,primaryPhoneNumber}'),'') IS NOT NULL
    OR NULLIF(btrim(o.data->>'POC Phone Number'),'') IS NOT NULL
    OR jsonb_path_exists(o.data,'$.pocPhoneNumber.additionalPhones[*] ? (@.number != null && @.number != "")')
    OR jsonb_path_exists(o.data,'$.pointOfContact.phones.additionalPhones[*] ? (@.number != null && @.number != "")')) AS has_client_phone,
  (NULLIF(btrim(o.data #>> '{companyEmail,primaryEmail}'),'') IS NOT NULL
    OR NULLIF(btrim(o.data #>> '{pointOfContact,emails,primaryEmail}'),'') IS NOT NULL
    OR jsonb_path_exists(o.data,'$.companyEmail.additionalEmails[*] ? (@ != null && @ != "")')
    OR jsonb_path_exists(o.data,'$.pointOfContact.emails.additionalEmails[*] ? (@ != null && @ != "")')) AS has_client_email,
  COALESCE(history.events,'[]'::jsonb) AS stage_history,
  history.event_count AS observed_stage_change_count,
  COALESCE(linked.notes,'[]'::jsonb) AS notes,
  COALESCE(linked.tasks,'[]'::jsonb) AS tasks,
  o.data->>'secondaryAssignee' AS secondary_assignee
FROM public.opportunities o
LEFT JOIN LATERAL (
  SELECT jsonb_agg(jsonb_build_object('id',t.id,'fromStage',t.from_stage,'toStage',t.to_stage,
    'changedAt',t.changed_at,'detectedAt',t.detected_at) ORDER BY t.changed_at,t.id) AS events,
    count(*)::integer AS event_count
  FROM public.stage_transitions t WHERE t.opportunity_id=o.opportunity_id
) history ON true
LEFT JOIN LATERAL (
  SELECT jsonb_agg(analytics.crm_mask_json(r.data) ORDER BY r.twenty_created_at,r.record_id)
      FILTER(WHERE r.object='notes') AS notes,
    jsonb_agg(analytics.crm_mask_json(r.data) ORDER BY r.twenty_created_at,r.record_id)
      FILTER(WHERE r.object='tasks') AS tasks
  FROM public.crm_records r WHERE r.opportunity_ids @> ARRAY[o.opportunity_id] AND r.deleted_at IS NULL
) linked ON true;
-- statement-breakpoint
CREATE OR REPLACE VIEW analytics.crm_notes
WITH (security_barrier=true,security_invoker=false) AS
SELECT record_id AS note_id, opportunity_ids, analytics.crm_mask_json(data) AS data,
  twenty_created_at,twenty_updated_at,deleted_at,deleted_at IS NOT NULL AS is_deleted,first_seen_at,last_polled_at
FROM public.crm_records WHERE object='notes';
-- statement-breakpoint
CREATE OR REPLACE VIEW analytics.crm_tasks
WITH (security_barrier=true,security_invoker=false) AS
SELECT record_id AS task_id, opportunity_ids, analytics.crm_mask_json(data) AS data,
  twenty_created_at,twenty_updated_at,deleted_at,deleted_at IS NOT NULL AS is_deleted,first_seen_at,last_polled_at
FROM public.crm_records WHERE object='tasks';
-- statement-breakpoint
COMMENT ON VIEW analytics.crm_notes IS 'wareongo.crm-analytics.v1: full raw note JSON with client contact redaction';
-- statement-breakpoint
COMMENT ON VIEW analytics.crm_tasks IS 'wareongo.crm-analytics.v1: full raw task JSON with client contact redaction';
-- statement-breakpoint
COMMENT ON FUNCTION analytics.crm_mask_text(text,boolean) IS 'wareongo.crm-analytics.v1: contact-pattern redaction, no database reads';
-- statement-breakpoint
COMMENT ON FUNCTION analytics.crm_mask_json(jsonb,text,boolean) IS 'wareongo.crm-analytics.v1: preserve stored JSON structure and internal actors; redact client phone/email fields and descriptive contact patterns';
-- statement-breakpoint
COMMENT ON VIEW analytics.crm_opportunities IS 'wareongo.crm-analytics.v1: current stored CRM JSON with client phones/emails redacted, native reporting columns, and observed stage history';
-- statement-breakpoint
REVOKE ALL ON FUNCTION analytics.crm_mask_text(text,boolean),analytics.crm_mask_json(jsonb,text,boolean) FROM PUBLIC,anon,authenticated,service_role;
-- statement-breakpoint
GRANT EXECUTE ON FUNCTION analytics.crm_mask_text(text,boolean),analytics.crm_mask_json(jsonb,text,boolean) TO crm_analytics_reader;
-- statement-breakpoint
REVOKE ALL ON analytics.crm_opportunities,analytics.crm_notes,analytics.crm_tasks FROM PUBLIC,anon,authenticated,service_role,crm_analytics_reader;
-- statement-breakpoint
GRANT SELECT ON analytics.crm_opportunities,analytics.crm_notes,analytics.crm_tasks TO crm_analytics_reader;
-- statement-breakpoint
RESET ROLE;
-- statement-breakpoint
REVOKE CREATE ON SCHEMA analytics FROM crm_analytics_owner;
