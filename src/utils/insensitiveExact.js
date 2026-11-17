// PostgreSQL Prisma mode:insensitive uses ILIKE even for equals. Email/name
// characters such as '_' and '%' must remain literal identity characters.
// https://www.prisma.io/docs/orm/v6/prisma-client/queries/filtering-and-sorting
module.exports = value => ({
    equals: value.replace(/[\\%_]/g, '\\$&'),
    mode: 'insensitive',
});
