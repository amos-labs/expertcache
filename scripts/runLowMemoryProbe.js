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
  "output/low-memory",
  new Date().toISOString().replace(/[:.]/g, "-")
));
const memoryGiB = totalmem() / 1024 ** 3;
const probeTokens = Number(option("--probe-tokens") || 1);
const noFit = args.includes("--no-fit");
const gpuLayers = option("--gpu-layers");
if (![1, 8].includes(probeTokens)) {
  throw new Error("--probe-tokens must be 1 (decode-step gate) or 8 (visible-token gate)");
}
if (noFit && !gpuLayers) {
  throw new Error("--no-fit requires an explicit --gpu-layers value");
}

if (!args.includes("--execute")) {
  console.log(JSON.stringify({
    purpose: "Bounded first-token feasibility probe; not a throughput or 32 GiB claim",
    target: "physical 16 GiB Apple Silicon host",
    model,
    server,
    output,
    probe_tokens: probeTokens,
    automatic_fit: !noFit,
    gpu_layers: gpuLayers || "auto",
    detected_memory_gib: memoryGiB,
    usage: "npm run experiment:low-memory -- --execute --confirm-low-memory-host [--probe-tokens 1|8] [--no-fit --gpu-layers all] [--model FILE --server FILE]"
  }, null, 2));
  process.exit(0);
}
if (!args.includes("--confirm-low-memory-host")) {
  throw new Error("Low-memory execution requires --confirm-low-memory-host");
}
if ((memoryGiB < 14 || memoryGiB > 20) && !args.includes("--allow-other-memory-class")) {
  throw new Error(`Expected a physical 16 GiB-class host, detected ${memoryGiB.toFixed(1)} GiB`);
}
await requirePinnedModel(model);
await requireFile(server, "server");
if (spawnSync("pgrep", ["-x", "llama-server"]).status === 0) {
  throw new Error("A llama-server process is already running");
}
const host = captureHostSnapshot({ hostId: "apple-silicon-16g-probe" });
if (!Number.isFinite(host.memory.swap_used_bytes)) {
  throw new Error("Swap must be measurable before the protected low-memory probe");
}
if (host.memory.swap_used_bytes > 2 * 1024 ** 3) {
  throw new Error("Starting swap exceeds 2 GiB; reboot the probe host before running");
}
await mkdir(output, { recursive: true });

const commandArgs = [
  resolve(root, "scripts/runLocal120BBaseline.js"),
  "--model", model,
  "--server", server,
  "--output-dir", output,
  "--context", "4096",
  "--batch", "4",
  "--ubatch", "1",
  "--fit-target-mib", "1024",
  "--no-warmup",
  "--probe-only",
  "--probe-max-tokens", String(probeTokens),
  "--sample-every-ms", "1000",
  "--max-swap-growth-gib", "2",
  "--minimum-free-percent", "3",
  "--max-run-seconds", "1800",
  "--expert-cache-slots", "128",
  "--expert-cache-cpu-fill",
  "--expert-cache-zero-copy"
];
if (noFit) commandArgs.push("--no-fit");
if (gpuLayers) commandArgs.push("--gpu-layers", gpuLayers);
const result = spawnSync(process.execPath, commandArgs, {
  cwd: root,
  env: {
    ...process.env,
    EXPERTCACHE_PUBLICATION_RUN_ID: `16g-${probeTokens}-token-feasibility`,
    EXPERTCACHE_HOST_ID: "apple-silicon-16g-probe"
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
