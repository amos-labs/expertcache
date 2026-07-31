#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { totalmem } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

const args = process.argv.slice(2);
const model = resolve(requiredOption(args, "--model"));
const server = resolve(requiredOption(args, "--server"));
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
const noWarmup = args.includes("--no-warmup");
const skipProbe = args.includes("--skip-probe");
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
const modelAlias = readOption(args, "--model-alias") || "gpt-oss-120b";
const sampleEveryMs = boundedInteger(
  readOption(args, "--sample-every-ms"),
  500,
  60_000,
  2_000
);
const baseUrl = `http://127.0.0.1:${port}`;
const manifest = JSON.parse(await readFile(
  resolve("runtime/runtime-manifest.json"),
  "utf8"
));
const modelStat = await stat(model);
if (modelStat.size !== manifest.model_artifact.size_bytes) {
  throw new Error(
    `Pinned model size mismatch: expected ${manifest.model_artifact.size_bytes}, ` +
    `got ${modelStat.size}`
  );
}

await mkdir(outputDir, { recursive: true });
const serverLogPath = resolve(outputDir, "llama-server.log");
const qualificationPath = resolve(outputDir, "qualification.json");
const reportPath = resolve(outputDir, "baseline.json");
const before = hostSnapshot();
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
const sampler = setInterval(() => {
  samples.push(processSnapshot(child.pid));
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
    probe = await streamingProbe(baseUrl, servedModel);
    if (!probe.first_token_ms || probe.completion_tokens === 0) {
      throw new Error("Streaming probe completed without producing a token");
    }
  }
  qualification = await runQualification({
    baseUrl,
    context,
    modelAlias: servedModel,
    output: qualificationPath,
    suite,
    only,
    requestTimeoutSeconds,
    maxTokens,
    reasoningEffort
  });
  serverMetrics = await readEndpointText(`${baseUrl}/metrics`);
} catch (error) {
  failure = String(error?.stack || error);
} finally {
  serverMetrics ||= await readEndpointText(`${baseUrl}/metrics`);
  clearInterval(sampler);
  samples.push(processSnapshot(child.pid));
  stopProcessGroup(child.pid);
  await waitForExit(child, 15_000);
  for (const [signal, handler] of signalHandlers) {
    process.off(signal, handler);
  }
  log.end();
}

const report = {
  schema: "amos.local-120b-live-baseline",
  version: 1,
  started_at: startedAt,
  completed_at: new Date().toISOString(),
  model,
  model_alias: modelAlias,
  served_model: servedModel,
  runtime: server,
  runtime_revision: manifest.runtime.revision,
  model_revision: manifest.model_artifact.revision,
  model_size_bytes: modelStat.size,
  context_length: context,
  batch_size: batch,
  micro_batch_size: ubatch,
  fit_target_mib: fitTarget,
  gpu_layers: gpuLayers || "auto",
  cpu_moe: cpuMoe,
  warmup: !noWarmup,
  server_verbose: serverVerbose,
  skip_chat_parsing: skipChatParsing,
  streaming_probe_enabled: !skipProbe,
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
  readiness_seconds: readinessSeconds,
  streaming_probe: probe,
  qualification,
  server_metrics: serverMetrics,
  server_exit: exit,
  host_before: before,
  host_after: hostSnapshot(),
  process_samples: samples,
  failure,
  artifacts: {
    server_log: serverLogPath,
    qualification: qualificationPath
  }
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({
  report: reportPath,
  readiness_seconds: readinessSeconds,
  streaming_probe: probe,
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
} else if (failure || qualification?.status !== 0) {
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

async function streamingProbe(url, model) {
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
      max_tokens: 32,
      temperature: 0,
      stream: true,
      stream_options: { include_usage: true }
    })
  });
  if (!response.ok || !response.body) {
    throw new Error(`Streaming probe returned HTTP ${response.status}: ${await response.text()}`);
  }
  let firstTokenMs = null;
  let completionTokens = 0;
  let text = "";
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
      const tokenText = delta.content || delta.reasoning_content || "";
      if (tokenText && firstTokenMs === null) firstTokenMs = performance.now() - started;
      text += delta.content || "";
      completionTokens = payload?.usage?.completion_tokens || completionTokens;
    }
  }
  const elapsedMs = performance.now() - started;
  return {
    first_token_ms: firstTokenMs,
    elapsed_ms: elapsedMs,
    completion_tokens: completionTokens,
    tokens_per_second: completionTokens > 0 ? completionTokens / (elapsedMs / 1_000) : null,
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
  reasoningEffort: selectedReasoningEffort
}) {
  return new Promise((resolveRun) => {
    const qualificationArgs = [
      resolve("scripts/benchmarkLocalModels.js"),
      model,
      "--protocol", "openai",
      "--url", url,
      "--suite", selectedSuite,
      "--context", String(numCtx),
      "--request-timeout-seconds", String(timeoutSeconds),
      "--max-tokens", String(completionTokens),
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

function hostSnapshot() {
  const swap = runText("sysctl", ["-n", "vm.swapusage"]);
  const memoryPressure = runText("/usr/bin/memory_pressure", ["-Q"]);
  return {
    captured_at: new Date().toISOString(),
    total_memory_bytes: totalmem(),
    swap,
    swap_used_bytes: parseSwapUsedBytes(swap),
    memory_pressure: memoryPressure,
    memory_free_percent: parseMemoryFreePercent(memoryPressure),
    vm_stat: runText("/usr/bin/vm_stat", [])
  };
}

function processSnapshot(pid) {
  const output = runText("ps", ["-o", "rss=,vsz=,%cpu=", "-p", String(pid)]);
  const [rssKb, vszKb, cpu] = output.trim().split(/\s+/).map(Number);
  const swap = runText("sysctl", ["-n", "vm.swapusage"]);
  return {
    captured_at: new Date().toISOString(),
    rss_bytes: Number.isFinite(rssKb) ? rssKb * 1_024 : null,
    virtual_bytes: Number.isFinite(vszKb) ? vszKb * 1_024 : null,
    cpu_percent: Number.isFinite(cpu) ? cpu : null,
    swap,
    swap_used_bytes: parseSwapUsedBytes(swap)
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

function parseSwapUsedBytes(value) {
  const match = String(value).match(/used\s*=\s*([\d.]+)M/i);
  return match ? Number(match[1]) * 1_048_576 : null;
}

function parseMemoryFreePercent(value) {
  const match = String(value).match(/free percentage:\s*(\d+)%/i);
  return match ? Number(match[1]) : null;
}

function requiredOption(values, name) {
  const value = readOption(values, name);
  if (!value) {
    console.error(
      "Usage: node scripts/runLocal120BBaseline.js " +
      "--model MODEL.gguf --server LLAMA_SERVER " +
      "[--context TOKENS] [--batch TOKENS] [--ubatch TOKENS] " +
      "[--fit-target-mib MiB] [--gpu-layers N|auto|all] [--cpu-moe] " +
      "[--no-warmup] [--skip-probe] [--server-verbose] " +
      "[--expert-cache-slots N] [--expert-cache-cpu-fill] " +
      "[--expert-cache-trace] [--expert-cache-zero-copy] " +
      "[--expert-cache-grouped] [--expert-cache-prefetch THREADS] " +
      "[--expert-cache-hot-ceiling] " +
      "[--suite smoke|qualification|all] " +
      "[--only SCENARIO,...] " +
      "[--request-timeout-seconds SECONDS] " +
      "[--max-tokens TOKENS] " +
      "[--reasoning-effort low|medium|high] " +
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

function boundedInteger(value, minimum, maximum, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
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
