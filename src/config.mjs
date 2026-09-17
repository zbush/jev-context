import path from 'node:path';
import os from 'node:os';
import { readSettings } from './settings.mjs';

export function configFromEnv(root = process.env.JEV_CONTEXT_ROOT) {
  const concurrency = Number(process.env.JEV_CONTEXT_CONCURRENCY || 4);
  const minYesProbability = Number(process.env.JEV_CONTEXT_MIN_YES_PROBABILITY || 0);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('Concurrency must be 1–8.');
  if (!Number.isFinite(minYesProbability) || minYesProbability < 0 || minYesProbability > 1) throw new Error('Minimum Yes probability must be 0–1.');
  const settings = readSettings();
  return { root: root ? path.resolve(root) : undefined,
    dataDir: path.resolve(process.env.JEV_CONTEXT_DATA_DIR || path.join(os.homedir(), '.jev-context')),
    key: process.env.TYPESAFE_API_KEY, model: process.env.TYPESAFE_MODEL || 'jev-latest',
    encoding: process.env.JEV_CONTEXT_ENCODING || 'o200k_base', concurrency, minYesProbability,
    includeReceipts: settings.include_receipts, runMode: settings.run_mode };
}
