const MODEL = 'gpt-6.2-sol';
const TIMEOUT_MS = 55000;
const settings = Object.freeze({
  model: MODEL,
  store: false,
  reasoning: { effort: 'low' },
  max_output_tokens: 9000
});
module.exports = { MODEL, TIMEOUT_MS, settings };
