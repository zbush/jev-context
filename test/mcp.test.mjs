import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, realpath } from 'node:fs/promises';
import { loadRecords } from '../src/engine.mjs';
import { summarize } from '../src/metrics.mjs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

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
    assert.equal(tools.tools.length, 1);
    assert.equal(tools.tools[0].name, 'search_code');
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
