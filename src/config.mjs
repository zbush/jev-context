import path from 'node:path';

export function configFromEnv(root = process.env.JEV_CONTEXT_ROOT) {
  if (!root) throw new Error('Set JEV_CONTEXT_ROOT to the repository directory.');
  const concurrency = Number(process.env.JEV_CONTEXT_CONCURRENCY || 4);
  const minYesProbability = Number(process.env.JEV_CONTEXT_MIN_YES_PROBABILITY || 0);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('Concurrency must be 1–8.');
  if (!Number.isFinite(minYesProbability) || minYesProbability < 0 || minYesProbability > 1) throw new Error('Minimum Yes probability must be 0–1.');
  return { root: path.resolve(root), dataDir: path.resolve(process.env.JEV_CONTEXT_DATA_DIR || path.join(root, '.jev-context')),
    key: process.env.TYPESAFE_API_KEY, model: process.env.TYPESAFE_MODEL || 'jev-latest',
    encoding: process.env.JEV_CONTEXT_ENCODING || 'o200k_base', concurrency, minYesProbability };
}
