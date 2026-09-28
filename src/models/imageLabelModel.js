const BaseModel = require('./baseModel');
const { ImagePipelineRepository } = require('./imagePipelineRepository.cjs');

// Dashboard readers share the registered image rows with the enrichment worker.
class ImageLabelModel extends BaseModel {
    constructor(prismaClient = null) {
        super(prismaClient);
        this.model = this.prisma.labeledWarehouseImage;
        this.pipeline = new ImagePipelineRepository(this.prisma);
    }
    async countUnlabelled() {
        const rows = await this.prisma.$queryRawUnsafe(`SELECT count(DISTINCT u.url)::int AS n
          FROM "Warehouse" w CROSS JOIN LATERAL unnest(public.wareongo_image_urls(w.media::jsonb, w.photos)) u(url)
          LEFT JOIN labeled_warehouse_images l ON l."imageUrl" = u.url WHERE l.classification IS NULL`);
        return rows[0]?.n ?? 0;
    }
    async findForWarehouse(id) { return this.findForWarehouses([id]); }
    async findForWarehouses(ids) {
        return (await this.pipeline.rowsForWarehouses(ids)).map(row => ({ ...row, imageUrl: row.originalUrl }));
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
