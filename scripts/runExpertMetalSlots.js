#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const source = resolve("runtime/expert_metal_slots.mm");
const buildDir = resolve(
  readOption(args, "--build-dir") ||
    resolve(tmpdir(), "expertcache-metal")
);
const executable = resolve(buildDir, "expert-metal-slots");
const forwarded = stripOption(args, "--build-dir");

await mkdir(buildDir, { recursive: true });
if (await needsBuild(source, executable)) {
  run("xcrun", [
    "clang++",
    "-std=c++17",
    "-O3",
    "-fobjc-arc",
    "-framework", "Foundation",
    "-framework", "Metal",
    source,
    "-o", executable
  ]);
}
run(executable, forwarded);

async function needsBuild(input, output) {
  try {
    const [inputStat, outputStat] = await Promise.all([
      stat(input),
      stat(output)
    ]);
    return inputStat.mtimeMs > outputStat.mtimeMs;
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

function stripOption(values, name) {
  const output = [];
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === name) {
      index += 1;
      continue;
    }
    output.push(values[index]);
  }
  return output;
}
