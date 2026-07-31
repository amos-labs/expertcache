#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPublicationBundle } from "../src/publicationArtifact.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output");
const result = await buildPublicationBundle(root, {
  output: outputIndex >= 0 ? resolve(args[outputIndex + 1]) : null,
  strict: args.includes("--strict"),
  allowProvisional: args.includes("--allow-provisional"),
  allowDirty: args.includes("--allow-dirty"),
  archive: !args.includes("--no-archive")
});
console.log(JSON.stringify({
  output: result.output,
  archive: result.archive,
  file_count: result.file_count,
  source_revision: result.index.source_revision,
  source_dirty: result.index.source_dirty,
  incomplete_gates: result.index.incomplete_gates
}, null, 2));

