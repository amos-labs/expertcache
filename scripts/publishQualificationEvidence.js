#!/usr/bin/env node
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const outputDir = option("--output-dir");
const force = args.includes("--force");
const inputs = repeatedOptions("--input").map(parseInput);

if (!outputDir || inputs.length === 0) {
  console.error(
    "Usage: node scripts/publishQualificationEvidence.js " +
    "--output-dir DIR --input LABEL=FILE [--input LABEL=FILE ...] [--force]"
  );
  process.exit(2);
}

const target = resolve(outputDir);
await mkdir(target, { recursive: true });
const index = {
  schema: "expertcache.sanitized-evidence-index",
  version: 1,
  created_at: new Date().toISOString(),
  sanitation: {
    worktree_paths: "$WORKTREE",
    home_paths: "$HOME",
    host_fingerprint: "redacted",
    battery_identifier: "redacted",
    numerical_measurements_changed: false,
    synthetic_messages_changed: false
  },
  files: []
};

for (const input of inputs) {
  const source = resolve(input.path);
  const raw = await readFile(source);
  const parsed = JSON.parse(raw.toString("utf8"));
  const report = sanitize(parsed);
  const payload = {
    schema: "expertcache.sanitized-evidence",
    version: 1,
    label: input.label,
    source: {
      filename: basename(source),
      sha256: sha256(raw)
    },
    report
  };
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  assertSanitized(serialized);
  const destination = resolve(target, `${input.label}.json`);
  if (!force && await exists(destination)) {
    throw new Error(`Refusing to overwrite existing evidence: ${destination}`);
  }
  await writeFile(destination, serialized);
  index.files.push({
    label: input.label,
    filename: basename(destination),
    source_sha256: payload.source.sha256,
    sanitized_sha256: sha256(Buffer.from(serialized)),
    schema: parsed.schema || null,
    report_version: parsed.version || null
  });
}

index.files.sort((left, right) => left.label.localeCompare(right.label));
const indexPath = resolve(target, "index.json");
if (!force && await exists(indexPath)) {
  throw new Error(`Refusing to overwrite existing evidence index: ${indexPath}`);
}
await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);
console.log(JSON.stringify({ output_dir: target, files: index.files }, null, 2));

function sanitize(value, key = "") {
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [
      childKey,
      childKey === "host_fingerprint" ? "redacted" : sanitize(child, childKey)
    ]));
  }
  if (typeof value !== "string") return value;
  let text = value
    .split(root).join("$WORKTREE")
    .split(homedir()).join("$HOME")
    .replace(/\(id=\d+\)/g, "(id=REDACTED)");
  if (key === "host_fingerprint") text = "redacted";
  return text;
}

function assertSanitized(serialized) {
  const forbidden = [root, homedir(), "/Users/", "rickbarkley"];
  for (const value of forbidden) {
    if (serialized.includes(value)) {
      throw new Error(`Sanitized evidence still contains forbidden text: ${value}`);
    }
  }
}

function parseInput(value) {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`Invalid --input value: ${value}`);
  }
  const label = value.slice(0, separator);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(label)) {
    throw new Error(`Input label must be lowercase kebab-case: ${label}`);
  }
  return { label, path: value.slice(separator + 1) };
}

function repeatedOptions(name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) values.push(args[index + 1] || "");
  }
  return values;
}

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : "";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function exists(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
