CREATE TABLE IF NOT EXISTS "WarehouseFieldReview" (
 "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, "warehouseId" INTEGER NOT NULL,
 "assigneeId" INTEGER NOT NULL, "uploaderId" INTEGER, "createdBy" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "closedAt" TIMESTAMP(3),
 "version" INTEGER NOT NULL DEFAULT 0
);
-- statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "field_review_one_active_warehouse" ON "WarehouseFieldReview" ("warehouseId") WHERE "closedAt" IS NULL;
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS "WarehouseFieldReview_assigneeId_closedAt_idx" ON "WarehouseFieldReview" ("assigneeId","closedAt");
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS "WarehouseFieldReview_warehouseId_createdAt_idx" ON "WarehouseFieldReview" ("warehouseId","createdAt");
-- statement-breakpoint
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS "WarehouseFieldFlag" (
 "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, "reviewId" TEXT NOT NULL REFERENCES "WarehouseFieldReview"("id") ON DELETE RESTRICT,
 "warehouseId" INTEGER NOT NULL, "fieldKey" TEXT NOT NULL, "labelSnapshot" TEXT NOT NULL DEFAULT '', "comment" TEXT NOT NULL,
 "originalValue" JSONB NOT NULL, "status" TEXT NOT NULL DEFAULT 'NEEDS_RESPONSE'
 CHECK ("status" IN ('NEEDS_RESPONSE','AWAITING_ADMIN','CHANGES_REQUESTED','VERIFIED','CANCELLED')),
 "version" INTEGER NOT NULL DEFAULT 0, "baselineValue" JSONB, "baselineVersion" INTEGER, "proposedValue" JSONB,
 "resolution" TEXT, "explanation" TEXT, "respondedBy" TEXT, "respondedAt" TIMESTAMP(3),
 "returnComment" TEXT, "decision" TEXT, "decisionReason" TEXT, "finalValue" JSONB, "decidedBy" TEXT, "decidedAt" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "field_review_one_active_field" ON "WarehouseFieldFlag" ("warehouseId","fieldKey") WHERE "status" NOT IN ('VERIFIED','CANCELLED');
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS "WarehouseFieldFlag_reviewId_status_idx" ON "WarehouseFieldFlag" ("reviewId","status");
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS "WarehouseFieldFlag_warehouseId_fieldKey_idx" ON "WarehouseFieldFlag" ("warehouseId","fieldKey");
-- statement-breakpoint
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS "WarehouseFieldReviewEvent" (
 "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, "reviewId" TEXT NOT NULL REFERENCES "WarehouseFieldReview"("id") ON DELETE RESTRICT,
 "flagId" TEXT, "action" TEXT NOT NULL, "actorEmail" TEXT NOT NULL, "actorName" TEXT NOT NULL,
 "payload" JSONB NOT NULL, "requestId" TEXT UNIQUE, "requestHash" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS "WarehouseFieldReviewEvent_reviewId_createdAt_idx" ON "WarehouseFieldReviewEvent" ("reviewId","createdAt");
-- statement-breakpoint
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS "WarehouseFieldVersion" (
 "warehouseId" INTEGER NOT NULL, "fieldKey" TEXT NOT NULL, "version" INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY ("warehouseId","fieldKey")
);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS "WarehouseFieldEdit" (
 "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, "warehouseId" INTEGER NOT NULL, "fieldKey" TEXT NOT NULL,
 "oldValue" JSONB NOT NULL, "newValue" JSONB NOT NULL, "actorEmail" TEXT, "source" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS "WarehouseFieldEdit_warehouseId_fieldKey_createdAt_idx" ON "WarehouseFieldEdit" ("warehouseId","fieldKey","createdAt");
-- statement-breakpoint
ALTER TABLE "WarehouseFieldEdit" ADD COLUMN IF NOT EXISTS "version" INTEGER;
-- statement-breakpoint
-- Canonical gallery matches the View's JSON/legacy fallback. Track the whole
-- section so additions, removals, replacements and reordering share one revision.
CREATE OR REPLACE FUNCTION field_review_media(row_value JSONB) RETURNS JSONB LANGUAGE plpgsql IMMUTABLE AS $media$
DECLARE
 stored JSONB := row_value->'media'; photos JSONB := row_value->'photos';
 legacy JSONB := '{"images":[],"videos":[],"docs":[]}'::jsonb;
 result JSONB := legacy; entry JSONB; file_url TEXT; path TEXT; kind TEXT; source JSONB; items JSONB; attempt INTEGER;
BEGIN
 FOR attempt IN 1..2 LOOP
  EXIT WHEN jsonb_typeof(stored) IS DISTINCT FROM 'string';
  BEGIN stored := (stored #>> '{}')::jsonb; EXCEPTION WHEN invalid_text_representation THEN EXIT; END;
 END LOOP;
 FOR attempt IN 1..2 LOOP
  EXIT WHEN jsonb_typeof(photos) IS DISTINCT FROM 'string';
  BEGIN photos := (photos #>> '{}')::jsonb; EXCEPTION WHEN invalid_text_representation THEN EXIT; END;
 END LOOP;
 IF jsonb_typeof(photos) IS DISTINCT FROM 'array' THEN photos := jsonb_build_array(photos); END IF;
 FOR entry IN SELECT value FROM jsonb_array_elements(photos) LOOP
  IF jsonb_typeof(entry) IS DISTINCT FROM 'string' THEN CONTINUE; END IF;
  FOR file_url IN SELECT btrim(value) FROM regexp_split_to_table(entry #>> '{}', ',\s*(?=https?://)|,\s+(?![^,]*/)','i') value LOOP
   IF file_url='' THEN CONTINUE; END IF;
   path := split_part(split_part(file_url,'?',1),'#',1);
   kind := CASE WHEN path ~* '\.(mp4|mov|avi|mkv|webm)$' THEN 'videos' WHEN path ~* '\.(pdf|docx?|xlsx?)$' THEN 'docs' ELSE 'images' END;
   legacy := jsonb_set(legacy,ARRAY[kind],(legacy->kind) || jsonb_build_array(file_url));
  END LOOP;
 END LOOP;
 FOREACH kind IN ARRAY ARRAY['images','videos','docs'] LOOP
  source := CASE WHEN jsonb_typeof(stored->kind)='array' THEN stored->kind ELSE legacy->kind END;
  items := '[]'::jsonb;
  FOR entry IN SELECT value FROM jsonb_array_elements(source) LOOP
   IF jsonb_typeof(entry)='string' AND btrim(entry #>> '{}')<>'' AND NOT items ? (entry #>> '{}') THEN items := items || jsonb_build_array(entry); END IF;
  END LOOP;
  result := jsonb_set(result,ARRAY[kind],items);
 END LOOP;
 RETURN result;
END
$media$;
-- statement-breakpoint
CREATE OR REPLACE FUNCTION field_review_track_edit() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
 old_row JSONB; new_row JSONB; before_value JSONB; after_value JSONB;
 field_key TEXT; column_key TEXT; warehouse_id INTEGER; field_version INTEGER; tracked TEXT[];
 old_media JSONB; new_media JSONB;
BEGIN
 old_row := CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
 new_row := CASE WHEN TG_OP='DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
 warehouse_id := COALESCE((new_row->>'warehouseId')::integer,(old_row->>'warehouseId')::integer,
                          (new_row->>'id')::integer,(old_row->>'id')::integer);
 tracked := TG_ARGV[0]::text[];
 IF TG_TABLE_NAME='Warehouse' AND (old_row->'media' IS DISTINCT FROM new_row->'media' OR old_row->'photos' IS DISTINCT FROM new_row->'photos') THEN
  old_media := field_review_media(old_row); new_media := field_review_media(new_row);
 END IF;
 FOREACH column_key IN ARRAY tracked LOOP
  field_key := CASE WHEN TG_TABLE_NAME='WarehouseData' THEN 'warehouseData.' ELSE '' END || column_key;
  IF column_key='media' THEN
   before_value := old_media; after_value := new_media;
  ELSIF column_key='availabilityReview' THEN
   before_value := jsonb_build_object('availability',old_row->'availability','availabilityLastReviewedOn',old_row->'availabilityLastReviewedOn');
   after_value := jsonb_build_object('availability',new_row->'availability','availabilityLastReviewedOn',new_row->'availabilityLastReviewedOn');
  ELSIF column_key='handover' THEN
   before_value := jsonb_build_object('handoverType',old_row->'handoverType','handoverDate',old_row->'handoverDate','handoverLeadValue',old_row->'handoverLeadValue','handoverLeadUnit',old_row->'handoverLeadUnit');
   after_value := jsonb_build_object('handoverType',new_row->'handoverType','handoverDate',new_row->'handoverDate','handoverLeadValue',new_row->'handoverLeadValue','handoverLeadUnit',new_row->'handoverLeadUnit');
  ELSE
   before_value := COALESCE(old_row->column_key,'null'::jsonb);
   after_value := COALESCE(new_row->column_key,'null'::jsonb);
  END IF;
  IF before_value IS DISTINCT FROM after_value THEN
   INSERT INTO "WarehouseFieldVersion" ("warehouseId","fieldKey","version") VALUES (warehouse_id,field_key,1)
    ON CONFLICT ("warehouseId","fieldKey") DO UPDATE SET "version"="WarehouseFieldVersion"."version"+1
    RETURNING "version" INTO field_version;
   INSERT INTO "WarehouseFieldEdit" ("warehouseId","fieldKey","version","oldValue","newValue","actorEmail","source","createdAt")
    VALUES (warehouse_id,field_key,field_version,before_value,after_value,
      NULLIF(current_setting('wareongo.actor_email',true),''),
      COALESCE(NULLIF(current_setting('wareongo.edit_source',true),''),'Warehouse edit'),clock_timestamp());
  END IF;
 END LOOP;
 RETURN COALESCE(NEW,OLD);
END
$fn$;
-- statement-breakpoint

-- statement-breakpoint
DROP TRIGGER IF EXISTS field_review_track_edit ON "Warehouse";
-- statement-breakpoint
CREATE TRIGGER field_review_track_edit AFTER UPDATE ON "Warehouse"
FOR EACH ROW EXECUTE FUNCTION field_review_track_edit('{listing_type,warehouseOwnerType,ownerCompanyName,contactPerson,contactNumber,alt_phone_number,ownerAltPoc,isBroker,is_builder,owner_warmnth,owner_of_multiple_sites,availabilityReview,handover,lockInDate,status,address,city,state,postalCode,zone,googleLocation,nearest_transport,distance_from_highway,warehouseType,totalFloors,liftAccess,passengerLiftCount,serviceLiftCount,liftLoadCapacity,totalSpaceSqft,chargeableArea,land_parcel_size,builtup_area,carpet_area,clearHeightFt,centreHeight,plinthHeightFt,numberOfDocks,dockDimension,dockApronLengthFt,dockPlatformType,gateSizeFt,setbackArea,ccRoads,wallAndSecurityRoom,canopyType,otherDockingSpecs,flooringType,floorStrengthPerSqm,ventilationType,ventilationAirChangesPerDay,insulationPresent,insulationType,lightingDetails,washroom_count,waterSupply,suitableFor,otherSpecifications,compliances,fire_exits,fire_compliance_cert_type,ratePerSqft,negotiated_rent,cam,scoutNotes,media}');
-- statement-breakpoint

-- statement-breakpoint
DROP TRIGGER IF EXISTS field_review_track_edit ON "WarehouseData";
-- statement-breakpoint
CREATE TRIGGER field_review_track_edit AFTER INSERT OR UPDATE OR DELETE ON "WarehouseData"
FOR EACH ROW EXECUTE FUNCTION field_review_track_edit('{latitude,longitude,approachRoadWidth,landType,pollutionZone,dimensions,parkingDockingSpace,powerKva,fireNocAvailable,fireSafetyMeasures,vaastuCompliance}');
-- statement-breakpoint

-- statement-breakpoint
ALTER TABLE "WarehouseFieldReview" ADD COLUMN IF NOT EXISTS "uploaderId" INTEGER;
-- statement-breakpoint
ALTER TABLE "WarehouseFieldFlag" ADD COLUMN IF NOT EXISTS "labelSnapshot" TEXT NOT NULL DEFAULT '';
-- statement-breakpoint
ALTER TABLE "WarehouseFieldFlag" ADD COLUMN IF NOT EXISTS "createdBy" TEXT;
-- statement-breakpoint
-- All access goes through the backend's roster and assignment checks. Direct
-- database API access must not expose raw proposals, phone snapshots or history.
DO $security$
DECLARE table_name TEXT; role_name TEXT;
BEGIN
 FOREACH table_name IN ARRAY ARRAY['WarehouseFieldReview','WarehouseFieldFlag','WarehouseFieldReviewEvent','WarehouseFieldVersion','WarehouseFieldEdit'] LOOP
  EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',current_schema(),table_name);
  EXECUTE format('REVOKE ALL ON %I.%I FROM PUBLIC',current_schema(),table_name);
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
   IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
    EXECUTE format('REVOKE ALL ON %I.%I FROM %I',current_schema(),table_name,role_name);
   END IF;
  END LOOP;
 END LOOP;
END
$security$;
