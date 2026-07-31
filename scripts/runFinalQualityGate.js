#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
import { totalmem } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { captureHostSnapshot } from "../src/hostSnapshot.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const model = resolve(option("--model") || resolve(
  root,
  ".cache/models/gpt-oss-120b-MXFP4.gguf"
));
const server = resolve(option("--server") || resolve(
  root,
  ".cache/runtime/llama.cpp/build-expertcache-metal/bin/llama-server"
));
const output = resolve(option("--output-dir") || resolve(
  root,
  "output/final-quality",
  new Date().toISOString().replace(/[:.]/g, "-")
));
const commandArgs = [
  resolve(root, "scripts/runLocal120BBaseline.js"),
  "--model", model,
  "--server", server,
  "--output-dir", output,
  "--context", "8192",
  "--batch", "64",
  "--ubatch", "64",
  "--fit-target-mib", "1024",
  "--no-warmup",
  "--skip-probe",
  "--suite", "qualification",
  "--max-tokens", "1536",
  "--request-timeout-seconds", "7200",
  "--sample-every-ms", "2000",
  "--max-swap-growth-gib", "8",
  "--minimum-free-percent", "2",
  "--max-run-seconds", "21600",
  "--expert-cache-slots", "128",
  "--expert-cache-cpu-fill",
  "--expert-cache-zero-copy",
  "--expert-cache-grouped",
  "--expert-cache-prefetch", "6"
];

if (!args.includes("--execute")) {
  console.log(JSON.stringify({
    purpose: "Final-runtime seven-scenario, 16-point qualification gate",
    performance_grade: "quality-only; host cache and power state are not a throughput estimate",
    model,
    server,
    output,
    command: [process.execPath, ...commandArgs],
    usage: "npm run experiment:quality -- --execute --confirm-final-runtime"
  }, null, 2));
  process.exit(0);
}
if (!args.includes("--confirm-final-runtime")) {
  throw new Error("Quality execution requires --confirm-final-runtime");
}
if (totalmem() < 60 * 1024 ** 3) {
  throw new Error("The final quality gate is registered for the 64 GiB primary host");
}
await requirePinnedModel(model);
await requireFile(server, "server");
if (spawnSync("pgrep", ["-x", "llama-server"]).status === 0) {
  throw new Error("A llama-server process is already running");
}
const host = captureHostSnapshot({ hostId: "m1-max-64-primary" });
if (!Number.isFinite(host.memory.swap_used_bytes)) {
  throw new Error("Swap must be measurable before the final quality gate");
}
if (host.memory.swap_used_bytes > 2 * 1024 ** 3) {
  throw new Error("Starting swap exceeds 2 GiB; reboot before the final quality gate");
}
await mkdir(output, { recursive: true });
const result = spawnSync(process.execPath, commandArgs, {
  cwd: root,
  env: {
    ...process.env,
    EXPERTCACHE_PUBLICATION_RUN_ID: "64g-final-quality-prefetch-6",
    EXPERTCACHE_HOST_ID: "m1-max-64-primary"
  },
  stdio: "inherit"
});
if (result.status !== 0) process.exitCode = result.status || 1;

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : "";
}

async function requirePinnedModel(path) {
  await requireFile(path, "model");
  const manifest = JSON.parse(await readFile(
    resolve(root, "runtime/runtime-manifest.json"),
    "utf8"
  ));
  const info = await stat(path);
  if (info.size !== manifest.model_artifact.size_bytes) {
    throw new Error(`Pinned model size mismatch: ${info.size}`);
  }
}

async function requireFile(path, label) {
  try {
    if (!(await stat(path)).isFile()) throw new Error("not a file");
  } catch {
    throw new Error(`Required ${label} is missing: ${path}`);
  }
}
