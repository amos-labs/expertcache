#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { captureHostSnapshot, parseSwapUsedBytes } from "../src/hostSnapshot.js";
import { parseLlamaTimingLog } from "../src/llamaTimings.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const model = resolve(requiredOption(args, "--model"));
const server = resolve(requiredOption(args, "--server"));
const modelSpecPath = readOption(args, "--model-spec")
  ? resolve(readOption(args, "--model-spec"))
  : null;
const outputDir = resolve(readOption(args, "--output-dir") ||
  "output/live-baseline");
const context = boundedInteger(readOption(args, "--context"), 4_096, 131_072, 8_192);
const batch = boundedInteger(readOption(args, "--batch"), 1, 2_048, 2_048);
const ubatch = boundedInteger(readOption(args, "--ubatch"), 1, batch, Math.min(512, batch));
const fitTarget = boundedInteger(
  readOption(args, "--fit-target-mib"),
  1_024,
  32_768,
  1_024
);
const gpuLayers = readOption(args, "--gpu-layers");
const cpuMoe = args.includes("--cpu-moe");
const noFit = args.includes("--no-fit");
const noWarmup = args.includes("--no-warmup");
const skipProbe = args.includes("--skip-probe");
const probeOnly = args.includes("--probe-only");
if (skipProbe && probeOnly) {
  throw new Error("--probe-only cannot be combined with --skip-probe");
}
const probeMaxTokens = boundedInteger(
  readOption(args, "--probe-max-tokens"),
  1,
  128,
  32
);
const serverVerbose = args.includes("--server-verbose");
const skipChatParsing = args.includes("--skip-chat-parsing");
const expertCacheSlots = boundedInteger(
  readOption(args, "--expert-cache-slots") ||
    process.env.GGML_METAL_EXPERT_CACHE_SLOTS,
  0,
  128,
  0
);
const expertCacheCpuFill =
  args.includes("--expert-cache-cpu-fill") ||
  process.env.GGML_METAL_EXPERT_CACHE_CPU_FILL !== undefined;
const expertCacheTrace =
  args.includes("--expert-cache-trace") ||
  process.env.GGML_METAL_EXPERT_CACHE_TRACE !== undefined;
const expertCacheZeroCopy =
  args.includes("--expert-cache-zero-copy") ||
  process.env.GGML_METAL_EXPERT_CACHE_ZERO_COPY !== undefined;
const expertCacheGrouped =
  args.includes("--expert-cache-grouped") ||
  process.env.GGML_METAL_EXPERT_CACHE_GROUPED !== undefined;
if (expertCacheGrouped && !expertCacheZeroCopy) {
  throw new Error(
    "--expert-cache-grouped extends the zero-copy dispatch path and requires " +
    "--expert-cache-zero-copy"
  );
}
const expertCachePrefetch = boundedInteger(
  readOption(args, "--expert-cache-prefetch") ||
    process.env.GGML_METAL_EXPERT_CACHE_PREFETCH,
  0,
  16,
  0
);
if (expertCachePrefetch > 0 && !expertCacheZeroCopy) {
  throw new Error(
    "--expert-cache-prefetch extends the zero-copy dispatch path and requires " +
    "--expert-cache-zero-copy"
  );
}
const expertCacheHotCeiling =
  args.includes("--expert-cache-hot-ceiling") ||
  process.env.GGML_METAL_EXPERT_CACHE_HOT_CEILING !== undefined;
if (expertCacheHotCeiling && !expertCacheZeroCopy) {
  throw new Error(
    "--expert-cache-hot-ceiling is a synthetic zero-copy ceiling and requires " +
    "--expert-cache-zero-copy"
  );
}
const port = boundedInteger(readOption(args, "--port"), 1_024, 65_535, 11_436);
const suite = readOption(args, "--suite") || "qualification";
const only = readOption(args, "--only");
const requestTimeoutSeconds = boundedInteger(
  readOption(args, "--request-timeout-seconds"),
  60,
  7_200,
  600
);
const maxTokens = boundedInteger(
  readOption(args, "--max-tokens"),
  32,
  4_096,
  768
);
const reasoningEffort = normalizeReasoningEffort(
  readOption(args, "--reasoning-effort")
);
const seed = boundedInteger(
  readOption(args, "--seed"),
  0,
  2_147_483_647,
  42
);
const modelAlias = readOption(args, "--model-alias") || "gpt-oss-120b";
const sampleEveryMs = boundedInteger(
  readOption(args, "--sample-every-ms"),
  500,
  60_000,
  2_000
);
const maxSwapGrowthGiB = optionalNumber(
  readOption(args, "--max-swap-growth-gib"),
  0,
  64
);
const minimumFreePercent = optionalNumber(
  readOption(args, "--minimum-free-percent"),
  0,
  100
);
const maxRunSeconds = optionalNumber(
  readOption(args, "--max-run-seconds"),
  1,
  86_400
);
const baseUrl = `http://127.0.0.1:${port}`;
const manifest = JSON.parse(await readFile(
  resolve(root, "runtime/runtime-manifest.json"),
  "utf8"
));
const modelArtifact = modelSpecPath
  ? await readModelArtifact(modelSpecPath)
  : {
      schema: "expertcache.primary-model-artifact",
      version: 1,
      id: "gpt-oss-120b-mxfp4",
      sha256: manifest.model_artifact.x_linked_etag,
      ...manifest.model_artifact
    };
const modelStat = await stat(model);
if (modelStat.size !== modelArtifact.size_bytes) {
  throw new Error(
    `Pinned model size mismatch: expected ${modelArtifact.size_bytes}, ` +
    `got ${modelStat.size}`
  );
}
const serverStat = await stat(server);
if (!serverStat.isFile()) {
  throw new Error(`Runtime is not a file: ${server}`);
}
const runtimeBinarySha256 = await sha256File(server);
const runtimeBundle = await hashRuntimeBundle(server);

await mkdir(outputDir, { recursive: true });
const serverLogPath = resolve(outputDir, "llama-server.log");
const qualificationPath = resolve(outputDir, "qualification.json");
const reportPath = resolve(outputDir, "baseline.json");
const publicationRunId = process.env.EXPERTCACHE_PUBLICATION_RUN_ID || null;
const hostId = process.env.EXPERTCACHE_HOST_ID || "unregistered";
const before = captureHostSnapshot({ hostId });
if (
  maxSwapGrowthGiB !== null &&
  !Number.isFinite(before.memory.swap_used_bytes)
) {
  throw new Error(
    "Swap telemetry is unavailable; refusing to run with a swap-growth watchdog"
  );
}
const startedAt = new Date().toISOString();
const started = performance.now();
const log = createWriteStream(serverLogPath, { flags: "w" });
const serverArgs = [
  "--model", model,
  "--host", "127.0.0.1",
  "--port", String(port),
  "--ctx-size", String(context),
  "--batch-size", String(batch),
  "--ubatch-size", String(ubatch),
  "--fit-target", String(fitTarget),
  "--parallel", "1",
  "--perf",
  "--metrics",
  "--jinja"
];
if (noFit) serverArgs.push("--fit", "off");
if (gpuLayers) serverArgs.push("--gpu-layers", gpuLayers);
if (cpuMoe) serverArgs.push("--cpu-moe");
if (noWarmup) serverArgs.push("--no-warmup");
if (serverVerbose) serverArgs.push("--verbose");
if (skipChatParsing) serverArgs.push("--skip-chat-parsing");
const childEnv = { ...process.env };
if (expertCacheSlots > 0) {
  childEnv.GGML_METAL_LAZY_TENSOR_MAP = "1";
  childEnv.GGML_METAL_EXPERT_CACHE_SLOTS = String(expertCacheSlots);
  if (expertCacheCpuFill) {
    childEnv.GGML_METAL_EXPERT_CACHE_CPU_FILL = "1";
  }
  if (expertCacheTrace) {
    childEnv.GGML_METAL_EXPERT_CACHE_TRACE = "1";
  }
  if (expertCacheZeroCopy) {
    childEnv.GGML_METAL_EXPERT_CACHE_ZERO_COPY = "1";
  }
  if (expertCacheGrouped) {
    childEnv.GGML_METAL_EXPERT_CACHE_GROUPED = "1";
  }
  if (expertCachePrefetch > 0) {
    childEnv.GGML_METAL_EXPERT_CACHE_PREFETCH = String(expertCachePrefetch);
  }
  if (expertCacheHotCeiling) {
    childEnv.GGML_METAL_EXPERT_CACHE_HOT_CEILING = "1";
  }
}
const child = spawn(server, serverArgs, {
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: childEnv
});
child.stdout.pipe(log);
child.stderr.pipe(log);
let activeQualificationRunner = null;
let interruptedSignal = null;
const signalHandlers = new Map(
  ["SIGINT", "SIGTERM"].map((signal) => {
    const handler = () => {
      interruptedSignal ||= signal;
      stopProcessGroup(child.pid);
      activeQualificationRunner?.kill("SIGTERM");
    };
    process.once(signal, handler);
    return [signal, handler];
  })
);

const samples = [];
const initialSwapUsedBytes = before.memory.swap_used_bytes;
const maxSwapGrowthBytes = maxSwapGrowthGiB === null
  ? null
  : maxSwapGrowthGiB * 1024 ** 3;
let watchdogFailure = null;
const sampler = setInterval(() => {
  const sample = processSnapshot(child.pid, {
    includeMemoryPressure: minimumFreePercent !== null
  });
  samples.push(sample);
  if (
    watchdogFailure === null &&
    maxSwapGrowthBytes !== null &&
    Number.isFinite(initialSwapUsedBytes) &&
    Number.isFinite(sample.swap_used_bytes) &&
    sample.swap_used_bytes - initialSwapUsedBytes > maxSwapGrowthBytes
  ) {
    watchdogFailure = `watchdog: swap growth exceeded ${maxSwapGrowthGiB} GiB`;
  }
  if (
    watchdogFailure === null &&
    minimumFreePercent !== null &&
    Number.isFinite(sample.memory_free_percent) &&
    sample.memory_free_percent < minimumFreePercent
  ) {
    watchdogFailure =
      `watchdog: memory free percentage fell below ${minimumFreePercent}%`;
  }
  if (
    watchdogFailure === null &&
    maxRunSeconds !== null &&
    performance.now() - started > maxRunSeconds * 1_000
  ) {
    watchdogFailure = `watchdog: run exceeded ${maxRunSeconds} seconds`;
  }
  if (watchdogFailure) stopProcessGroup(child.pid);
}, sampleEveryMs);
let exit = null;
child.once("exit", (code, signal) => {
  exit = { code, signal };
});

let readinessSeconds = null;
let servedModel = modelAlias;
let probe = null;
let qualification = null;
let serverMetrics = null;
let failure = null;
try {
  await waitForServer(baseUrl, () => exit);
  readinessSeconds = (performance.now() - started) / 1_000;
  servedModel = await resolveServedModel(baseUrl, modelAlias);
  if (!skipProbe) {
    probe = await streamingProbe(baseUrl, servedModel, probeMaxTokens);
    if (
      probe.completion_tokens === 0 ||
      (!probeOnly && !probe.first_token_ms)
    ) {
      throw new Error("Streaming probe completed without a measurable completion");
    }
  }
  if (!probeOnly) {
    qualification = await runQualification({
      baseUrl,
      context,
      modelAlias: servedModel,
      output: qualificationPath,
      suite,
      only,
      requestTimeoutSeconds,
      maxTokens,
      reasoningEffort,
      seed
    });
  }
  serverMetrics = await readEndpointText(`${baseUrl}/metrics`);
} catch (error) {
  failure = watchdogFailure || String(error?.stack || error);
} finally {
  serverMetrics ||= await readEndpointText(`${baseUrl}/metrics`);
  clearInterval(sampler);
  samples.push(processSnapshot(child.pid, {
    includeMemoryPressure: minimumFreePercent !== null
  }));
  stopProcessGroup(child.pid);
  await waitForExit(child, 15_000);
  for (const [signal, handler] of signalHandlers) {
    process.off(signal, handler);
  }
  await closeWritable(log);
}

const after = captureHostSnapshot({ hostId });
const llamaTimings = parseLlamaTimingLog(await readFile(serverLogPath, "utf8"));
const configuration = {
  runtime_revision: manifest.runtime.revision,
  runtime_patch_sha256: manifest.runtime_patch.sha256,
  runtime_binary_sha256: runtimeBinarySha256,
  runtime_binary_size_bytes: serverStat.size,
  runtime_bundle_sha256: runtimeBundle.sha256,
  model_artifact_id: modelArtifact.id,
  model_repository: modelArtifact.repository,
  model_revision: modelArtifact.revision,
  model_filename: modelArtifact.filename,
  model_expected_sha256: modelArtifact.sha256 || null,
  model_size_bytes: modelStat.size,
  context_length: context,
  batch_size: batch,
  micro_batch_size: ubatch,
  fit_target_mib: fitTarget,
  gpu_layers: gpuLayers || "auto",
  cpu_moe: cpuMoe,
  automatic_fit: !noFit,
  warmup: !noWarmup,
  expert_cache_slots: expertCacheSlots,
  expert_cache_cpu_fill: expertCacheSlots > 0 && expertCacheCpuFill,
  expert_cache_trace: expertCacheSlots > 0 && expertCacheTrace,
  expert_cache_zero_copy: expertCacheSlots > 0 && expertCacheZeroCopy,
  expert_cache_grouped: expertCacheSlots > 0 && expertCacheGrouped,
  expert_cache_prefetch_threads: expertCacheSlots > 0 ? expertCachePrefetch : 0,
  expert_cache_hot_ceiling: expertCacheSlots > 0 && expertCacheHotCeiling,
  probe_only: probeOnly,
  probe_max_tokens: probeMaxTokens,
  max_swap_growth_gib: maxSwapGrowthGiB,
  minimum_free_percent: minimumFreePercent,
  max_run_seconds: maxRunSeconds,
  suite,
  only_scenarios: only || null,
  request_timeout_seconds: requestTimeoutSeconds,
  max_tokens: maxTokens,
  reasoning_effort: reasoningEffort,
  seed
};
const artifactHashes = {};
for (const [name, path] of Object.entries({
  server_log: serverLogPath,
  qualification: qualificationPath
})) {
  try {
    artifactHashes[name] = await sha256File(path);
  } catch {
    artifactHashes[name] = null;
  }
}
const report = {
  schema: "amos.local-120b-live-baseline",
  version: 3,
  publication_run_id: publicationRunId,
  started_at: startedAt,
  completed_at: new Date().toISOString(),
  configuration_sha256: sha256Json(configuration),
  configuration,
  model,
  model_alias: modelAlias,
  served_model: servedModel,
  runtime: server,
  runtime_revision: manifest.runtime.revision,
  runtime_binary_sha256: runtimeBinarySha256,
  runtime_binary_size_bytes: serverStat.size,
  runtime_bundle_sha256: runtimeBundle.sha256,
  runtime_artifacts: runtimeBundle.artifacts,
  model_artifact_id: modelArtifact.id,
  model_repository: modelArtifact.repository,
  model_revision: modelArtifact.revision,
  model_filename: modelArtifact.filename,
  model_expected_sha256: modelArtifact.sha256 || null,
  model_size_bytes: modelStat.size,
  context_length: context,
  batch_size: batch,
  micro_batch_size: ubatch,
  fit_target_mib: fitTarget,
  gpu_layers: gpuLayers || "auto",
  cpu_moe: cpuMoe,
  automatic_fit: !noFit,
  warmup: !noWarmup,
  server_verbose: serverVerbose,
  skip_chat_parsing: skipChatParsing,
  streaming_probe_enabled: !skipProbe,
  probe_only: probeOnly,
  probe_max_tokens: probeMaxTokens,
  expert_cache_slots: expertCacheSlots,
  expert_cache_cpu_fill: expertCacheSlots > 0 && expertCacheCpuFill,
  expert_cache_trace: expertCacheSlots > 0 && expertCacheTrace,
  expert_cache_zero_copy: expertCacheSlots > 0 && expertCacheZeroCopy,
  expert_cache_grouped: expertCacheSlots > 0 && expertCacheGrouped,
  expert_cache_prefetch_threads:
    expertCacheSlots > 0 ? expertCachePrefetch : 0,
  expert_cache_hot_ceiling: expertCacheSlots > 0 && expertCacheHotCeiling,
  suite,
  only_scenarios: only || null,
  request_timeout_seconds: requestTimeoutSeconds,
  max_tokens: maxTokens,
  reasoning_effort: reasoningEffort,
  seed,
  readiness_seconds: readinessSeconds,
  streaming_probe: probe,
  llama_timings: llamaTimings,
  qualification,
  server_metrics: serverMetrics,
  server_exit: exit,
  host_before: before,
  host_after: after,
  host_delta: hostDelta(before, after),
  telemetry_coverage: {
    process_rss: true,
    process_virtual_memory: true,
    process_cpu_percent: true,
    system_swap: true,
    system_vm_counters: true,
    memory_pressure: true,
    thermal_state: true,
    package_energy_joules: null
  },
  process_samples: samples,
  watchdog: {
    max_swap_growth_gib: maxSwapGrowthGiB,
    minimum_free_percent: minimumFreePercent,
    max_run_seconds: maxRunSeconds,
    triggered: watchdogFailure
  },
  failure,
  artifacts: {
    server_log: serverLogPath,
    qualification: qualificationPath,
    sha256: artifactHashes
  }
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({
  report: reportPath,
  readiness_seconds: readinessSeconds,
  streaming_probe: probe,
  llama_timings: llamaTimings,
  qualification,
  peak_rss_bytes: Math.max(0, ...samples.map((sample) => sample.rss_bytes || 0)),
  peak_swap_used_bytes: Math.max(
    0,
    ...samples.map((sample) => sample.swap_used_bytes || 0)
  ),
  failure
}, null, 2));
if (interruptedSignal) {
  process.exitCode = interruptedSignal === "SIGINT" ? 130 : 143;
} else if (failure || (!probeOnly && qualification?.status !== 0)) {
  process.exitCode = 1;
}

async function waitForServer(url, exited) {
  const deadline = Date.now() + 45 * 60_000;
  while (Date.now() < deadline) {
    const stopped = exited();
    if (stopped) {
      throw new Error(`llama-server exited before readiness: ${JSON.stringify(stopped)}`);
    }
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch {
      // The model is still loading.
    }
    await delay(2_000);
  }
  throw new Error("llama-server did not become ready within 45 minutes");
}

async function resolveServedModel(url, fallback) {
  try {
    const response = await fetch(`${url}/v1/models`);
    const payload = await response.json();
    return payload?.data?.[0]?.id || fallback;
  } catch {
    return fallback;
  }
}

async function readEndpointText(url) {
  try {
    const response = await fetch(url);
    return response.ok ? await response.text() : null;
  } catch {
    return null;
  }
}

async function streamingProbe(url, model, completionLimit) {
  const started = performance.now();
  const response = await fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{
        role: "user",
        content: "Reply with exactly: ExpertCache baseline ready"
      }],
      max_tokens: completionLimit,
      temperature: 0,
      stream: true,
      stream_options: { include_usage: true }
    })
  });
  if (!response.ok || !response.body) {
    throw new Error(`Streaming probe returned HTTP ${response.status}: ${await response.text()}`);
  }
  let firstTokenMs = null;
  let firstCompletionEventMs = null;
  let completionTokens = 0;
  let text = "";
  let contentCharacters = 0;
  let reasoningCharacters = 0;
  let firstTokenChannel = null;
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
      const payload = JSON.parse(line.slice(6));
      const delta = payload?.choices?.[0]?.delta || {};
      if (payload?.choices?.length > 0 && firstCompletionEventMs === null) {
        firstCompletionEventMs = performance.now() - started;
      }
      const contentText = delta.content || "";
      const reasoningText = delta.reasoning_content || delta.reasoning ||
        delta.analysis || "";
      const tokenText = contentText || reasoningText;
      if (tokenText && firstTokenMs === null) {
        firstTokenMs = performance.now() - started;
        firstTokenChannel = contentText ? "content" : "reasoning";
      }
      text += contentText;
      contentCharacters += contentText.length;
      reasoningCharacters += reasoningText.length;
      completionTokens = payload?.usage?.completion_tokens || completionTokens;
    }
  }
  const elapsedMs = performance.now() - started;
  return {
    first_token_ms: firstTokenMs,
    first_token_channel: firstTokenChannel,
    first_completion_event_ms: firstCompletionEventMs,
    elapsed_ms: elapsedMs,
    completion_tokens: completionTokens,
    tokens_per_second: completionTokens > 0 ? completionTokens / (elapsedMs / 1_000) : null,
    content_characters: contentCharacters,
    reasoning_characters: reasoningCharacters,
    text: text.trim()
  };
}

function runQualification({
  baseUrl: url,
  context: numCtx,
  modelAlias: model,
  output,
  suite: selectedSuite,
  only: selectedScenarios,
  requestTimeoutSeconds: timeoutSeconds,
  maxTokens: completionTokens,
  reasoningEffort: selectedReasoningEffort,
  seed: selectedSeed
}) {
  return new Promise((resolveRun) => {
    const qualificationArgs = [
      resolve(root, "scripts/benchmarkLocalModels.js"),
      model,
      "--protocol", "openai",
      "--url", url,
      "--suite", selectedSuite,
      "--context", String(numCtx),
      "--request-timeout-seconds", String(timeoutSeconds),
      "--max-tokens", String(completionTokens),
      "--seed", String(selectedSeed),
      "--output", output
    ];
    if (selectedScenarios) qualificationArgs.push("--only", selectedScenarios);
    if (selectedReasoningEffort) {
      qualificationArgs.push("--reasoning-effort", selectedReasoningEffort);
    }
    const runner = spawn(process.execPath, qualificationArgs, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    activeQualificationRunner = runner;
    let stdout = "";
    let stderr = "";
    runner.stdout.on("data", (chunk) => {
      stdout = appendTail(stdout, chunk);
      process.stdout.write(chunk);
    });
    runner.stderr.on("data", (chunk) => {
      stderr = appendTail(stderr, chunk);
      process.stderr.write(chunk);
    });
    const timeout = setTimeout(() => {
      runner.kill("SIGTERM");
    }, 90 * 60_000);
    runner.once("error", (error) => {
      clearTimeout(timeout);
      if (activeQualificationRunner === runner) {
        activeQualificationRunner = null;
      }
      resolveRun({
        status: null,
        signal: null,
        stdout,
        stderr,
        error: String(error)
      });
    });
    runner.once("exit", (status, signal) => {
      clearTimeout(timeout);
      if (activeQualificationRunner === runner) {
        activeQualificationRunner = null;
      }
      resolveRun({
        status,
        signal,
        stdout,
        stderr,
        error: null
      });
    });
  });
}

function processSnapshot(pid, { includeMemoryPressure = false } = {}) {
  const output = runText("ps", ["-o", "rss=,vsz=,%cpu=", "-p", String(pid)]);
  const [rssKb, vszKb, cpu] = output.trim().split(/\s+/).map(Number);
  const swap = runText("/usr/sbin/sysctl", ["-n", "vm.swapusage"]);
  const memoryPressure = includeMemoryPressure
    ? runText("/usr/bin/memory_pressure", ["-Q"])
    : null;
  return {
    captured_at: new Date().toISOString(),
    rss_bytes: Number.isFinite(rssKb) ? rssKb * 1_024 : null,
    virtual_bytes: Number.isFinite(vszKb) ? vszKb * 1_024 : null,
    cpu_percent: Number.isFinite(cpu) ? cpu : null,
    swap,
    swap_used_bytes: parseSwapUsedBytes(swap),
    memory_pressure: memoryPressure,
    memory_free_percent: parseMemoryFreePercent(memoryPressure)
  };
}

function stopProcessGroup(pid) {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // It may already have exited.
  }
}

async function waitForExit(processHandle, timeoutMs) {
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) return;
  await Promise.race([
    new Promise((resolveExit) => processHandle.once("exit", resolveExit)),
    delay(timeoutMs)
  ]);
  if (processHandle.exitCode === null && processHandle.signalCode === null) {
    try {
      process.kill(-processHandle.pid, "SIGKILL");
    } catch {
      // It exited between checks.
    }
  }
}

function runText(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    encoding: "utf8",
    timeout: 10_000
  });
  return String(result.stdout || result.stderr || "").trim();
}

function appendTail(current, chunk) {
  return `${current}${String(chunk)}`.slice(-20_000);
}

function requiredOption(values, name) {
  const value = readOption(values, name);
  if (!value) {
    console.error(
      "Usage: node scripts/runLocal120BBaseline.js " +
      "--model MODEL.gguf --server LLAMA_SERVER " +
      "[--model-spec ARTIFACT.json] " +
      "[--context TOKENS] [--batch TOKENS] [--ubatch TOKENS] " +
      "[--fit-target-mib MiB] [--gpu-layers N|auto|all] [--cpu-moe] [--no-fit] " +
      "[--no-warmup] [--skip-probe] [--probe-only] " +
      "[--probe-max-tokens N] [--server-verbose] " +
      "[--expert-cache-slots N] [--expert-cache-cpu-fill] " +
      "[--expert-cache-trace] [--expert-cache-zero-copy] " +
      "[--expert-cache-grouped] [--expert-cache-prefetch THREADS] " +
      "[--expert-cache-hot-ceiling] " +
      "[--suite smoke|qualification|all] " +
      "[--only SCENARIO,...] " +
      "[--request-timeout-seconds SECONDS] " +
      "[--max-tokens TOKENS] " +
      "[--reasoning-effort low|medium|high] " +
      "[--seed INTEGER] " +
      "[--max-swap-growth-gib GiB] [--minimum-free-percent PERCENT] " +
      "[--max-run-seconds SECONDS] " +
      "[--output-dir DIR]"
    );
    process.exit(2);
  }
  return value;
}

function readOption(values, name) {
  const index = values.indexOf(name);
  return index >= 0 ? values[index + 1] : "";
}

async function readModelArtifact(path) {
  const artifact = JSON.parse(await readFile(path, "utf8"));
  if (artifact.schema !== "expertcache.model-artifact" || artifact.version !== 1) {
    throw new Error(`Unsupported model artifact spec: ${path}`);
  }
  for (const field of ["id", "repository", "revision", "filename", "sha256"]) {
    if (!artifact[field]) throw new Error(`Model artifact spec is missing ${field}`);
  }
  if (!Number.isInteger(artifact.size_bytes) || artifact.size_bytes <= 0) {
    throw new Error("Model artifact spec has an invalid size_bytes");
  }
  if (!/^[0-9a-f]{40}$/.test(artifact.revision)) {
    throw new Error("Model artifact spec has an invalid revision");
  }
  if (!/^[0-9a-f]{64}$/.test(artifact.sha256)) {
    throw new Error("Model artifact spec has an invalid SHA-256");
  }
  return artifact;
}

function boundedInteger(value, minimum, maximum, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function optionalNumber(value, minimum, maximum) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Expected a number from ${minimum} to ${maximum}, got ${value}`);
  }
  return parsed;
}

function parseMemoryFreePercent(value) {
  const match = String(value || "").match(/free percentage:\s*(\d+)%/i);
  return match ? Number(match[1]) : null;
}

function normalizeReasoningEffort(value) {
  if (value === undefined || value === null || value === "") return null;
  const normalized = String(value).trim().toLowerCase();
  if (["low", "medium", "high"].includes(normalized)) return normalized;
  throw new Error(`Unsupported reasoning effort: ${value}`);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function closeWritable(stream) {
  return new Promise((resolveClose, rejectClose) => {
    stream.once("error", rejectClose);
    stream.end(resolveClose);
  });
}

function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function hashRuntimeBundle(serverPath) {
  const directory = dirname(serverPath);
  const serverName = basename(serverPath);
  const entries = await readdir(directory, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile() && (
      entry.name === serverName || entry.name.endsWith(".dylib")
    ))
    .map((entry) => entry.name)
    .sort();
  const artifacts = {};
  for (const name of names) {
    const path = resolve(directory, name);
    const info = await stat(path);
    artifacts[name] = {
      size_bytes: info.size,
      sha256: await sha256File(path)
    };
  }
  return {
    sha256: sha256Json(artifacts),
    artifacts
  };
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

function hostDelta(beforeSnapshot, afterSnapshot) {
  const beforeCounters = beforeSnapshot?.memory?.vm_counters || {};
  const afterCounters = afterSnapshot?.memory?.vm_counters || {};
  const vmCounters = {};
  for (const [key, value] of Object.entries(afterCounters)) {
    if (key === "page_size_bytes") continue;
    const beforeValue = beforeCounters[key];
    if (Number.isFinite(value) && Number.isFinite(beforeValue)) {
      vmCounters[key] = value - beforeValue;
    }
  }
  const startSwap = beforeSnapshot?.memory?.swap_used_bytes;
  const endSwap = afterSnapshot?.memory?.swap_used_bytes;
  return {
    elapsed_ms: new Date(afterSnapshot.captured_at) - new Date(beforeSnapshot.captured_at),
    swap_growth_bytes: Number.isFinite(startSwap) && Number.isFinite(endSwap)
      ? endSwap - startSwap
      : null,
    vm_counters: vmCounters
  };
}
