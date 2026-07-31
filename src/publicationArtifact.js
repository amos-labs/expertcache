import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile
} from "node:fs/promises";
import { basename, dirname, extname, relative, resolve } from "node:path";

const CLAIM_GRADES = new Set([
  "architecture-validated",
  "targeted-quality-validated",
  "deterministic-equivalence-validated",
  "trace-derived",
  "single-run-observation",
  "decision-grade",
  "decision-grade-synthetic",
  "publication-grade"
]);
const GATE_STATUSES = new Set([
  "complete",
  "scoped-out",
  "active",
  "pending",
  "external",
  "blocked"
]);
const TEXT_EXTENSIONS = new Set([
  ".bib", ".cff", ".js", ".json", ".jsonl", ".md", ".mm",
  ".patch", ".py", ".tex", ".txt", ".yaml", ".yml"
]);

export async function validatePublicationArtifact(root, { strict = false } = {}) {
  const errors = [];
  const warnings = [];
  const manifestPath = resolve(root, "artifact/publication-manifest.json");
  const manifest = await readJson(manifestPath, errors);
  if (!manifest) return { valid: false, errors, warnings, manifest: null };

  if (manifest.schema !== "expertcache.publication-artifact") {
    errors.push("Unexpected publication manifest schema");
  }
  if (manifest.version !== 1) errors.push("Unsupported publication manifest version");
  if (!["provisional", "release-candidate", "release"].includes(manifest.state)) {
    errors.push(`Unsupported artifact state: ${manifest.state}`);
  }
  if (
    manifest.licenses?.software !== "Apache-2.0" ||
    manifest.licenses?.paper !== "CC-BY-4.0"
  ) {
    errors.push("Publication manifest must declare Apache-2.0 software and CC-BY-4.0 paper licenses");
  }

  checkUniqueIds(manifest.claims, "claim", errors);
  checkUniqueIds(manifest.gates, "gate", errors);
  await verifySecondaryModels(root, manifest.secondary_models || [], errors);
  for (const claim of manifest.claims || []) {
    if (!CLAIM_GRADES.has(claim.grade)) {
      errors.push(`Claim ${claim.id} has unsupported grade ${claim.grade}`);
    }
    if (!Array.isArray(claim.evidence) || claim.evidence.length === 0) {
      errors.push(`Claim ${claim.id} has no evidence paths`);
      continue;
    }
    for (const evidence of claim.evidence) {
      if (!(await exists(resolve(root, evidence)))) {
        errors.push(`Claim ${claim.id} evidence is missing: ${evidence}`);
      }
    }
  }

  const incompleteGates = [];
  for (const gate of manifest.gates || []) {
    if (!GATE_STATUSES.has(gate.status)) {
      errors.push(`Gate ${gate.id} has unsupported status ${gate.status}`);
    }
    if (!["complete", "scoped-out"].includes(gate.status)) incompleteGates.push(gate.id);
  }
  if (manifest.state === "release" && incompleteGates.length > 0) {
    errors.push(`Release state has incomplete gates: ${incompleteGates.join(", ")}`);
  }
  if (strict && manifest.state !== "release") {
    errors.push(`Strict validation requires state=release, got ${manifest.state}`);
  }
  if (strict && incompleteGates.length > 0) {
    errors.push(`Strict validation has incomplete gates: ${incompleteGates.join(", ")}`);
  } else if (incompleteGates.length > 0) {
    warnings.push(`Provisional artifact has incomplete gates: ${incompleteGates.join(", ")}`);
  }

  for (const include of manifest.bundle_include || []) {
    if (!(await exists(resolve(root, include)))) {
      errors.push(`Bundle include path is missing: ${include}`);
    }
  }

  await verifyRuntimePatch(root, errors);
  await scanIncludedText(root, manifest.bundle_include || [], errors);
  await verifyPaper(root, { strict, errors, warnings });

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    incomplete_gates: incompleteGates,
    manifest
  };
}

export async function buildPublicationBundle(root, options = {}) {
  const validation = await validatePublicationArtifact(root, {
    strict: Boolean(options.strict)
  });
  if (!validation.valid) {
    throw new Error(`Artifact validation failed:\n- ${validation.errors.join("\n- ")}`);
  }
  if (validation.manifest.state !== "release" && !options.allowProvisional) {
    throw new Error("Refusing to bundle a provisional artifact without --allow-provisional");
  }

  const sourceRevision = git(root, ["rev-parse", "HEAD"]);
  const dirty = git(root, ["status", "--porcelain"]).length > 0;
  if (dirty && !options.allowDirty) {
    throw new Error("Refusing to bundle a dirty worktree without --allow-dirty");
  }
  const label = `${validation.manifest.artifact_version}-${sourceRevision.slice(0, 8)}`
    .replace(/[^A-Za-z0-9._-]+/g, "-");
  const output = resolve(options.output || resolve(root, "dist", `expertcache-artifact-${label}`));
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output, { recursive: false });

  for (const include of validation.manifest.bundle_include) {
    const source = resolve(root, include);
    const target = resolve(output, include);
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, {
      recursive: true,
      filter: (candidate) => !isExcludedBundlePath(root, candidate)
    });
  }

  const index = {
    schema: "expertcache.artifact-index",
    version: 1,
    created_at: new Date().toISOString(),
    artifact_version: validation.manifest.artifact_version,
    artifact_state: validation.manifest.state,
    source_revision: sourceRevision,
    source_dirty: dirty,
    incomplete_gates: validation.incomplete_gates,
    model_weights_included: false
  };
  await writeFile(
    resolve(output, "artifact-index.json"),
    `${JSON.stringify(index, null, 2)}\n`
  );

  const files = (await listFiles(output))
    .filter((file) => basename(file) !== "SHA256SUMS")
    .sort();
  const sums = [];
  for (const file of files) {
    const digest = createHash("sha256").update(await readFile(file)).digest("hex");
    sums.push(`${digest}  ${relative(output, file)}`);
  }
  await writeFile(resolve(output, "SHA256SUMS"), `${sums.join("\n")}\n`);

  let archive = null;
  if (options.archive) {
    archive = `${output}.tar.gz`;
    execFileSync("tar", ["-czf", archive, "-C", dirname(output), basename(output)], {
      stdio: "inherit"
    });
  }
  return { output, archive, file_count: files.length + 1, index, validation };
}

async function verifyRuntimePatch(root, errors) {
  try {
    const runtime = JSON.parse(await readFile(resolve(root, "runtime/runtime-manifest.json"), "utf8"));
    const patch = await readFile(resolve(root, "runtime", runtime.runtime_patch.filename));
    const digest = createHash("sha256").update(patch).digest("hex");
    if (digest !== runtime.runtime_patch.sha256) {
      errors.push(`Runtime patch digest mismatch: ${digest}`);
    }
  } catch (error) {
    errors.push(`Could not verify runtime patch: ${error.message}`);
  }
}

async function verifySecondaryModels(root, models, errors) {
  const seen = new Set();
  for (const model of models) {
    if (!model?.id || seen.has(model.id)) {
      errors.push(`Secondary model has a missing or duplicate id: ${model?.id || "<missing>"}`);
      continue;
    }
    seen.add(model.id);
    if (!model.spec) {
      errors.push(`Secondary model ${model.id} has no artifact spec`);
      continue;
    }
    try {
      const spec = JSON.parse(await readFile(resolve(root, model.spec), "utf8"));
      if (spec.schema !== "expertcache.model-artifact" || spec.version !== 1) {
        errors.push(`Secondary model ${model.id} has an unsupported artifact spec`);
      }
      if (spec.id !== model.id) {
        errors.push(`Secondary model id mismatch: ${model.id} != ${spec.id}`);
      }
      if (!/^[0-9a-f]{40}$/.test(spec.revision || "")) {
        errors.push(`Secondary model ${model.id} has an invalid revision`);
      }
      if (!Number.isInteger(spec.size_bytes) || spec.size_bytes <= 0) {
        errors.push(`Secondary model ${model.id} has an invalid size`);
      }
      if (!/^[0-9a-f]{64}$/.test(spec.sha256 || "")) {
        errors.push(`Secondary model ${model.id} has an invalid SHA-256`);
      }
      if (!spec.repository || !spec.filename || !spec.claim_boundary) {
        errors.push(`Secondary model ${model.id} has incomplete provenance`);
      }
    } catch (error) {
      errors.push(`Could not verify secondary model ${model.id}: ${error.message}`);
    }
  }
}

async function verifyPaper(root, { strict, errors, warnings }) {
  const paperPath = resolve(root, "paper/main.tex");
  if (!(await exists(paperPath))) {
    errors.push("Paper source is missing: paper/main.tex");
    return;
  }
  const paper = await readFile(paperPath, "utf8");
  const resultsPath = resolve(root, "paper/results.tex");
  const results = await exists(resultsPath) ? await readFile(resultsPath, "utf8") : "";
  const combined = `${paper}\n${results}`;
  for (const section of [
    "Introduction", "Background and Related Work", "Design", "Methodology",
    "Evaluation", "Limitations", "Conclusion", "Acknowledgments"
  ]) {
    if (!paper.includes(`\\section{${section}}`)) {
      errors.push(`Paper is missing section: ${section}`);
    }
  }
  if (combined.includes("74.24")) errors.push("Paper contains the retracted 74.24 tok/s value");
  const pending = (combined.match(/\\Pending\{/g) || []).length;
  if (strict && pending > 0) errors.push(`Paper contains ${pending} pending result markers`);
  if (!strict && pending > 0) warnings.push(`Paper contains ${pending} pending result markers`);
}

async function scanIncludedText(root, includes, errors) {
  const files = [];
  for (const include of includes) {
    const path = resolve(root, include);
    if (await exists(path)) files.push(...await listFiles(path));
  }
  const patterns = [
    { name: "personal absolute path", regex: /\/Users\/[A-Za-z0-9._-]+\// },
    { name: "private key", regex: /BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY/ },
    { name: "GitHub token", regex: /gh[opusr]_[A-Za-z0-9]{20,}/ },
    { name: "AWS access key", regex: /AKIA[0-9A-Z]{16}/ }
  ];
  for (const file of new Set(files)) {
    if (!TEXT_EXTENSIONS.has(extname(file).toLowerCase())) continue;
    const text = await readFile(file, "utf8");
    for (const pattern of patterns) {
      if (pattern.regex.test(text)) {
        errors.push(`${pattern.name} found in ${relative(root, file)}`);
      }
    }
  }
}

function isExcludedBundlePath(root, candidate) {
  const path = relative(root, candidate);
  return path.split("/").some((part) => [
    ".cache", ".git", "dist", "node_modules", "output", "__pycache__"
  ].includes(part));
}

async function readJson(path, errors) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    errors.push(`Could not read ${path}: ${error.message}`);
    return null;
  }
}

function checkUniqueIds(items, label, errors) {
  const seen = new Set();
  for (const item of items || []) {
    if (!item?.id) {
      errors.push(`${label} is missing an id`);
    } else if (seen.has(item.id)) {
      errors.push(`Duplicate ${label} id: ${item.id}`);
    }
    seen.add(item?.id);
  }
}

async function listFiles(path) {
  const info = await stat(path);
  if (info.isFile()) return [path];
  const files = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}
