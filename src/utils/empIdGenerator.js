const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const LENGTH = 6;

const generateEmpId = () => {
  const bytes = crypto.randomBytes(LENGTH);
  let out = '';
  for (let i = 0; i < LENGTH; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
};

const generateUniqueEmpId = async (prisma, maxAttempts = 10) => {
  for (let i = 0; i < maxAttempts; i++) {
    const candidate = generateEmpId();
    const existing = await prisma.verifiedNumber.findUnique({
      where: { empID: candidate },
      select: { id: true },
    });
    if (!existing) return candidate;
  }
  throw new Error('Failed to generate a unique empID after multiple attempts');
};

module.exports = {
  generateEmpId,
  generateUniqueEmpId,
};
