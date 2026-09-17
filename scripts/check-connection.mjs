import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCounter } from '../src/metrics.mjs';

const { values } = parseArgs({ options: { config: { type: 'string', default: '.mcp.json' }, root: { type: 'string' } } });
const config = JSON.parse(await readFile(values.config, 'utf8')).mcpServers.jev_context;
const client = new Client({ name: 'jev-context-connection-check', version: '0.1.0' });
const transport = new StdioClientTransport({ command: config.command, args: config.args, cwd: config.cwd,
  env: { ...process.env, ...config.env }, stderr: 'pipe' });
let errors = '';
transport.stderr?.on('data', chunk => { errors += String(chunk); });
const counter = createCounter();
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  if (tools.length !== 1 || tools[0].name !== 'search_code') throw new Error('Expected search_code tool was not registered.');
  // Unique no-match pattern verifies retrieval and logging without sending code to Jev or returning source.
  const result = await client.callTool({ name: 'search_code', arguments: {
    question: 'Verify the local plugin connection without calling Jev.',
    ...(values.root ? { repository_root: values.root } : {}),
    query: '__JEV_CONNECTION_CHECK_7ba8d1d9__', globs: ['*.nonexistent-extension-7ba8d1d9'],
    mode: 'baseline', max_candidates: 1,
  } });
  if (result.isError) throw new Error('MCP search returned an error.');
  const payload = JSON.parse(result.content[0].text);
  if (payload.results.length) throw new Error('Expected zero results in connection check.');
  console.log(JSON.stringify({ status: 'ok', tool: tools[0].name, retrieval_id: payload.retrieval_id,
    jev_calls: 0, exposed_tool_definition_json_tokens: counter.count(JSON.stringify(tools[0])),
    tokenizer: counter.metadata.encoding,
    note: 'Tool-definition JSON count is diagnostic; host prompt rendering and injection frequency differ.' }, null, 2));
} finally { await client.close(); counter.free(); }
