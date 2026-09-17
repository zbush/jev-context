import { parseArgs } from 'node:util';
import { writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { values } = parseArgs({ options: { root: { type: 'string' },
  'env-file': { type: 'string' }, rg: { type: 'string' }, data: { type: 'string' } } });
if (!values.root) throw new Error('--root is required.');
const pluginRoot = fileURLToPath(new URL('..', import.meta.url));
const root = await realpath(values.root);
const args = [];
if (values['env-file']) args.push(`--env-file=${await realpath(values['env-file'])}`);
args.push(path.join(pluginRoot, 'src/server.mjs'));
const config = { mcpServers: { jev_context: {
  command: process.execPath, args, cwd: pluginRoot,
  env: { JEV_CONTEXT_ROOT: root,
    ...(values.rg ? { JEV_CONTEXT_RG: await realpath(values.rg) } : {}),
    ...(values.data ? { JEV_CONTEXT_DATA_DIR: path.resolve(values.data) } : {}) },
  env_vars: ['TYPESAFE_API_KEY', 'TYPESAFE_MODEL', 'JEV_CONTEXT_ENCODING', 'JEV_CONTEXT_CONCURRENCY',
    'JEV_CONTEXT_MIN_YES_PROBABILITY', 'PATH'],
  startup_timeout_sec: 20, tool_timeout_sec: 600,
} } };
await writeFile(path.join(pluginRoot, '.mcp.json'), JSON.stringify(config, null, 2) + '\n');
console.log('Configured local MCP launcher. Only paths and environment-variable names were written; no key values.');
