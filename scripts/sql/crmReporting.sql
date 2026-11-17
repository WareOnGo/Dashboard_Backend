-- Scalar CRM reporting views for Data Studio. Does not modify source data.
GRANT CREATE ON SCHEMA analytics TO crm_analytics_owner;
-- statement-breakpoint
SET LOCAL ROLE crm_analytics_owner;
-- statement-breakpoint
CREATE OR REPLACE FUNCTION analytics.crm_report_number(value text)
RETURNS numeric LANGUAGE plpgsql IMMUTABLE STRICT SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE cleaned text;
BEGIN
  cleaned := replace(btrim(value),',','');
  IF cleaned !~ '^[+-]?[0-9]+([.][0-9]+)?$' THEN RETURN NULL; END IF;
  RETURN cleaned::numeric;
EXCEPTION WHEN numeric_value_out_of_range OR invalid_text_representation THEN RETURN NULL;
END $$;
-- statement-breakpoint
CREATE OR REPLACE FUNCTION analytics.crm_report_text(value jsonb)
RETURNS text LANGUAGE sql IMMUTABLE STRICT SECURITY INVOKER SET search_path=pg_catalog AS $$
  SELECT CASE jsonb_typeof(value)
    WHEN 'array' THEN (SELECT string_agg(v #>> '{}',', ' ORDER BY n)
      FROM jsonb_array_elements(value) WITH ORDINALITY AS a(v,n)
      WHERE jsonb_typeof(v) IN ('string','number','boolean'))
    WHEN 'string' THEN value #>> '{}'
    WHEN 'number' THEN value #>> '{}'
    WHEN 'boolean' THEN value #>> '{}'
    ELSE NULL END
$$;
-- statement-breakpoint
CREATE OR REPLACE FUNCTION analytics.crm_report_date(value text)
RETURNS date LANGUAGE plpgsql IMMUTABLE STRICT SECURITY INVOKER SET search_path=pg_catalog SET datestyle='ISO,YMD' AS $$
BEGIN
  IF value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}($|T)' THEN RETURN NULL; END IF;
  RETURN left(value,10)::date;
EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN RETURN NULL;
END $$;
-- statement-breakpoint
CREATE OR REPLACE VIEW analytics.crm_report
WITH (security_barrier=true,security_invoker=false) AS
SELECT
  o.opportunity_id,
  analytics.crm_mask_text(COALESCE(NULLIF(o.name,''),o.data->>'name',o.data->>'deal_name')) AS opportunity_name,
  o.stage,
  analytics.crm_mask_text(COALESCE(NULLIF(o.company_name,''),NULLIF(o.data->>'companyName',''),
    CASE WHEN jsonb_typeof(o.data->'company')='string' THEN o.data->>'company' ELSE o.data#>>'{company,name}' END)) AS company_name,
  analytics.crm_mask_text(o.city) AS city,
  analytics.crm_mask_text(o.data->>'microMarket') AS micro_market,
  analytics.crm_mask_text(o.data->>'description') AS description,
  analytics.crm_mask_text(COALESCE(NULLIF(concat_ws(' ',o.data#>>'{pocName,firstName}',o.data#>>'{pocName,lastName}'),''),
    o.data->>'POC Name',NULLIF(concat_ws(' ',o.data#>>'{pointOfContact,name,firstName}',o.data#>>'{pointOfContact,name,lastName}'),''))) AS client_contact_name,
  NULLIF(btrim(split_part(COALESCE(analytics.crm_report_text(o.assigned_to),
    analytics.crm_report_text(o.data->'assigned_to')),',',1)),'') AS primary_assignees,
  COALESCE(NULLIF(btrim(split_part(COALESCE(analytics.crm_report_text(o.assigned_to),
    analytics.crm_report_text(o.data->'assigned_to')),',',2)),''),
    analytics.crm_report_text(o.data->'secondaryAssignee')) AS secondary_assignee,
  o.assignee_email AS internal_assignee_emails,
  o.owner_id,
  NULLIF(concat_ws(' ',o.data#>>'{owner,name,firstName}',o.data#>>'{owner,name,lastName}'),'') AS owner_name,
  o.data#>>'{owner,userEmail}' AS internal_owner_email,
  o.data#>>'{createdBy,name}' AS created_by_name,
  o.data#>>'{createdBy,source}' AS created_by_source,
  o.data#>>'{updatedBy,name}' AS updated_by_name,
  o.data#>>'{updatedBy,source}' AS updated_by_source,
  o.priority,
  analytics.crm_report_number(regexp_replace(o.priority,'^RATING_','')) AS priority_stars,
  analytics.crm_mask_text(o.data->>'leadSource') AS lead_source,
  analytics.crm_mask_text(analytics.crm_report_text(o.data->'industryVertical')) AS industry_verticals,
  analytics.crm_mask_text(analytics.crm_report_text(o.data->'repeatClient')) AS repeat_client,
  analytics.crm_mask_text(analytics.crm_report_text(o.data->'supplyLead')) AS supply_leads,
  analytics.crm_mask_text(analytics.crm_report_text(o.data->'occupancyTimeline')) AS occupancy_timelines,
  analytics.crm_mask_text(analytics.crm_report_text(o.data->'preferredLanguage')) AS preferred_languages,
  analytics.crm_report_number(o.data->>'requirementInSft') AS required_area_sqft,
  analytics.crm_report_number(o.data#>>'{amount,amountMicros}') / 1000000::numeric AS amount,
  o.data#>>'{amount,currencyCode}' AS amount_currency,
  analytics.crm_mask_text(o.data->>'budget',false) AS budget_text,
  analytics.crm_report_number(o.data->>'budget') AS budget_numeric,
  analytics.crm_mask_text(analytics.crm_report_text(o.data->'duration')) AS requested_duration,
  analytics.crm_report_date(o.data->>'closeDate') AS close_date,
  analytics.crm_mask_text(o.data->>'reasonForDealLost') AS reason_for_deal_lost,
  analytics.crm_report_number(o.data->>'followupcount') AS follow_up_count,
  analytics.crm_report_number(o.data->>'ringingNoResponseCount') AS ringing_no_response_count,
  o.twenty_created_at AS created_at,
  (o.twenty_created_at AT TIME ZONE 'Asia/Kolkata')::date AS created_date_ist,
  o.twenty_updated_at AS updated_at,
  (o.twenty_updated_at AT TIME ZONE 'Asia/Kolkata')::date AS updated_date_ist,
  o.last_contacted,
  o.next_follow_up,
  (o.next_follow_up AT TIME ZONE 'Asia/Kolkata')::date AS next_follow_up_date_ist,
  o.next_follow_up IS NOT NULL AND o.next_follow_up < CURRENT_TIMESTAMP AND o.deleted_at IS NULL AS follow_up_is_past_due,
  o.stage_entered_at AS current_stage_entered_at,
  (o.stage_entered_at AT TIME ZONE 'Asia/Kolkata')::date AS current_stage_entered_date_ist,
  CASE WHEN o.deleted_at IS NULL AND o.stage_entered_at <= CURRENT_TIMESTAMP
    THEN round(extract(epoch FROM (CURRENT_TIMESTAMP-o.stage_entered_at))/86400,2) END AS days_in_current_stage,
  o.last_meaningful_update_at,
  o.last_meaningful_update_kind,
  o.last_meaningful_update_by,
  CASE WHEN o.deleted_at IS NULL AND o.last_meaningful_update_at <= CURRENT_TIMESTAMP
    THEN round(extract(epoch FROM (CURRENT_TIMESTAMP-o.last_meaningful_update_at))/86400,2) END AS days_since_meaningful_update,
  o.last_note_at,
  analytics.crm_mask_text(o.last_note_text) AS latest_note_excerpt,
  o.last_task_at,
  linked.note_count,
  linked.task_count,
  CASE WHEN jsonb_typeof(o.data->'attachments')='array' THEN jsonb_array_length(o.data->'attachments') ELSE 0 END AS attachment_count,
  history.transition_count AS observed_stage_change_count,
  history.raw_row_count AS stage_log_row_count,
  history.raw_row_count-history.transition_count AS duplicate_stage_row_count,
  history.transition_count>0 AS has_observed_stage_history,
  history.first_change_at AS first_observed_stage_change_at,
  history.last_change_at AS last_observed_stage_change_at,
  flags.has_client_phone,
  flags.has_client_email,
  o.first_seen_at,
  o.last_polled_at,
  o.deleted_at,
  o.deleted_at IS NOT NULL AS is_deleted,
  CASE WHEN o.data ? 'updatedAt' THEN 'rest_snapshot' ELSE 'legacy_webhook' END AS snapshot_format
FROM public.opportunities o
-- Only read the inexpensive presence flags; raw JSON is not selected or unpacked
-- from the masking view repeatedly for every reporting field.
JOIN analytics.crm_opportunities flags ON flags.opportunity_id=o.opportunity_id
LEFT JOIN LATERAL (
  SELECT count(*) FILTER(WHERE r.object='notes')::integer AS note_count,
    count(*) FILTER(WHERE r.object='tasks')::integer AS task_count
  FROM public.crm_records r WHERE r.opportunity_ids @> ARRAY[o.opportunity_id] AND r.deleted_at IS NULL
) linked ON true
LEFT JOIN LATERAL (
  SELECT count(*)::integer AS raw_row_count,
    count(DISTINCT (t.from_stage,t.to_stage,t.changed_at))::integer AS transition_count,
    min(t.changed_at) AS first_change_at,max(t.changed_at) AS last_change_at
  FROM public.stage_transitions t WHERE t.opportunity_id=o.opportunity_id
) history ON true;
-- statement-breakpoint
CREATE OR REPLACE VIEW analytics.crm_stage_transitions
WITH (security_barrier=true,security_invoker=false) AS
WITH ranked AS (
  SELECT t.*,row_number() OVER (
    PARTITION BY opportunity_id,from_stage,to_stage,changed_at ORDER BY detected_at,id) AS duplicate_rank
  FROM public.stage_transitions t
), sequenced AS (
  SELECT t.*,row_number() OVER (PARTITION BY opportunity_id ORDER BY changed_at,id) AS sequence_number,
    lead(changed_at) OVER (PARTITION BY opportunity_id ORDER BY changed_at,id) AS next_change_at,
    lead(from_stage) OVER (PARTITION BY opportunity_id ORDER BY changed_at,id) AS next_from_stage
  FROM ranked t WHERE duplicate_rank=1
)
SELECT
  t.id::text AS transition_id,
  t.opportunity_id,
  d.opportunity_name,
  d.company_name,
  d.city,
  d.primary_assignees AS current_primary_assignees,
  d.secondary_assignee AS current_secondary_assignee,
  d.internal_assignee_emails AS current_internal_assignee_emails,
  d.stage AS current_stage,
  t.from_stage,
  t.to_stage,
  t.changed_at,
  (t.changed_at AT TIME ZONE 'Asia/Kolkata')::date AS changed_date_ist,
  t.detected_at,
  s.sequence_number::integer AS observed_transition_number,
  t.duplicate_rank>1 AS is_duplicate,
  s.next_change_at AS next_observed_transition_at,
  CASE WHEN s.next_from_stage=t.to_stage THEN s.next_change_at END AS to_stage_exited_at,
  COALESCE(t.duplicate_rank=1 AND s.next_change_at IS NULL AND t.to_stage=d.stage AND NOT d.is_deleted,false) AS is_current_stage_entry,
  CASE
    WHEN s.next_from_stage=t.to_stage AND s.next_change_at >= t.changed_at
      THEN round(extract(epoch FROM (s.next_change_at-t.changed_at))/86400,2)
    WHEN t.duplicate_rank=1 AND s.next_change_at IS NULL AND t.to_stage=d.stage AND NOT d.is_deleted AND t.changed_at<=CURRENT_TIMESTAMP
      THEN round(extract(epoch FROM (CURRENT_TIMESTAMP-t.changed_at))/86400,2)
  END AS days_in_to_stage,
  CASE
    WHEN t.duplicate_rank>1 THEN 'duplicate_log_row'
    WHEN s.next_change_at IS NOT NULL AND s.next_from_stage=t.to_stage THEN 'between_observed_transitions'
    WHEN s.next_change_at IS NOT NULL THEN 'gap_in_observed_history'
    WHEN t.to_stage=d.stage AND NOT d.is_deleted THEN 'current_stage_so_far'
    ELSE 'unknown_exit'
  END AS duration_basis,
  d.is_deleted AS opportunity_is_deleted,
  d.opportunity_id IS NOT NULL AS has_opportunity_record
FROM ranked t
LEFT JOIN sequenced s ON s.id=t.id
LEFT JOIN analytics.crm_report d ON d.opportunity_id=t.opportunity_id;
-- statement-breakpoint
COMMENT ON VIEW analytics.crm_report IS 'wareongo.crm-analytics.v1: one row per opportunity; scalar reporting fields, masked client contacts, deduplicated stage counts and current linked-note/task counts';
-- statement-breakpoint
COMMENT ON VIEW analytics.crm_stage_transitions IS 'wareongo.crm-analytics.v1: every stored stage-transition row with current deal dimensions; is_duplicate flags repeated historical events without changing the source log';
-- statement-breakpoint
COMMENT ON COLUMN analytics.crm_report.amount IS 'Twenty amountMicros divided by 1000000; group by amount_currency before summing different currencies';
-- statement-breakpoint
COMMENT ON COLUMN analytics.crm_report.budget_numeric IS 'Only plain numeric/comma-separated budget text is parsed; units are not inferred and words/ranges remain NULL';
-- statement-breakpoint
COMMENT ON COLUMN analytics.crm_report.primary_assignees IS 'First comma-separated assignee in source order, trimmed; later assignees are excluded from this field';
-- statement-breakpoint
COMMENT ON COLUMN analytics.crm_report.secondary_assignee IS 'Second comma-separated primary assignee, trimmed; falls back to the separately synced secondaryAssignee when the second entry is empty or absent; third and later primary assignees are ignored';
-- statement-breakpoint
COMMENT ON COLUMN analytics.crm_report.observed_stage_change_count IS 'Distinct observed from-stage/to-stage/change-time events; excludes duplicate log rows';
-- statement-breakpoint
COMMENT ON COLUMN analytics.crm_report.current_stage_entered_at IS 'Existing sync clock preserved; baseline may be approximate when the poller did not observe stage entry';
-- statement-breakpoint
COMMENT ON COLUMN analytics.crm_stage_transitions.days_in_to_stage IS 'Time in destination stage until the next contiguous observed transition, or elapsed time in the current stage; NULL for duplicates and unknown exits';
-- statement-breakpoint
COMMENT ON COLUMN analytics.crm_stage_transitions.current_primary_assignees IS 'Current opportunity assignees, not historical assignees at transition time';
-- statement-breakpoint
COMMENT ON FUNCTION analytics.crm_report_number(text) IS 'wareongo.crm-analytics.v1: safe numeric reporting conversion; no database reads';
-- statement-breakpoint
COMMENT ON FUNCTION analytics.crm_report_text(jsonb) IS 'wareongo.crm-analytics.v1: scalar or comma-separated reporting labels; no database reads';
-- statement-breakpoint
COMMENT ON FUNCTION analytics.crm_report_date(text) IS 'wareongo.crm-analytics.v1: ISO calendar-date conversion; invalid values become NULL';
-- statement-breakpoint
REVOKE ALL ON FUNCTION analytics.crm_report_number(text),analytics.crm_report_text(jsonb),analytics.crm_report_date(text) FROM PUBLIC,anon,authenticated,service_role;
-- statement-breakpoint
GRANT EXECUTE ON FUNCTION analytics.crm_report_number(text),analytics.crm_report_text(jsonb),analytics.crm_report_date(text) TO crm_analytics_reader;
-- statement-breakpoint
REVOKE ALL ON analytics.crm_report,analytics.crm_stage_transitions FROM PUBLIC,anon,authenticated,service_role,crm_analytics_reader;
-- statement-breakpoint
GRANT SELECT ON analytics.crm_report,analytics.crm_stage_transitions TO crm_analytics_reader;
-- statement-breakpoint
RESET ROLE;
-- statement-breakpoint
REVOKE CREATE ON SCHEMA analytics FROM crm_analytics_owner;
