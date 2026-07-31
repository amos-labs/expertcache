import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { hostname, totalmem } from "node:os";

export function captureHostSnapshot({ hostId = "unregistered" } = {}) {
  const swap = runText("/usr/sbin/sysctl", ["-n", "vm.swapusage"]);
  const vmStat = runText("/usr/bin/vm_stat", []);
  const hardware = readHardwareProfile();
  const gitRevision = runText("git", ["rev-parse", "HEAD"]);
  return {
    schema: "expertcache.host-snapshot",
    version: 1,
    captured_at: new Date().toISOString(),
    host_id: hostId,
    host_fingerprint: createHash("sha256")
      .update(`${hostname()}\0${hardware.model_identifier || ""}\0${totalmem()}`)
      .digest("hex")
      .slice(0, 16),
    source_revision: gitRevision || null,
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
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000
    }).trim();
  } catch (error) {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      timeout: 30_000
    });
    return String(result.stdout || result.stderr || error?.message || "").trim();
  }
}

