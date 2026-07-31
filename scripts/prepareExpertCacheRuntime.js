#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(
  root,
  "runtime/runtime-manifest.json"
);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const expertCachePatch = resolve(
  root,
  "runtime/llama-expert-cache-runtime.patch"
);
const args = process.argv.slice(2);
const checkout = resolve(
  readOption(args, "--dir") ||
    resolve(homedir(), ".cache/expertcache/llama.cpp")
);
const build = !args.includes("--no-build");
const runtime = manifest.runtime;

if (!(await exists(resolve(checkout, ".git")))) {
  run("git", ["clone", "--filter=blob:none", "--no-checkout", runtime.repository, checkout]);
}

run("git", ["fetch", "--depth", "1", "origin", runtime.revision], checkout);
run("git", ["checkout", "--detach", runtime.revision], checkout);
const actual = run("git", ["rev-parse", "HEAD"], checkout).trim();
if (actual !== runtime.revision) {
  throw new Error(
    `Pinned llama.cpp revision mismatch: expected ${runtime.revision}, got ${actual}`
  );
}

const hasExpertCachePatch = await exists(expertCachePatch);
let patchApplied = false;
if (hasExpertCachePatch) {
  const patchDigest = createHash("sha256")
    .update(await readFile(expertCachePatch))
    .digest("hex");
  if (patchDigest !== manifest.runtime_patch?.sha256) {
    throw new Error(
      `ExpertCache patch digest mismatch: expected ` +
      `${manifest.runtime_patch?.sha256 || "(missing)"}, got ${patchDigest}`
    );
  }
  const alreadyApplied = succeeds(
    "git",
    ["apply", "--reverse", "--check", expertCachePatch],
    checkout
  );
  if (!alreadyApplied) {
    run("git", ["apply", "--check", expertCachePatch], checkout);
    run("git", ["apply", expertCachePatch], checkout);
    patchApplied = true;
  }
}

if (build) {
  const buildDir = resolve(checkout, "build-expertcache-metal");
  run(
    "cmake",
    [
      "-S",
      checkout,
      "-B",
      buildDir,
      "-DCMAKE_BUILD_TYPE=Release",
      "-DGGML_METAL=ON",
      "-DGGML_NATIVE=ON",
      "-DLLAMA_BUILD_TESTS=ON"
    ],
    checkout
  );
  run(
    "cmake",
    [
      "--build",
      buildDir,
      "--config",
      "Release",
      "--target",
      "llama-cli",
      "llama-server",
      "llama-bench",
      "test-backend-ops",
      "-j",
      String(Math.max(1, Number(process.env.EXPERTCACHE_BUILD_JOBS || 4)))
    ],
    checkout
  );
}

console.log(
  JSON.stringify(
    {
      checkout,
      revision: actual,
      metalStrategy: manifest.metal_strategy.name,
      expertCachePatch: hasExpertCachePatch ? expertCachePatch : null,
      patchApplied,
      built: build
    },
    null,
    2
  )
);

function readOption(values, name) {
  const index = values.indexOf(name);
  return index >= 0 ? values[index + 1] : "";
}

function run(command, commandArgs, cwd = root) {
  return execFileSync(command, commandArgs, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"]
  });
}

function succeeds(command, commandArgs, cwd = root) {
  try {
    execFileSync(command, commandArgs, {
      cwd,
      encoding: "utf8",
      stdio: "ignore"
    });
    return true;
  } catch {
    return false;
  }
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
