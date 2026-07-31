#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const specPath = resolve(
  option("--model-spec") ||
  resolve(root, "artifact/model-specs/gpt-oss-20b-mxfp4.json")
);
const spec = JSON.parse(await readFile(specPath, "utf8"));
const model = resolve(
  option("--model") || resolve(root, ".cache/models", spec.filename)
);
const server = resolve(
  option("--server") ||
  resolve(root, ".cache/runtime/llama.cpp/build-expertcache-metal/bin/llama-server")
);
const output = resolve(
  option("--output-dir") ||
  resolve(root, "output/second-checkpoint", new Date().toISOString().replace(/[:.]/g, "-"))
);
const arms = [
  { id: "stock", flags: [] },
  {
    id: "direct",
    flags: [
      "--expert-cache-slots", "128",
      "--expert-cache-cpu-fill",
      "--expert-cache-zero-copy"
    ]
  },
  {
    id: "grouped",
    flags: [
      "--expert-cache-slots", "128",
      "--expert-cache-cpu-fill",
      "--expert-cache-zero-copy",
      "--expert-cache-grouped"
    ]
  },
  {
    id: "prefetch-6",
    flags: [
      "--expert-cache-slots", "128",
      "--expert-cache-cpu-fill",
      "--expert-cache-zero-copy",
      "--expert-cache-grouped",
      "--expert-cache-prefetch", "6"
    ]
  }
];

if (!args.includes("--execute")) {
  console.log(JSON.stringify({
    purpose: "Same-family sparse-checkpoint portability and output-equivalence gate",
    claim_boundary: spec.claim_boundary,
    performance_grade: "correctness-only; arm timings are diagnostic, not publication estimates",
    model_spec: specPath,
    model,
    server,
    output,
    arms: arms.map((arm) => arm.id),
    download: [
      "hf", "download", spec.repository, spec.filename,
      "--revision", spec.revision,
      "--local-dir", resolve(root, ".cache/models")
    ],
    usage: "npm run experiment:second-checkpoint -- --execute --confirm-second-checkpoint"
  }, null, 2));
  process.exit(0);
}
if (!args.includes("--confirm-second-checkpoint")) {
  throw new Error("Execution requires --confirm-second-checkpoint");
}
validateSpec(spec);
await requireFile(model, "model");
await requireFile(server, "server");
const modelStat = await stat(model);
if (modelStat.size !== spec.size_bytes) {
  throw new Error(`Pinned model size mismatch: expected ${spec.size_bytes}, got ${modelStat.size}`);
}
if (spawnSync("pgrep", ["-x", "llama-server"]).status === 0) {
  throw new Error("A llama-server process is already running");
}

console.log(`Verifying ${spec.filename} SHA-256 before the correctness-only gate...`);
const modelSha256 = await sha256File(model);
if (modelSha256 !== spec.sha256) {
  throw new Error(`Pinned model SHA-256 mismatch: ${modelSha256}`);
}

await mkdir(output, { recursive: false });
const state = {
  schema: "expertcache.second-checkpoint-gate",
  version: 1,
  purpose: "same-family sparse-checkpoint portability",
  claim_boundary: spec.claim_boundary,
  started_at: new Date().toISOString(),
  model_artifact: spec,
  verified_model_sha256: modelSha256,
  runtime: server,
  runs: []
};
await writeJson(resolve(output, "gate-state.json"), state);

for (const arm of arms) {
  const runDir = resolve(output, arm.id);
  const commandArgs = [
    resolve(root, "scripts/runLocal120BBaseline.js"),
    "--model", model,
    "--model-spec", specPath,
    "--model-alias", "gpt-oss-20b",
    "--server", server,
    "--output-dir", runDir,
    "--context", "8192",
    "--batch", "64",
    "--ubatch", "64",
    "--fit-target-mib", "1024",
    "--no-warmup",
    "--probe-max-tokens", "16",
    "--suite", "smoke",
    "--max-tokens", "768",
    "--request-timeout-seconds", "1200",
    "--sample-every-ms", "2000",
    "--max-swap-growth-gib", "2",
    "--minimum-free-percent", "5",
    "--max-run-seconds", "5400",
    ...arm.flags
  ];
  const record = {
    arm: arm.id,
    started_at: new Date().toISOString(),
    command: [process.execPath, ...commandArgs],
    status: "running"
  };
  state.runs.push(record);
  await writeJson(resolve(output, "gate-state.json"), state);
  const result = spawnSync(process.execPath, commandArgs, {
    cwd: root,
    env: {
      ...process.env,
      EXPERTCACHE_PUBLICATION_RUN_ID: `second-checkpoint-${arm.id}`,
      EXPERTCACHE_HOST_ID: "m1-max-64-primary"
    },
    stdio: "inherit"
  });
  record.completed_at = new Date().toISOString();
  record.exit_status = result.status;
  record.signal = result.signal;
  record.status = result.status === 0 ? "complete" : "failed";
  record.result = await readRunResult(runDir);
  await writeJson(resolve(output, "gate-state.json"), state);
  if (result.status !== 0 && !args.includes("--continue-on-failure")) break;
}

const reference = state.runs.find((run) => run.arm === "stock")?.result;
const equivalence = state.runs.map((run) => {
  const candidate = run.result?.response_output_sha256 || [];
  const expected = reference?.response_output_sha256 || [];
  return {
    arm: run.arm,
    response_count: candidate.length,
    exact_output_hash_match: run.status === "complete" &&
      candidate.length > 0 && arraysEqual(candidate, expected),
    mismatch_indices: mismatchIndices(expected, candidate)
  };
});
const complete = state.runs.length === arms.length &&
  state.runs.every((run) => run.status === "complete") &&
  equivalence.every((item) => item.exact_output_hash_match);
const summary = {
  schema: "expertcache.second-checkpoint-summary",
  version: 1,
  completed_at: new Date().toISOString(),
  status: complete ? "complete" : "incomplete",
  checkpoint: {
    id: spec.id,
    repository: spec.repository,
    revision: spec.revision,
    filename: spec.filename,
    size_bytes: spec.size_bytes,
    sha256: modelSha256
  },
  scope: {
    proves: "same-family GPT-OSS MXFP4 checkpoint portability across stock, direct, grouped, and prefetch paths",
    does_not_prove: ["second oversized checkpoint", "second model architecture"]
  },
  suite: "public deterministic smoke suite",
  equivalence,
  scores: state.runs.map((run) => ({
    arm: run.arm,
    score: run.result?.score ?? null,
    maximum: run.result?.maximum ?? null
  }))
};
state.completed_at = summary.completed_at;
state.status = summary.status;
await writeJson(resolve(output, "gate-state.json"), state);
await writeJson(resolve(output, "second-checkpoint-summary.json"), summary);
console.log(JSON.stringify({ output, summary }, null, 2));
if (!complete) process.exitCode = 1;

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : "";
}

function validateSpec(value) {
  if (value.schema !== "expertcache.model-artifact" || value.version !== 1) {
    throw new Error("Unsupported model artifact spec");
  }
  if (!/^[0-9a-f]{40}$/.test(value.revision || "")) {
    throw new Error("Model artifact revision must be a 40-character commit digest");
  }
  if (!/^[0-9a-f]{64}$/.test(value.sha256 || "")) {
    throw new Error("Model artifact SHA-256 is invalid");
  }
  if (!Number.isInteger(value.size_bytes) || value.size_bytes <= 0) {
    throw new Error("Model artifact size is invalid");
  }
}

async function requireFile(path, label) {
  try {
    if (!(await stat(path)).isFile()) throw new Error("not a file");
  } catch {
    throw new Error(`Required ${label} is missing: ${path}`);
  }
}

async function readRunResult(runDir) {
  try {
    const report = JSON.parse(await readFile(resolve(runDir, "qualification.json"), "utf8"));
    const result = report.results?.[0];
    return result ? {
      score: result.score,
      maximum: result.maximum,
      response_output_sha256: result.response_output_sha256 || [],
      scenarios: (result.scenarios || []).map((scenario) => ({
        name: scenario.name,
        passed: scenario.passed,
        weight: scenario.weight
      }))
    } : null;
  } catch {
    return null;
  }
}

function sha256File(path) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", rejectHash);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function mismatchIndices(left, right) {
  const mismatches = [];
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) mismatches.push(index);
  }
  return mismatches;
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
