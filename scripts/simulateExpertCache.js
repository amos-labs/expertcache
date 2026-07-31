#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import {
  EXPERT_CACHE_POLICIES,
  parseExpertTrace,
  slotsForBudget,
  sweepExpertCache
} from "../src/expertCache.js";

const args = process.argv.slice(2);
const tracePath = readOption(args, "--trace");
const profileTracePath = readOption(args, "--profile-trace");
const policies = listOption(args, "--policies", EXPERT_CACHE_POLICIES);
const slots = listOption(args, "--slots", [4, 8, 16, 32, 64, 96], Number);
const budgetsGiB = listOption(args, "--budgets-gib", [], Number);
const budgetsBytes = budgetsGiB.map((value) => value * 1024 ** 3);
const verifyBatchSizes = listOption(args, "--verify-batches", [1], Number);
const verificationAcceptanceRates = listOption(args, "--acceptance-rates", [1], Number);
const concurrencyLevels = listOption(args, "--concurrency", [1], Number);
const latencyOptionNames = [
  "--read-gib-s",
  "--range-latency-ms",
  "--upload-gib-s",
  "--slot-remap-ms"
];
const latencyValues = latencyOptionNames.map((name) => numberOption(args, name));
const providedLatencyValues = latencyValues.filter((value) => value !== null);
if (
  providedLatencyValues.length > 0 &&
  providedLatencyValues.length !== latencyOptionNames.length
) {
  console.error(
    `Latency modeling requires all of: ${latencyOptionNames.join(", ")}`
  );
  process.exit(2);
}
const latencyModel = providedLatencyValues.length === latencyOptionNames.length
  ? {
      readBandwidthBytesPerSecond: latencyValues[0] * 1024 ** 3,
      rangeLatencyMs: latencyValues[1],
      uploadBandwidthBytesPerSecond: latencyValues[2] * 1024 ** 3,
      slotRemapMs: latencyValues[3]
    }
  : null;
const json = args.includes("--json");

if (!tracePath) {
  console.error(
    "Usage: npm run experiment:simulate -- --trace TRACE.jsonl " +
    "[--policies lru,lfu,slru,tinylfu] [--slots 4,8,16,32,64,96] " +
    "[--budgets-gib 32,40,46] [--verify-batches 1,2,4,8] " +
    "[--acceptance-rates 0.5,0.75,1] [--concurrency 1,2] " +
    "[--profile-trace TRAINING_TRACE.jsonl] " +
    "[--read-gib-s N --range-latency-ms N --upload-gib-s N " +
    "--slot-remap-ms N] [--json]"
  );
  process.exit(2);
}
if (profileTracePath && profileTracePath === tracePath) {
  console.error("--profile-trace must be a separate training trace, not the evaluation trace");
  process.exit(2);
}

const trace = parseExpertTrace(await readFile(tracePath, "utf8"));
const profileTrace = profileTracePath
  ? parseExpertTrace(await readFile(profileTracePath, "utf8"))
  : null;
const results = sweepExpertCache(trace, {
  policies,
  slots,
  budgetsBytes,
  latencyModel,
  verifyBatchSizes,
  verificationAcceptanceRates,
  concurrencyLevels,
  profileTrace
});
const rejectedBudgets = budgetsBytes.filter(
  (budget) => slotsForBudget(trace.metadata, budget) < 1
);

if (json) {
  console.log(
    JSON.stringify(
      {
        metadata: trace.metadata,
        profileMetadata: profileTrace
          ? {
              model: profileTrace.metadata.model,
              captureMode: profileTrace.metadata.captureMode,
              tokenCount: profileTrace.tokens.length
            }
          : null,
        rejectedBudgets,
        results
      },
      null,
      2
    )
  );
  process.exit(0);
}

console.log(
  `ExpertCache sweep · ${trace.metadata.model} · ${trace.tokens.length} tokens · ` +
  `${trace.metadata.layers} layers × top-${trace.metadata.activeExperts}`
);
const prefill = results[0]?.prefillStreaming;
if (prefill) {
  console.log(
    `Prefill bypass · ${prefill.tokenCount} tokens · ` +
    `${formatBytes(prefill.coldBytes)} streamed · ` +
    `${formatBytes(prefill.peakLayerBytes)} peak layer working set`
  );
}
console.log(
  [
    pad("policy", 10),
    pad("budget", 11),
    pad("slots", 7),
    pad("verify", 8),
    pad("accept", 9),
    pad("streams", 9),
    pad("hit rate", 10),
    pad("p95 stall", 12),
    pad("prewarm", 12),
    pad("p95 cold/token", 17),
    pad("cache", 12),
    pad("resident", 12),
    pad("p95 ranges", 12),
    pad("early", 10)
  ].join("")
);
for (const result of results) {
  console.log(
    [
      pad(result.policy, 10),
      pad(
        result.requestedBudgetBytes
          ? formatBytes(result.requestedBudgetBytes)
          : "slots",
        11
      ),
      pad(result.slotsPerLayer, 7),
      pad(result.verifyBatchSize, 8),
      pad(percent(result.assumedAcceptanceRate), 9),
      pad(result.concurrency, 9),
      pad(percent(result.hitRate), 10),
      pad(
        result.stallMsPerToken
          ? `${result.stallMsPerToken.total.p95.toFixed(1)} ms`
          : "unmodeled",
        12
      ),
      pad(formatBytes(result.workflowPrewarm.coldBytes), 12),
      pad(formatBytes(result.coldBytesPerToken.p95), 17),
      pad(formatBytes(result.cacheFootprintBytes), 12),
      pad(formatBytes(result.estimatedResidentBytes), 12),
      pad(result.coldRangesPerToken.p95.toFixed(1), 12),
      pad(percent(result.decodePositions["000-031"]?.hitRate), 10)
    ].join("")
  );
}
for (const budget of rejectedBudgets) {
  console.warn(
    `Budget ${formatBytes(budget)} cannot hold the shared baseline plus one ` +
    "expert slot per layer."
  );
}

function readOption(values, name) {
  const index = values.indexOf(name);
  return index >= 0 ? values[index + 1] : "";
}

function listOption(values, name, fallback, transform = String) {
  const value = readOption(values, name);
  if (!value) return [...fallback];
  return value
    .split(",")
    .map((item) => transform(item.trim()))
    .filter((item) => (
      typeof item === "number" ? Number.isFinite(item) && item > 0 : Boolean(item)
    ));
}

function numberOption(values, name) {
  const raw = readOption(values, name);
  if (raw === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    console.error(`${name} must be a non-negative number`);
    process.exit(2);
  }
  return value;
}

function percent(value) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

function pad(value, width) {
  return String(value).slice(0, width - 1).padEnd(width, " ");
}
