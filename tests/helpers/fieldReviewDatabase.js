const {
  Prisma
} = require('@prisma/client');
const q = value => '"' + value.replaceAll('"', '""') + '"';
const literal = value => "'" + String(value).replaceAll("'", "''") + "'";

// Isolated-schema fixture, never production DDL. Callers must validate their URL
// with testDatabaseUrl before creating a connection.
async function createSchema(db) {
  const names = ['VerifiedNumber', 'Warehouse', 'WarehouseData', 'WarehouseProximity', 'AuditLog'];
  const models = names.map(name => Prisma.dmmf.datamodel.models.find(model => model.name === name));
  const enums = new Set(models.flatMap(model => model.fields.filter(field => field.kind === 'enum').map(field => field.type)));
  for (const name of enums) {
    const definition = Prisma.dmmf.datamodel.enums.find(entry => entry.name === name);
    await db.$executeRawUnsafe('CREATE TYPE ' + q(name) + ' AS ENUM (' + definition.values.map(value => "'" + value.name + "'").join(',') + ')');
  }
  for (const model of models) {
    const columns = model.fields.filter(field => ['scalar', 'enum'].includes(field.kind)).map(field => {
      if (field.isId) return q(field.name) + (field.type === 'Int' ? ' serial PRIMARY KEY' : ' text PRIMARY KEY');
      const type = field.kind === 'enum' ? q(field.type) : {
        String: 'text',
        Int: 'integer',
        Float: 'double precision',
        Boolean: 'boolean',
        DateTime: field.nativeType?.[0] === 'Date' ? 'date' : 'timestamp(3)',
        Json: 'jsonb'
      }[field.type];
      let fallback = '';
      if (field.hasDefaultValue) {
        if (field.default?.name === 'now') fallback = ' DEFAULT CURRENT_TIMESTAMP';
        else if (field.isList && Array.isArray(field.default)) fallback = " DEFAULT '{}'";
        else if (['boolean', 'number'].includes(typeof field.default)) fallback = ' DEFAULT ' + field.default;
        else if (typeof field.default === 'string') fallback = ' DEFAULT ' + literal(field.default);
      }
      return q(field.dbName || field.name) + ' ' + type + (field.isList ? '[]' : '')
        + (field.isRequired ? ' NOT NULL' : '') + fallback + (field.isUnique ? ' UNIQUE' : '');
    });
    await db.$executeRawUnsafe('CREATE TABLE ' + q(model.dbName || model.name) + ' (' + columns.join(',') + ')');
  }
  for (const model of models) {
    for (const field of model.fields.filter(field => field.relationFromFields?.length && names.includes(field.type))) {
      const target = models.find(entry => entry.name === field.type);
      await db.$executeRawUnsafe('ALTER TABLE ' + q(model.dbName || model.name)
        + ' ADD FOREIGN KEY (' + field.relationFromFields.map(q).join(',') + ') REFERENCES '
        + q(target.dbName || target.name) + ' (' + field.relationToFields.map(q).join(',') + ')'
        + (field.relationOnDelete === 'Cascade' ? ' ON DELETE CASCADE' : ''));
    }
  }
}
module.exports = {
  createSchema
};
