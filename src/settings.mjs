import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const DEFAULT_SETTINGS_PATH = fileURLToPath(new URL('../jev-context.settings.json', import.meta.url));
export const settingsSchema = z.object({
  include_receipts: z.boolean().default(true),
  run_mode: z.enum(['auto', 'ask-only']).default('ask-only'),
}).strict();

export function readSettings(settingsPath = process.env.JEV_CONTEXT_SETTINGS_FILE || DEFAULT_SETTINGS_PATH) {
  try { return settingsSchema.parse(JSON.parse(readFileSync(settingsPath, 'utf8'))); }
  catch (error) {
    if (error.code === 'ENOENT') return settingsSchema.parse({});
    throw new Error('Invalid Jev Context settings. Expected include_receipts (boolean) and run_mode (auto or ask-only).');
  }
}

export function usageInstruction(settings) {
  return settings.run_mode === 'auto'
    ? 'Auto run mode: always use Jev search_code when searching code within the current task workspace, without waiting for the user to name Jev. Honor explicit user opt-outs. This is agent guidance, not interception of native tools. If the tool is unavailable, explain the limitation and use an appropriate available search tool.'
    : 'Ask only mode: use Jev search_code only when the user explicitly asks for Jev code search, Jev relevance filtering, or its benchmark. Do not use it for ordinary code-search requests and do not ask the user to enable it on every search. An explicit Jev request can cover the ongoing task until the user changes it.';
}

export function receiptInstruction(settings) {
  return settings.include_receipts
    ? 'Receipts are on. Append token_savings.footer to the final answer after using this tool. For multiple distinct retrieval_ids, sum saved_tokens and baseline_tokens per encoding and compute a weighted percentage. State unavailable receipts separately. These are retrieval payload savings, not total billing.'
    : 'Receipts are off. Do not append a Jev token-savings footer to answers or read telemetry just to add one. Tool responses omit token_savings, but local telemetry continues to record exact payload counts. Answer an explicit user request about metrics normally.';
}

export function toolDescription(settings) {
  return `${usageInstruction(settings)} Supply repository_root as the absolute current task workspace path on every call; never use the server working directory as the project. Search code with ripgrep and score relevance with a binary Yes/No Jev question. Supply the user question and current retrieval objective. Literal search by default. Filtered mode keeps P(Yes) strictly above min_yes_probability (configured default, otherwise 0.50), regardless of winning verdict. Responses report the effective threshold and withheld score bands. Use expand_results with the original retrieval_id to lower the threshold without new Jev calls. Baseline returns all candidates without Jev; shadow scores but returns all candidates for an explicit comparison. ${receiptInstruction(settings)} Private candidate code is sent to TypeSafe in filtered/shadow modes.`;
}
