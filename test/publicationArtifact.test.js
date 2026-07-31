import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  captureHostSnapshot,
  normalizeGitRevision,
  parseSwapUsedBytes
} from "../src/hostSnapshot.js";
import { validatePublicationArtifact } from "../src/publicationArtifact.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("provisional publication artifact is internally valid and explicitly incomplete", async () => {
  const result = await validatePublicationArtifact(root);
  assert.equal(result.valid, true, result.errors.join("\n"));
  assert.equal(result.manifest.state, "provisional");
  assert.equal(result.manifest.licenses.software, "Apache-2.0");
  assert.equal(result.manifest.licenses.paper, "CC-BY-4.0");
  assert.ok(result.incomplete_gates.includes("clean-64g-matrix"));
  assert.equal(result.manifest.secondary_models[0].id, "gpt-oss-20b-mxfp4");
  assert.ok(result.warnings.some((warning) => warning.includes("incomplete gates")));
});

test("strict publication validation refuses unfinished gates", async () => {
  const result = await validatePublicationArtifact(root, { strict: true });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes("Strict validation")));
});

test("host snapshots are sanitized and swap units parse deterministically", () => {
  assert.equal(parseSwapUsedBytes("total = 4096.00M  used = 1.50G  free = 2.50G"), 1.5 * 1024 ** 3);
  const snapshot = captureHostSnapshot({ hostId: "test-host" });
  assert.equal(snapshot.host_id, "test-host");
  assert.match(snapshot.host_fingerprint, /^[0-9a-f]{16}$/);
  assert.equal(JSON.stringify(snapshot).includes("serial"), false);
});

test("host snapshots accept commit IDs but reject failed symbolic revisions", () => {
  const revision = "350677641c9f937d925adb77cc55c8286481fa45";
  assert.equal(normalizeGitRevision(revision), revision);
  assert.equal(normalizeGitRevision("HEAD"), null);
  assert.equal(normalizeGitRevision("fatal: ambiguous argument 'HEAD'"), null);
});
