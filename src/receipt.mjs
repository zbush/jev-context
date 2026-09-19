export const PAYLOAD_FORMAT = 'savings-receipt-v2';

export function unavailableReceipt(encoding) {
  return { encoding, status: 'unavailable',
    footer: 'Jev Context: retrieval token savings unavailable for this call.' };
}

function receipt(mode, baseline, returned, encoding) {
  const saved = baseline - returned;
  const percentage = baseline ? Number((100 * saved / baseline).toFixed(1)) : 0;
  const change = saved < 0 ? `added ${-saved} retrieval tokens`
    : saved === 0 ? 'saved 0 retrieval tokens' : `saved ${saved} retrieval tokens`;
  const qualifier = mode === 'filtered' ? `${Math.abs(percentage).toFixed(1)}%${saved < 0 ? ' increase' : ''}`
    : `${mode} mode; unfiltered results`;
  return { encoding, status: 'measured', mode, baseline_tokens: baseline, returned_tokens: returned,
    saved_tokens: saved, reduction_pct: percentage,
    scope: 'tool-response text, including receipt; not whole-task or billed savings',
    footer: `Jev Context: ${change} (${qualifier}; ${encoding}).` };
}

export const attachReceipt = (payload, value) => `${payload.slice(0, -1)},"token_savings":${JSON.stringify(value)}}`;

// Expansion adds context to an already counted retrieval. A zero incremental
// baseline prevents counting the original unfiltered response a second time.
export function withExpansionReceipt(body, counter, label = 'snapshot expansion') {
  const encoding = counter.metadata.encoding;
  for (let padding = 0; padding <= 8; padding++) {
    let tokens = counter.count(body);
    const seen = new Set();
    for (let i = 0; i < 16 && !seen.has(tokens); i++) {
      seen.add(tokens);
      const value = { encoding, status: 'measured', mode: 'expansion', baseline_tokens: 0,
        returned_tokens: tokens, saved_tokens: -tokens, reduction_pct: 0,
        scope: 'additional tool-response text; subtract from original retrieval savings; not whole-task or billed savings',
        footer: `Jev Context: added ${tokens} retrieval tokens (${label}; ${encoding}).` };
      const payload = attachReceipt(body, value) + ' \n'.repeat(padding);
      const next = counter.count(payload);
      if (next === tokens) return { payload, receipt_status: 'measured' };
      tokens = next;
    }
  }
  return { payload: attachReceipt(body, unavailableReceipt(encoding)), receipt_status: 'unavailable' };
}

// A count embedded in the counted text is self-referential. Recount both complete
// responses until the embedded counts equal the actual counts. Never publish an
// approximate fixed point: a rare cycle falls back to a nonnumeric receipt.
export function withReceipts(baselineBody, filteredBody, mode, counter) {
  const encoding = counter.metadata.encoding;
  const initialB = counter.count(baselineBody), initialF = counter.count(filteredBody);
  // Tiny, counted JSON whitespace breaks token-boundary cycles without rounding
  // or hiding overhead. Bound the retries; retrieval must still work if none settle.
  for (let padding = 0; padding <= 8; padding++) {
    let b = initialB, f = initialF;
    const suffix = ' \n'.repeat(padding);
    const seen = new Set();
    for (let iteration = 0; iteration < 16; iteration++) {
      const key = `${b}:${f}`;
      if (seen.has(key)) break;
      seen.add(key);
      const baseline = attachReceipt(baselineBody, receipt(mode === 'shadow' ? 'shadow' : 'baseline', b, b, encoding)) + suffix;
      const filtered = mode === 'baseline' ? baseline : attachReceipt(filteredBody, receipt('filtered', b, f, encoding)) + suffix;
      const nextB = counter.count(baseline), nextF = counter.count(filtered);
      if (b === nextB && f === nextF) return { baseline, filtered, receipt_status: 'measured' };
      b = nextB; f = nextF;
    }
  }
  const fallback = unavailableReceipt(encoding);
  return { baseline: attachReceipt(baselineBody, fallback),
    filtered: attachReceipt(filteredBody, fallback), receipt_status: 'unavailable' };
}
