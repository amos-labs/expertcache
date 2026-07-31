import assert from "node:assert/strict";
import test from "node:test";
import { summarizeNumbers, summarizePublicationRuns } from "../src/publicationResults.js";

test("publication summaries report medians, quartiles, quality, and resource peaks", () => {
  const summary = summarizePublicationRuns([1, 2, 3].map((value) => ({
    block_id: `block-${value}`,
    run_id: `prefetch-${value}`,
    arm: "prefetch-6",
    position: value,
    status: "complete",
    baseline: {
      configuration_sha256: "abc",
      readiness_seconds: value * 10,
      streaming_probe: { first_token_ms: value * 100 },
      host_delta: { swap_growth_bytes: value },
      process_samples: [
        { rss_bytes: value * 1_000, swap_used_bytes: value * 100 },
        { rss_bytes: value * 2_000, swap_used_bytes: value * 200 }
      ]
    },
    qualification: {
      results: [{
        score: 16,
        maximum: 16,
        timings: {
          prompt_tokens_per_second: value * 5,
          predicted_tokens_per_second: value * 2
        }
      }]
    }
  })));
  assert.equal(summary.completed_count, 3);
  assert.equal(summary.arms["prefetch-6"].quality_passed, 3);
  assert.equal(summary.arms["prefetch-6"].metrics.prompt_tokens_per_second.median, 10);
  assert.equal(summary.arms["prefetch-6"].metrics.peak_rss_bytes.max, 6_000);
});

test("numeric summaries make missing observations explicit", () => {
  assert.deepEqual(summarizeNumbers([null, undefined, Number.NaN]), {
    n: 0,
    median: null,
    q1: null,
    q3: null,
    min: null,
    max: null
  });
  assert.equal(summarizeNumbers([1, 2, 3, 4]).median, 2.5);
});
