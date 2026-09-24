const BaseModel = require('./baseModel');
const { ImagePipelineRepository } = require('./imagePipelineRepository.cjs');

// Compatibility readers/writers share the registered image rows with stage workers.
class ImageLabelModel extends BaseModel {
    constructor(prismaClient = null) {
        super(prismaClient);
        this.model = this.prisma.labeledWarehouseImage;
        this.pipeline = new ImagePipelineRepository(this.prisma);
    }
    async bounded(method, ...args) {
        return this.prisma.$transaction(async tx => {
            await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '5s'");
            return new ImageLabelModel(tx)[method](...args);
        }, { maxWait: 3000, timeout: 8000 });
    }
    async findUnlabelled(limit) {
        return this.prisma.$queryRawUnsafe(`SELECT DISTINCT ON (u.url) w.id AS "warehouseId", u.url AS "imageUrl"
          FROM "Warehouse" w CROSS JOIN LATERAL unnest(public.wareongo_image_urls(w.media::jsonb, w.photos)) u(url)
          LEFT JOIN labeled_warehouse_images l ON l."imageUrl" = u.url
          WHERE l.classification IS NULL AND (l.id IS NULL OR (l."labelStatus" IN ('PENDING', 'FAILED')
            AND l."labelAttempts" < 5 AND (l."labelNextAttemptAt" IS NULL OR l."labelNextAttemptAt" <= now())))
          ORDER BY u.url, w.id DESC LIMIT $1`, limit);
    }
    async countUnlabelled() {
        const rows = await this.prisma.$queryRawUnsafe(`SELECT count(DISTINCT u.url)::int AS n
          FROM "Warehouse" w CROSS JOIN LATERAL unnest(public.wareongo_image_urls(w.media::jsonb, w.photos)) u(url)
          LEFT JOIN labeled_warehouse_images l ON l."imageUrl" = u.url WHERE l.classification IS NULL`);
        return rows[0]?.n ?? 0;
    }
    async createManyLabels(rows) {
        if (!rows.length) return 0;
        return this.prisma.$executeRawUnsafe(`INSERT INTO labeled_warehouse_images
          ("warehouseId", "imageUrl", classification, description, model, confidence, "documentKind", "labelStatus", "labelledAt", "documentStatus")
          SELECT r."warehouseId", r."imageUrl", r.classification::"ImageClass", r.description, r.model, r.confidence,
            r."documentKind"::"DocumentKind", 'READY', now(), CASE WHEN r.classification = 'DOCUMENT' AND r."documentKind" IS NULL THEN 'PENDING' ELSE 'READY' END
          FROM jsonb_to_recordset($1::jsonb) AS r("warehouseId" int, "imageUrl" text, classification text, description text, model text, confidence float, "documentKind" text)
          ON CONFLICT ("imageUrl") DO UPDATE SET classification = EXCLUDED.classification,
            description = EXCLUDED.description, model = EXCLUDED.model, confidence = EXCLUDED.confidence,
            "documentKind" = EXCLUDED."documentKind", "labelStatus" = 'READY', "labelledAt" = now(),
            "labelError" = NULL, "labelNextAttemptAt" = NULL, "documentStatus" = EXCLUDED."documentStatus"
          WHERE labeled_warehouse_images.classification IS NULL AND labeled_warehouse_images."labelStatus" <> 'RUNNING'`, JSON.stringify(rows));
    }
    async findForWarehouse(id) { return this.findForWarehouses([id]); }
    async findForWarehouses(ids) {
        return (await this.pipeline.rowsForWarehouses(ids)).map(row => ({ ...row, imageUrl: row.originalUrl }));
    }
    async countStale() {
        const rows = await this.prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM labeled_warehouse_images l
          WHERE "unreferencedAt" IS NULL AND NOT EXISTS (SELECT 1 FROM "Warehouse" w
            CROSS JOIN LATERAL unnest(public.wareongo_image_urls(w.media::jsonb, w.photos)) u(url) WHERE u.url = l."imageUrl")`);
        return rows[0]?.n ?? 0;
    }
    // Historical method name retained for the sweep response; this only marks retention.
    async pruneStale() {
        return this.prisma.$executeRawUnsafe(`UPDATE labeled_warehouse_images l SET "unreferencedAt" = now()
          WHERE "unreferencedAt" IS NULL AND NOT EXISTS (SELECT 1 FROM "Warehouse" w
            CROSS JOIN LATERAL unnest(public.wareongo_image_urls(w.media::jsonb, w.photos)) u(url) WHERE u.url = l."imageUrl")`);
    }
    async countByClassification() {
        return this.prisma.$queryRawUnsafe(`SELECT l.classification, count(*)::int AS count
          FROM labeled_warehouse_images l WHERE l.classification IS NOT NULL AND EXISTS (
            SELECT 1 FROM "Warehouse" w CROSS JOIN LATERAL
            unnest(public.wareongo_image_urls(w.media::jsonb, w.photos)) u(url) WHERE u.url = l."imageUrl")
          GROUP BY l.classification ORDER BY count DESC`);
    }
    async countAll() {
        return (await this.countByClassification()).reduce((total, row) => total + row.count, 0);
    }
}
module.exports = ImageLabelModel;
