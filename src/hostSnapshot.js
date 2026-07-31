import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname, totalmem } from "node:os";
import { resolve } from "node:path";

export function captureHostSnapshot({ hostId = "unregistered" } = {}) {
  const swap = runText("/usr/sbin/sysctl", ["-n", "vm.swapusage"]);
  const vmStat = runText("/usr/bin/vm_stat", []);
  const hardware = readHardwareProfile();
  const git = captureGitState();
  return {
    schema: "expertcache.host-snapshot",
    version: 1,
    captured_at: new Date().toISOString(),
    host_id: hostId,
    host_fingerprint: createHash("sha256")
      .update(`${hostname()}\0${hardware.model_identifier || ""}\0${totalmem()}`)
      .digest("hex")
      .slice(0, 16),
    source_revision: git.revision,
    source_dirty: git.dirty,
    source_state_sha256: git.state_sha256,
    source_tracked_diff_sha256: git.tracked_diff_sha256,
    source_untracked_files: git.untracked_files,
    os: {
      product_name: runText("/usr/bin/sw_vers", ["-productName"]) || null,
      product_version: runText("/usr/bin/sw_vers", ["-productVersion"]) || null,
      build_version: runText("/usr/bin/sw_vers", ["-buildVersion"]) || null
    },
    hardware: {
      model_name: hardware.model_name || null,
      model_identifier: hardware.model_identifier || null,
      chip: hardware.chip || null,
      physical_memory: hardware.physical_memory || null,
      total_memory_bytes: totalmem()
    },
    memory: {
      swap,
      swap_used_bytes: parseSwapUsedBytes(swap),
      pressure: runText("/usr/bin/memory_pressure", ["-Q"]) || null,
      vm_stat: vmStat || null,
      vm_counters: parseVmStat(vmStat)
    },
    power: {
      source_and_battery: runText("/usr/bin/pmset", ["-g", "batt"]) || null,
      thermal_state: runText("/usr/bin/pmset", ["-g", "therm"]) || null
    }
  };
}

export function captureGitState() {
  const revision = normalizeGitRevision(runText("git", ["rev-parse", "HEAD"]));
  const root = runText("git", ["rev-parse", "--show-toplevel"]);
  if (!revision || !root) {
    return {
      revision: revision || null,
      dirty: null,
      state_sha256: null,
      tracked_diff_sha256: null,
      untracked_files: null
    };
  }
  const status = runBuffer("git", [
    "status", "--porcelain=v1", "--untracked-files=all"
  ]);
  const trackedDiff = runBuffer("git", ["diff", "--binary", "HEAD", "--"]);
  const untracked = runBuffer("git", [
    "ls-files", "--others", "--exclude-standard", "-z"
  ]).toString("utf8").split("\0").filter(Boolean).sort();
  const stateHash = createHash("sha256")
    .update(`revision\0${revision}\0status\0`)
    .update(status)
    .update("\0tracked-diff\0")
    .update(trackedDiff);
  for (const path of untracked) {
    stateHash.update("\0untracked\0").update(path).update("\0");
    try {
      stateHash.update(readFileSync(resolve(root, path)));
    } catch {
      stateHash.update("<unreadable>");
    }
  }
  return {
    revision,
    dirty: status.length > 0,
    state_sha256: stateHash.digest("hex"),
    tracked_diff_sha256: trackedDiff.length > 0
      ? createHash("sha256").update(trackedDiff).digest("hex")
      : null,
    untracked_files: untracked.length
  };
}

function readHardwareProfile() {
  const raw = runText("/usr/sbin/system_profiler", [
    "-json",
    "SPHardwareDataType"
  ]);
  try {
    const item = JSON.parse(raw)?.SPHardwareDataType?.[0] || {};
    return {
      model_name: item.machine_name,
      model_identifier: item.machine_model,
      chip: item.chip_type,
      physical_memory: item.physical_memory
    };
  } catch {
    return {};
  }
}

export function parseSwapUsedBytes(value) {
  const match = String(value || "").match(/used\s*=\s*([\d.]+)([MG])/i);
  if (!match) return null;
  const multiplier = match[2].toUpperCase() === "G" ? 1_073_741_824 : 1_048_576;
  return Number(match[1]) * multiplier;
}

export function normalizeGitRevision(value) {
  const revision = String(value || "").trim();
  return /^[0-9a-f]{7,64}$/i.test(revision) ? revision : null;
}

function parseVmStat(value) {
  const pageSizeMatch = String(value || "").match(/page size of (\d+) bytes/);
  const pageSize = pageSizeMatch ? Number(pageSizeMatch[1]) : 16_384;
  const counters = {};
  for (const line of String(value || "").split(/\r?\n/)) {
    const match = line.match(/^([^:]+):\s+([\d.]+)\.?$/);
    if (!match) continue;
    const key = match[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
    counters[key] = Number(match[2]);
  }
  return { page_size_bytes: pageSize, ...counters };
}

function runText(command, args) {
  return runBuffer(command, args).toString("utf8").trim();
}

function runBuffer(command, args) {
  const result = spawnSync(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.status !== 0) return Buffer.alloc(0);
  return Buffer.from(result.stdout || "");
}
