import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { searchSchema } from './search.mjs';
import { configFromEnv } from './config.mjs';
import { createCounter } from './metrics.mjs';
import { search } from './engine.mjs';
import { unavailableReceipt } from './receipt.mjs';
import { toolDescription } from './settings.mjs';

const config = { ...configFromEnv(), source: 'mcp' };
const description = toolDescription({ include_receipts: config.includeReceipts, run_mode: config.runMode });
const counter = createCounter(config.encoding);
const server = new McpServer({ name: 'jev-context', version: '0.1.0' });
server.registerTool('search_code', { description, inputSchema: searchSchema.shape,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true } },
async (args, extra) => {
  try {
    const result = await search(args, config, { counter, signal: extra.signal });
    return { content: [{ type: 'text', text: result.payload }], ...(result.isError ? { isError: true } : {}) };
  } catch {
    // A telemetry/storage/configuration error is not an empty successful search.
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({
      error: 'Search failed before a complete audited result could be saved. Check plugin configuration and telemetry storage.',
      ...(config.includeReceipts ? { token_savings: unavailableReceipt(counter.metadata.encoding) } : {}),
    }) }] };
  }
});
await server.connect(new StdioServerTransport());
process.on('exit', () => counter.free());
