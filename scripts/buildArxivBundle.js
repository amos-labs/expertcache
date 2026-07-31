#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const allowProvisional = args.includes("--allow-provisional");
const paperDir = resolve(root, "paper");
const required = ["main.tex", "results.tex", "references.bib"];
const optional = ["main.bbl"];
const files = [];

for (const name of required) {
  await requireFile(resolve(paperDir, name));
  files.push(name);
}
for (const name of optional) {
  if (await isFile(resolve(paperDir, name))) files.push(name);
}

const source = await Promise.all(files.map(async (name) => ({
  name,
  text: await readFile(resolve(paperDir, name), "utf8")
})));
const combined = source.map((item) => item.text).join("\n");
const pending = (combined.match(/\\Pending\{/g) || []).length;
if (pending > 0 && !allowProvisional) {
  throw new Error(
    `Refusing final arXiv bundle: ${pending} pending result markers remain. ` +
    "Use --allow-provisional only to test compilation."
  );
}
for (const { name, text } of source) {
  if (/\/Users\/[A-Za-z0-9._-]+\//.test(text)) {
    throw new Error(`Personal absolute path found in ${name}`);
  }
  if (!/^[A-Za-z0-9_+\-.,=]+$/.test(name)) {
    throw new Error(`arXiv-unsafe file name: ${name}`);
  }
}

const label = allowProvisional ? "provisional" : "release";
const date = new Date().toISOString().slice(0, 10);
const outputDir = resolve(root, "output/arxiv");
const archive = resolve(outputDir, `expertcache-arxiv-${label}-${date}.tar.gz`);
const stagingParent = await mkdtemp(resolve(tmpdir(), "expertcache-arxiv-"));
const staging = resolve(stagingParent, "source");
await mkdir(staging);
for (const { name, text } of source) {
  await writeFile(resolve(staging, name), text);
}
await mkdir(outputDir, { recursive: true });
let listing;
try {
  execFileSync("tar", ["-czf", archive, "-C", staging, ...files], {
    stdio: "inherit"
  });
  listing = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean);
} finally {
  await rm(stagingParent, { recursive: true, force: true });
}
if (listing.length !== files.length || !files.every((file) => listing.includes(file))) {
  throw new Error(`Unexpected arXiv archive contents: ${listing.join(", ")}`);
}
const manifest = {
  schema: "expertcache.arxiv-source-bundle",
  version: 1,
  state: label,
  created_at: new Date().toISOString(),
  pending_markers: pending,
  archive,
  files: listing
};
await writeFile(
  resolve(outputDir, `expertcache-arxiv-${label}-${date}.json`),
  `${JSON.stringify(manifest, null, 2)}\n`
);
console.log(JSON.stringify(manifest, null, 2));

async function requireFile(path) {
  if (!(await isFile(path))) throw new Error(`Required paper source is missing: ${path}`);
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
