import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createCounter, measurePair } from './metrics.mjs';
import { sha256 } from './search.mjs';

export async function auditRecords(dataDir, records) {
  const results = [];
  for (const r of records) {
    if (r.status !== 'ok') { results.push({ id: r.id, status: 'excluded-error' }); continue; }
    const counter = createCounter(r.tokenizer.encoding);
    const errors = [];
    try {
      const [baseline, filtered, actual] = await Promise.all(['baseline', 'filtered', 'actual'].map(name =>
        readFile(path.join(dataDir, r.id, `${name}.txt`), 'utf8')));
      for (const [name, value] of Object.entries({ baseline, filtered, actual })) {
        if (sha256(value) !== r.payload_sha256[name]) errors.push(`${name} payload hash mismatch`);
      }
      const measured = measurePair(baseline, filtered, actual, counter);
      for (const [name, value] of Object.entries(measured)) {
        if (r.metrics[name] !== value) errors.push(`${name} count mismatch`);
      }
      for (const [name, value] of Object.entries({ baseline, filtered, actual })) {
        const receipt = JSON.parse(value).token_savings;
        if (receipt?.status === 'measured') {
          const tokens = counter.count(value);
          const saved = measured.baseline_response_tokens - tokens;
          if (receipt.returned_tokens !== tokens || receipt.baseline_tokens !== measured.baseline_response_tokens ||
              receipt.saved_tokens !== saved || receipt.encoding !== r.tokenizer.encoding ||
              receipt.reduction_pct !== (receipt.baseline_tokens ? Number((100 * saved / receipt.baseline_tokens).toFixed(1)) : 0)) {
            errors.push(`${name} savings receipt mismatch`);
          }
        }
      }
      if (sha256(JSON.stringify(r.retrieval.candidates)) !== r.retrieval.snapshot_sha256) errors.push('Candidate snapshot hash mismatch');
      if (counter.metadata.version !== r.tokenizer.version) errors.push('Tokenizer version differs from recorded version');
      const expected = r.mode === 'baseline' ? r.retrieval.candidates.map(c => c.id)
        : r.retrieval.candidates.filter((_, i) => r.decisions[i].label === 'Yes').map(c => c.id);
      if (JSON.stringify(JSON.parse(filtered).results.map(c => c.id)) !== JSON.stringify(expected)) errors.push('Filtered selection mismatch');
      results.push({ id: r.id, status: errors.length ? 'failed' : 'verified', errors });
    } catch (error) { results.push({ id: r.id, status: 'failed', errors: [error.message] }); }
    finally { counter.free(); }
  }
  return { all_successful_runs_verified: results.every(r => r.status !== 'failed'),
    note: 'Local reproducibility check, not a signed or tamper-proof attestation.', results };
}
