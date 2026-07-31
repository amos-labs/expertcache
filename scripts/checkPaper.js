#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const strict = process.argv.slice(2).includes("--strict");
const main = await readFile(resolve(root, "paper/main.tex"), "utf8");
const results = await readFile(resolve(root, "paper/results.tex"), "utf8");
const bibliography = await readFile(resolve(root, "paper/references.bib"), "utf8");
const errors = [];
const warnings = [];

for (const section of [
  "Introduction",
  "Background and Related Work",
  "Design",
  "Implementation",
  "Methodology",
  "Evaluation",
  "Discussion and Roadmap",
  "Limitations",
  "Conclusion",
  "Acknowledgments"
]) {
  if (!main.includes(`\\section{${section}}`)) errors.push(`Missing section: ${section}`);
}
if (!main.includes("AI-assisted research process")) {
  errors.push("Methods do not disclose AI assistance");
}
if (!/These systems are not\s+authors/.test(main)) {
  errors.push("Acknowledgments do not preserve the non-author boundary");
}
const authorBlock = main.match(/\\author\{([\s\S]*?)\}\n\\date/)?.[1] || "";
if (/Fable|GPT|OpenAI/i.test(authorBlock)) errors.push("AI system appears in author block");

const combined = `${main}\n${results}`;
if (combined.includes("74.24")) errors.push("Retracted throughput value appears in paper source");
if (/16[- ]case/i.test(combined)) {
  errors.push("Quality suite is seven scenarios/16 points, not 16 cases");
}
const pending = (combined.match(/\\Pending\{/g) || []).length;
if (strict && pending > 0) errors.push(`${pending} pending result markers remain`);
if (!strict && pending > 0) warnings.push(`${pending} pending result markers remain`);

const cited = new Set();
for (const match of main.matchAll(/\\cite\{([^}]+)\}/g)) {
  for (const key of match[1].split(",")) cited.add(key.trim());
}
const defined = new Set(
  [...bibliography.matchAll(/@[A-Za-z]+\{([^,]+),/g)].map((match) => match[1].trim())
);
for (const key of cited) {
  if (!defined.has(key)) errors.push(`Missing bibliography entry: ${key}`);
}
for (const key of defined) {
  if (!cited.has(key)) warnings.push(`Uncited bibliography entry: ${key}`);
}

console.log(JSON.stringify({
  valid: errors.length === 0,
  strict,
  pending_markers: pending,
  citations: cited.size,
  bibliography_entries: defined.size,
  warnings,
  errors
}, null, 2));
if (errors.length > 0) process.exitCode = 1;
