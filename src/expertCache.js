export const EXPERT_TRACE_SCHEMA = "amos.expert-routing-trace";
export const EXPERT_TRACE_VERSION = 1;
export const EXPERT_CACHE_POLICIES = Object.freeze(["lru", "lfu", "slru", "tinylfu"]);

const MAX_TRACE_LINES = 2_000_000;
const PHASES = new Set(["prefill", "decode"]);
const METADATA_KEYS = new Set([
  "type",
  "schema",
  "version",
  "model",
  "layers",
  "experts_per_layer",
  "active_experts",
  "expert_bytes",
  "weight_store_bytes",
  "shared_resident_bytes",
  "source_revision",
  "capture_mode",
  "sampling_temperature",
  "sampling_top_p",
  "sampling_seed",
  "created_at"
]);
const TOKEN_KEYS = new Set([
  "type",
  "trace_id",
  "token_index",
  "phase",
  "workflow",
  "experts"
]);

export function parseExpertTrace(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) throw new Error("Expert trace is empty");
  if (lines.length > MAX_TRACE_LINES) {
    throw new Error(`Expert trace exceeds ${MAX_TRACE_LINES} records`);
  }

  const records = lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`Expert trace line ${index + 1} is not valid JSON: ${error.message}`);
    }
  });
  const metadata = normalizeMetadata(records[0]);
  const tokens = records.slice(1).map((record, index) =>
    normalizeToken(record, metadata, index + 2)
  );
  if (tokens.length === 0) throw new Error("Expert trace contains no token records");
  return { metadata, tokens };
}

export function simulateExpertCache(
  trace,
  {
    policy = "lru",
    slotsPerLayer = 32,
    latencyModel = null,
    verifyBatchSize = 1,
    verificationAcceptanceRate = 1,
    concurrency = 1,
    profileTrace = null
  } = {}
) {
  const metadata = normalizeNormalizedMetadata(trace?.metadata);
  const tokens = Array.isArray(trace?.tokens) ? trace.tokens : [];
  const normalizedPolicy = normalizePolicy(policy);
  const slots = boundedInteger(slotsPerLayer, 1, metadata.expertsPerLayer, "slotsPerLayer");
  const batchSize = boundedInteger(
    verifyBatchSize,
    1,
    256,
    "verifyBatchSize"
  );
  const acceptedFraction = boundedNumber(
    verificationAcceptanceRate,
    Number.EPSILON,
    1,
    "verificationAcceptanceRate"
  );
  const streamCount = boundedInteger(concurrency, 1, 64, "concurrency");
  const normalizedLatency = latencyModel
    ? normalizeLatencyModel(latencyModel)
    : null;
  const normalizedTokens = addDecodePositions(
    tokens.map((token) => normalizeNormalizedToken(token, metadata))
  );
  const prefillStreaming = summarizePrefillStreaming(normalizedTokens, metadata);
  const decodeTokens = normalizedTokens.filter((token) => token.phase === "decode");
  const verificationUnits = interleaveVerificationUnits(
    buildVerificationUnits(decodeTokens, batchSize),
    streamCount
  );
  const workflowProfiles = profileTrace
    ? buildWorkflowProfiles(profileTrace, {
        slotsPerLayer: slots,
        expectedMetadata: metadata
      })
    : null;
  const caches = Array.from(
    { length: metadata.layers },
    () => createCache(normalizedPolicy, slots, metadata.activeExperts)
  );
  const totals = emptyCounter();
  const byWorkflow = new Map();
  const byDecodePosition = new Map();
  const coldBytesPerToken = [];
  const coldRangesPerToken = [];
  const reuseTokenDistances = [];
  const lastSeenToken = new Map();
  const stall = normalizedLatency ? emptyStallSeries() : null;
  const prewarmedTraces = new Set();
  const prewarm = {
    enabled: Boolean(workflowProfiles),
    traceStarts: 0,
    profiledTraceStarts: 0,
    misses: 0,
    coldBytes: 0,
    coldRanges: 0,
    stallMs: []
  };

  for (let unitOrdinal = 0; unitOrdinal < verificationUnits.length; unitOrdinal += 1) {
    const unit = verificationUnits[unitOrdinal];
    if (!prewarmedTraces.has(unit.traceId)) {
      prewarmedTraces.add(unit.traceId);
      prewarm.traceStarts += 1;
      const profile = workflowProfiles?.workflows?.[unit.workflow];
      if (profile) {
        prewarm.profiledTraceStarts += 1;
        const warmed = prewarmWorkflow(profile, caches, metadata);
        prewarm.misses += warmed.misses;
        prewarm.coldBytes += warmed.coldBytes;
        prewarm.coldRanges += warmed.coldRanges;
        if (normalizedLatency) {
          prewarm.stallMs.push(
            estimateStall(warmed, normalizedLatency, 1).total
          );
        }
      }
    }
    const workflowCounter = byWorkflow.get(unit.workflow) || emptyCounter();
    const positionCounter =
      byDecodePosition.get(unit.positionBucket) || emptyCounter();
    let unitMisses = 0;
    const missesByLayer = Array.from({ length: metadata.layers }, () => []);

    for (let layer = 0; layer < metadata.layers; layer += 1) {
      for (const expertId of unit.experts[layer]) {
        const reuseKey = `${layer}:${expertId}`;
        const lastSeen = lastSeenToken.get(reuseKey);
        if (lastSeen !== undefined) reuseTokenDistances.push(unitOrdinal - lastSeen);
        lastSeenToken.set(reuseKey, unitOrdinal);
        const hit = caches[layer].access(expertId);
        incrementCounter(totals, hit);
        incrementCounter(workflowCounter, hit);
        incrementCounter(positionCounter, hit);
        if (!hit) {
          unitMisses += 1;
          missesByLayer[layer].push(expertId);
        }
      }
    }
    byWorkflow.set(unit.workflow, workflowCounter);
    byDecodePosition.set(unit.positionBucket, positionCounter);
    const acceptedTokens = Math.max(
      Number.EPSILON,
      unit.tokenCount * acceptedFraction
    );
    const coldBytes = unitMisses * metadata.expertBytes;
    const coldRanges = missesByLayer.reduce(
      (sum, ids) => sum + contiguousRangeCount(ids),
      0
    );
    coldBytesPerToken.push(coldBytes / acceptedTokens);
    coldRangesPerToken.push(coldRanges / acceptedTokens);
    if (stall) {
      appendStall(
        stall,
        estimateStall(
          {
            coldBytes,
            coldRanges,
            misses: unitMisses
          },
          normalizedLatency,
          acceptedTokens
        )
      );
    }
  }

  return {
    model: metadata.model,
    policy: normalizedPolicy,
    slotsPerLayer: slots,
    layers: metadata.layers,
    expertsPerLayer: metadata.expertsPerLayer,
    activeExperts: metadata.activeExperts,
    sourceTokenCount: normalizedTokens.length,
    tokenCount: decodeTokens.length,
    verificationUnits: verificationUnits.length,
    verifyBatchSize: batchSize,
    assumedAcceptanceRate: acceptedFraction,
    concurrency: streamCount,
    prefillStrategy: "sequential-layer-stream-bypass",
    prefillStreaming,
    workflowPrewarm: {
      ...prewarm,
      stallMs: summarizeSeries(prewarm.stallMs)
    },
    cacheFootprintBytes: slots * metadata.layers * metadata.expertBytes,
    estimatedResidentBytes:
      metadata.sharedResidentBytes + slots * metadata.layers * metadata.expertBytes,
    ...finishCounter(totals),
    coldBytes: totals.misses * metadata.expertBytes,
    coldBytesPerToken: {
      mean: average(coldBytesPerToken),
      p50: percentile(coldBytesPerToken, 0.50),
      p95: percentile(coldBytesPerToken, 0.95),
      p99: percentile(coldBytesPerToken, 0.99),
      maximum: Math.max(...coldBytesPerToken, 0)
    },
    coldRangesPerToken: {
      mean: average(coldRangesPerToken),
      p95: percentile(coldRangesPerToken, 0.95),
      maximum: Math.max(...coldRangesPerToken, 0)
    },
    reuseTokenDistance: {
      observations: reuseTokenDistances.length,
      mean: average(reuseTokenDistances),
      p50: percentile(reuseTokenDistances, 0.50),
      p95: percentile(reuseTokenDistances, 0.95),
      maximum: Math.max(...reuseTokenDistances, 0)
    },
    stallMsPerToken: stall
      ? finishStallSeries(stall, normalizedLatency)
      : null,
    phases: {
      decode: finishCounter(totals),
      prefill: {
        strategy: "sequential-layer-stream-bypass",
        tokenCount: prefillStreaming.tokenCount,
        selectedExpertAccesses: prefillStreaming.selectedExpertAccesses,
        streamedExperts: prefillStreaming.streamedExperts
      }
    },
    workflows: Object.fromEntries(
      [...byWorkflow.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, counter]) => [name, finishCounter(counter)])
    ),
    decodePositions: Object.fromEntries(
      [...byDecodePosition.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, counter]) => [name, finishCounter(counter)])
    )
  };
}

export function sweepExpertCache(
  trace,
  {
    policies = EXPERT_CACHE_POLICIES,
    slots = [4, 8, 16, 32, 64, 96],
    budgetsBytes = [],
    latencyModel = null,
    verifyBatchSizes = [1],
    verificationAcceptanceRates = [1],
    concurrencyLevels = [1],
    profileTrace = null
  } = {}
) {
  const budgetConfigurations = budgetsBytes.map((requestedBudgetBytes) => ({
    slotsPerLayer: slotsForBudget(trace.metadata, requestedBudgetBytes),
    requestedBudgetBytes
  }));
  const budgetSlots = new Set(
    budgetConfigurations
      .filter((configuration) => configuration.slotsPerLayer > 0)
      .map((configuration) => configuration.slotsPerLayer)
  );
  const configurations = [
    ...slots
      .filter((slotsPerLayer) => !budgetSlots.has(slotsPerLayer))
      .map((slotsPerLayer) => ({ slotsPerLayer, requestedBudgetBytes: null })),
    ...budgetConfigurations
  ];
  const results = [];
  for (const policy of policies) {
    for (const configuration of configurations) {
      if (
        configuration.slotsPerLayer < 1 ||
        configuration.slotsPerLayer > trace.metadata.expertsPerLayer
      ) {
        continue;
      }
      for (const verifyBatchSize of verifyBatchSizes) {
        const acceptanceRates = Number(verifyBatchSize) === 1
          ? [1]
          : verificationAcceptanceRates;
        for (const verificationAcceptanceRate of acceptanceRates) {
          for (const concurrency of concurrencyLevels) {
            results.push({
              ...simulateExpertCache(trace, {
                policy,
                slotsPerLayer: configuration.slotsPerLayer,
                latencyModel,
                verifyBatchSize,
                verificationAcceptanceRate,
                concurrency,
                profileTrace
              }),
              requestedBudgetBytes: configuration.requestedBudgetBytes
            });
          }
        }
      }
    }
  }
  return results.sort((left, right) => {
    const leftStall = left.stallMsPerToken?.total?.p95;
    const rightStall = right.stallMsPerToken?.total?.p95;
    if (Number.isFinite(leftStall) && Number.isFinite(rightStall)) {
      const stallDifference = leftStall - rightStall;
      if (stallDifference !== 0) return stallDifference;
    }
    return (
      right.hitRate - left.hitRate ||
    left.coldBytesPerToken.p95 - right.coldBytesPerToken.p95 ||
    left.cacheFootprintBytes - right.cacheFootprintBytes ||
      left.policy.localeCompare(right.policy)
    );
  });
}

export function buildWorkflowProfiles(
  trace,
  {
    slotsPerLayer = 32,
    expectedMetadata = null
  } = {}
) {
  const metadata = normalizeNormalizedMetadata(trace?.metadata);
  if (expectedMetadata) assertCompatibleMetadata(metadata, expectedMetadata);
  const slots = boundedInteger(
    slotsPerLayer,
    1,
    metadata.expertsPerLayer,
    "slotsPerLayer"
  );
  const workflows = new Map();
  for (const rawToken of Array.isArray(trace?.tokens) ? trace.tokens : []) {
    const token = normalizeNormalizedToken(rawToken, metadata);
    if (token.phase !== "decode") continue;
    let layers = workflows.get(token.workflow);
    if (!layers) {
      layers = Array.from(
        { length: metadata.layers },
        () => new Map()
      );
      workflows.set(token.workflow, layers);
    }
    for (let layer = 0; layer < metadata.layers; layer += 1) {
      for (const expertId of token.experts[layer]) {
        layers[layer].set(expertId, (layers[layer].get(expertId) || 0) + 1);
      }
    }
  }
  return {
    model: metadata.model,
    slotsPerLayer: slots,
    workflows: Object.fromEntries(
      [...workflows.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([workflow, layers]) => [
          workflow,
          layers.map((frequencies) =>
            [...frequencies.entries()]
              .sort(
                ([leftId, leftCount], [rightId, rightCount]) =>
                  rightCount - leftCount || leftId - rightId
              )
              .slice(0, slots)
              .map(([expertId]) => expertId)
          )
        ])
    )
  };
}

export function compareExpertTraces(referenceTrace, candidateTrace) {
  const referenceMetadata = normalizeNormalizedMetadata(referenceTrace?.metadata);
  const candidateMetadata = normalizeNormalizedMetadata(candidateTrace?.metadata);
  assertCompatibleMetadata(candidateMetadata, referenceMetadata);
  const referenceTokens = (referenceTrace?.tokens || []).map((token) =>
    normalizeNormalizedToken(token, referenceMetadata)
  );
  const candidateTokens = new Map();
  for (const rawToken of candidateTrace?.tokens || []) {
    const token = normalizeNormalizedToken(rawToken, candidateMetadata);
    const key = traceTokenKey(token);
    if (candidateTokens.has(key)) {
      throw new Error(`Candidate trace repeats token ${key}`);
    }
    candidateTokens.set(key, token);
  }
  if (candidateTokens.size !== referenceTokens.length) {
    throw new Error(
      "Reference and candidate traces must contain the same number of tokens"
    );
  }

  let layerComparisons = 0;
  let exactSetMatches = 0;
  let overlappingExperts = 0;
  const mismatches = [];
  for (const reference of referenceTokens) {
    const key = traceTokenKey(reference);
    const candidate = candidateTokens.get(key);
    if (!candidate) throw new Error(`Candidate trace is missing token ${key}`);
    for (let layer = 0; layer < referenceMetadata.layers; layer += 1) {
      layerComparisons += 1;
      const expected = reference.experts[layer];
      const actual = candidate.experts[layer];
      const actualSet = new Set(actual);
      const overlap = expected.filter((expertId) => actualSet.has(expertId)).length;
      overlappingExperts += overlap;
      if (overlap === referenceMetadata.activeExperts) {
        exactSetMatches += 1;
      } else if (mismatches.length < 20) {
        mismatches.push({
          traceId: reference.traceId,
          tokenIndex: reference.tokenIndex,
          phase: reference.phase,
          workflow: reference.workflow,
          layer,
          reference: [...expected].sort((left, right) => left - right),
          candidate: [...actual].sort((left, right) => left - right)
        });
      }
    }
  }
  return {
    model: referenceMetadata.model,
    tokenCount: referenceTokens.length,
    layerComparisons,
    exactSetMatches,
    exactSetAgreement:
      layerComparisons > 0 ? exactSetMatches / layerComparisons : 0,
    expertOverlapRate:
      layerComparisons > 0
        ? overlappingExperts /
          (layerComparisons * referenceMetadata.activeExperts)
        : 0,
    mismatchSamples: mismatches
  };
}

export function slotsForBudget(metadata, totalBudgetBytes) {
  const normalized = normalizeNormalizedMetadata(metadata);
  const budget = boundedInteger(
    totalBudgetBytes,
    1,
    Number.MAX_SAFE_INTEGER,
    "totalBudgetBytes"
  );
  const available = budget - normalized.sharedResidentBytes;
  if (available < normalized.layers * normalized.expertBytes) return 0;
  return Math.min(
    normalized.expertsPerLayer,
    Math.floor(available / (normalized.layers * normalized.expertBytes))
  );
}

function traceTokenKey(token) {
  return `${token.traceId}:${token.tokenIndex}:${token.phase}:${token.workflow}`;
}

function normalizeMetadata(record) {
  requireObject(record, "Expert trace metadata");
  assertAllowedKeys(record, METADATA_KEYS, "Expert trace metadata");
  if (record.type !== "metadata") throw new Error("Expert trace must begin with metadata");
  if (record.schema !== EXPERT_TRACE_SCHEMA) {
    throw new Error(`Unsupported expert trace schema: ${record.schema || "missing"}`);
  }
  if (record.version !== EXPERT_TRACE_VERSION) {
    throw new Error(`Unsupported expert trace version: ${record.version}`);
  }
  const metadata = {
    schema: record.schema,
    version: record.version,
    model: boundedText(record.model, "model", 240),
    layers: boundedInteger(record.layers, 1, 256, "layers"),
    expertsPerLayer: boundedInteger(
      record.experts_per_layer,
      2,
      4_096,
      "experts_per_layer"
    ),
    activeExperts: boundedInteger(record.active_experts, 1, 256, "active_experts"),
    expertBytes: boundedInteger(
      record.expert_bytes,
      1,
      Number.MAX_SAFE_INTEGER,
      "expert_bytes"
    ),
    weightStoreBytes: optionalInteger(record.weight_store_bytes),
    sharedResidentBytes: nonNegativeInteger(record.shared_resident_bytes),
    sourceRevision: optionalText(record.source_revision, 240),
    captureMode: optionalEnum(record.capture_mode, ["greedy", "sampled"]),
    samplingTemperature: optionalBoundedNumber(
      record.sampling_temperature,
      Number.EPSILON,
      Number.MAX_VALUE,
      "sampling_temperature"
    ),
    samplingTopP: optionalBoundedNumber(
      record.sampling_top_p,
      Number.EPSILON,
      1,
      "sampling_top_p"
    ),
    samplingSeed: optionalNonNegativeInteger(record.sampling_seed),
    createdAt: optionalText(record.created_at, 80)
  };
  if (metadata.activeExperts > metadata.expertsPerLayer) {
    throw new Error("active_experts cannot exceed experts_per_layer");
  }
  validateCaptureMetadata(metadata);
  return metadata;
}

function normalizeToken(record, metadata, lineNumber) {
  requireObject(record, `Expert trace line ${lineNumber}`);
  assertAllowedKeys(record, TOKEN_KEYS, `Expert trace line ${lineNumber}`);
  if (record.type !== "token") {
    throw new Error(`Expert trace line ${lineNumber} must have type token`);
  }
  if (!PHASES.has(record.phase)) {
    throw new Error(`Expert trace line ${lineNumber} has an invalid phase`);
  }
  if (!Array.isArray(record.experts) || record.experts.length !== metadata.layers) {
    throw new Error(
      `Expert trace line ${lineNumber} must contain ${metadata.layers} expert layers`
    );
  }
  const experts = record.experts.map((selected, layer) => {
    if (!Array.isArray(selected) || selected.length !== metadata.activeExperts) {
      throw new Error(
        `Expert trace line ${lineNumber}, layer ${layer} must select ` +
        `${metadata.activeExperts} experts`
      );
    }
    const ids = selected.map((value) =>
      boundedInteger(value, 0, metadata.expertsPerLayer - 1, `expert at layer ${layer}`)
    );
    if (new Set(ids).size !== ids.length) {
      throw new Error(`Expert trace line ${lineNumber}, layer ${layer} repeats an expert`);
    }
    return ids;
  });
  const normalized = {
    traceId: boundedText(record.trace_id, "trace_id", 160),
    tokenIndex: boundedInteger(record.token_index, 0, Number.MAX_SAFE_INTEGER, "token_index"),
    phase: record.phase,
    workflow: boundedText(record.workflow || "unspecified", "workflow", 120),
    experts
  };
  return normalized;
}

function normalizeNormalizedMetadata(metadata) {
  requireObject(metadata, "Expert trace metadata");
  const normalized = {
    schema: EXPERT_TRACE_SCHEMA,
    version: EXPERT_TRACE_VERSION,
    model: boundedText(metadata.model, "model", 240),
    layers: boundedInteger(metadata.layers, 1, 256, "layers"),
    expertsPerLayer: boundedInteger(
      metadata.expertsPerLayer,
      2,
      4_096,
      "expertsPerLayer"
    ),
    activeExperts: boundedInteger(metadata.activeExperts, 1, 256, "activeExperts"),
    expertBytes: boundedInteger(
      metadata.expertBytes,
      1,
      Number.MAX_SAFE_INTEGER,
      "expertBytes"
    ),
    weightStoreBytes: optionalInteger(metadata.weightStoreBytes),
    sharedResidentBytes: nonNegativeInteger(metadata.sharedResidentBytes),
    captureMode: optionalEnum(metadata.captureMode, ["greedy", "sampled"]),
    samplingTemperature: optionalBoundedNumber(
      metadata.samplingTemperature,
      Number.EPSILON,
      Number.MAX_VALUE,
      "samplingTemperature"
    ),
    samplingTopP: optionalBoundedNumber(
      metadata.samplingTopP,
      Number.EPSILON,
      1,
      "samplingTopP"
    ),
    samplingSeed: optionalNonNegativeInteger(metadata.samplingSeed)
  };
  if (normalized.activeExperts > normalized.expertsPerLayer) {
    throw new Error("activeExperts cannot exceed expertsPerLayer");
  }
  validateCaptureMetadata(normalized);
  return normalized;
}

function validateCaptureMetadata(metadata) {
  const samplingValues = [
    metadata.samplingTemperature,
    metadata.samplingTopP,
    metadata.samplingSeed
  ];
  if (
    metadata.captureMode === "sampled" &&
    samplingValues.some((value) => value === null)
  ) {
    throw new Error("Sampled capture metadata requires temperature, top-p, and seed");
  }
  if (
    metadata.captureMode === "greedy" &&
    samplingValues.some((value) => value !== null)
  ) {
    throw new Error("Greedy capture metadata cannot contain sampling settings");
  }
}

function normalizeNormalizedToken(token, metadata) {
  requireObject(token, "Expert token");
  if (!PHASES.has(token.phase)) throw new Error("Expert token has an invalid phase");
  if (!Array.isArray(token.experts) || token.experts.length !== metadata.layers) {
    throw new Error(`Expert token must contain ${metadata.layers} expert layers`);
  }
  const experts = token.experts.map((selected, layer) => {
    if (!Array.isArray(selected) || selected.length !== metadata.activeExperts) {
      throw new Error(`Each layer must select ${metadata.activeExperts} experts`);
    }
    const ids = selected.map((value) =>
      boundedInteger(value, 0, metadata.expertsPerLayer - 1, `expert at layer ${layer}`)
    );
    if (new Set(ids).size !== ids.length) {
      throw new Error(`Expert token layer ${layer} repeats an expert`);
    }
    return ids;
  });
  return {
    traceId: boundedText(token.traceId, "traceId", 160),
    tokenIndex: boundedInteger(
      token.tokenIndex,
      0,
      Number.MAX_SAFE_INTEGER,
      "tokenIndex"
    ),
    phase: token.phase,
    workflow: boundedText(token.workflow || "unspecified", "workflow", 120),
    experts
  };
}

function addDecodePositions(tokens) {
  const counts = new Map();
  return tokens.map((token) => {
    if (token.phase !== "decode") return token;
    const decodeIndex = counts.get(token.traceId) || 0;
    counts.set(token.traceId, decodeIndex + 1);
    return {
      ...token,
      decodeIndex
    };
  });
}

function summarizePrefillStreaming(tokens, metadata) {
  const traces = new Map();
  for (const token of tokens) {
    if (token.phase !== "prefill") continue;
    let trace = traces.get(token.traceId);
    if (!trace) {
      trace = {
        workflow: token.workflow,
        tokenCount: 0,
        selectedExpertAccesses: 0,
        experts: Array.from({ length: metadata.layers }, () => new Set())
      };
      traces.set(token.traceId, trace);
    }
    trace.tokenCount += 1;
    for (let layer = 0; layer < metadata.layers; layer += 1) {
      trace.selectedExpertAccesses += token.experts[layer].length;
      for (const expertId of token.experts[layer]) {
        trace.experts[layer].add(expertId);
      }
    }
  }

  const coldBytesPerToken = [];
  const coldRangesPerToken = [];
  const byWorkflow = new Map();
  let tokenCount = 0;
  let selectedExpertAccesses = 0;
  let streamedExperts = 0;
  let coldBytes = 0;
  let coldRanges = 0;
  let peakLayerBytes = 0;

  for (const trace of traces.values()) {
    const traceExperts = trace.experts.reduce((sum, experts) => sum + experts.size, 0);
    const traceRanges = trace.experts.reduce(
      (sum, experts) => sum + contiguousRangeCount([...experts]),
      0
    );
    const traceBytes = traceExperts * metadata.expertBytes;
    tokenCount += trace.tokenCount;
    selectedExpertAccesses += trace.selectedExpertAccesses;
    streamedExperts += traceExperts;
    coldBytes += traceBytes;
    coldRanges += traceRanges;
    peakLayerBytes = Math.max(
      peakLayerBytes,
      ...trace.experts.map((experts) => experts.size * metadata.expertBytes)
    );
    coldBytesPerToken.push(traceBytes / trace.tokenCount);
    coldRangesPerToken.push(traceRanges / trace.tokenCount);
    const workflow = byWorkflow.get(trace.workflow) || {
      traces: 0,
      tokenCount: 0,
      coldBytes: 0,
      coldRanges: 0
    };
    workflow.traces += 1;
    workflow.tokenCount += trace.tokenCount;
    workflow.coldBytes += traceBytes;
    workflow.coldRanges += traceRanges;
    byWorkflow.set(trace.workflow, workflow);
  }

  return {
    traceCount: traces.size,
    tokenCount,
    selectedExpertAccesses,
    streamedExperts,
    coldBytes,
    coldRanges,
    peakLayerBytes,
    coldBytesPerToken: summarizeSeries(coldBytesPerToken),
    coldRangesPerToken: summarizeSeries(coldRangesPerToken),
    workflows: Object.fromEntries(
      [...byWorkflow.entries()].sort(([left], [right]) => left.localeCompare(right))
    )
  };
}

function buildVerificationUnits(tokens, verifyBatchSize) {
  const byTrace = new Map();
  for (const token of tokens) {
    const grouped = byTrace.get(token.traceId) || [];
    grouped.push(token);
    byTrace.set(token.traceId, grouped);
  }

  return [...byTrace.entries()].map(([traceId, traceTokens]) => {
    const units = [];
    for (let offset = 0; offset < traceTokens.length; offset += verifyBatchSize) {
      const batch = traceTokens.slice(offset, offset + verifyBatchSize);
      const first = batch[0];
      units.push({
        traceId,
        workflow: first.workflow,
        tokenCount: batch.length,
        positionBucket: decodePositionBucket(first.decodeIndex),
        experts: first.experts.map((_selected, layer) =>
          [...new Set(batch.flatMap((token) => token.experts[layer]))]
            .sort((left, right) => left - right)
        )
      });
    }
    return units;
  });
}

function interleaveVerificationUnits(groups, concurrency) {
  const result = [];
  for (let offset = 0; offset < groups.length; offset += concurrency) {
    const active = groups.slice(offset, offset + concurrency);
    const indexes = active.map(() => 0);
    let remaining = true;
    while (remaining) {
      remaining = false;
      for (let stream = 0; stream < active.length; stream += 1) {
        const unit = active[stream][indexes[stream]];
        if (!unit) continue;
        result.push(unit);
        indexes[stream] += 1;
        remaining = true;
      }
    }
  }
  return result;
}

function decodePositionBucket(index) {
  if (index < 32) return "000-031";
  if (index < 128) return "032-127";
  return "128+";
}

function normalizeLatencyModel(model) {
  requireObject(model, "latencyModel");
  return {
    readBandwidthBytesPerSecond: boundedNumber(
      model.readBandwidthBytesPerSecond,
      Number.EPSILON,
      Number.MAX_VALUE,
      "readBandwidthBytesPerSecond"
    ),
    rangeLatencyMs: boundedNumber(
      model.rangeLatencyMs,
      0,
      Number.MAX_VALUE,
      "rangeLatencyMs"
    ),
    uploadBandwidthBytesPerSecond: boundedNumber(
      model.uploadBandwidthBytesPerSecond,
      Number.EPSILON,
      Number.MAX_VALUE,
      "uploadBandwidthBytesPerSecond"
    ),
    slotRemapMs: boundedNumber(
      model.slotRemapMs,
      0,
      Number.MAX_VALUE,
      "slotRemapMs"
    )
  };
}

function assertCompatibleMetadata(profile, target) {
  const fields = [
    "model",
    "layers",
    "expertsPerLayer",
    "activeExperts"
  ];
  const mismatch = fields.find((field) => profile[field] !== target[field]);
  if (mismatch) {
    throw new Error(
      `Workflow profile trace ${mismatch} does not match the evaluation trace`
    );
  }
}

function prewarmWorkflow(profile, caches, metadata) {
  if (!Array.isArray(profile) || profile.length !== metadata.layers) {
    throw new Error("Workflow profile has an invalid layer count");
  }
  let misses = 0;
  let coldRanges = 0;
  for (let layer = 0; layer < metadata.layers; layer += 1) {
    const experts = profile[layer];
    if (!Array.isArray(experts)) {
      throw new Error(`Workflow profile layer ${layer} must be an array`);
    }
    const missed = [];
    for (const expertId of [...experts].reverse()) {
      const normalized = boundedInteger(
        expertId,
        0,
        metadata.expertsPerLayer - 1,
        `workflow profile expert at layer ${layer}`
      );
      if (!caches[layer].access(normalized)) {
        misses += 1;
        missed.push(normalized);
      }
    }
    coldRanges += contiguousRangeCount(missed);
  }
  return {
    misses,
    coldBytes: misses * metadata.expertBytes,
    coldRanges
  };
}

function emptyStallSeries() {
  return {
    readSeek: [],
    readTransfer: [],
    upload: [],
    slotRemap: [],
    total: []
  };
}

function estimateStall(
  { coldBytes, coldRanges, misses },
  latencyModel,
  acceptedTokens
) {
  const readSeek = coldRanges * latencyModel.rangeLatencyMs / acceptedTokens;
  const readTransfer =
    coldBytes / latencyModel.readBandwidthBytesPerSecond * 1_000 / acceptedTokens;
  const upload =
    coldBytes / latencyModel.uploadBandwidthBytesPerSecond * 1_000 / acceptedTokens;
  const slotRemap = misses * latencyModel.slotRemapMs / acceptedTokens;
  return {
    readSeek,
    readTransfer,
    upload,
    slotRemap,
    total: readSeek + readTransfer + upload + slotRemap
  };
}

function appendStall(series, values) {
  for (const name of Object.keys(series)) series[name].push(values[name]);
}

function finishStallSeries(series, model) {
  return {
    model: {
      ...model,
      composition: "conservative-additive"
    },
    readSeek: summarizeSeries(series.readSeek),
    readTransfer: summarizeSeries(series.readTransfer),
    upload: summarizeSeries(series.upload),
    slotRemap: summarizeSeries(series.slotRemap),
    total: summarizeSeries(series.total)
  };
}

function normalizePolicy(value) {
  const policy = String(value || "").trim().toLowerCase();
  if (!EXPERT_CACHE_POLICIES.includes(policy)) {
    throw new Error(`Unknown ExpertCache policy: ${value}`);
  }
  return policy;
}

function createCache(policy, capacity, activeExperts) {
  if (policy === "lru") return new LruCache(capacity);
  if (policy === "lfu") return new LfuCache(capacity);
  if (policy === "slru") return new SlruCache(capacity, activeExperts);
  return new TinyLfuCache(capacity);
}

class LruCache {
  constructor(capacity) {
    this.capacity = capacity;
    this.items = new Map();
  }

  access(id) {
    if (this.items.has(id)) {
      touch(this.items, id);
      return true;
    }
    evictOldest(this.items, this.capacity);
    this.items.set(id, true);
    return false;
  }
}

class LfuCache {
  constructor(capacity) {
    this.capacity = capacity;
    this.items = new Map();
    this.tick = 0;
  }

  access(id) {
    this.tick += 1;
    const current = this.items.get(id);
    if (current) {
      current.frequency += 1;
      current.lastUsed = this.tick;
      return true;
    }
    if (this.items.size >= this.capacity) {
      let victim = null;
      for (const [candidateId, candidate] of this.items) {
        if (
          !victim ||
          candidate.frequency < victim.value.frequency ||
          (
            candidate.frequency === victim.value.frequency &&
            candidate.lastUsed < victim.value.lastUsed
          )
        ) {
          victim = { id: candidateId, value: candidate };
        }
      }
      this.items.delete(victim.id);
    }
    this.items.set(id, { frequency: 1, lastUsed: this.tick });
    return false;
  }
}

class SlruCache {
  constructor(capacity, activeExperts) {
    this.fallback = capacity < activeExperts * 2 ? new LruCache(capacity) : null;
    this.protectedCapacity = Math.max(activeExperts, Math.floor(capacity * 0.5));
    this.probationCapacity = Math.max(1, capacity - this.protectedCapacity);
    this.protected = new Map();
    this.probation = new Map();
  }

  access(id) {
    if (this.fallback) return this.fallback.access(id);
    if (this.protected.has(id)) {
      touch(this.protected, id);
      return true;
    }
    if (this.probation.has(id)) {
      this.probation.delete(id);
      if (this.protected.size >= this.protectedCapacity) {
        const demoted = oldestKey(this.protected);
        this.protected.delete(demoted);
        evictOldest(this.probation, this.probationCapacity);
        this.probation.set(demoted, true);
      }
      this.protected.set(id, true);
      return true;
    }
    evictOldest(this.probation, this.probationCapacity);
    this.probation.set(id, true);
    return false;
  }
}

class TinyLfuCache {
  constructor(capacity) {
    this.capacity = capacity;
    this.items = new Map();
    this.frequencies = new Map();
  }

  access(id) {
    const frequency = (this.frequencies.get(id) || 0) + 1;
    this.frequencies.set(id, frequency);
    if (this.items.has(id)) {
      touch(this.items, id);
      return true;
    }
    if (this.items.size < this.capacity) {
      this.items.set(id, true);
      return false;
    }
    const victim = oldestKey(this.items);
    const victimFrequency = this.frequencies.get(victim) || 0;
    if (frequency > victimFrequency) {
      this.items.delete(victim);
      this.items.set(id, true);
    }
    return false;
  }
}

function touch(map, key) {
  const value = map.get(key);
  map.delete(key);
  map.set(key, value);
}

function evictOldest(map, capacity) {
  if (map.size < capacity) return;
  map.delete(oldestKey(map));
}

function oldestKey(map) {
  return map.keys().next().value;
}

function emptyCounter() {
  return { accesses: 0, hits: 0, misses: 0 };
}

function incrementCounter(counter, hit) {
  counter.accesses += 1;
  if (hit) counter.hits += 1;
  else counter.misses += 1;
}

function finishCounter(counter) {
  return {
    ...counter,
    hitRate: counter.accesses > 0 ? counter.hits / counter.accesses : 0
  };
}

function average(values) {
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function summarizeSeries(values) {
  return {
    mean: average(values),
    p50: percentile(values, 0.50),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    maximum: Math.max(...values, 0)
  };
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(fraction * sorted.length) - 1);
  return sorted[index];
}

function contiguousRangeCount(values) {
  const ids = [...new Set(values)].sort((left, right) => left - right);
  if (ids.length === 0) return 0;
  let ranges = 1;
  for (let index = 1; index < ids.length; index += 1) {
    if (ids[index] !== ids[index - 1] + 1) ranges += 1;
  }
  return ranges;
}

function assertAllowedKeys(value, allowed, label) {
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) {
    throw new Error(
      `${label} contains unsupported field ${unexpected}; traces must not contain payload data`
    );
  }
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function boundedInteger(value, minimum, maximum, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return number;
}

function boundedNumber(value, minimum, maximum, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new Error(`${label} must be a number from ${minimum} through ${maximum}`);
  }
  return number;
}

function boundedText(value, label, maximum) {
  const text = String(value || "").trim();
  if (!text || text.length > maximum) {
    throw new Error(`${label} must contain 1 through ${maximum} characters`);
  }
  return text;
}

function optionalText(value, maximum) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.length > maximum) throw new Error(`Optional text exceeds ${maximum} characters`);
  return text;
}

function optionalInteger(value) {
  if (value === undefined || value === null || value === "") return null;
  return boundedInteger(value, 1, Number.MAX_SAFE_INTEGER, "optional integer");
}

function optionalBoundedNumber(value, minimum, maximum, label) {
  if (value === undefined || value === null || value === "") return null;
  return boundedNumber(value, minimum, maximum, label);
}

function optionalNonNegativeInteger(value) {
  if (value === undefined || value === null || value === "") return null;
  return boundedInteger(value, 0, Number.MAX_SAFE_INTEGER, "optional integer");
}

function optionalEnum(value, allowed) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (!allowed.includes(text)) {
    throw new Error(`Optional value must be one of ${allowed.join(", ")}`);
  }
  return text;
}

function nonNegativeInteger(value) {
  if (value === undefined || value === null || value === "") return 0;
  return boundedInteger(value, 0, Number.MAX_SAFE_INTEGER, "non-negative integer");
}
