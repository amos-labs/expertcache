#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus, freemem, hostname, totalmem } from "node:os";
import { basename, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const ggufs = readOptions(args, "--gguf").map((value) => resolve(value));
const traceOption = readOption(args, "--trace");
const trace = traceOption ? resolve(traceOption) : "";
const outputDir = resolve(
  readOption(args, "--output-dir") ||
    resolve(root, "output/phase-one")
);
const ggufPythonOption = readOption(args, "--gguf-python");
const ggufPython = ggufPythonOption ? resolve(ggufPythonOption) : "";
const slots = (readOption(args, "--slots") || "63,81")
  .split(",")
  .map(Number)
  .filter((value) => Number.isInteger(value) && value > 0);
const phase = readOption(args, "--phase") || "all";
const tokenOffset = Number(readOption(args, "--token-offset") || 0);
const maxTokens = Number(readOption(args, "--max-tokens") || 0);
const selectedTraceIds = readOptions(args, "--trace-id");
const selectedWorkflows = readOptions(args, "--workflow");
const profileTraceOption = readOption(args, "--profile-trace");
const profileTrace = profileTraceOption ? resolve(profileTraceOption) : "";
const prewarmExpertsPerLayer = Number(
  readOption(args, "--prewarm-experts-per-layer") || 0
);
const prewarmFromPrefill = Number(
  readOption(args, "--prewarm-from-prefill") || 0
);
const prewarmAdmission =
  readOption(args, "--prewarm-admission") || "physical-only";
const candidateOptions = readOptions(args, "--cache-candidate");
const candidates =
  candidateOptions.length > 0
    ? candidateOptions.map(parseCandidate)
    : slots.map((capacity) => ({
        policy: "lru",
        capacity,
        admitAfter: 1
      }));
const manifest = JSON.parse(
  await readFile(
    resolve(root, "runtime/runtime-manifest.json"),
    "utf8"
  )
);
const hostBefore = {
  hostname: hostname(),
  platform: process.platform,
  architecture: process.arch,
  cpu: cpus()[0]?.model || "unknown",
  logical_cpus: cpus().length,
  total_memory_bytes: totalmem(),
  free_memory_bytes: freemem()
};

if (ggufs.length === 0 || !trace || !ggufPython || slots.length === 0) {
  console.error(
    "Usage: npm run experiment:phase-one -- " +
      "--gguf MODEL.gguf [--gguf SHARD.gguf] --trace TRACE.jsonl " +
      "--gguf-python LLAMA_CPP/gguf-py [--slots 63,81] " +
      "[--phase all|prefill|decode] [--token-offset N] " +
      "[--max-tokens N] [--trace-id ID] [--workflow NAME] " +
      "[--profile-trace TRAIN.jsonl --prewarm-experts-per-layer N] " +
      "[--prewarm-from-prefill N] " +
      "[--prewarm-admission physical-only|cache] " +
      "[--cache-candidate POLICY:SLOTS:ADMIT_AFTER] [--output-dir DIR]"
  );
  process.exit(2);
}
if (!["all", "prefill", "decode"].includes(phase)) {
  console.error("--phase must be all, prefill, or decode");
  process.exit(2);
}
if (!Number.isInteger(tokenOffset) || tokenOffset < 0) {
  console.error("--token-offset must be a non-negative integer");
  process.exit(2);
}
if (
  (profileTrace && (!Number.isInteger(prewarmExpertsPerLayer) ||
    prewarmExpertsPerLayer <= 0)) ||
  (!profileTrace && prewarmExpertsPerLayer !== 0)
) {
  console.error(
    "--profile-trace and a positive --prewarm-experts-per-layer are required together"
  );
  process.exit(2);
}
if (!["physical-only", "cache"].includes(prewarmAdmission)) {
  console.error("--prewarm-admission must be physical-only or cache");
  process.exit(2);
}
if (
  !Number.isInteger(prewarmFromPrefill) ||
  prewarmFromPrefill < 0 ||
  (prewarmFromPrefill > 0 && Boolean(profileTrace))
) {
  console.error(
    "--prewarm-from-prefill must be non-negative and cannot be combined with --profile-trace"
  );
  process.exit(2);
}

await mkdir(outputDir, { recursive: true });
const model = manifest.model_artifact;
const sourceRevision = [
  `model:${model.revision}`,
  `llama.cpp:${manifest.runtime.revision}`,
  `xet:${model.x_linked_etag}`
].join(";");
const layoutPath = resolve(outputDir, "gpt-oss-120b.layout.json");
const layoutArgs = [
  "harness/build_expert_layout.py",
  ...ggufs.flatMap((path) => ["--gguf", path]),
  "--gguf-python",
  ggufPython,
  "--source-revision",
  sourceRevision,
  "--model",
  "openai/gpt-oss-120b",
  "--output",
  layoutPath
];
run("python3", layoutArgs);
const layout = JSON.parse(await readFile(layoutPath, "utf8"));
const traceMetadata = JSON.parse(
  (await readFile(trace, "utf8")).split(/\r?\n/, 1)[0]
);

const arms = [
  { name: "disabled", mode: "disabled" },
  { name: "natural", mode: "natural" },
  ...candidates.map(({ policy, capacity, admitAfter }) => ({
    name: `working-set-${policy}-${capacity}-admit-${admitAfter}`,
    mode: "working-set",
    policy,
    capacity,
    admitAfter
  }))
];
const reports = [];
for (const arm of arms) {
  const output = resolve(outputDir, `${arm.name}.json`);
  const replayArgs = [
    "harness/replay_expert_pages.py",
    "--trace",
    trace,
    "--layout",
    layoutPath,
    "--mode",
    arm.mode,
    "--phase",
    phase,
    "--token-offset",
    String(tokenOffset),
    "--cold-start",
    "--output",
    output
  ];
  for (const traceId of selectedTraceIds) {
    replayArgs.push("--trace-id", traceId);
  }
  for (const workflow of selectedWorkflows) {
    replayArgs.push("--workflow", workflow);
  }
  if (arm.policy) {
    replayArgs.push(
      "--policy",
      arm.policy,
      "--slots-per-layer",
      String(arm.capacity),
      "--admit-after",
      String(arm.admitAfter)
    );
    if (profileTrace) {
      replayArgs.push(
        "--profile-trace",
        profileTrace,
        "--prewarm-experts-per-layer",
        String(prewarmExpertsPerLayer)
      );
    }
    if (prewarmFromPrefill > 0) {
      replayArgs.push(
        "--prewarm-from-prefill",
        String(prewarmFromPrefill)
      );
    }
    if (profileTrace || prewarmFromPrefill > 0) {
      replayArgs.push("--prewarm-admission", prewarmAdmission);
    }
  }
  if (maxTokens > 0) {
    replayArgs.push("--max-tokens", String(maxTokens));
  }
  console.error(`\n=== Phase 1 arm: ${arm.name} ===`);
  run("python3", replayArgs);
  const report = JSON.parse(await readFile(output, "utf8"));
  reports.push({ arm: arm.name, output, ...report });
}

const summary = {
  schema: "amos.expert-cache-phase-one-summary",
  version: 1,
  created_at: new Date().toISOString(),
  model_artifact: model,
  runtime: manifest.runtime,
  trace: basename(trace),
  host: { ...hostBefore, free_memory_bytes_after_arms: freemem() },
  max_tokens: maxTokens || null,
  trace_phase: phase,
  selected_trace_ids: selectedTraceIds,
  selected_workflows: selectedWorkflows,
  profile_trace: profileTrace ? basename(profileTrace) : null,
  prewarm_experts_per_layer: prewarmExpertsPerLayer || null,
  prewarm_from_prefill: prewarmFromPrefill || null,
  prewarm_admission: prewarmAdmission,
  token_offset: tokenOffset,
  arms: reports.map((report) => ({
    arm: report.arm,
    output: basename(report.output),
    token_count: report.token_count,
    logical_hit_rate: report.hit_rate,
    physical_resident_page_rate:
      report.physical_residency_before_access.resident_page_rate,
    physical_fully_resident_accesses:
      report.physical_residency_before_access.fully_resident_accesses,
    physical_partially_resident_accesses:
      report.physical_residency_before_access.partially_resident_accesses,
    physical_unresident_accesses:
      report.physical_residency_before_access.unresident_accesses,
    p95_access_latency_ms: report.access_latency_ms.p95,
    p99_access_latency_ms: report.access_latency_ms.p99,
    p95_physical_cold_bytes: report.cold_bytes_per_token.p95,
    p95_logical_miss_bytes: report.logical_miss_bytes_per_token.p95,
    worst_workflow_p95_physical_cold_bytes: Math.max(
      0,
      ...Object.values(report.strata.by_workflow).map(
        (stratum) => stratum.cold_bytes_per_token.p95
      )
    ),
    max_trace_boundary_physical_cold_bytes: Math.max(
      0,
      ...report.strata.trace_boundaries.map(
        (boundary) => boundary.first_token_physical_cold_bytes
      )
    ),
    workflow_prewarm: report.workflow_prewarm,
    major_page_faults: report.page_faults.major,
    minor_page_faults: report.page_faults.minor,
    max_rss_bytes: report.max_rss_bytes,
    elapsed_seconds: report.elapsed_seconds
  })),
  page_gate: evaluatePageGate(reports, layout, traceMetadata, phase)
};
const summaryPath = resolve(outputDir, "summary.json");
await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ summary: summaryPath, ...summary }, null, 2));

function readOption(values, name) {
  const index = values.indexOf(name);
  return index >= 0 ? values[index + 1] || "" : "";
}

function readOptions(values, name) {
  const results = [];
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === name && values[index + 1]) {
      results.push(values[index + 1]);
    }
  }
  return results;
}

function parseCandidate(value) {
  const [policy, capacityText, admitAfterText] = value.split(":");
  const capacity = Number(capacityText);
  const admitAfter = Number(admitAfterText);
  if (
    !["lru", "slru"].includes(policy) ||
    !Number.isInteger(capacity) ||
    capacity <= 0 ||
    !Number.isInteger(admitAfter) ||
    admitAfter <= 0
  ) {
    console.error(
      `Invalid --cache-candidate ${value}; expected lru|slru:SLOTS:ADMIT_AFTER`
    );
    process.exit(2);
  }
  return { policy, capacity, admitAfter };
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    stdio: "inherit"
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${commandArgs.join(" ")} exited ${result.status}`
    );
  }
}

function evaluatePageGate(reports, layout, traceMetadata, phase) {
  const gib = 1024 ** 3;
  const mib = 1024 ** 2;
  const disabled = reports.find((report) => report.arm === "disabled");
  const candidates = reports
    .filter((report) => report.arm.startsWith("working-set-"))
    .sort(
      (left, right) =>
        left.access_latency_ms.p95 - right.access_latency_ms.p95 ||
        left.cold_bytes_per_token.p95 - right.cold_bytes_per_token.p95
    );
  if (!disabled || candidates.length === 0) {
    return {
      status: "incomplete",
      reason: "The disabled control and at least one working-set arm are required."
    };
  }

  const candidate = candidates[0];
  const workflowP95ColdBytes = Object.values(
    candidate.strata.by_workflow
  ).map((stratum) => stratum.cold_bytes_per_token.p95);
  const boundaryColdBytes = candidate.strata.trace_boundaries.map(
    (boundary) => boundary.first_token_physical_cold_bytes
  );
  const worstWorkflowP95ColdBytes = Math.max(0, ...workflowP95ColdBytes);
  const maxBoundaryColdBytes = Math.max(0, ...boundaryColdBytes);
  const completeExpertBytes =
    layout.bytes_per_layer_expert *
    layout.layer_count *
    candidate.slots_per_layer;
  const sharedBytes = Number(traceMetadata.shared_resident_bytes || 0);
  const completeResidentBytes = completeExpertBytes + sharedBytes;
  const checks = {
    lower_p95_access_latency_than_disabled:
      candidate.access_latency_ms.p95 < disabled.access_latency_ms.p95,
    lower_p95_physical_cold_bytes_than_disabled:
      candidate.cold_bytes_per_token.p95 <
      disabled.cold_bytes_per_token.p95,
    estimated_complete_resident_at_or_below_46_gib:
      completeResidentBytes <= 46 * gib
  };
  if (phase === "decode") {
    checks.physical_cold_reads_at_or_below_250_mib =
      candidate.cold_bytes_per_token.p95 <= 250 * mib;
    checks.every_workflow_p95_at_or_below_250_mib =
      worstWorkflowP95ColdBytes <= 250 * mib;
    checks.every_trace_boundary_at_or_below_250_mib =
      maxBoundaryColdBytes <= 250 * mib;
  }
  return {
    status:
      phase === "decode"
        ? Object.values(checks).every(Boolean)
          ? "pass"
          : "fail"
        : "directional",
    scope: "mapped-page feasibility only; not an inference or product gate",
    trace_phase: phase,
    candidate: candidate.arm,
    checks,
    estimated_complete_expert_bytes: completeExpertBytes,
    shared_resident_bytes: sharedBytes,
    estimated_complete_resident_bytes: completeResidentBytes,
    p95_access_latency_ms: candidate.access_latency_ms.p95,
    p95_physical_cold_bytes: candidate.cold_bytes_per_token.p95,
    worst_workflow_p95_physical_cold_bytes: worstWorkflowP95ColdBytes,
    max_trace_boundary_physical_cold_bytes: maxBoundaryColdBytes,
    limitations: [
      ...(phase === "decode"
        ? []
        : [
            "The 250 MiB generated-token bound applies only to a decode-only run."
          ]),
      "Page advice must still prove bit-equivalent model output.",
      "Live Metal inference must still meet throughput, first-output, memory, thermal, and quality gates.",
      ...(candidate.token_count <= 128
        ? [
            "A 128-token calibration is directional; a longer held-out trace decides this gate."
          ]
        : [
            `This held-out run covered ${candidate.token_count} decode tokens; live inference gates remain separate.`
          ])
    ]
  };
}
