import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { search, loadRecords } from '../src/engine.mjs';
import { expand, expansionSchema } from '../src/expansion.mjs';
import { createCounter, summarize } from '../src/metrics.mjs';
import { auditRecords } from '../src/audit.mjs';
import { searchSchema } from '../src/search.mjs';
import { requestFor, PROMPT_VERSION } from '../src/jev.mjs';
import { quality } from '../src/cli.mjs';

const counter = createCounter();
test.after(() => counter.free());
const probabilities = [0.9, 0.5, 0.49, 0.34, 0.33, 0.2, 0];
const input = { question: 'Which code helps?', query: 'passage', context_lines: 0 };
async function fixture(extra = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jev-expand-'));
  for (const [i, p] of probabilities.entries()) await writeFile(path.join(root, `${i}.js`), `const passage = ${p};\n`);
  return { root, dataDir: path.join(root, '.jev-context'), key: 'test-key', source: 'test', ...extra };
}
let calls = 0;
const fetchImpl = async (_, options) => {
  calls++;
  const request = JSON.parse(options.body);
  assert.deepEqual(Object.keys(request.questions.relevance.criteria), ['Yes', 'No']);
  const p = probabilities[Number(path.basename(request.state.candidate.file, '.js'))];
  return { ok: true, status: 200, json: async () => ({ model: 'test-double',
    usage: { input_tokens: 5, output_tokens: 5 }, answers: { relevance: {
      type: 'choice', choice: p > 0.5 ? 'Yes' : 'No', confidence: Math.abs(2 * p - 1),
      probabilities: { Yes: p, No: 1 - p },
    } } }) };
};
const run = (config, args = {}) => search({ ...input, ...args }, config, { counter, fetchImpl });
const expandArgs = (r, config, previous = 0.5, next = 0.33) => ({ retrieval_id: r.record.id,
  repository_root: config.root, previous_threshold: previous, min_yes_probability: next });
const scores = result => JSON.parse(result.payload).results.map(c => c.yes_probability);

test('binary search uses strict threshold, preserves No verdicts, and reports withheld bands', async () => {
  const config = await fixture();
  const r = await run(config);
  assert.equal(r.isError, false);
  assert.equal(r.record.prompt_version, PROMPT_VERSION);
  assert.deepEqual(scores(r), [0.9]);
  const summary = JSON.parse(r.payload).scoring;
  assert.equal(summary.min_yes_probability, 0.5);
  assert.deepEqual(summary.withheld_score_bands.map(b => b.count), [3, 3, 0, 0]);
  const loose = await run(config, { min_yes_probability: 0.33 });
  assert.deepEqual(scores(loose), [0.9, 0.5, 0.49, 0.34]);
  assert.equal(loose.record.decisions[2].label, 'No');
  assert.equal(loose.record.counts.selected, 4);
  assert.deepEqual(scores(await run({ ...config, minYesProbability: 0.8 }, { min_yes_probability: 0 })), probabilities.filter(p => p > 0));
  assert.deepEqual(scores(await run(config, { min_yes_probability: 1 })), []);
  assert.equal((await run({ ...config, minYesProbability: 0.8 })).record.config.min_yes_probability, 0.8);
  for (const p of [-1, 1.01, NaN, Infinity, '0.33']) assert.throws(() => searchSchema.parse({ ...input, min_yes_probability: p }));
  const q = quality([{ ...loose.record, experiment: 'loose' }], { loose: [{ file: '2.js', line: 1, relevant: true }] });
  assert.equal(q[0].filter_recall_given_retrieval, 1);
});

test('successive expansion intervals are disjoint snapshots and incur no Jev calls', async () => {
  const config = await fixture();
  const r = await run(config), before = calls;
  await writeFile(path.join(config.root, '2.js'), 'CHANGED AFTER SEARCH');
  const e = await expand(expandArgs(r, config), config, { counter });
  assert.equal(e.isError, false);
  assert.deepEqual(scores(e), [0.5, 0.49, 0.34]);
  assert.match(e.payload, /const passage = 0.49/);
  assert.doesNotMatch(e.payload, /CHANGED AFTER SEARCH/);
  const e2 = await expand(expandArgs(r, config, 0.33, 0.1), config, { counter });
  assert.deepEqual(scores(e2), [0.33, 0.2]);
  const empty = await expand(expandArgs(r, config, 0.1, 0), config, { counter });
  assert.deepEqual(scores(empty), []);
  assert.equal(calls, before);
  assert.equal(e.record.jev.calls, 0);
  assert.equal(JSON.parse(e.payload).source_retrieval_id, r.record.id);
  assert.notEqual(JSON.parse(e.payload).retrieval_id, r.record.id);
  assert.match(JSON.parse(e.payload).notice, /snapshot/);
  assert.equal(await readFile(path.join(e.directory, 'actual.txt'), 'utf8'), e.payload);
});

test('expansion receipts subtract full added payload and reports/audits retain that cost', async () => {
  const config = await fixture();
  const r = await run(config);
  const e = await expand(expandArgs(r, config), config, { counter });
  const again = await expand(expandArgs(r, config), config, { counter });
  for (const result of [e, again]) {
    const receipt = JSON.parse(result.payload).token_savings;
    assert.equal(receipt.status, 'measured');
    assert.equal(receipt.returned_tokens, counter.count(result.payload));
    assert.equal(receipt.baseline_tokens, 0);
    assert.equal(receipt.saved_tokens, -counter.count(result.payload));
  }
  const records = await loadRecords(config.dataDir);
  const report = summarize(records);
  assert.equal(report.groups.length, 2);
  const expansion = report.groups.find(g => g.operation === 'expand');
  assert.equal(expansion.actual_vs_baseline_tokens_saved, -counter.count(e.payload) - counter.count(again.payload));
  assert.equal(expansion.weighted_reduction_pct, null);
  assert.equal(report.jev_calls_all_runs, probabilities.length);
  assert.equal((await auditRecords(config.dataDir, records)).all_successful_runs_verified, true);
  await writeFile(path.join(e.directory, 'actual.txt'), e.payload + ' ');
  assert.equal((await auditRecords(config.dataDir, records)).all_successful_runs_verified, false);
});

test('expansion rejects missing, wrong-root, invalid intervals, and non-filtered snapshots', async () => {
  const config = await fixture(), r = await run(config), args = expandArgs(r, config);
  for (const change of [
    { retrieval_id: randomUUID() }, { repository_root: os.tmpdir() },
    { previous_threshold: 0.33, min_yes_probability: 0.33 },
    { previous_threshold: 0.8 }, { previous_threshold: 0.2, min_yes_probability: 0.33 },
  ]) {
    const result = await expand({ ...args, ...change }, config, { counter });
    assert.equal(result.isError, true);
    assert.doesNotMatch(result.payload, /const passage/);
  }
  for (const change of [{ retrieval_id: '../record' }, { previous_threshold: -1 }, { min_yes_probability: 2 }, { repository_root: 'relative' }]) {
    assert.throws(() => expansionSchema.parse({ ...args, ...change }));
  }
  for (const mode of ['baseline', 'shadow']) {
    const other = await run(config, { mode });
    assert.equal((await expand(expandArgs(other, config), config, { counter })).isError, true);
  }
  const e = await expand(args, config, { counter });
  assert.equal((await expand(expandArgs(e, config), config, { counter })).isError, true);
});

test('expansion refuses legacy and corrupt records instead of reinterpreting their scores', async () => {
  const config = await fixture(), r = await run(config), filename = path.join(r.directory, 'record.json');
  for (const change of [
    x => { x.schema_version = 1; x.prompt_version = 'relevance-v1'; },
    x => { x.status = 'error'; },
    x => { x.retrieval.candidates[0].text = 'tampered'; },
    x => { x.decisions[1].candidate_id = 'wrong'; },
    x => { x.decisions[0].answer.probabilities = { Yes: 0.6, No: 0.3, Unknown: 0.1 }; },
    x => { x.config.min_yes_probability = -1; },
  ]) {
    const modified = structuredClone(r.record); change(modified);
    await writeFile(filename, JSON.stringify(modified));
    const result = await expand(expandArgs(r, config), config, { counter });
    assert.equal(result.isError, true);
    assert.doesNotMatch(result.payload, /const passage|tampered/);
  }
});

test('receipts off and empty snapshots expand locally with auditable responses', async () => {
  const config = await fixture({ includeReceipts: false });
  for (const query of ['passage', 'no_such_token']) {
    const r = await run(config, { query });
    const e = await expand(expandArgs(r, config), config, { counter });
    assert.equal(e.isError, false);
    assert.equal(JSON.parse(e.payload).token_savings, undefined);
    assert.equal(e.record.metrics.actual_response_tokens, counter.count(e.payload));
    assert.equal((await auditRecords(config.dataDir, [r.record, e.record])).all_successful_runs_verified, true);
  }
});

test('binary prompt contains no selection threshold and no Unknown criterion', () => {
  const a = requestFor({ ...input, min_yes_probability: 0.5 }, { id: 'one', text: 'code' }, 'test');
  const b = requestFor({ ...input, min_yes_probability: 0.33 }, { id: 'one', text: 'code' }, 'test');
  assert.deepEqual(a, b);
  assert.deepEqual(Object.keys(a.questions.relevance.criteria), ['Yes', 'No']);
});
