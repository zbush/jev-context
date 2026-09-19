import { PROMPT_VERSION } from './jev.mjs';

// Legacy records retain their original ternary selection semantics for reports.
export function selectedCandidates(record) {
  const candidates = record.retrieval.candidates;
  if (record.mode === 'baseline') return candidates;
  return candidates.filter((_, i) => record.prompt_version === PROMPT_VERSION
    ? record.decisions[i].answer.probabilities.Yes > record.config.min_yes_probability
    : record.decisions[i].label === 'Yes');
}

export function scoreSummary(decisions, threshold) {
  const withheld = decisions.map(d => d.answer.probabilities.Yes).filter(p => p <= threshold);
  return { min_yes_probability: threshold, comparison: 'strictly_greater_than',
    withheld_score_bands: [[0, 0.33], [0.33, 0.5], [0.5, 0.75], [0.75, 1]].map(([lower, upper], i) => ({
      lower, upper, lower_inclusive: i === 0, upper_inclusive: true,
      count: withheld.filter(p => (i === 0 ? p >= lower : p > lower) && p <= upper).length,
    })) };
}

export function passages(candidates, decisions = []) {
  const scores = new Map(decisions.map(d => [d.candidate_id, d.answer.probabilities.Yes]));
  return candidates.map(({ id, file, start_line, end_line, text }) => ({ id, file, start_line, end_line, text,
    ...(scores.has(id) ? { yes_probability: scores.get(id) } : {}) }));
}
