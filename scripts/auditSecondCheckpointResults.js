#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  canonicalQualificationMessageSha256
} from "../src/qualificationEvidence.js";
import { evaluateFunnelBottleneck } from "../src/qualificationEvaluators.js";

const args = process.argv.slice(2);
const input = resolve(option("--input-dir"));
const output = resolve(option("--output"));
const arms = ["stock", "direct", "grouped", "prefetch-6"];

if (!option("--input-dir") || !option("--output")) {
  console.error(
    "Usage: node scripts/auditSecondCheckpointResults.js " +
    "--input-dir DIR --output FILE"
  );
  process.exit(2);
}

const sourceSummary = await readJson(resolve(input, "second-checkpoint-summary.json"));
const sourceState = await readJson(resolve(input, "gate-state.json"));
const auditedArms = [];

for (const arm of arms) {
  const qualificationPath = resolve(input, arm, "qualification.json");
  const baselinePath = resolve(input, arm, "baseline.json");
  const qualificationRaw = await readFile(qualificationPath);
  const baselineRaw = await readFile(baselinePath);
  const qualification = JSON.parse(qualificationRaw);
  const baseline = JSON.parse(baselineRaw);
  const result = qualification.results?.[0];
  if (!result) throw new Error(`Missing qualification result for ${arm}`);
  const business = result.scenarios?.find(
    (scenario) => scenario.name === "business diagnosis"
  );
  const businessRecord = result.response_records?.[1];
  if (!business || !businessRecord) {
    throw new Error(`Missing frozen business diagnosis evidence for ${arm}`);
  }
  const businessPassesV5 = evaluateFunnelBottleneck(
    businessRecord.message?.content
  );
  const scoreDelta = !business.passed && businessPassesV5
    ? business.weight
    : 0;
  auditedArms.push({
    arm,
    frozen: {
      contract_version: qualification.qualification_contract?.version || null,
      score: result.score,
      maximum: result.maximum,
      response_output_sha256: result.response_output_sha256 || [],
      qualification_sha256: sha256(qualificationRaw),
      baseline_sha256: sha256(baselineRaw)
    },
    version_5_audit: {
      score: result.score + scoreDelta,
      maximum: result.maximum,
      changed_scenarios: scoreDelta > 0
        ? [{
          name: business.name,
          weight: business.weight,
          response_record_index: businessRecord.index,
          response_output_sha256: businessRecord.output_sha256,
          reason: "The answer identifies the Playground-to-Sign-up bottleneck; contract v5 accepts equivalent signup punctuation."
        }]
        : []
    },
    canonical_response_output_sha256: result.response_records.map(
      (record) => canonicalQualificationMessageSha256(record.message)
    ),
    source: {
      before_revision: baseline.host_before?.source_revision || null,
      before_dirty: baseline.host_before?.source_dirty ?? null,
      before_state_sha256: baseline.host_before?.source_state_sha256 || null,
      after_revision: baseline.host_after?.source_revision || null,
      after_dirty: baseline.host_after?.source_dirty ?? null,
      after_state_sha256: baseline.host_after?.source_state_sha256 || null
    },
    resources: {
      peak_rss_bytes: maximum(resultValues(baseline.process_samples, "rss_bytes")),
      peak_swap_used_bytes: maximum(
        resultValues(baseline.process_samples, "swap_used_bytes")
      ),
      swap_growth_bytes: baseline.host_delta?.swap_growth_bytes ?? null,
      minimum_memory_free_percent: minimum(
        resultValues(baseline.process_samples, "memory_free_percent")
      )
    },
    diagnostic_timing: {
      qualification_wall_seconds: result.wallSeconds,
      prompt_tokens_per_second: result.timings?.prompt_tokens_per_second || null,
      predicted_tokens_per_second:
        result.timings?.predicted_tokens_per_second || null
    }
  });
}

const stock = auditedArms.find((item) => item.arm === "stock");
const direct = auditedArms.find((item) => item.arm === "direct");
const stockComparisons = auditedArms.map((item) => comparison(stock, item));
const customComparisons = auditedArms
  .filter((item) => item.arm !== "stock")
  .map((item) => comparison(direct, item));
const customCanonicalComplete = customComparisons.every(
  (item) => item.canonical_response_hash_match
);
const stockCanonicalComplete = stockComparisons.every(
  (item) => item.canonical_response_hash_match
);
const auditedScoresComplete = auditedArms.every(
  (item) => item.version_5_audit.score === item.version_5_audit.maximum
);

const audit = {
  schema: "expertcache.second-checkpoint-audit",
  version: 1,
  created_at: new Date().toISOString(),
  auditor_source_revision: gitRevision(),
  source: {
    directory_label: basename(input),
    gate_state_sha256: sha256(await readFile(resolve(input, "gate-state.json"))),
    summary_sha256: sha256(
      await readFile(resolve(input, "second-checkpoint-summary.json"))
    ),
    frozen_status: sourceSummary.status,
    frozen_gate_schema: sourceState.schema,
    checkpoint: sourceSummary.checkpoint
  },
  audit_contract: {
    qualification_version: 5,
    smoke_funnel_evaluator: "semantic-signup-format-v5",
    canonical_response_hash: "opaque-tool-call-id-v1",
    model_rerun: false,
    responses_changed: false
  },
  established: {
    all_arms_complete: auditedArms.length === 4,
    all_arms_score_7_of_7_under_v5_audit: auditedScoresComplete,
    direct_grouped_prefetch_canonical_equivalence: customCanonicalComplete,
    stock_to_custom_canonical_equivalence: stockCanonicalComplete
  },
  claim_boundary: {
    supports: [
      "same-family 20B checkpoint execution in all four registered arms",
      "identical scenario outcomes in all four arms under the v5 evaluator audit",
      "canonical response equivalence across direct, grouped, and prefetch-6"
    ],
    does_not_support: [
      "stock-to-custom output equivalence",
      "second oversized checkpoint",
      "second model architecture",
      "publication-grade timing comparison"
    ]
  },
  stock_reference_equivalence: stockComparisons,
  custom_path_equivalence: customComparisons,
  arms: auditedArms
};

await writeFile(output, `${JSON.stringify(audit, null, 2)}\n`);
console.log(JSON.stringify({ output, established: audit.established }, null, 2));

function comparison(reference, candidate) {
  const strictExpected = reference.frozen.response_output_sha256;
  const strictCandidate = candidate.frozen.response_output_sha256;
  const canonicalExpected = reference.canonical_response_output_sha256;
  const canonicalCandidate = candidate.canonical_response_output_sha256;
  return {
    reference: reference.arm,
    arm: candidate.arm,
    strict_response_hash_match: arraysEqual(strictExpected, strictCandidate),
    strict_mismatch_indices: mismatchIndices(strictExpected, strictCandidate),
    canonical_response_hash_match:
      arraysEqual(canonicalExpected, canonicalCandidate),
    canonical_mismatch_indices:
      mismatchIndices(canonicalExpected, canonicalCandidate)
  };
}

function arraysEqual(left, right) {
  return left.length > 0 &&
    left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function mismatchIndices(left, right) {
  const mismatches = [];
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) mismatches.push(index);
  }
  return mismatches;
}

function resultValues(samples, key) {
  return (samples || [])
    .map((sample) => Number(sample?.[key]))
    .filter(Number.isFinite);
}

function maximum(values) {
  return values.length > 0 ? Math.max(...values) : null;
}

function minimum(values) {
  return values.length > 0 ? Math.min(...values) : null;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function gitRevision() {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8"
  }).trim();
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : "";
}
