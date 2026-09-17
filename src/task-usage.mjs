import { z } from 'zod';

const usage = z.object({
  task_id: z.string().min(1), model: z.string().min(1), evidence: z.string().min(1),
  input_tokens: z.number().int().nonnegative(),
  cached_input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  quality_passed: z.boolean(),
}).strict().refine(x => x.cached_input_tokens <= x.input_tokens, 'Cached tokens must be included in input tokens.');
const schema = z.array(z.object({
  name: z.string().min(1), baseline: usage, filtered: usage,
}).strict()).min(1);

// Imports complete-task usage from the host/API; never extrapolates it from retrieval savings.
export function compareTaskUsage(input) {
  const pairs = schema.parse(input);
  const seen = new Set();
  for (const pair of pairs) {
    if (pair.baseline.model !== pair.filtered.model) throw new Error('A/B task models must match.');
    for (const side of [pair.baseline, pair.filtered]) {
      if (seen.has(side.task_id)) throw new Error('Each side must use a distinct task id.');
      seen.add(side.task_id);
    }
  }
  const results = pairs.map(p => ({ name: p.name, model: p.baseline.model,
    baseline_task: p.baseline.task_id, filtered_task: p.filtered.task_id,
    quality_passed_both: p.baseline.quality_passed && p.filtered.quality_passed,
    input_tokens_saved: p.baseline.input_tokens - p.filtered.input_tokens,
    uncached_input_tokens_saved: (p.baseline.input_tokens - p.baseline.cached_input_tokens) -
      (p.filtered.input_tokens - p.filtered.cached_input_tokens),
    output_tokens_saved: p.baseline.output_tokens - p.filtered.output_tokens,
    total_codex_tokens_saved: p.baseline.input_tokens + p.baseline.output_tokens -
      p.filtered.input_tokens - p.filtered.output_tokens,
    baseline_input_tokens: p.baseline.input_tokens, filtered_input_tokens: p.filtered.input_tokens,
    evidence: { baseline: p.baseline.evidence, filtered: p.filtered.evidence },
  }));
  return { source: 'user-supplied complete-task host/API usage; evidence references are not independently verified',
    pairs: results,
    input_tokens_saved_all_pairs: results.reduce((n, r) => n + r.input_tokens_saved, 0),
    input_tokens_saved_quality_passing_pairs: results.filter(r => r.quality_passed_both).reduce((n, r) => n + r.input_tokens_saved, 0),
    limitations: ['Includes follow-up retrieval and prompts only if supplied counts cover the complete task.',
      'Jev usage remains separate. Different model token counts are not interchangeable costs.',
      'Compare identical repository snapshots and task instructions, and report failed-quality pairs.'] };
}
