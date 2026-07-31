#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import {
  compareExpertTraces,
  parseExpertTrace
} from "../src/expertCache.js";

const args = process.argv.slice(2);
const referencePath = readOption(args, "--reference");
const candidatePath = readOption(args, "--candidate");
const json = args.includes("--json");

if (!referencePath || !candidatePath) {
  console.error(
    "Usage: npm run experiment:compare -- " +
    "--reference TRANSFORMERS.jsonl --candidate LLAMA_CPP.jsonl [--json]"
  );
  process.exit(2);
}

const [reference, candidate] = await Promise.all([
  readFile(referencePath, "utf8").then(parseExpertTrace),
  readFile(candidatePath, "utf8").then(parseExpertTrace)
]);
const result = compareExpertTraces(reference, candidate);

if (json) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

console.log(`Expert routing comparison · ${result.model}`);
console.log(`Tokens: ${result.tokenCount}`);
console.log(`Layer comparisons: ${result.layerComparisons}`);
console.log(`Exact top-k set agreement: ${percent(result.exactSetAgreement)}`);
console.log(`Selected-expert overlap: ${percent(result.expertOverlapRate)}`);
if (result.mismatchSamples.length > 0) {
  console.log("First mismatches:");
  for (const mismatch of result.mismatchSamples) {
    console.log(
      `  ${mismatch.traceId} token ${mismatch.tokenIndex} layer ${mismatch.layer}: ` +
      `[${mismatch.reference.join(",")}] vs [${mismatch.candidate.join(",")}]`
    );
  }
}

function readOption(values, name) {
  const index = values.indexOf(name);
  return index >= 0 ? values[index + 1] : "";
}

function percent(value) {
  return `${(Number(value || 0) * 100).toFixed(4)}%`;
}
