#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { totalmem } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { captureHostSnapshot } from "../src/hostSnapshot.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const matrix = JSON.parse(await readFile(resolve(root, "artifact/experiment-matrix.json"), "utf8"));
const blockId = option("--block");
const block = matrix.cold_blocks_64g.find((item) => item.id === blockId);
const model = resolve(option("--model") || resolve(root, ".cache/models", "gpt-oss-120b-MXFP4.gguf"));
const server = resolve(option("--server") || resolve(root, ".cache/runtime/llama.cpp/build-expertcache-metal/bin/llama-server"));
const outputRoot = resolve(option("--output-dir") || resolve(root, "output/publication"));
const execute = args.includes("--execute");

if (!blockId || !block) {
  console.log(JSON.stringify({
    protocol: matrix.protocol,
    usage: "npm run experiment:publication -- --block 64g-block-01 [--execute --confirm-live --confirm-clean-boot]",
    blocks: matrix.cold_blocks_64g
  }, null, 2));
  process.exit(blockId ? 2 : 0);
}

const planned = block.order.map((arm, index) => ({
  run_id: `${block.id}-${String(index + 1).padStart(2, "0")}-${arm}`,
  arm,
  position: index + 1,
  host_state: index === 0 ? "cold-first-position" : "warm-ordered",
  flags: matrix.primary_arms[arm]
}));
if (!execute) {
  console.log(JSON.stringify({ block, model, server, outputRoot, planned }, null, 2));
  process.exit(0);
}
if (!args.includes("--confirm-live") || !args.includes("--confirm-clean-boot")) {
  throw new Error("Live blocks require --confirm-live and --confirm-clean-boot");
}
if (totalmem() < 60 * 1024 ** 3) {
  throw new Error(`64 GiB block cannot run on host with ${totalmem()} bytes`);
}
await requireFile(model, "model");
await requireFile(server, "server");
const modelStat = await stat(model);
if (modelStat.size !== 63_387_346_208) {
  throw new Error(`Pinned model size mismatch: ${modelStat.size}`);
}
if (spawnSync("pgrep", ["-x", "llama-server"]).status === 0) {
  throw new Error("A llama-server process is already running");
}

const blockDir = resolve(outputRoot, block.id);
await mkdir(blockDir, { recursive: false });
const before = captureHostSnapshot({ hostId: "m1-max-64-primary" });
await writeJson(resolve(blockDir, "host-before.json"), before);
const swapLimit = Number(option("--max-start-swap-gib") || 2) * 1024 ** 3;
if (before.memory.swap_used_bytes === null && !args.includes("--allow-unknown-start-swap")) {
  throw new Error(
    "Starting swap could not be measured; rerun with host telemetry access. " +
    "Use --allow-unknown-start-swap only for a non-publication diagnostic"
  );
}
if ((before.memory.swap_used_bytes || 0) > swapLimit && !args.includes("--allow-start-swap")) {
  throw new Error(
    `Starting swap ${before.memory.swap_used_bytes} exceeds ${swapLimit}; ` +
    "reboot or explicitly pass --allow-start-swap and record the deviation"
  );
}

const state = {
  schema: "expertcache.publication-block",
  version: 1,
  block_id: block.id,
  started_at: new Date().toISOString(),
  protocol: matrix.protocol,
  source_revision: before.source_revision,
  model,
  server,
  planned,
  runs: []
};
await writeJson(resolve(blockDir, "block-state.json"), state);

for (const run of planned) {
  const runDir = resolve(blockDir, run.run_id);
  const commandArgs = [
    resolve(root, "scripts/runLocal120BBaseline.js"),
    "--model", model,
    "--server", server,
    "--output-dir", runDir,
    ...matrix.fixed_options,
    ...run.flags
  ];
  const only = option("--only");
  if (only) commandArgs.push("--only", only);
  const record = {
    ...run,
    started_at: new Date().toISOString(),
    command: [process.execPath, ...commandArgs],
    status: "running"
  };
  state.runs.push(record);
  await writeJson(resolve(blockDir, "block-state.json"), state);
  const result = spawnSync(process.execPath, commandArgs, {
    cwd: root,
    env: {
      ...process.env,
      EXPERTCACHE_PUBLICATION_RUN_ID: run.run_id,
      EXPERTCACHE_HOST_ID: "m1-max-64-primary"
    },
    stdio: "inherit"
  });
  record.completed_at = new Date().toISOString();
  record.exit_status = result.status;
  record.signal = result.signal;
  record.status = result.status === 0 ? "complete" : "failed";
  await writeJson(resolve(blockDir, "block-state.json"), state);
  if (result.status !== 0 && !args.includes("--continue-on-failure")) break;
}
state.completed_at = new Date().toISOString();
state.status = state.runs.length === planned.length &&
  state.runs.every((run) => run.status === "complete") ? "complete" : "incomplete";
await writeJson(resolve(blockDir, "block-state.json"), state);
console.log(JSON.stringify({ block: block.id, output: blockDir, status: state.status }, null, 2));
if (state.status !== "complete") process.exitCode = 1;

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : "";
}

async function requireFile(path, label) {
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("not a file");
  } catch {
    throw new Error(`Required ${label} is missing: ${path}`);
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
