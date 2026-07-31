#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const source = resolve(
  "runtime/expert_mxfp4_slots.mm"
);
const llamaRoot = resolve(
  readOption(args, "--llama-root") ||
    resolve(homedir(), ".cache/expertcache/llama.cpp")
);
const buildRoot = resolve(
  readOption(args, "--llama-build") ||
    resolve(llamaRoot, "build-expertcache-metal")
);
const libraryDir = resolve(buildRoot, "bin");
const buildDir = resolve(
  readOption(args, "--build-dir") ||
    resolve(tmpdir(), "expertcache-mxfp4")
);
const executable = resolve(buildDir, "expert-mxfp4-slots");
const forwarded = stripOptions(args, [
  "--build-dir",
  "--llama-root",
  "--llama-build"
]);

await mkdir(buildDir, { recursive: true });
if (
  await needsBuild(
    [
      source,
      resolve(llamaRoot, "ggml/include/ggml.h"),
      resolve(llamaRoot, "ggml/include/ggml-backend.h")
    ],
    executable
  )
) {
  run("xcrun", [
    "clang++",
    "-std=c++17",
    "-O3",
    "-fobjc-arc",
    `-I${resolve(llamaRoot, "ggml/include")}`,
    `-L${libraryDir}`,
    `-Wl,-rpath,${libraryDir}`,
    source,
    "-lggml",
    "-lggml-base",
    "-lggml-cpu",
    "-lggml-metal",
    "-framework", "Foundation",
    "-framework", "Metal",
    "-o", executable
  ]);
}
run(executable, forwarded);

async function needsBuild(inputs, output) {
  try {
    const [inputStats, outputStat] = await Promise.all([
      Promise.all(inputs.map((input) => stat(input))),
      stat(output)
    ]);
    return inputStats.some(
      (inputStat) => inputStat.mtimeMs > outputStat.mtimeMs
    );
  } catch {
    return true;
  }
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited ${result.status}`);
  }
}

function readOption(values, name) {
  const index = values.indexOf(name);
  return index >= 0 ? values[index + 1] || "" : "";
}

function stripOptions(values, names) {
  const selected = new Set(names);
  const output = [];
  for (let index = 0; index < values.length; index += 1) {
    if (selected.has(values[index])) {
      index += 1;
      continue;
    }
    output.push(values[index]);
  }
  return output;
}
