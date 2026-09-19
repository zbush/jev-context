import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, realpath } from 'node:fs/promises';
import { search, loadRecords } from '../src/engine.mjs';
import { summarize, createCounter } from '../src/metrics.mjs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('MCP expansion reads saved scores without credentials or another search', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jev-mcp-expand-'));
  const dataDir = path.join(root, '.jev-context');
  await writeFile(path.join(root, 'sample.js'), 'export const session = 42;\n');
  const counter = createCounter();
  let original;
  try {
    original = await search({ repository_root: root, question: 'Find session', query: 'session' },
      { dataDir, key: 'fixture-key' }, { counter, fetchImpl: async () => ({ ok: true, status: 200,
        json: async () => ({ model: 'fixture', usage: { input_tokens: 1, output_tokens: 1 },
          answers: { relevance: { type: 'choice', choice: 'No', confidence: 0.1, probabilities: { Yes: 0.4, No: 0.6 } } } }) }) });
  } finally { counter.free(); }
  assert.equal(original.isError, false);
  assert.deepEqual(JSON.parse(original.payload).results, []);
  const settingsFile = path.join(root, 'settings.json');
  await writeFile(settingsFile, JSON.stringify({ include_receipts: true, run_mode: 'ask-only' }));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../src/server.mjs', import.meta.url))],
    env: { ...process.env, TYPESAFE_API_KEY: '', JEV_CONTEXT_ROOT: '', JEV_CONTEXT_DATA_DIR: dataDir,
      JEV_CONTEXT_SETTINGS_FILE: settingsFile }, stderr: 'pipe' });
  const client = new Client({ name: 'expansion-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const args = { retrieval_id: original.record.id, repository_root: root, previous_threshold: 0.5, min_yes_probability: 0.33 };
    const response = await client.callTool({ name: 'expand_results', arguments: args });
    assert.equal(response.isError, undefined);
    const payload = JSON.parse(response.content[0].text);
    assert.match(payload.results[0].text, /session = 42/);
    assert.equal(payload.results[0].yes_probability, 0.4);
    assert.equal(payload.token_savings.baseline_tokens, 0);
    assert.ok(payload.token_savings.saved_tokens < 0);
    const context=await client.callTool({name:'expand_context',arguments:{retrieval_id:original.record.id,
      candidate_id:payload.results[0].id,repository_root:root}});
    assert.equal(context.isError,undefined);
    const expandedContext=JSON.parse(context.content[0].text);
    assert.match(expandedContext.results[0].text,/session = 42/);
    assert.equal(expandedContext.results[0].selection,'surrounding_fallback');
    assert.equal(expandedContext.results[0].yes_probability,undefined);
    assert.equal(expandedContext.token_savings.baseline_tokens,0);
    const invalid = await client.callTool({ name: 'expand_results', arguments: { ...args, min_yes_probability: 0.8 } });
    assert.equal(invalid.isError, true);
    assert.doesNotMatch(invalid.content[0].text, /session = 42/);
    const malformed = await client.callTool({ name: 'expand_results', arguments: { ...args, retrieval_id: '../secret' } });
    assert.equal(malformed.isError, true);
  } finally { await client.close(); }
});

for (const include_receipts of [true, false]) for (const run_mode of ['auto', 'ask-only']) {
test(`MCP settings: receipts=${include_receipts}, mode=${run_mode}`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jev-mcp-test-'));
  await writeFile(path.join(root, 'sample.js'), 'export const session = 42;\n');
  const data = path.join(root, '.jev-context');
  const settingsFile = path.join(root, 'settings.json');
  await writeFile(settingsFile, JSON.stringify({ include_receipts, run_mode }));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../src/server.mjs', import.meta.url))],
    env: { ...process.env, JEV_CONTEXT_ROOT: '', JEV_CONTEXT_DATA_DIR: data,
      JEV_CONTEXT_SETTINGS_FILE: settingsFile }, stderr: 'pipe' });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 3);
    assert.equal(tools.tools[0].name, 'search_code');
    assert.equal(tools.tools[1].name, 'expand_results');
    assert.equal(tools.tools[2].name, 'expand_context');
    assert.ok(tools.tools[0].inputSchema.properties.min_yes_probability);
    assert.match(tools.tools[0].description, run_mode === 'auto' ? /Auto run mode/ : /Ask only mode/);
    assert.match(tools.tools[0].description, include_receipts ? /Receipts are on/ : /Receipts are off/);
    const result = await client.callTool({ name: 'search_code', arguments: {
      repository_root: root, question: 'Where is session defined?', query: 'session', mode: 'baseline' } });
    assert.equal(result.isError, undefined);
    const text = result.content[0].text;
    assert.match(text, /session = 42/);
    const payload = JSON.parse(text);
    if (include_receipts) {
    assert.equal(payload.token_savings.status, 'measured');
    assert.equal(payload.token_savings.saved_tokens, 0);
    assert.match(payload.token_savings.footer, /baseline mode/);
    } else assert.equal(payload.token_savings, undefined);
    const stored = await readFile(path.join(data, payload.retrieval_id, 'actual.txt'), 'utf8');
    assert.equal(text, stored);
    const record = JSON.parse(await readFile(path.join(data, payload.retrieval_id, 'record.json'), 'utf8'));
    assert.equal(record.source, 'mcp');
    assert.equal(record.metrics.paired_tokens_saved, 0);
    const bad = await client.callTool({ name: 'search_code', arguments: {
      question: 'Find session', query: 'session', max_candidates: 9999 } });
    assert.equal(bad.isError, true);
    assert.equal((await readdir(data)).length, 1);
    const other = await mkdtemp(path.join(os.tmpdir(), "jev-other project's-"));
    await writeFile(path.join(other, 'sample.js'), 'export const session = 999;\n');
    const call = repository_root => client.callTool({ name: 'search_code', arguments: {
      repository_root, question: 'Find session', query: 'session', mode: 'baseline' } });
    const results = await Promise.all([call(root), call(other)]);
    assert.match(results[0].content[0].text, /session = 42/);
    assert.doesNotMatch(results[0].content[0].text, /session = 999/);
    assert.match(results[1].content[0].text, /session = 999/);
    assert.doesNotMatch(results[1].content[0].text, /session = 42/);
    const groups = summarize(await loadRecords(data)).groups;
    assert.equal(groups.length, 2);
    assert.deepEqual(new Set(groups.map(g => g.repository_root)), new Set(await Promise.all([realpath(root), realpath(other)])));
    const missing = await client.callTool({ name: 'search_code', arguments: {
      question: 'Find session', query: 'session', mode: 'baseline' } });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /Supply repository_root/);
    assert.equal((await call('relative/path')).isError, true);
    assert.equal((await call(path.join(root, 'sample.js'))).isError, true);
    assert.equal((await call(path.join(root, 'missing-directory'))).isError, true);
    const escape = await client.callTool({ name: 'search_code', arguments: {
      repository_root: root, path: '..', question: 'Find session', query: 'session', mode: 'baseline' } });
    assert.equal(escape.isError, true);
  } finally { await client.close(); }
});
}
