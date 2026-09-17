import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { searchSchema } from './search.mjs';
import { configFromEnv } from './config.mjs';
import { createCounter } from './metrics.mjs';
import { search } from './engine.mjs';
import { unavailableReceipt } from './receipt.mjs';

export const description = 'Search code inside the configured repository using ripgrep, then classify passages with Jev before returning only relevant evidence. Supply the user question and current retrieval objective. Literal search by default. Filtered mode withholds No/Unknown; baseline returns all admitted candidates without Jev; shadow evaluates Jev but returns all candidates for an explicit comparison. Each call saves paired payloads and token/latency/API-usage telemetry locally. Append token_savings.footer to your final answer; for multiple distinct retrieval_ids, sum saved_tokens and baseline_tokens per encoding and compute a weighted percentage. State unavailable receipts separately. These are retrieval payload savings, not total billing. Private candidate code is sent to TypeSafe in filtered/shadow modes.';

const config = { ...configFromEnv(), source: 'mcp' };
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
      token_savings: unavailableReceipt(counter.metadata.encoding),
    }) }] };
  }
});
await server.connect(new StdioServerTransport());
process.on('exit', () => counter.free());
