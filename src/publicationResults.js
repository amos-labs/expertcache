export function summarizePublicationRuns(runs) {
  const normalized = runs.map(normalizeRun);
  const arms = {};
  for (const arm of [...new Set(normalized.map((run) => run.arm))].sort()) {
    const selected = normalized.filter((run) => run.arm === arm);
    arms[arm] = {
      planned: selected.length,
      completed: selected.filter((run) => run.status === "complete").length,
      failed: selected.filter((run) => run.status === "failed").length,
      quality_passed: selected.filter((run) => run.quality_passed === true).length,
      metrics: {
        readiness_seconds: summarizeNumbers(selected.map((run) => run.readiness_seconds)),
        first_token_ms: summarizeNumbers(selected.map((run) => run.first_token_ms)),
        prompt_tokens_per_second: summarizeNumbers(
          selected.map((run) => run.prompt_tokens_per_second)
        ),
        predicted_tokens_per_second: summarizeNumbers(
          selected.map((run) => run.predicted_tokens_per_second)
        ),
        peak_rss_bytes: summarizeNumbers(selected.map((run) => run.peak_rss_bytes)),
        peak_swap_used_bytes: summarizeNumbers(
          selected.map((run) => run.peak_swap_used_bytes)
        ),
        swap_growth_bytes: summarizeNumbers(selected.map((run) => run.swap_growth_bytes))
      }
    };
  }
  return {
    schema: "expertcache.publication-summary",
    version: 1,
    run_count: normalized.length,
    completed_count: normalized.filter((run) => run.status === "complete").length,
    arms,
    runs: normalized
  };
}

export function summarizeNumbers(values) {
  const numbers = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (numbers.length === 0) {
    return { n: 0, median: null, q1: null, q3: null, min: null, max: null };
  }
  return {
    n: numbers.length,
    median: quantile(numbers, 0.5),
    q1: quantile(numbers, 0.25),
    q3: quantile(numbers, 0.75),
    min: numbers[0],
    max: numbers.at(-1)
  };
}

function normalizeRun(run) {
  const baseline = run.baseline || {};
  const qualification = run.qualification || {};
  const result = qualification.results?.[0] || {};
  const samples = baseline.process_samples || [];
  return {
    block_id: run.block_id || null,
    run_id: run.run_id,
    arm: run.arm,
    position: run.position,
    host_state: run.host_state,
    status: run.status,
    configuration_sha256: baseline.configuration_sha256 || null,
    quality_score: Number.isFinite(result.score) ? result.score : null,
    quality_maximum: Number.isFinite(result.maximum) ? result.maximum : null,
    quality_passed: Number.isFinite(result.score) && Number.isFinite(result.maximum)
      ? result.score === result.maximum
      : null,
    readiness_seconds: finiteOrNull(baseline.readiness_seconds),
    first_token_ms: finiteOrNull(baseline.streaming_probe?.first_token_ms),
    prompt_tokens_per_second: finiteOrNull(result.timings?.prompt_tokens_per_second),
    predicted_tokens_per_second: finiteOrNull(
      result.timings?.predicted_tokens_per_second ?? result.tokensPerSecond
    ),
    peak_rss_bytes: maximum(samples.map((sample) => sample.rss_bytes)),
    peak_swap_used_bytes: maximum(samples.map((sample) => sample.swap_used_bytes)),
    swap_growth_bytes: finiteOrNull(baseline.host_delta?.swap_growth_bytes),
    failure: baseline.failure || null
  };
}

function quantile(sorted, probability) {
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function maximum(values) {
  const numbers = values.filter(Number.isFinite);
  return numbers.length > 0 ? Math.max(...numbers) : null;
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}
