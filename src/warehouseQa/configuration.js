const { fail } = require('./common');

function databaseTarget(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(503, 'QA_CONFIGURATION', 'Invalid QA database configuration.');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    ['host', 'hostaddr', 'options'].some((key) => url.searchParams.has(key))
  )
    fail(503, 'QA_CONFIGURATION', 'QA database connections cannot override their destination.');
  return [
    url.hostname.toLowerCase(),
    url.port || '5432',
    decodeURIComponent(url.pathname),
    url.searchParams.get('schema') || 'public'
  ];
}

function handoffMode(env) {
  const mode = env.AI_QA_HANDOFF || 'staged';
  if (!['staged', 'field-review'].includes(mode))
    fail(503, 'QA_CONFIGURATION', 'AI_QA_HANDOFF must be staged or field-review.');
  if (
    mode === 'field-review' &&
    (env.AI_QA_SOURCE !== 'warehouse' ||
      JSON.stringify(databaseTarget(env.AI_QA_DATABASE_URL)) !==
        JSON.stringify(databaseTarget(env.DATABASE_URL)))
  )
    fail(
      503,
      'QA_CONFIGURATION',
      'Employee handoff requires QA and warehouse tables in the same database and schema.'
    );
  return mode;
}

module.exports = { databaseTarget, handoffMode };
