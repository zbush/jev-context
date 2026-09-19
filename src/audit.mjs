import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createCounter, measurePair } from './metrics.mjs';
import { sha256 } from './search.mjs';
import { selectedCandidates, passages } from './selection.mjs';
import { expansionCandidates, loadSnapshot } from './expansion.mjs';

export async function auditRecords(dataDir, records) {
  const results = [];
  for (const r of records) {
    if (r.status !== 'ok') { results.push({ id: r.id, status: 'excluded-error' }); continue; }
    const counter = createCounter(r.tokenizer.encoding);
    const errors = [];
    try {
      if (r.mode === 'expansion') {
        const actual = await readFile(path.join(dataDir, r.id, 'actual.txt'), 'utf8');
        if (sha256(actual) !== r.payload_sha256.actual) errors.push('actual payload hash mismatch');
        const measured = measurePair('', actual, actual, counter);
        for (const [name, value] of Object.entries(measured)) {
          if (r.metrics[name] !== value) errors.push(`${name} count mismatch`);
        }
        const payload = JSON.parse(actual), receipt = payload.token_savings;
        if (receipt?.status === 'measured' && (receipt.baseline_tokens !== 0 ||
            receipt.returned_tokens !== measured.actual_response_tokens || receipt.saved_tokens !== -measured.actual_response_tokens ||
            receipt.reduction_pct !== 0 || receipt.encoding !== r.tokenizer.encoding)) errors.push('Expansion receipt mismatch');
        const snapshot = await loadSnapshot(dataDir, r.source_retrieval_id);
        let expected;
        if (r.operation === 'expand_context') {
          expected = [r.context_snapshot];
          const context = r.context_snapshot;
          if (sha256(context.text) !== context.text_sha256) errors.push('Context snapshot hash mismatch');
          const original = snapshot.retrieval.candidates.find(c => c.id === r.args.candidate_id);
          if (!original || original.file !== context.file || context.anchor_line < original.start_line ||
              context.anchor_line > original.end_line || context.anchor_line < context.start_line ||
              context.anchor_line > context.end_line || context.end_line - context.start_line + 1 > r.args.max_lines ||
              context.text.length > r.args.max_chars) errors.push('Invalid context range');
        } else expected = passages(expansionCandidates(snapshot, r.args), snapshot.decisions);
        if (JSON.stringify(payload.results) !== JSON.stringify(expected)) errors.push('Expansion selection mismatch');
        if (counter.metadata.version !== r.tokenizer.version) errors.push('Tokenizer version differs from recorded version');
        results.push({ id: r.id, status: errors.length ? 'failed' : 'verified', errors });
        continue;
      }
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
      const expected = selectedCandidates(r).map(c => c.id);
      if (JSON.stringify(JSON.parse(filtered).results.map(c => c.id)) !== JSON.stringify(expected)) errors.push('Filtered selection mismatch');
      if (r.schema_version === 2 && JSON.stringify(JSON.parse(filtered).results) !==
          JSON.stringify(passages(selectedCandidates(r), r.decisions))) errors.push('Filtered passage or score mismatch');
      results.push({ id: r.id, status: errors.length ? 'failed' : 'verified', errors });
    } catch (error) { results.push({ id: r.id, status: 'failed', errors: [error.message] }); }
    finally { counter.free(); }
  }
  return { all_successful_runs_verified: results.every(r => r.status !== 'failed'),
    note: 'Local reproducibility check, not a signed or tamper-proof attestation.', results };
}
