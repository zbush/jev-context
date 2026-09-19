import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { searchSchema } from './search.mjs';
import { configFromEnv } from './config.mjs';
import { createCounter } from './metrics.mjs';
import { search } from './engine.mjs';
import { unavailableReceipt } from './receipt.mjs';
import { toolDescription, receiptInstruction } from './settings.mjs';
import { expand, expansionSchema } from './expansion.mjs';
import { expandContext, contextSchema } from './context.mjs';

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
server.registerTool('expand_results', {
  description: `Recover lower-scoring passages from a saved binary filtered search with no new search or Jev calls. Supply the original retrieval_id, current repository_root, previous_threshold (lowest already consumed), and a lower min_yes_probability. Returns only new < P(Yes) <= previous. Saved code may be stale; verify current files before edits. Repeated or overlapping intervals repeat content. ${receiptInstruction({ include_receipts: config.includeReceipts })} Expansion receipts subtract added tokens from original savings, with zero incremental baseline.`,
  inputSchema: expansionSchema.shape,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async args => {
  try {
    const result = await expand(args, config, { counter });
    return { content: [{ type: 'text', text: result.payload }], ...(result.isError ? { isError: true } : {}) };
  } catch {
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({
      error: 'Expansion failed before a complete audited result could be saved. Check arguments and telemetry storage.',
      ...(config.includeReceipts ? { token_savings: unavailableReceipt(counter.metadata.encoding) } : {}),
    }) }] };
  }
});
server.registerTool('expand_context', {
  description: `Read more local source around a returned passage without Jev calls or relevance filtering. Supply original retrieval_id, candidate_id, repository_root and optionally anchor_line within that passage. Function mode recognizes GDScript/Python indentation and falls back to surrounding lines for other cases. Default bounds: 120 lines/12000 characters; hard limits: 300 lines/24000 characters. Current source must still match the saved passage and remain searchable; changed or excluded files fail. Inspect truncation. Use for missing branches or nearby helpers; use expand_results for lower-scoring saved candidates. ${receiptInstruction({ include_receipts: config.includeReceipts })} Added context counts against original savings.`,
  inputSchema: contextSchema.shape,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async args => {
  try {
    const result = await expandContext(args, config, { counter });
    return { content: [{ type: 'text', text: result.payload }], ...(result.isError ? { isError: true } : {}) };
  } catch {
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({
      error: 'Context expansion failed before a complete audited result could be saved. Check arguments and telemetry storage.',
      ...(config.includeReceipts ? { token_savings: unavailableReceipt(counter.metadata.encoding) } : {}),
    }) }] };
  }
});
await server.connect(new StdioServerTransport());
process.on('exit', () => counter.free());
