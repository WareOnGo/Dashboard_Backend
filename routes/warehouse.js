// routes/warehouse.js
const express = require('express');
const router = express.Router();
const { PrismaClient, Prisma } = require('@prisma/client'); // Import error type
const { z } = require('zod'); // Import Zod
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('crypto');

// --- Initialize Clients ---
const prisma = new PrismaClient();
const r2 = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
});

// --- Zod Validation Schemas ---

// Sub-schema for the nested WarehouseData
const warehouseDataSchema = z.object({
    latitude: z.number().optional().nullable(),
    longitude: z.number().optional().nullable(),
    fireNocAvailable: z.boolean().optional().nullable(),
    fireSafetyMeasures: z.string().optional().nullable(),
    landType: z.string().optional().nullable(),
    vaastuCompliance: z.string().optional().nullable(),
    approachRoadWidth: z.string().optional().nullable(),
    dimensions: z.string().optional().nullable(),
    parkingDockingSpace: z.string().optional().nullable(),
    pollutionZone: z.string().optional().nullable(),
    powerKva: z.string().optional().nullable(),
});

// Schema for CREATING a warehouse
const createWarehouseSchema = z.object({
    // Required fields
    warehouseType: z.string().min(1, "warehouseType is required"),
    address: z.string().min(1, "address is required"),
    city: z.string().min(1, "city is required"),
    state: z.string().min(1, "state is required"),
    zone: z.string().min(1, "zone is required"),
    contactPerson: z.string().min(1, "contactPerson is required"),
    contactNumber: z.string().min(1, "contactNumber is required"),
    totalSpaceSqft: z.array(z.number().int()).min(1, "totalSpaceSqft is required"),
    compliances: z.string().min(1, "compliances is required"),
    ratePerSqft: z.string().min(1, "ratePerSqft is required"),
    uploadedBy: z.string().min(1, "uploadedBy is required"),
    
    // Optional/Nullable fields
    warehouseOwnerType: z.string().optional().nullable(),
    googleLocation: z.string().optional().nullable(),
    postalCode: z.string().optional().nullable(),
    offeredSpaceSqft: z.string().optional().nullable(),
    numberOfDocks: z.string().optional().nullable(),
    clearHeightFt: z.string().optional().nullable(),
    otherSpecifications: z.string().optional().nullable(),
    availability: z.string().optional().nullable(),
    isBroker: z.string().optional().nullable(),
    photos: z.string().optional().nullable(),
    
    // Nested object
    warehouseData: warehouseDataSchema,
});

// Schema for UPDATING a warehouse (all fields are optional)
const updateWarehouseSchema = createWarehouseSchema.partial();

// --- CRUD Endpoints ---

/**
 * GET /api/warehouses
 */
router.get('/', async (req, res) => {
    try {
        const warehouses = await prisma.warehouse.findMany({
            // CORRECTED: Use capital 'W' to match schema
            include: { WarehouseData: true }, 
            orderBy: { createdAt: 'desc' }
        });
        res.json(warehouses);
    } catch (error) {
        console.error("Error fetching warehouses:", error);
        res.status(500).json({ error: "Could not fetch warehouses" });
    }
});

/**
 * POST /api/warehouses
 */
router.post('/', async (req, res) => {
    try {
        // 1. Validate the request body
        const validationResult = createWarehouseSchema.safeParse(req.body);
        if (!validationResult.success) {
            return res.status(400).json({ error: "Invalid input", issues: validationResult.error.issues });        
        }
        
        const { warehouseData, ...warehouse } = validationResult.data;

        // 2. Create in database
        const newWarehouse = await prisma.warehouse.create({
            data: {
                ...warehouse,
                // CORRECTED: Use capital 'W' to match schema
                WarehouseData: {
                    create: warehouseData,
                },
            },
            // CORRECTED: Use capital 'W' to match schema
            include: { WarehouseData: true },
        });
        res.status(201).json(newWarehouse);
    } catch (error) {
        console.error("Error creating warehouse:", error);
        res.status(500).json({ error: "Could not create warehouse" });
    }
});

/**
 * PUT /api/warehouses/:id
 */
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;

        // 1. Validate the request body
        const validationResult = updateWarehouseSchema.safeParse(req.body);
        if (!validationResult.success) {
            return res.status(400).json({ error: "Invalid input", issues: validationResult.error.issues });
        }
        
        // Handle empty body
        if (Object.keys(validationResult.data).length === 0) {
            return res.status(400).json({ error: "Request body cannot be empty for an update" });
        }

        const { warehouseData, ...warehouse } = validationResult.data;

        // 2. Update in database
        const updatedWarehouse = await prisma.warehouse.update({
            where: { id: parseInt(id) },
            data: {
                ...warehouse,
                // Only update warehouseData if it was provided
                ...(warehouseData && {
                    // CORRECTED: Use capital 'W' to match schema
                    WarehouseData: {
                        update: warehouseData,
                    },
                }),
            },
            // CORRECTED: Use capital 'W' to match schema
            include: { WarehouseData: true },
        });
        res.json(updatedWarehouse);
    } catch (error) {
        // 3. Specific Error Handling
        if (error instanceof Prisma.PrismaClientKnownRequestError) {
            if (error.code === 'P2025') { // "Record to update not found"
                return res.status(404).json({ error: `Warehouse with ID ${req.params.id} not found` });
            }
        }
        console.error("Error updating warehouse:", error);
        res.status(500).json({ error: "Could not update warehouse" });
    }
});

/**
 * DELETE /api/warehouses/:id
 */
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        await prisma.warehouse.delete({
            where: { id: parseInt(id) }
        });
        res.status(204).send(); 
    } catch (error) {
        // Specific Error Handling
        if (error instanceof Prisma.PrismaClientKnownRequestError) {
            if (error.code === 'P2025') { // "Record to delete not found"
                return res.status(404).json({ error: `Warehouse with ID ${req.params.id} not found` });
            }
        }
        console.error("Error deleting warehouse:", error);
        res.status(500).json({ error: "Could not delete warehouse" });
    }
});

// --- File Upload Endpoint ---

/**
 * POST /api/warehouses/presigned-url
 */
router.post('/presigned-url', async (req, res) => {
    // Basic validation for content type
    const contentType = req.body.contentType;
    if (!contentType || typeof contentType !== 'string') {
        return res.status(400).json({ error: 'A valid contentType string is required' });
    }

    const rawBytes = crypto.randomBytes(16);
    const imageName = rawBytes.toString('hex');
    
    const command = new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: imageName,
        ContentType: contentType,
    });

    try {
        const signedUrl = await getSignedUrl(r2, command, { expiresIn: 360 }); 
        const finalImageUrl = `${process.env.R2_PUBLIC_URL}/${imageName}`;

        res.json({
            uploadUrl: signedUrl,
            imageUrl: finalImageUrl,
        });
    } catch (error) {
        console.error("Error generating presigned URL:", error);
        res.status(500).json({ error: 'Could not generate signed URL' });
    }
});

module.exports = router;