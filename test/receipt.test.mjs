import test from 'node:test';
import assert from 'node:assert/strict';
import { createCounter, measurePair } from '../src/metrics.mjs';
import { withReceipts } from '../src/receipt.mjs';

const body = text => JSON.stringify({ results: [{ text }] });
for (const encoding of ['o200k_base', 'cl100k_base']) {
  test(`receipt includes its own token cost under ${encoding}`, () => {
    const counter = createCounter(encoding);
    try {
      const b = body('const session = revoke(user);\n'.repeat(30));
      const f = body('const session = revoke(user);');
      const pair = withReceipts(b, f, 'filtered', counter);
      assert.equal(pair.receipt_status, 'measured');
      const receipt = JSON.parse(pair.filtered).token_savings;
      const metrics = measurePair(pair.baseline, pair.filtered, pair.filtered, counter);
      assert.equal(receipt.returned_tokens, metrics.actual_response_tokens);
      assert.equal(receipt.baseline_tokens, metrics.baseline_response_tokens);
      assert.equal(receipt.saved_tokens, metrics.actual_vs_baseline_tokens_saved);
      assert.equal(receipt.reduction_pct, Number(metrics.paired_reduction_pct.toFixed(1)));
      assert.ok(counter.count(pair.filtered) > counter.count(f));
      assert.match(receipt.footer, new RegExp(`saved ${receipt.saved_tokens} retrieval tokens`));
    } finally { counter.free(); }
  });
}

test('receipt reports negative savings as added tokens', () => {
  const counter = createCounter();
  try {
    const pair = withReceipts(body('a'), body('more content '.repeat(100)), 'filtered', counter);
    assert.equal(pair.receipt_status, 'measured');
    const r = JSON.parse(pair.filtered).token_savings;
    assert.ok(r.saved_tokens < 0);
    assert.match(r.footer, /added \d+ retrieval tokens/);
    assert.match(r.footer, /increase/);
  } finally { counter.free(); }
});

test('baseline and shadow receipts claim no hypothetical savings', () => {
  const counter = createCounter();
  try {
    for (const mode of ['baseline', 'shadow']) {
      const pair = withReceipts(body('many tokens '.repeat(100)), body('few'), mode, counter);
      assert.equal(pair.receipt_status, 'measured');
      const r = JSON.parse(pair.baseline).token_savings;
      assert.equal(r.saved_tokens, 0);
      assert.equal(r.returned_tokens, counter.count(pair.baseline));
      assert.match(r.footer, new RegExp(`${mode} mode; unfiltered results`));
    }
  } finally { counter.free(); }
});

test('a count cycle produces an unavailable receipt, never an incorrect number', () => {
  const counter = { metadata: { encoding: 'test' }, count: text => {
    const value = JSON.parse(text).token_savings?.returned_tokens;
    return value === 100 ? 101 : 100;
  } };
  const pair = withReceipts(body('a'), body('a'), 'baseline', counter);
  assert.equal(pair.receipt_status, 'unavailable');
  const r = JSON.parse(pair.baseline).token_savings;
  assert.equal(r.status, 'unavailable');
  assert.equal(r.saved_tokens, undefined);
});
