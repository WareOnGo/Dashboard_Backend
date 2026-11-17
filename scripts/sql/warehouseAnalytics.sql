-- Applied transactionally by provisionWarehouseAnalytics.js.
-- The reader starts NOLOGIN. Activation requires the global-grant audit to pass,
-- or the explicitly selected owner-controlled Data Studio access policy.
-- Do not give this role memberships in authenticated, service_role, or wog_ro.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'warehouse_analytics_owner') THEN
    CREATE ROLE warehouse_analytics_owner NOLOGIN NOINHERIT NOSUPERUSER
      NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    COMMENT ON ROLE warehouse_analytics_owner IS 'wareongo.warehouse-analytics.v1: view owner';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'analytics_reader') THEN
    CREATE ROLE analytics_reader NOLOGIN NOINHERIT NOSUPERUSER
      NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5;
    COMMENT ON ROLE analytics_reader IS 'wareongo.warehouse-analytics.v1: restricted BI login';
  END IF;
END $$;
-- statement-breakpoint
-- Only the project administrator can assume these roles, for maintenance/testing.
GRANT warehouse_analytics_owner, analytics_reader TO postgres
  WITH INHERIT FALSE, SET TRUE;
-- statement-breakpoint
CREATE SCHEMA IF NOT EXISTS analytics AUTHORIZATION postgres;
-- statement-breakpoint
COMMENT ON SCHEMA analytics IS 'wareongo.warehouse-analytics.v1: private BI views';
-- statement-breakpoint
REVOKE ALL ON SCHEMA analytics FROM PUBLIC, anon, authenticated, service_role;
-- statement-breakpoint
GRANT USAGE ON SCHEMA analytics TO analytics_reader;
-- statement-breakpoint
GRANT USAGE, CREATE ON SCHEMA analytics TO warehouse_analytics_owner;
-- statement-breakpoint
GRANT USAGE ON SCHEMA public TO warehouse_analytics_owner;
-- statement-breakpoint
GRANT CONNECT ON DATABASE postgres TO analytics_reader;
-- statement-breakpoint
ALTER ROLE analytics_reader IN DATABASE postgres SET search_path = pg_catalog, analytics;
-- statement-breakpoint
ALTER ROLE analytics_reader IN DATABASE postgres SET statement_timeout = '60s';
-- statement-breakpoint
ALTER ROLE analytics_reader IN DATABASE postgres SET idle_in_transaction_session_timeout = '60s';
-- statement-breakpoint
-- A convenience default; SELECT-only grants are the actual write protection.
ALTER ROLE analytics_reader IN DATABASE postgres SET default_transaction_read_only = on;
-- statement-breakpoint
GRANT SELECT (
  id, "warehouseOwnerType", "warehouseType", city, state, zone,
  "totalSpaceSqft", "numberOfDocks", "clearHeightFt", "ratePerSqft", availability,
  "isBroker", "createdAt", status_updated_at, visibility, builtup_area, is_builder,
  carpet_area, fire_exits, fire_compliance_cert_type, negotiated_rent, washroom_count,
  "gateSizeFt", "dockApronLengthFt", "setbackArea", "ccRoads", "wallAndSecurityRoom",
  "plinthHeightFt", "dockDimension", "canopyType", "dockPlatformType", "flooringType",
  "floorStrengthPerSqm", "ventilationType", "ventilationAirChangesPerDay",
  "insulationPresent", "insulationType", "lightingDetails", "wogVerified", "centreHeight",
  listing_type, "handoverDate", "lockInDate", status, cam, "chargeableArea", "liftAccess",
  "liftLoadCapacity", "passengerLiftCount", "serviceLiftCount", "totalFloors", micromarket,
  "handoverLeadUnit", "handoverLeadValue", "handoverType", "waterSupply", "suitableFor",
  "contactNumber", alt_phone_number, "googleLocation", address, "contactPerson", "postalCode",
  "ownerCompanyName", "ownerAltPoc", "uploadedBy", "otherSpecifications", "scoutNotes",
  ai_description, media, photos, "photosWebp", "scoutVoiceNotes", land_parcel_size,
  nearest_transport, compliances, "otherDockingSpecs"
) ON public."Warehouse" TO warehouse_analytics_owner;
-- statement-breakpoint
GRANT SELECT (
  id, "warehouseId", latitude, longitude, geog, embedding, "fireNocAvailable",
  "fireSafetyMeasures", "landType", "approachRoadWidth", dimensions,
  "parkingDockingSpace", "pollutionZone", "powerKva", "vaastuCompliance"
) ON public."WarehouseData" TO warehouse_analytics_owner;
-- statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_policy WHERE polrelid = 'public."Warehouse"'::regclass
    AND polname = 'warehouse_analytics_owner_select') THEN
    CREATE POLICY warehouse_analytics_owner_select ON public."Warehouse"
      FOR SELECT TO warehouse_analytics_owner USING (true);
  END IF;
  IF NOT EXISTS (SELECT FROM pg_policy WHERE polrelid = 'public."WarehouseData"'::regclass
    AND polname = 'warehouse_analytics_owner_select') THEN
    CREATE POLICY warehouse_analytics_owner_select ON public."WarehouseData"
      FOR SELECT TO warehouse_analytics_owner USING (true);
  END IF;
END $$;
-- statement-breakpoint
SET LOCAL ROLE warehouse_analytics_owner;
-- statement-breakpoint
-- Preserve the existing view, grants, and column positions while restoring
-- source names. Derived columns and the disambiguated WarehouseData ID retain
-- their descriptive names. This also makes --apply safe on an existing view.
DO $$
DECLARE column_rename record;
BEGIN
  IF to_regclass('analytics.warehouse') IS NOT NULL THEN
    FOR column_rename IN SELECT * FROM (VALUES
      ('warehouse_id', 'id'),
      ('warehouse_owner_type', 'warehouseOwnerType'),
      ('warehouse_type', 'warehouseType'),
      ('micromarkets', 'micromarket'),
      ('space_options_sqft', 'totalSpaceSqft'),
      ('chargeable_area_sqft', 'chargeableArea'),
      ('number_of_docks', 'numberOfDocks'),
      ('clear_height_ft', 'clearHeightFt'),
      ('centre_height', 'centreHeight'),
      ('rate_per_sqft', 'ratePerSqft'),
      ('is_broker', 'isBroker'),
      ('wog_verified', 'wogVerified'),
      ('created_at', 'createdAt'),
      ('gate_size_ft', 'gateSizeFt'),
      ('dock_apron_length_ft', 'dockApronLengthFt'),
      ('setback_area', 'setbackArea'),
      ('cc_roads', 'ccRoads'),
      ('wall_and_security_room', 'wallAndSecurityRoom'),
      ('plinth_height_ft', 'plinthHeightFt'),
      ('dock_dimension', 'dockDimension'),
      ('canopy_type', 'canopyType'),
      ('dock_platform_type', 'dockPlatformType'),
      ('flooring_type', 'flooringType'),
      ('floor_strength_per_sqm', 'floorStrengthPerSqm'),
      ('ventilation_type', 'ventilationType'),
      ('ventilation_air_changes_per_day', 'ventilationAirChangesPerDay'),
      ('insulation_present', 'insulationPresent'),
      ('insulation_type', 'insulationType'),
      ('lighting_details', 'lightingDetails'),
      ('handover_date', 'handoverDate'),
      ('lock_in_date', 'lockInDate'),
      ('handover_lead_unit', 'handoverLeadUnit'),
      ('handover_lead_value', 'handoverLeadValue'),
      ('handover_type', 'handoverType'),
      ('water_supply', 'waterSupply'),
      ('suitable_for', 'suitableFor'),
      ('lift_access', 'liftAccess'),
      ('lift_load_capacity', 'liftLoadCapacity'),
      ('passenger_lift_count', 'passengerLiftCount'),
      ('service_lift_count', 'serviceLiftCount'),
      ('total_floors', 'totalFloors'),
      ('fire_noc_available', 'fireNocAvailable'),
      ('land_type', 'landType'),
      ('approach_road_width', 'approachRoadWidth'),
      ('parking_docking_space', 'parkingDockingSpace'),
      ('pollution_zone', 'pollutionZone'),
      ('power_kva', 'powerKva'),
      ('vaastu_compliance', 'vaastuCompliance')
    ) AS names(old_name, new_name) LOOP
      IF EXISTS (SELECT 1 FROM pg_attribute
        WHERE attrelid='analytics.warehouse'::regclass AND NOT attisdropped
          AND attname=column_rename.old_name) THEN
        EXECUTE format('ALTER VIEW analytics.warehouse RENAME COLUMN %I TO %I',
          column_rename.old_name, column_rename.new_name);
      END IF;
    END LOOP;
  END IF;
END $$;
-- statement-breakpoint
CREATE OR REPLACE VIEW analytics.warehouse
WITH (security_barrier = true, security_invoker = false) AS
SELECT
  w.id AS "id",
  d.id AS warehouse_data_id,
  d.id IS NOT NULL AS has_warehouse_data,
  w."warehouseOwnerType" AS "warehouseOwnerType",
  w."warehouseType" AS "warehouseType",
  w.city,
  w.state,
  w.zone,
  array_to_string(w.micromarket, ', ') AS "micromarket",
  array_to_string(w."totalSpaceSqft", ', ') AS "totalSpaceSqft",
  cardinality(w."totalSpaceSqft") AS space_option_count,
  (SELECT min(area) FROM unnest(w."totalSpaceSqft") AS area) AS min_space_sqft,
  (SELECT max(area) FROM unnest(w."totalSpaceSqft") AS area) AS max_space_sqft,
  w."chargeableArea" AS "chargeableArea",
  w."numberOfDocks" AS "numberOfDocks",
  w."clearHeightFt" AS "clearHeightFt",
  w."centreHeight" AS "centreHeight",
  w."ratePerSqft" AS "ratePerSqft",
  w.negotiated_rent,
  w.cam,
  w.availability,
  w.status,
  w.listing_type,
  w."isBroker" AS "isBroker",
  w.is_builder,
  w.visibility,
  w."wogVerified" AS "wogVerified",
  w."createdAt" AS "createdAt",
  w.status_updated_at,
  w.builtup_area,
  w.carpet_area,
  w.fire_exits,
  w.fire_compliance_cert_type,
  w.washroom_count,
  w."gateSizeFt" AS "gateSizeFt",
  w."dockApronLengthFt" AS "dockApronLengthFt",
  w."setbackArea" AS "setbackArea",
  w."ccRoads" AS "ccRoads",
  w."wallAndSecurityRoom" AS "wallAndSecurityRoom",
  w."plinthHeightFt" AS "plinthHeightFt",
  w."dockDimension" AS "dockDimension",
  w."canopyType" AS "canopyType",
  w."dockPlatformType" AS "dockPlatformType",
  w."flooringType" AS "flooringType",
  w."floorStrengthPerSqm" AS "floorStrengthPerSqm",
  w."ventilationType" AS "ventilationType",
  w."ventilationAirChangesPerDay" AS "ventilationAirChangesPerDay",
  w."insulationPresent" AS "insulationPresent",
  w."insulationType" AS "insulationType",
  w."lightingDetails" AS "lightingDetails",
  w."handoverDate" AS "handoverDate",
  w."lockInDate" AS "lockInDate",
  w."handoverLeadUnit"::text AS "handoverLeadUnit",
  w."handoverLeadValue" AS "handoverLeadValue",
  w."handoverType"::text AS "handoverType",
  w."waterSupply"::text AS "waterSupply",
  array_to_string(w."suitableFor", ', ') AS "suitableFor",
  w."liftAccess" AS "liftAccess",
  w."liftLoadCapacity" AS "liftLoadCapacity",
  w."passengerLiftCount" AS "passengerLiftCount",
  w."serviceLiftCount" AS "serviceLiftCount",
  w."totalFloors" AS "totalFloors",
  d."fireNocAvailable" AS "fireNocAvailable",
  d."landType" AS "landType",
  d."approachRoadWidth" AS "approachRoadWidth",
  d.dimensions,
  d."parkingDockingSpace" AS "parkingDockingSpace",
  d."pollutionZone" AS "pollutionZone",
  d."powerKva" AS "powerKva",
  d."vaastuCompliance" AS "vaastuCompliance",
  NULLIF(btrim(w."contactNumber", E' \t\r\n'), '') IS NOT NULL AS has_phone,
  NULLIF(btrim(w.alt_phone_number, E' \t\r\n'), '') IS NOT NULL AS has_alt_phone,
  NULLIF(btrim(w."googleLocation", E' \t\r\n'), '') IS NOT NULL AS has_google_location,
  d.latitude IS NOT NULL AS has_latitude,
  d.longitude IS NOT NULL AS has_longitude,
  (d.latitude IS NOT NULL AND d.longitude IS NOT NULL) AS has_coordinates,
  d.geog IS NOT NULL AS has_geography,
  d.embedding IS NOT NULL AS has_embedding,
  NULLIF(btrim(w.address, E' \t\r\n'), '') IS NOT NULL AS has_address,
  NULLIF(btrim(w."contactPerson", E' \t\r\n'), '') IS NOT NULL AS has_contact_person,
  NULLIF(btrim(w."postalCode", E' \t\r\n'), '') IS NOT NULL AS has_postal_code,
  NULLIF(btrim(w."ownerCompanyName", E' \t\r\n'), '') IS NOT NULL AS has_owner_company,
  NULLIF(btrim(w."ownerAltPoc", E' \t\r\n'), '') IS NOT NULL AS has_owner_alt_poc,
  NULLIF(btrim(w."uploadedBy", E' \t\r\n'), '') IS NOT NULL AS has_uploaded_by,
  NULLIF(btrim(w."otherSpecifications", E' \t\r\n'), '') IS NOT NULL AS has_other_specifications,
  NULLIF(btrim(w."scoutNotes", E' \t\r\n'), '') IS NOT NULL AS has_scout_notes,
  NULLIF(btrim(w.ai_description, E' \t\r\n'), '') IS NOT NULL AS has_ai_description,
  (w.media IS NOT NULL AND w.media NOT IN ('null'::jsonb, '[]'::jsonb, '{}'::jsonb)) AS has_media,
  (NULLIF(btrim(w.photos, E' \t\r\n'), '') IS NOT NULL
    OR NULLIF(btrim(w."photosWebp", E' \t\r\n'), '') IS NOT NULL) AS has_photos,
  (w."scoutVoiceNotes" IS NOT NULL
    AND w."scoutVoiceNotes" NOT IN ('null'::jsonb, '[]'::jsonb, '{}'::jsonb)) AS has_scout_voice_notes,
  NULLIF(btrim(w.land_parcel_size, E' \t\r\n'), '') IS NOT NULL AS has_land_parcel_size,
  NULLIF(btrim(w.nearest_transport, E' \t\r\n'), '') IS NOT NULL AS has_nearest_transport,
  NULLIF(btrim(w.compliances, E' \t\r\n'), '') IS NOT NULL AS has_compliances,
  NULLIF(btrim(w."otherDockingSpecs", E' \t\r\n'), '') IS NOT NULL AS has_other_docking_specs,
  NULLIF(btrim(d."fireSafetyMeasures", E' \t\r\n'), '') IS NOT NULL AS has_fire_safety_measures
FROM public."Warehouse" AS w
LEFT JOIN public."WarehouseData" AS d ON d."warehouseId" = w.id;
-- statement-breakpoint
COMMENT ON VIEW analytics.warehouse IS
  'wareongo.warehouse-analytics.v1: one row per warehouse; sensitive fields replaced with presence flags; no hashes or original contact/location values';
-- statement-breakpoint
REVOKE ALL ON analytics.warehouse FROM PUBLIC, anon, authenticated, service_role, analytics_reader;
-- statement-breakpoint
GRANT SELECT ON analytics.warehouse TO analytics_reader;
-- statement-breakpoint
RESET ROLE;
