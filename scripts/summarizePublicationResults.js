#!/usr/bin/env node
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { summarizePublicationRuns } from "../src/publicationResults.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const input = resolve(option("--input") || resolve(root, "output/publication"));
const output = option("--output") ? resolve(option("--output")) : null;
const runs = [];

for (const blockName of await directories(input)) {
  const blockDir = resolve(input, blockName);
  const state = await readJson(resolve(blockDir, "block-state.json"));
  if (!state) continue;
  for (const run of state.runs || []) {
    const runDir = resolve(blockDir, run.run_id);
    runs.push({
      ...run,
      block_id: state.block_id,
      baseline: await readJson(resolve(runDir, "baseline.json")),
      qualification: await readJson(resolve(runDir, "qualification.json"))
    });
  }
}

const summary = summarizePublicationRuns(runs);
const serialized = `${JSON.stringify(summary, null, 2)}\n`;
if (output) await writeFile(output, serialized);
console.log(serialized.trimEnd());
if (runs.length === 0) process.exitCode = 2;

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : "";
}

async function directories(path) {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

async function readJson(path) {
  try {
    if (!(await stat(path)).isFile()) return null;
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}
