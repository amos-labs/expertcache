#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validatePublicationArtifact } from "../src/publicationArtifact.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const strict = process.argv.slice(2).includes("--strict");
const result = await validatePublicationArtifact(root, { strict });
console.log(JSON.stringify({
  valid: result.valid,
  state: result.manifest?.state || null,
  incomplete_gates: result.incomplete_gates || [],
  warnings: result.warnings,
  errors: result.errors
}, null, 2));
if (!result.valid) process.exitCode = 1;

