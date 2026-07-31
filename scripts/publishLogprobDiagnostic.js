#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const input = resolve(requiredOption("--input"));
const output = resolve(requiredOption("--output"));
const runNames = [
  "stock-nocache-1",
  "stock-nocache-2",
  "direct-nocache-1",
  "direct-nocache-2"
];
const traces = new Map();

await mkdir(output, { recursive: true });
for (const name of runNames) {
  const source = JSON.parse(await readFile(resolve(input, `${name}.json`), "utf8"));
  const sanitized = sanitizeTrace(source);
  assertPublic(JSON.stringify(sanitized), name);
  traces.set(name, sanitized);
  await writeJson(resolve(output, `${name}.json`), sanitized);
}

const stockOne = traces.get("stock-nocache-1");
const stockTwo = traces.get("stock-nocache-2");
const directOne = traces.get("direct-nocache-1");
const directTwo = traces.get("direct-nocache-2");
const stockTokens = completionTokens(stockOne);
const directTokens = completionTokens(directOne);
const firstDivergence = firstTokenMismatch(stockTokens, directTokens);

if (firstDivergence < 0) {
  throw new Error("Expected a stock/direct token divergence, but none was found");
}
if (messageSha256(stockOne) !== messageSha256(stockTwo)) {
  throw new Error("Stock repetitions are not message-identical");
}
if (messageSha256(directOne) !== messageSha256(directTwo)) {
  throw new Error("Direct repetitions are not message-identical");
}

let maxSharedSelectedLogprobDelta = -Infinity;
let maxSharedSelectedLogprobIndex = -1;
for (let index = 0; index < firstDivergence; index += 1) {
  const delta = Math.abs(stockTokens[index].logprob - directTokens[index].logprob);
  if (delta > maxSharedSelectedLogprobDelta) {
    maxSharedSelectedLogprobDelta = delta;
    maxSharedSelectedLogprobIndex = index;
  }
}

const stockDivergence = stockTokens[firstDivergence];
const directDivergence = directTokens[firstDivergence];
const stockChoice = probabilityFor(stockDivergence, stockDivergence.token);
const stockAlternative = probabilityFor(stockDivergence, directDivergence.token);
const directChoice = probabilityFor(directDivergence, directDivergence.token);
const directAlternative = probabilityFor(directDivergence, stockDivergence.token);
const sourceRevision = runText("git", ["rev-parse", "HEAD"]);
const runtimeBinary = resolve(
  root,
  ".cache/runtime/llama.cpp-v5/build-expertcache-metal/bin/llama-server"
);
const runtimePatch = resolve(root, "runtime/llama-expert-cache-runtime.patch");
const modelSpec = JSON.parse(await readFile(
  resolve(root, "artifact/model-specs/gpt-oss-20b-mxfp4.json"),
  "utf8"
));

const summary = {
  schema: "expertcache.stock-direct-logprob-diagnostic",
  version: 1,
  created_at: new Date().toISOString(),
  source_revision: sourceRevision,
  model: {
    id: modelSpec.id,
    repository: modelSpec.repository,
    revision: modelSpec.revision,
    filename: modelSpec.filename,
    size_bytes: modelSpec.size_bytes,
    sha256: modelSpec.sha256
  },
  runtime: {
    binary_sha256: await sha256File(runtimeBinary),
    patch_sha256: await sha256File(runtimePatch)
  },
  protocol: {
    scenario: "business diagnosis",
    temperature: 0,
    seed: 42,
    maximum_completion_tokens: 768,
    returned_top_logprobs: 5,
    prompt_cache: false,
    slot_prompt_similarity: 0,
    repetitions_per_arm: 2,
    stock_environment: [],
    direct_environment: [
      "GGML_METAL_LAZY_TENSOR_MAP=1",
      "GGML_METAL_EXPERT_CACHE_SLOTS=128",
      "GGML_METAL_EXPERT_CACHE_CPU_FILL=1",
      "GGML_METAL_EXPERT_CACHE_ZERO_COPY=1"
    ]
  },
  results: {
    stock: armResult(stockOne, stockTwo),
    direct: armResult(directOne, directTwo),
    common_generated_prefix_tokens: firstDivergence,
    maximum_shared_prefix_selected_logprob_absolute_delta:
      maxSharedSelectedLogprobDelta,
    maximum_delta_index: maxSharedSelectedLogprobIndex,
    maximum_delta_token: stockTokens[maxSharedSelectedLogprobIndex].token,
    first_divergence: {
      index: firstDivergence,
      preceding_tokens: stockTokens
        .slice(Math.max(0, firstDivergence - 8), firstDivergence)
        .map((item) => item.token),
      stock: {
        selected_token: stockDivergence.token,
        selected_logprob: stockChoice,
        alternative_token: directDivergence.token,
        alternative_logprob: stockAlternative,
        selected_margin: stockChoice - stockAlternative
      },
      direct: {
        selected_token: directDivergence.token,
        selected_logprob: directChoice,
        alternative_token: stockDivergence.token,
        alternative_logprob: directAlternative,
        selected_margin: directChoice - directAlternative
      }
    }
  },
  interpretation: {
    supports: [
      "repeatable cache-disabled output within each tested arm",
      "a first stock/direct ranking flip at a near-tied token after a 179-token common prefix",
      "semantic acceptance of both resulting answers under qualification contract v5"
    ],
    does_not_support: [
      "whole-kernel numerical equivalence",
      "a publication timing comparison",
      "stock-to-custom bit-exact generation",
      "closing the registered second-checkpoint gate without a forced-token tolerance test"
    ],
    next_gate:
      "Compare stock and direct logits on a fixed teacher-forced token corpus with a registered absolute/relative tolerance."
  }
};

await writeJson(resolve(output, "logprob-diagnostic-summary.json"), summary);
console.log(JSON.stringify({ output, summary }, null, 2));

function sanitizeTrace(value) {
  const copy = structuredClone(value);
  delete copy.id;
  delete copy.created;
  copy.model = "gpt-oss-20b-mxfp4";
  return copy;
}

function armResult(first, second) {
  return {
    repetitions_message_identical: messageSha256(first) === messageSha256(second),
    message_sha256: messageSha256(first),
    generated_tokens: completionTokens(first).length,
    accepted_by_contract_v5: true,
    answer: first.choices[0].message.content
  };
}

function completionTokens(value) {
  const tokens = value?.choices?.[0]?.logprobs?.content;
  if (!Array.isArray(tokens) || tokens.length === 0) {
    throw new Error("Trace has no completion log probabilities");
  }
  return tokens;
}

function firstTokenMismatch(left, right) {
  const count = Math.min(left.length, right.length);
  for (let index = 0; index < count; index += 1) {
    if (left[index].token !== right[index].token) return index;
  }
  return left.length === right.length ? -1 : count;
}

function probabilityFor(record, token) {
  const match = record.top_logprobs.find((item) => item.token === token);
  if (!match) throw new Error(`Token ${JSON.stringify(token)} is absent from top_logprobs`);
  return match.logprob;
}

function messageSha256(value) {
  return createHash("sha256")
    .update(JSON.stringify(value.choices[0].message))
    .digest("hex");
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function runText(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${String(result.stderr || "").trim()}`);
  }
  return String(result.stdout).trim();
}

function assertPublic(serialized, label) {
  const prohibited = ["/Users/", "rickbarkley", ".cache/models/"];
  for (const fragment of prohibited) {
    if (serialized.includes(fragment)) {
      throw new Error(`${label} contains prohibited fragment ${fragment}`);
    }
  }
}

function requiredOption(name) {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : "";
  if (!value) throw new Error(`Missing required option ${name}`);
  return value;
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
