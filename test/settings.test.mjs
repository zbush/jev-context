import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readSettings } from '../src/settings.mjs';
import { configureSettings } from '../scripts/settings.mjs';
import { search } from '../src/engine.mjs';
import { createCounter } from '../src/metrics.mjs';
import { auditRecords } from '../src/audit.mjs';
import { sha256 } from '../src/search.mjs';

test('settings default safely, preserve other values, and reject invalid edits', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jev-settings-'));
  const file = path.join(root, 'jev-context.settings.json');
  assert.deepEqual(readSettings(file), { include_receipts: true, run_mode: 'ask-only' });
  await configureSettings(root, { include_receipts: false });
  assert.deepEqual(await configureSettings(root, { run_mode: 'auto' }), { include_receipts: false, run_mode: 'auto' });
  const before = await readFile(file, 'utf8');
  for (const invalid of [{ run_mode: 'always' }, { include_receipts: 'false' }, { extra: true }]) {
    await assert.rejects(configureSettings(root, invalid));
    assert.equal(await readFile(file, 'utf8'), before);
  }
  await writeFile(file, '{broken');
  assert.throws(() => readSettings(file), /Invalid Jev Context settings/);
});

test('all four settings combinations produce consistent skill triggers and footer guidance', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jev-skill-'));
  for (const include_receipts of [true, false]) for (const run_mode of ['auto', 'ask-only']) {
    await configureSettings(root, { include_receipts, run_mode });
    const skill = await readFile(path.join(root, 'skills/jev-code-search/SKILL.md'), 'utf8');
    assert.doesNotMatch(skill, /\{\{/);
    assert.match(skill, run_mode === 'auto' ? /description: Always use Jev/ : /description: Use Jev code search only/);
    assert.match(skill, include_receipts ? /Receipts are on/ : /Receipts are off/);
    if (!include_receipts) assert.doesNotMatch(skill, /Append token_savings.footer|copy the top-level/);
  }
});

test('receipts off preserves auditable counts and omits receipts from success and errors', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'jev-no-receipt-'));
  const counter = createCounter();
  const candidates = [{ id: 'one', file: 'a.js', start_line: 1, end_line: 1, text: 'const a = 1;' }];
  const retrieveImpl = async () => ({ candidates, candidates_found: 1, retrieval_ms: 0,
    omitted_candidate_cap: 0, omitted_long_lines: 0, snapshot_sha256: sha256(JSON.stringify(candidates)) });
  const config = { root: dataDir, dataDir, includeReceipts: false, runMode: 'auto' };
  try {
    const result = await search({ question: 'Find a', query: 'a' }, config, { counter, retrieveImpl,
      classifyImpl: async () => [{ candidate_id: 'one', label: 'Yes', answer: { probabilities: { Yes: 1, No: 0 } } }] });
    assert.equal(result.isError, false);
    assert.equal(JSON.parse(result.payload).token_savings, undefined);
    assert.equal(result.record.metrics.actual_response_tokens, counter.count(result.payload));
    assert.equal(result.record.metrics.baseline_receipt_tokens, 0);
    assert.equal(result.record.metrics.filtered_receipt_tokens, 0);
    assert.equal(result.record.receipt_status, 'disabled');
    assert.equal((await auditRecords(dataDir, [result.record])).all_successful_runs_verified, true);
    const failed = await search({ question: 'Find a', query: 'a' }, config, { counter,
      retrieveImpl: async () => { throw new Error('offline failure'); } });
    assert.equal(failed.isError, true);
    assert.equal(JSON.parse(failed.payload).token_savings, undefined);
    assert.equal(failed.record.error_response_tokens, counter.count(failed.payload));
  } finally { counter.free(); }
});
