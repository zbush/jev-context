import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readSettings, settingsSchema, usageInstruction, receiptInstruction } from '../src/settings.mjs';

export async function configureSettings(pluginRoot, changes) {
  const settingsPath = path.join(pluginRoot, 'jev-context.settings.json');
  const settings = settingsSchema.parse({ ...readSettings(settingsPath), ...changes });
  const template = await readFile(new URL('../skills/jev-code-search/SKILL.template.md', import.meta.url), 'utf8');
  const description = settings.run_mode === 'auto'
    ? 'Always use Jev for code searches within the current task workspace. Use this skill whenever searching a codebase, even when the user does not mention Jev. Applies relevance filtering before loading code into context.'
    : 'Use Jev code search only when the user explicitly requests Jev, Jev relevance filtering, or its benchmark. Do not use for ordinary code searches.';
  const skill = template.replace('{{description}}', description)
    .replace('{{usage}}', usageInstruction(settings))
    .replace('{{receipts}}', receiptInstruction(settings))
    .replace('{{receipt_details}}', settings.include_receipts ? RECEIPT_DETAILS : '');
  const skillPath = path.join(pluginRoot, 'skills/jev-code-search/SKILL.md');
  await mkdir(path.dirname(skillPath), { recursive: true });
  // Validate and render before touching either file. Atomic replacement protects
  // readers from partial JSON/Markdown; restart/reinstall activates the pair.
  await writeFile(`${settingsPath}.tmp`, JSON.stringify(settings, null, 2) + '\n');
  await writeFile(`${skillPath}.tmp`, skill);
  await rename(`${settingsPath}.tmp`, settingsPath);
  await rename(`${skillPath}.tmp`, skillPath);
  return settings;
}

const RECEIPT_DETAILS = 'For one call, copy the top-level `token_savings.footer` exactly. For multiple calls used in this answer, deduplicate by `retrieval_id`, group by encoding, sum `saved_tokens` and `baseline_tokens`, and calculate `100 * total_saved / total_baseline` (0 when the denominator is 0). Say "added N retrieval tokens" for a negative sum. Include the encoding and number of searches. Do not sum percentages, mix encodings, repeat earlier turns\' receipts, or count shadow-mode hypothetical savings. Mention unavailable/error receipts separately, including failed calls without a receipt; never assume they saved zero. If every receipt is unavailable, say "Jev Context: retrieval token savings unavailable." Do not read raw logs to build the footer. Tool receipt counts exclude the final-answer footer and whole-task costs.';

async function main() {
  const { values } = parseArgs({ options: { receipts: { type: 'string' }, 'run-mode': { type: 'string' } } });
  const changes = {};
  if (values.receipts !== undefined) {
    if (!['on', 'off'].includes(values.receipts)) throw new Error('--receipts must be on or off.');
    changes.include_receipts = values.receipts === 'on';
  }
  if (values['run-mode'] !== undefined) changes.run_mode = values['run-mode'];
  const pluginRoot = fileURLToPath(new URL('..', import.meta.url));
  const settings = Object.keys(changes).length ? await configureSettings(pluginRoot, changes)
    : readSettings(path.join(pluginRoot, 'jev-context.settings.json'));
  console.log(JSON.stringify(settings, null, 2));
  if (Object.keys(changes).length) console.log('Saved local settings and generated skill instructions. Refresh the installed plugin and start a new Codex task to activate both.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
