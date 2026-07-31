#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { captureHostSnapshot } from "../src/hostSnapshot.js";

const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output");
const hostIndex = args.indexOf("--host-id");
if (outputIndex < 0 || !args[outputIndex + 1]) {
  console.error("Usage: node scripts/captureHostSnapshot.js --output FILE [--host-id ID]");
  process.exit(2);
}
const output = resolve(args[outputIndex + 1]);
const snapshot = captureHostSnapshot({
  hostId: hostIndex >= 0 ? args[hostIndex + 1] : "unregistered"
});
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(JSON.stringify({ output, snapshot }, null, 2));

