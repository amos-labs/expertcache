#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import {
  analyzeExpertRouteUnions,
  parseExpertRouteLog
} from "../src/expertRouteUnions.js";

const args = process.argv.slice(2);
const logPath = readOption(args, "--log");
const outputPath = readOption(args, "--output");
const expertBytes = Number(
  readOption(args, "--expert-bytes") || 13_219_200
);
const windows = String(
  readOption(args, "--windows") || "1,2,4,8,16,32,64"
)
  .split(",")
  .map(Number);

if (!logPath) {
  console.error(
    "Usage: node scripts/analyzeExpertRouteUnions.js --log LLAMA_SERVER.log " +
    "[--windows 1,2,4,8,16,32,64] [--expert-bytes BYTES] " +
    "[--output REPORT.json]"
  );
  process.exit(2);
}

const log = await readFile(logPath, "utf8");
const trace = parseExpertRouteLog(log);
const report = analyzeExpertRouteUnions(trace, {
  windows,
  expertBytes
});
const json = `${JSON.stringify(report, null, 2)}\n`;

if (outputPath) {
  await writeFile(outputPath, json);
}
console.log(json.trimEnd());

function readOption(values, name) {
  const index = values.indexOf(name);
  return index >= 0 ? values[index + 1] : "";
}
