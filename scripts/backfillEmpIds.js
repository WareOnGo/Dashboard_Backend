const { PrismaClient } = require('@prisma/client');
const { generateUniqueEmpId } = require('../src/utils/empIdGenerator');

const prisma = new PrismaClient();

async function main() {
  const rows = await prisma.verifiedNumber.findMany({
    where: { empID: null },
    select: { id: true, name: true, phone_number: true },
  });

  console.log(`Found ${rows.length} VerifiedNumber row(s) without empID.`);

  let assigned = 0;
  for (const row of rows) {
    const empID = await generateUniqueEmpId(prisma);
    await prisma.verifiedNumber.update({
      where: { id: row.id },
      data: { empID },
    });
    assigned++;
    console.log(`  → id=${row.id} (${row.name}, ${row.phone_number}) → ${empID}`);
  }

  console.log(`Done. Assigned ${assigned} empID(s).`);
}

main()
  .catch((err) => {
    console.error('Backfill failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
