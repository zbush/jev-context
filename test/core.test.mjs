import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { retrieve, searchSchema, parseCandidates } from '../src/search.mjs';
import { search, loadRecords } from '../src/engine.mjs';
import { classify, validateAnswer } from '../src/jev.mjs';
import { createCounter, summarize } from '../src/metrics.mjs';
import { auditRecords } from '../src/audit.mjs';
import { quality } from '../src/cli.mjs';

const counter = createCounter();
test.after(() => counter.free());
const answer = choice => ({ type: 'choice', choice, confidence: 1,
  probabilities: Object.fromEntries(['Yes', 'No', 'Unknown'].map(k => [k, Number(k === choice)])) });
const response = (choice, usage = { input_tokens: 80, output_tokens: 12 }) => ({ ok: true, status: 200,
  json: async () => ({ model: 'test-double', usage, answers: { relevance: answer(choice) } }) });
const input = { question: 'How are sessions revoked?', query: 'session', context_lines: 0 };
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jev-context-test-'));
  await writeFile(path.join(root, 'a.js'), 'const session = "KEEP_REVOKE";\n');
  await writeFile(path.join(root, 'b.js'), 'const session = "DROP_ANALYTICS";\n');
  await writeFile(path.join(root, 'c.js'), 'const session = "UNKNOWN_USAGE";\n');
  await writeFile(path.join(root, '.env'), 'session=SECRET_NEVER_SEND\n');
  return { root, dataDir: path.join(root, '.jev-context'), key: 'test-key', source: 'test' };
}
const judge = async (_, options) => {
  const text = JSON.parse(options.body).state.candidate.text;
  return response(text.includes('KEEP') ? 'Yes' : text.includes('DROP') ? 'No' : 'Unknown');
};

test('only Yes enters response; saved pair reproduces token counts exactly', async () => {
  const config = await fixture();
  const result = await search(input, config, { counter, fetchImpl: judge });
  assert.equal(result.isError, false);
  assert.match(result.payload, /KEEP_REVOKE/);
  assert.doesNotMatch(result.payload, /DROP_ANALYTICS|UNKNOWN_USAGE|SECRET_NEVER_SEND/);
  assert.deepEqual(result.record.counts, { Yes: 1, No: 1, Unknown: 1, not_evaluated: 0 });
  const baseline = await readFile(path.join(result.directory, 'baseline.txt'), 'utf8');
  assert.equal(result.record.metrics.paired_tokens_saved, counter.count(baseline) - counter.count(result.payload));
  assert.equal(result.record.jev.known_input_tokens, 240);
  assert.equal(result.record.jev.known_output_tokens, 36);
  const receipt = JSON.parse(result.payload).token_savings;
  assert.equal(receipt.status, 'measured');
  assert.equal(receipt.saved_tokens, result.record.metrics.paired_tokens_saved);
  assert.equal(receipt.returned_tokens, counter.count(result.payload));
  const records = await loadRecords(config.dataDir);
  assert.equal(records.length, 1);
  assert.equal(summarize(records).groups[0].paired_tokens_saved, result.record.metrics.paired_tokens_saved);
});

test('shadow returns full baseline; savings are hypothetical and API tokens are counted', async () => {
  const result = await search({ ...input, mode: 'shadow' }, await fixture(), { counter, fetchImpl: judge });
  assert.match(result.payload, /DROP_ANALYTICS/);
  assert.equal(result.record.metrics.actual_vs_baseline_tokens_saved, 0);
  assert.ok(result.record.metrics.paired_tokens_saved > 0);
  assert.equal(result.record.jev.calls, 3);
});

test('baseline does not call Jev and records zero filtering savings', async () => {
  const result = await search({ ...input, mode: 'baseline' }, await fixture(), { counter,
    fetchImpl: () => { throw new Error('must not call'); } });
  assert.equal(result.isError, false);
  assert.equal(result.record.jev.calls, 0);
  assert.equal(result.record.metrics.paired_tokens_saved, 0);
  assert.match(result.payload, /UNKNOWN_USAGE/);
});

test('Jev failure returns no raw text, records partial cost, and is excluded from savings', async () => {
  let calls = 0;
  const result = await search(input, await fixture(), { counter, fetchImpl: async () => {
    calls++;
    return calls === 2 ? { ok: false, status: 429 } : response('Yes');
  } });
  assert.equal(result.isError, true);
  assert.doesNotMatch(result.payload, /KEEP_REVOKE|DROP_ANALYTICS|UNKNOWN_USAGE/);
  assert.equal(result.record.metrics, null);
  assert.equal(JSON.parse(result.payload).token_savings.status, 'unavailable');
  assert.equal(result.record.jev.known_input_tokens, 160);
  assert.equal(result.record.jev.missing_usage_calls, 1);
  assert.equal(summarize([result.record]).groups.length, 0);
});

test('candidate cap is explicit and does not masquerade as filtering', async () => {
  const result = await search({ ...input, mode: 'baseline', max_candidates: 1 }, await fixture(), { counter });
  assert.equal(result.record.retrieval.omitted_candidate_cap, 2);
  assert.equal(result.record.metrics.paired_tokens_saved, 0);
});

test('no matches makes no API requests and yields an audited result', async () => {
  const result = await search({ ...input, query: 'ABSENT' }, await fixture(), { counter,
    fetchImpl: () => { throw new Error('must not call'); } });
  assert.equal(result.isError, false);
  assert.equal(result.record.jev.calls, 0);
  assert.deepEqual(JSON.parse(result.payload).results, []);
});

test('root escape and invalid regex fail without leaking source', async () => {
  const config = await fixture();
  await assert.rejects(retrieve(config.root, searchSchema.parse({ ...input, path: '..' })), /inside/);
  const r = await search({ ...input, query: '[', regex: true }, config, { counter });
  assert.equal(r.isError, true);
});

test('user globs cannot reinclude credentials or telemetry', async () => {
  const config = await fixture();
  await mkdir(config.dataDir);
  await writeFile(path.join(config.dataDir, 'record.json'), '{"session":"leak"}');
  const result = await retrieve(config.root, searchSchema.parse({ ...input, globs: ['*', '.env', '.jev-context/**'] }));
  assert.equal(result.candidates.length, 3);
});

test('literal patterns cannot become shell options or commands', async () => {
  const config = await fixture();
  await writeFile(path.join(config.root, 'options.txt'), '--version; echo exploited\n');
  const result = await retrieve(config.root, searchSchema.parse({ ...input, query: '--version; echo exploited' }));
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].file, 'options.txt');
});

test('low-probability Yes becomes Unknown without losing the original judgment', async () => {
  const r = await classify(input, [{ id: 'a', text: 'code' }], { key: 'x', minYesProbability: 0.8,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ model: 'test', usage: {},
      answers: { relevance: { type: 'choice', choice: 'Yes', confidence: 0.1,
        probabilities: { Yes: 0.5, No: 0.3, Unknown: 0.2 } } } }) }) });
  assert.equal(r[0].label, 'Unknown');
  assert.equal(r[0].answer.choice, 'Yes');
  assert.equal(r[0].usage, null);
});

test('classification response validation rejects malformed distributions', () => {
  assert.throws(() => validateAnswer({ ...answer('Yes'), probabilities: { Yes: 0, No: 1, Unknown: 0 } }));
});

test('tokenizer handles source containing special-token spellings and Unicode', () => {
  assert.equal(counter.count('hello world'), 2);
  assert.ok(counter.count('<|endoftext|> 日本語 🧪') > 0);
});

test('overlapping contexts merge and oversized lines are explicit omissions', () => {
  const event = (n, text, type = 'match') => JSON.stringify({ type, data: {
    path: { text: 'a.js' }, line_number: n, lines: { text: text + '\n' } } });
  const parsed = parseCandidates([event(1, 'session'), event(2, 'context', 'context'),
    event(3, 'session'), event(9, 'x'.repeat(12001))].join('\n'));
  assert.equal(parsed.candidates.length, 1);
  assert.deepEqual(parsed.candidates[0].match_lines, [1, 3]);
  assert.equal(parsed.omitted_long_lines, 1);
});

test('aggregate reduction is weighted, not an average of percentages', () => {
  const make = (b, f) => ({ status: 'ok', mode: 'filtered', source: 'test', tokenizer: counter.metadata,
    config: { model: 'test', min_yes_probability: 0 }, prompt_version: 'test',
    metrics: { baseline_response_tokens: b, filtered_response_tokens: f, actual_response_tokens: f },
    timing: { total_ms: 10 }, jev: { known_input_tokens: 0, known_output_tokens: 0 },
    retrieval: { omitted_candidate_cap: 0 }, counts: { Yes: 1 } });
  assert.equal(summarize([make(100, 0), make(900, 900)]).groups[0].weighted_reduction_pct, 10);
});

test('audit detects changed payload and report separates retrieval misses from filter misses', async () => {
  const config = { ...await fixture(), experiment: 'retention' };
  const result = await search(input, config, { counter, fetchImpl: judge });
  assert.equal((await auditRecords(config.dataDir, [result.record])).all_successful_runs_verified, true);
  const labels = { retention: [{ file: 'a.js', line: 1, relevant: true },
    { file: 'b.js', line: 1, relevant: true }, { file: 'missing.js', line: 1, relevant: true }] };
  const q = quality([result.record], labels)[0];
  assert.equal(q.retrieval_recall, 2 / 3);
  assert.equal(q.filter_recall_given_retrieval, 1 / 2);
  assert.equal(q.end_to_end_anchor_recall, 1 / 3);
  await writeFile(path.join(result.directory, 'filtered.txt'), result.payload + ' ');
  const audit = await auditRecords(config.dataDir, [result.record]);
  assert.equal(audit.all_successful_runs_verified, false);
  assert.ok(audit.results[0].errors.includes('filtered payload hash mismatch'));
});
