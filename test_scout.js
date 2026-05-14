const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const http = require('http');

async function testScout() {
    console.log('Inserting test scout...');
    let scout;
    try {
        scout = await prisma.scout.upsert({
            where: { empid: 'TEST-SCOUT-123' },
            update: { status: 'ACTIVE' },
            create: {
                empid: 'TEST-SCOUT-123',
                name: 'Test Scout',
                email: 'testscout@example.com',
                status: 'ACTIVE'
            }
        });
        console.log('Scout inserted:', scout);
    } catch (e) {
        console.error('Error inserting scout', e);
        return;
    }

    // Now test the API
    console.log('Testing /api/warehouses/scout/presigned-url with valid empid...');
    const data = JSON.stringify({
        contentType: 'image/jpeg',
        uploadedBy: 'TEST-SCOUT-123'
    });

    const options = {
        hostname: 'localhost',
        port: 3000,
        path: '/api/warehouses/scout/presigned-url',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': data.length
        }
    };

    const req = http.request(options, (res) => {
        let responseBody = '';
        res.on('data', (chunk) => responseBody += chunk);
        res.on('end', () => {
            console.log(`Status: ${res.statusCode}`);
            console.log(`Body: ${responseBody}`);
            
            // Cleanup
            prisma.scout.delete({ where: { empid: 'TEST-SCOUT-123' } }).then(() => {
                console.log('Cleanup done.');
                process.exit(0);
            });
        });
    });

    req.on('error', (e) => {
        console.error(`Problem with request: ${e.message}`);
        process.exit(1);
    });

    req.write(data);
    req.end();
}

testScout();
