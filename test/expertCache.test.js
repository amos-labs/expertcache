import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  compareExpertTraces,
  parseExpertTrace,
  simulateExpertCache,
  slotsForBudget,
  sweepExpertCache
} from "../src/expertCache.js";

const fixturePath = fileURLToPath(
  new URL("./fixtures/expert-cache-trace.jsonl", import.meta.url)
);

test("expert trace parser accepts routing only and normalizes the contract", async () => {
  const trace = parseExpertTrace(await readFile(fixturePath, "utf8"));
  assert.equal(trace.metadata.model, "fixture-moe");
  assert.equal(trace.metadata.layers, 2);
  assert.equal(trace.metadata.expertsPerLayer, 8);
  assert.equal(trace.metadata.activeExperts, 2);
  assert.equal(trace.tokens.length, 6);
  assert.deepEqual(trace.tokens[0].experts, [[0, 1], [4, 5]]);
});

test("expert trace rejects payload data, duplicate experts, and invalid layers", () => {
  const metadata = JSON.stringify({
    type: "metadata",
    schema: "amos.expert-routing-trace",
    version: 1,
    model: "fixture",
    layers: 1,
    experts_per_layer: 4,
    active_experts: 2,
    expert_bytes: 1024
  });
  assert.throws(
    () => parseExpertTrace(`${metadata}\n${JSON.stringify({
      type: "token",
      trace_id: "trace",
      token_index: 0,
      phase: "decode",
      workflow: "test",
      experts: [[0, 1]],
      prompt: "must never enter a routing trace"
    })}`),
    /unsupported field prompt/
  );
  assert.throws(
    () => parseExpertTrace(`${metadata}\n${JSON.stringify({
      type: "token",
      trace_id: "trace",
      token_index: 0,
      phase: "decode",
      workflow: "test",
      experts: [[1, 1]]
    })}`),
    /repeats an expert/
  );
  assert.throws(
    () => parseExpertTrace(`${metadata}\n${JSON.stringify({
      type: "token",
      trace_id: "trace",
      token_index: 0,
      phase: "decode",
      workflow: "test",
      experts: [[0, 1], [2, 3]]
    })}`),
    /must contain 1 expert layers/
  );
});

test("expert trace labels sampled routing arms without accepting partial settings", () => {
  const metadata = {
    type: "metadata",
    schema: "amos.expert-routing-trace",
    version: 1,
    model: "fixture",
    layers: 1,
    experts_per_layer: 4,
    active_experts: 2,
    expert_bytes: 1024,
    capture_mode: "sampled",
    sampling_temperature: 0.7,
    sampling_top_p: 0.95,
    sampling_seed: 0
  };
  const token = {
    type: "token",
    trace_id: "sample-1",
    token_index: 0,
    phase: "decode",
    workflow: "coding",
    experts: [[0, 1]]
  };
  const trace = parseExpertTrace(
    `${JSON.stringify(metadata)}\n${JSON.stringify(token)}`
  );
  assert.equal(trace.metadata.captureMode, "sampled");
  assert.equal(trace.metadata.samplingSeed, 0);
  delete metadata.sampling_top_p;
  assert.throws(
    () => parseExpertTrace(`${JSON.stringify(metadata)}\n${JSON.stringify(token)}`),
    /requires temperature, top-p, and seed/
  );
});

test("trace comparison quantifies top-k set agreement across runtimes", async () => {
  const reference = parseExpertTrace(await readFile(fixturePath, "utf8"));
  const candidate = structuredClone(reference);
  candidate.tokens[2].experts[0] = [0, 2];
  const result = compareExpertTraces(reference, candidate);
  assert.equal(result.tokenCount, 6);
  assert.equal(result.layerComparisons, 12);
  assert.equal(result.exactSetMatches, 11);
  assert.equal(result.exactSetAgreement, 11 / 12);
  assert.equal(result.expertOverlapRate, 23 / 24);
  assert.equal(result.mismatchSamples.length, 1);
});

test("LRU isolates streamed prefill and reports reproducible decode metrics", async () => {
  const trace = parseExpertTrace(await readFile(fixturePath, "utf8"));
  const result = simulateExpertCache(trace, {
    policy: "lru",
    slotsPerLayer: 2
  });
  assert.equal(result.sourceTokenCount, 6);
  assert.equal(result.tokenCount, 4);
  assert.equal(result.accesses, 16);
  assert.equal(result.hits, 4);
  assert.equal(result.misses, 12);
  assert.equal(result.hitRate, 0.25);
  assert.equal(result.cacheFootprintBytes, 4 * 1024 ** 2);
  assert.equal(result.estimatedResidentBytes, 8 * 1024 ** 2);
  assert.equal(result.coldBytes, 12 * 1024 ** 2);
  assert.equal(result.coldBytesPerToken.maximum, 4 * 1024 ** 2);
  assert.equal(result.coldRangesPerToken.maximum, 2);
  assert.equal(result.reuseTokenDistance.p50, 1);
  assert.equal(result.reuseTokenDistance.p95, 2);
  assert.equal(result.prefillStreaming.tokenCount, 2);
  assert.equal(result.prefillStreaming.selectedExpertAccesses, 8);
  assert.equal(result.prefillStreaming.streamedExperts, 4);
  assert.equal(result.prefillStreaming.coldBytes, 4 * 1024 ** 2);
  assert.equal(result.prefillStreaming.peakLayerBytes, 2 * 1024 ** 2);
  assert.equal(result.phases.decode.accesses, 16);
  assert.equal(result.workflows["campaign-analysis"].hitRate, 0.25);
  assert.equal(result.decodePositions["000-031"].hitRate, 0.25);
});

test("TinyLFU protects the recurring hot set from one-off workflow pollution", async () => {
  const trace = parseExpertTrace(await readFile(fixturePath, "utf8"));
  const lru = simulateExpertCache(trace, { policy: "lru", slotsPerLayer: 2 });
  const tinylfu = simulateExpertCache(trace, { policy: "tinylfu", slotsPerLayer: 2 });
  assert.ok(tinylfu.hitRate > lru.hitRate);
  assert.equal(tinylfu.hits, 8);
  assert.equal(tinylfu.misses, 8);
});

test("latency model decomposes p95 read, upload, remap, and total stall", async () => {
  const trace = parseExpertTrace(await readFile(fixturePath, "utf8"));
  const result = simulateExpertCache(trace, {
    policy: "lru",
    slotsPerLayer: 2,
    latencyModel: {
      readBandwidthBytesPerSecond: 1024 ** 3,
      rangeLatencyMs: 1,
      uploadBandwidthBytesPerSecond: 2 * 1024 ** 3,
      slotRemapMs: 0.25
    }
  });
  assert.equal(result.stallMsPerToken.readSeek.p95, 2);
  assert.equal(result.stallMsPerToken.readTransfer.p95, 3.90625);
  assert.equal(result.stallMsPerToken.upload.p95, 1.953125);
  assert.equal(result.stallMsPerToken.slotRemap.p95, 1);
  assert.equal(result.stallMsPerToken.total.p95, 8.859375);
  assert.equal(
    result.stallMsPerToken.model.composition,
    "conservative-additive"
  );
});

test("verification batches union experts and amortize misses over accepted tokens", async () => {
  const trace = parseExpertTrace(await readFile(fixturePath, "utf8"));
  const result = simulateExpertCache(trace, {
    policy: "lru",
    slotsPerLayer: 4,
    verifyBatchSize: 2,
    verificationAcceptanceRate: 0.5
  });
  assert.equal(result.verificationUnits, 2);
  assert.equal(result.verifyBatchSize, 2);
  assert.equal(result.assumedAcceptanceRate, 0.5);
  assert.equal(result.accesses, 12);
  assert.equal(result.hits, 4);
  assert.equal(result.misses, 8);
  assert.equal(result.coldBytesPerToken.p95, 8 * 1024 ** 2);
});

test("workflow prewarm learns from a separate profile trace and reports its cost", async () => {
  const trace = parseExpertTrace(await readFile(fixturePath, "utf8"));
  const profileTrace = structuredClone(trace);
  const withoutProfile = simulateExpertCache(trace, {
    policy: "lru",
    slotsPerLayer: 2
  });
  const withProfile = simulateExpertCache(trace, {
    policy: "lru",
    slotsPerLayer: 2,
    profileTrace
  });
  assert.equal(withProfile.workflowPrewarm.enabled, true);
  assert.equal(withProfile.workflowPrewarm.profiledTraceStarts, 1);
  assert.equal(withProfile.workflowPrewarm.misses, 4);
  assert.equal(withProfile.workflowPrewarm.coldBytes, 4 * 1024 ** 2);
  assert.ok(withProfile.hitRate > withoutProfile.hitRate);
});

test("concurrency interleaves independent trace streams without crossing batches", async () => {
  const trace = parseExpertTrace(await readFile(fixturePath, "utf8"));
  const second = trace.tokens
    .filter((token) => token.phase === "decode")
    .map((token, index) => ({
      ...token,
      traceId: "fixture-2",
      tokenIndex: index + 2,
      workflow: "coding"
    }));
  const concurrent = simulateExpertCache(
    {
      metadata: trace.metadata,
      tokens: [...trace.tokens, ...second]
    },
    {
      policy: "lru",
      slotsPerLayer: 2,
      verifyBatchSize: 2,
      concurrency: 2
    }
  );
  assert.equal(concurrent.concurrency, 2);
  assert.equal(concurrent.tokenCount, 8);
  assert.equal(concurrent.verificationUnits, 4);
  assert.equal(concurrent.workflows.coding.accesses > 0, true);
  assert.equal(concurrent.workflows["campaign-analysis"].accesses > 0, true);
});

test("policy sweep ranks bounded configurations and rejects unknown policies", async () => {
  const trace = parseExpertTrace(await readFile(fixturePath, "utf8"));
  const results = sweepExpertCache(trace, {
    policies: ["lru", "lfu", "slru", "tinylfu"],
    slots: [2, 4]
  });
  assert.equal(results.length, 8);
  assert.ok(results[0].hitRate >= results.at(-1).hitRate);
  assert.ok(
    results.find((result) => result.policy === "slru" && result.slotsPerLayer === 4).hitRate > 0
  );
  assert.throws(
    () => simulateExpertCache(trace, { policy: "magic", slotsPerLayer: 2 }),
    /Unknown ExpertCache policy/
  );
});

test("memory budgets derive bounded per-layer slot counts", async () => {
  const trace = parseExpertTrace(await readFile(fixturePath, "utf8"));
  assert.equal(slotsForBudget(trace.metadata, 8 * 1024 ** 2), 2);
  assert.equal(slotsForBudget(trace.metadata, 12 * 1024 ** 2), 4);
  assert.equal(slotsForBudget(trace.metadata, 2 * 1024 ** 2), 0);
  assert.equal(slotsForBudget(trace.metadata, 100 * 1024 ** 2), 8);
  const results = sweepExpertCache(trace, {
    policies: ["lru"],
    slots: [],
    budgetsBytes: [8 * 1024 ** 2, 12 * 1024 ** 2]
  });
  assert.deepEqual(
    results.map((result) => result.slotsPerLayer).sort((left, right) => left - right),
    [2, 4]
  );
  assert.ok(results.every((result) => result.requestedBudgetBytes));
});

test("metadata cannot activate more experts than a layer owns", () => {
  assert.throws(
    () => parseExpertTrace(`${JSON.stringify({
      type: "metadata",
      schema: "amos.expert-routing-trace",
      version: 1,
      model: "invalid",
      layers: 1,
      experts_per_layer: 2,
      active_experts: 3,
      expert_bytes: 1024
    })}\n${JSON.stringify({
      type: "token",
      trace_id: "trace",
      token_index: 0,
      phase: "decode",
      workflow: "test",
      experts: [[0, 1, 2]]
    })}`),
    /active_experts cannot exceed experts_per_layer/
  );
});
