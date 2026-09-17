import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('MCP handshake, tool discovery, baseline call, and saved response are consistent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jev-mcp-test-'));
  await writeFile(path.join(root, 'sample.js'), 'export const session = 42;\n');
  const data = path.join(root, '.jev-context');
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../src/server.mjs', import.meta.url))],
    env: { ...process.env, JEV_CONTEXT_ROOT: root, JEV_CONTEXT_DATA_DIR: data }, stderr: 'pipe' });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 1);
    assert.equal(tools.tools[0].name, 'search_code');
    const result = await client.callTool({ name: 'search_code', arguments: {
      question: 'Where is session defined?', query: 'session', mode: 'baseline' } });
    assert.equal(result.isError, undefined);
    const text = result.content[0].text;
    assert.match(text, /session = 42/);
    const payload = JSON.parse(text);
    assert.equal(payload.token_savings.status, 'measured');
    assert.equal(payload.token_savings.saved_tokens, 0);
    assert.match(payload.token_savings.footer, /baseline mode/);
    const stored = await readFile(path.join(data, payload.retrieval_id, 'actual.txt'), 'utf8');
    assert.equal(text, stored);
    const record = JSON.parse(await readFile(path.join(data, payload.retrieval_id, 'record.json'), 'utf8'));
    assert.equal(record.source, 'mcp');
    assert.equal(record.metrics.paired_tokens_saved, 0);
    const bad = await client.callTool({ name: 'search_code', arguments: {
      question: 'Find session', query: 'session', max_candidates: 9999 } });
    assert.equal(bad.isError, true);
    assert.equal((await readdir(data)).length, 1);
  } finally { await client.close(); }
});
