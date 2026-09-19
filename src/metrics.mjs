import { get_encoding } from 'tiktoken';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const tokenizerVersion = JSON.parse(readFileSync(path.join(path.dirname(require.resolve('tiktoken')), 'package.json'), 'utf8')).version;

export function createCounter(encoding = 'o200k_base') {
  if (!['o200k_base', 'cl100k_base'].includes(encoding)) throw new Error('Unsupported tokenizer encoding.');
  const encoder = get_encoding(encoding);
  return {
    count: text => encoder.encode(text, [], []).length,
    free: () => encoder.free(),
    metadata: { implementation: 'tiktoken', version: tokenizerVersion, encoding,
      scope: 'exact count of saved UTF-8 response text under the named encoding',
      codex_model_tokenizer_verified: false, billing_tokens: false },
  };
}

export function measurePair(baseline, filtered, actual, counter) {
  const b = counter.count(baseline), f = counter.count(filtered), a = counter.count(actual);
  return { baseline_response_tokens: b, filtered_response_tokens: f, actual_response_tokens: a,
    paired_tokens_saved: b - f, paired_reduction_pct: b ? 100 * (b - f) / b : 0,
    actual_vs_baseline_tokens_saved: b - a,
    baseline_bytes: Buffer.byteLength(baseline), filtered_bytes: Buffer.byteLength(filtered),
    actual_bytes: Buffer.byteLength(actual) };
}

export function summarize(records) {
  const successful = records.filter(r => r.status === 'ok');
  const sum = (rows, fn) => rows.reduce((n, r) => n + fn(r), 0);
  const groups = new Map();
  for (const r of successful) {
    const key = JSON.stringify({ repository_root: r.root || null,
      operation: r.operation || 'search',
      encoding: r.tokenizer.encoding, tokenizer_version: r.tokenizer.version,
      payload_format: r.payload_format || 'legacy-v1',
      run_mode: r.config.run_mode || 'ask-only',
      mode: r.mode, source: r.source, requested_model: r.config.model, prompt: r.prompt_version,
      min_yes_probability: r.config.min_yes_probability });
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return { schema_version: 1, runs: records.length, failed_runs: records.length - successful.length,
    actual_response_tokens_all_runs: sum(records, r => r.metrics?.actual_response_tokens ?? r.error_response_tokens ?? 0),
    failed_run_response_tokens: sum(records.filter(r => r.status !== 'ok'), r => r.error_response_tokens || 0),
    jev_calls_all_runs: sum(records, r => r.jev?.calls || 0),
    jev_known_input_tokens_all_runs: sum(records, r => r.jev?.known_input_tokens || 0),
    jev_known_output_tokens_all_runs: sum(records, r => r.jev?.known_output_tokens || 0),
    jev_usage_missing_calls: sum(records, r => r.jev?.missing_usage_calls || 0),
    groups: [...groups].map(([key, rows]) => {
      const b = sum(rows, r => r.metrics.baseline_response_tokens);
      const f = sum(rows, r => r.metrics.filtered_response_tokens);
      const a = sum(rows, r => r.metrics.actual_response_tokens);
      const times = rows.map(r => r.timing.total_ms).sort((a, b) => a - b);
      return { ...JSON.parse(key), runs: rows.length, baseline_response_tokens: b,
        filtered_response_tokens: f, actual_response_tokens: a, paired_tokens_saved: b - f,
        weighted_reduction_pct: rows[0].mode === 'expansion' ? null : b ? 100 * (b - f) / b : 0, actual_vs_baseline_tokens_saved: b - a,
        latency_p50_ms: times[Math.ceil(times.length * 0.5) - 1],
        latency_p95_ms: times[Math.ceil(times.length * 0.95) - 1],
        jev_known_input_tokens: sum(rows, r => r.jev.known_input_tokens),
        jev_known_output_tokens: sum(rows, r => r.jev.known_output_tokens),
        omitted_candidate_cap: sum(rows, r => r.retrieval?.omitted_candidate_cap || 0),
        zero_yes_runs: rows.filter(r => r.mode !== 'expansion' && r.mode !== 'baseline' && r.counts.Yes === 0).length,
        zero_selected_runs: rows.filter(r => r.mode !== 'expansion' && r.mode !== 'baseline' && (r.counts.selected ?? r.counts.Yes) === 0).length };
    }),
    limitations: ['Payload token counts use an explicitly named tokenizer, not verified Codex billing.',
      'Paired savings compare identical admitted candidates; search limits are not credited as Jev savings.',
      'Shadow returns the baseline; its paired savings are hypothetical.',
      'Expansion groups have a zero incremental baseline: add their negative savings to the original search group, within the same encoding. Repeated expansions count again.',
      'CLI/benchmark responses are not evidence that Codex consumed those tokens.',
      'Whole-task savings require independent A/B tasks including follow-up reads, tool/skill overhead, and model usage.'] };
}
