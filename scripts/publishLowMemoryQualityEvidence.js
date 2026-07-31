#!/usr/bin/env node
import { createHash } from "node:crypto";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateFunnelBottleneck } from "../src/qualificationEvaluators.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = dirname(repositoryRoot);
const sourceRoot = resolve(repositoryRoot, "output/low-memory-quality");
const evidenceRoot = resolve(
  repositoryRoot,
  "evidence/low-memory-16g-2026-07-31"
);
const rawRoot = resolve(evidenceRoot, "quality-raw");
const comparatorRoot = resolve(
  repositoryRoot,
  "evidence/qualification-controls-2026-07-31"
);

const gateDirectory = "2026-07-31-m1-pro-warm-battery-8k-8-token-gate";
const interruptedDirectory =
  "2026-07-31-m1-pro-warm-quality-07-distractor-retrieval";
const scenarioRuns = [{
  directory: "2026-07-31-m1-pro-warm-quality-01-contradictory",
  power: "Battery, 100% before the scenario and 97% after."
}, {
  directory: "2026-07-31-m1-pro-warm-quality-02-prompt-injection",
  power: "Battery, 97% before the scenario and 91% after."
}, {
  directory: "2026-07-31-m1-pro-warm-quality-03-tenant-boundary",
  power: "Battery, 91% before the scenario and 85% after."
}, {
  directory: "2026-07-31-m1-pro-warm-quality-04-parked-approval",
  power: "Battery, 85% before the scenario and 79% after."
}, {
  directory: "2026-07-31-m1-pro-warm-quality-05-multi-tool",
  power: "Battery, 79% before the scenario and 68% after."
}, {
  directory: "2026-07-31-m1-pro-warm-quality-06-coding",
  power: "Mixed: began on battery and ended on AC at 70%; timing is not power-controlled."
}, {
  directory: "2026-07-31-m1-pro-warm-quality-07b-distractor-caffeinated",
  power: "AC for the complete attempt, wrapped in caffeinate -i -s."
}];

const publishedDirectories = [
  gateDirectory,
  ...scenarioRuns.map((run) => run.directory),
  interruptedDirectory
];
const publishedNames = ["baseline.json", "qualification.json", "llama-server.log"];

await mkdir(rawRoot, { recursive: true });

const manifestFiles = [];
for (const directory of publishedDirectories) {
  for (const name of publishedNames) {
    const source = resolve(sourceRoot, directory, name);
    if (!await exists(source)) continue;
    const destination = resolve(rawRoot, directory, name);
    await mkdir(dirname(destination), { recursive: true });
    const original = await readFile(source);
    const published = Buffer.from(sanitize(original.toString("utf8")));
    await writeFile(destination, published);
    manifestFiles.push({
      source_output: relative(repositoryRoot, source),
      published_path: relative(repositoryRoot, destination),
      original_sha256: sha256(original),
      published_sha256: sha256(published),
      original_size_bytes: (await stat(source)).size,
      published_size_bytes: published.length
    });
  }
}

const scenarioResults = [];
for (const run of scenarioRuns) {
  const directory = resolve(sourceRoot, run.directory);
  const baseline = JSON.parse(await readFile(resolve(directory, "baseline.json"), "utf8"));
  const qualification = JSON.parse(
    await readFile(resolve(directory, "qualification.json"), "utf8")
  );
  const result = qualification.results[0];
  const scenario = result.scenarios[0];
  const response = result.response_records.at(-1)?.message?.content || "";
  const correctedToolSequencePass = scenario.name === "dependent multi-tool sequence"
    ? evaluateFunnelBottleneck(response)
    : null;
  const functionalPass = scenario.passed || correctedToolSequencePass === true;
  const samples = baseline.process_samples || [];
  scenarioResults.push({
    name: scenario.name,
    weight: scenario.weight,
    raw_harness_pass: scenario.passed,
    raw_harness_score: scenario.passed ? scenario.weight : 0,
    functional_pass: functionalPass,
    functional_score: functionalPass ? scenario.weight : 0,
    evaluator_correction: correctedToolSequencePass === true && !scenario.passed
      ? {
          reason:
            "The v3 runner required the literal substring signup. The answer used " +
            "Sign-ups after Unicode normalization while correctly completing both " +
            "dependent calls and naming playground-to-signup as the largest bottleneck.",
          corrected_evaluator: "evaluateFunnelBottleneck",
          exact_response_replay_passed: true
        }
      : null,
    detail: scenario.detail,
    wall_seconds: scenario.wallSeconds,
    request_count: result.timings.request_count,
    prompt: {
      tokens: result.timings.prompt_tokens,
      milliseconds: result.timings.prompt_milliseconds,
      tokens_per_second: result.timings.prompt_tokens_per_second
    },
    decode: {
      tokens: result.timings.predicted_tokens,
      milliseconds: result.timings.predicted_milliseconds,
      tokens_per_second: result.timings.predicted_tokens_per_second
    },
    peak_process_rss_bytes: maximum(samples.map((sample) => sample.rss_bytes)),
    peak_swap_used_bytes: maximum(samples.map((sample) => sample.swap_used_bytes)),
    minimum_free_memory_percent: minimum(
      samples.map((sample) => sample.memory_free_percent)
    ),
    swap_growth_bytes: baseline.host_delta?.swap_growth_bytes ?? null,
    watchdog_triggered: baseline.watchdog?.triggered ?? null,
    power: run.power,
    evidence_directory: `$WORKTREE/evidence/low-memory-16g-2026-07-31/quality-raw/${run.directory}`
  });
}

const gate = JSON.parse(
  await readFile(resolve(sourceRoot, gateDirectory, "baseline.json"), "utf8")
);
const representative = JSON.parse(await readFile(
  resolve(sourceRoot, scenarioRuns.at(-1).directory, "baseline.json"),
  "utf8"
));
const rawScore = sum(scenarioResults.map((result) => result.raw_harness_score));
const functionalScore = sum(scenarioResults.map((result) => result.functional_score));
const maximumScore = sum(scenarioResults.map((result) => result.weight));
const governedComparators = await Promise.all([
  summarizeComparator("local-low-qualification.json"),
  summarizeComparator("bedrock-low-qualification.json")
]);

const summary = {
  schema: "expertcache.low-memory-16g-quality-summary",
  version: 1,
  created_at: new Date().toISOString(),
  status: "complete-warm-engineering-run",
  source_revision: representative.host_before?.source_revision ?? null,
  host: {
    model_name: representative.host_before?.hardware?.model_name,
    model_identifier: representative.host_before?.hardware?.model_identifier,
    chip: representative.host_before?.hardware?.chip,
    physical_memory: representative.host_before?.hardware?.physical_memory,
    os: representative.host_before?.os
  },
  model: {
    filename: representative.model_filename,
    size_bytes: representative.model_size_bytes,
    expected_sha256: representative.model_expected_sha256,
    repository: representative.model_repository,
    revision: representative.model_revision
  },
  runtime: {
    revision: representative.runtime_revision,
    binary_sha256: representative.runtime_binary_sha256,
    bundle_sha256: representative.runtime_bundle_sha256
  },
  configuration: {
    context_length: representative.context_length,
    batch_size: representative.batch_size,
    micro_batch_size: representative.micro_batch_size,
    automatic_fit: representative.automatic_fit,
    gpu_layers: representative.gpu_layers,
    expert_cache_slots: representative.expert_cache_slots,
    expert_cache_cpu_fill: representative.expert_cache_cpu_fill,
    expert_cache_zero_copy: representative.expert_cache_zero_copy,
    expert_cache_grouped: representative.expert_cache_grouped,
    expert_cache_prefetch_threads: representative.expert_cache_prefetch_threads,
    warmup: representative.warmup,
    max_tokens: representative.max_tokens,
    reasoning_effort: representative.reasoning_effort,
    seed: representative.seed,
    request_timeout_seconds: representative.request_timeout_seconds,
    watchdog: representative.watchdog
  },
  warm_context_gate: {
    passed: gate.failure === null && gate.watchdog?.triggered === null,
    context_length: gate.context_length,
    max_tokens: gate.max_tokens,
    prompt: gate.llama_timings?.prompt,
    decode: gate.llama_timings?.decode,
    peak_process_rss_bytes: maximum(
      (gate.process_samples || []).map((sample) => sample.rss_bytes)
    ),
    peak_swap_used_bytes: maximum(
      (gate.process_samples || []).map((sample) => sample.swap_used_bytes)
    ),
    power: "Battery-powered warm diagnostic; 100% before and after."
  },
  qualification: {
    contract_version: 3,
    scenarios: scenarioResults.length,
    maximum_score: maximumScore,
    raw_harness_score: rawScore,
    functional_score_after_evaluator_replay: functionalScore,
    total_scenario_wall_seconds: sum(
      scenarioResults.map((result) => result.wall_seconds)
    ),
    peak_process_rss_bytes: maximum(
      scenarioResults.map((result) => result.peak_process_rss_bytes)
    ),
    peak_swap_used_bytes: maximum(
      scenarioResults.map((result) => result.peak_swap_used_bytes)
    ),
    minimum_free_memory_percent: minimum(
      scenarioResults.map((result) => result.minimum_free_memory_percent)
    ),
    scenarios: scenarioResults
  },
  interrupted_long_context_attempt: {
    directory: interruptedDirectory,
    status: "operator-interrupted-and-preserved",
    progress_before_interrupt: "681 prompt tokens, approximately 17 percent",
    reason:
      "macOS repeatedly entered idle and maintenance sleep, including Dark Wake " +
      "Thermal Emergency sleeps. The two-hour HTTP timer included sleep time, so " +
      "the attempt was stopped before a predictable timeout and restarted under " +
      "caffeinate -i -s.",
    notable_sleep_events: [
      "2026-07-31 15:24:45 +0100: Dark Wake Thermal Emergency sleep for 701 seconds.",
      "2026-07-31 15:36:26 +0100: Dark Wake Thermal Emergency sleep for 983 seconds."
    ]
  },
  governed_comparators: governedComparators,
  interpretation: [
    "This is a warm-host engineering qualification, not a clean-boot publication run.",
    "Correctness and stability were in scope; power-normalized performance was not.",
    "The 2 GiB swap-growth watchdog was not restrictive on the successful path.",
    "The original multi-tool report remains unchanged at 0/3; the functional score " +
      "uses an exact-response replay through the regression-tested evaluator fix."
  ]
};

await writeFile(
  resolve(evidenceRoot, "quality-summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`
);
await writeFile(
  resolve(evidenceRoot, "quality-raw-manifest.json"),
  `${JSON.stringify({
    schema: "expertcache.sanitized-quality-evidence-manifest",
    version: 1,
    transformations: [
      "Replace the absolute pull-request worktree path with $WORKTREE.",
      "Replace the absolute project/cache root with $PROJECT_ROOT.",
      "Replace any remaining absolute home path with $HOME.",
      "Replace the host fingerprint and battery device identifier with redacted."
    ],
    files: manifestFiles
  }, null, 2)}\n`
);

console.log(JSON.stringify({
  raw_harness_score: rawScore,
  functional_score: functionalScore,
  maximum_score: maximumScore,
  published_files: manifestFiles.length,
  summary: relative(repositoryRoot, resolve(evidenceRoot, "quality-summary.json")),
  manifest: relative(repositoryRoot, resolve(evidenceRoot, "quality-raw-manifest.json"))
}, null, 2));

function sanitize(value) {
  return value
    .replaceAll(repositoryRoot, "$WORKTREE")
    .replaceAll(projectRoot, "$PROJECT_ROOT")
    .replaceAll(homedir(), "$HOME")
    .replace(/"host_fingerprint":\s*"[0-9a-f]+"/g, '"host_fingerprint": "redacted"')
    .replace(/\(id=\d+\)/g, "(id=redacted)");
}

async function summarizeComparator(filename) {
  const path = resolve(comparatorRoot, filename);
  const wrapper = JSON.parse(await readFile(path, "utf8"));
  const result = wrapper.report.results[0];
  return {
    label: wrapper.label,
    artifact: `$WORKTREE/${relative(repositoryRoot, path)}`,
    contract_version: wrapper.report.qualification_contract.version,
    score: result.score,
    maximum: result.maximum,
    failed_scenarios: result.scenarios
      .filter((scenario) => !scenario.passed)
      .map((scenario) => ({
        name: scenario.name,
        weight: scenario.weight
      }))
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function maximum(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length > 0 ? Math.max(...finite) : null;
}

function minimum(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length > 0 ? Math.min(...finite) : null;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}
