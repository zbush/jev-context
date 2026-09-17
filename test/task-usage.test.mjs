import test from 'node:test';
import assert from 'node:assert/strict';
import { compareTaskUsage } from '../src/task-usage.mjs';
const side = (id, input, cached = 0, passed = true) => ({ task_id: id, model: 'same-model',
  evidence: `local-export-${id}.json`, input_tokens: input, cached_input_tokens: cached,
  output_tokens: 100, quality_passed: passed });
test('complete-task comparison preserves negative savings and distinguishes cached inputs', () => {
  const result = compareTaskUsage([{ name: 'one', baseline: side('a', 1000, 800), filtered: side('b', 700, 200) },
    { name: 'two', baseline: side('c', 100), filtered: side('d', 200, 0, false) }]);
  assert.equal(result.pairs[0].input_tokens_saved, 300);
  assert.equal(result.pairs[0].uncached_input_tokens_saved, -300);
  assert.equal(result.input_tokens_saved_all_pairs, 200);
  assert.equal(result.input_tokens_saved_quality_passing_pairs, 300);
});
test('complete-task comparison rejects duplicate tasks, invalid usage, and model mismatch', () => {
  assert.throws(() => compareTaskUsage([{ name: 'x', baseline: side('a', 100), filtered: side('a', 90) }]));
  assert.throws(() => compareTaskUsage([{ name: 'x', baseline: side('a', 100, 200), filtered: side('b', 90) }]));
  assert.throws(() => compareTaskUsage([{ name: 'x', baseline: side('a', 100), filtered: { ...side('b', 90), model: 'other' } }]));
});
