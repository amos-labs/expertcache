import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

test("Phase 1 page replay measures a bounded real mmap working set", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "amos-expert-pages-"));
  const weights = resolve(directory, "weights.gguf");
  const layoutPath = resolve(directory, "layout.json");
  const tracePath = resolve(directory, "trace.jsonl");
  await writeFile(weights, Buffer.alloc(128 * 1024, 7));

  const experts = Array.from({ length: 4 }, (_, expert) => ({
    expert,
    bytes: 4096,
    ranges: [
      {
        file_id: "file-0",
        tensor: `blk.0.ffn_up_exps.weight`,
        offset: expert * 4096,
        length: 4096
      }
    ]
  }));
  await writeFile(
    layoutPath,
    JSON.stringify({
      schema: "amos.expert-byte-layout",
      version: 1,
      model: "synthetic-moe",
      source_revision: "test-revision",
      page_size: 4096,
      layer_count: 1,
      experts_per_layer: 4,
      bytes_per_layer_expert: 4096,
      files: [{ id: "file-0", path: weights, size_bytes: 128 * 1024 }],
      layers: [{ layer: 0, expert_count: 4, experts }]
    })
  );
  await writeFile(
    tracePath,
    [
      JSON.stringify({
        type: "metadata",
        schema: "amos.expert-routing-trace",
        version: 1,
        model: "synthetic-moe",
        layers: 1,
        experts_per_layer: 4,
        active_experts: 2,
        expert_bytes: 4096,
        source_revision: "test-revision",
        created_at: "2026-07-28T00:00:00Z"
      }),
      ...[
        [0, 1],
        [0, 1],
        [0, 2],
        [0, 1]
      ].map((selected, tokenIndex) =>
        JSON.stringify({
          type: "token",
          trace_id: "synthetic",
          token_index: tokenIndex,
          phase: tokenIndex === 0 ? "prefill" : "decode",
          workflow: "coding",
          experts: [selected]
        })
      )
    ].join("\n") + "\n"
  );

  const stdout = execFileSync(
    "python3",
    [
      "harness/replay_expert_pages.py",
      "--trace",
      tracePath,
      "--layout",
      layoutPath,
      "--mode",
      "working-set",
      "--policy",
      "slru",
      "--slots-per-layer",
      "3",
      "--admit-after",
      "1",
      "--phase",
      "decode",
      "--profile-trace",
      tracePath,
      "--prewarm-experts-per-layer",
      "2",
      "--cold-start"
    ],
    { encoding: "utf8" }
  );
  const report = JSON.parse(stdout);
  assert.equal(report.schema, "amos.expert-page-replay");
  assert.equal(report.trace_phase, "decode");
  assert.equal(report.token_count, 3);
  assert.equal(report.expert_accesses, 6);
  assert.ok(report.hits > 0);
  assert.ok(report.hit_rate > 0);
  assert.ok(report.access_latency_ms.p95 >= 0);
  assert.ok(report.cold_bytes_per_token.max >= 0);
  assert.ok(report.logical_miss_bytes_per_token.max > 0);
  assert.equal(typeof report.checksum, "number");
  assert.equal(report.cold_start, true);
  assert.equal(
    typeof report.physical_residency_before_access.resident_pages,
    "number"
  );
  assert.ok(
    report.physical_residency_before_access.pages_checked > 0
  );
  assert.equal(report.workflow_prewarm.enabled, true);
  assert.equal(report.workflow_prewarm.profiled_trace_starts, 1);
  assert.equal(report.strata.by_workflow.coding.token_count, 3);
  assert.equal(report.strata.by_trace.synthetic.token_count, 3);
  assert.equal(report.strata.trace_boundaries.length, 1);
  assert.equal(
    report.strata.trace_boundaries[0].prewarm.experts,
    2
  );

  const prefillReport = JSON.parse(
    execFileSync(
      "python3",
      [
        "harness/replay_expert_pages.py",
        "--trace",
        tracePath,
        "--layout",
        layoutPath,
        "--mode",
        "working-set",
        "--policy",
        "slru",
        "--slots-per-layer",
        "3",
        "--admit-after",
        "1",
        "--phase",
        "decode",
        "--prewarm-from-prefill",
        "2",
        "--cold-start"
      ],
      { encoding: "utf8" }
    )
  );
  assert.equal(
    prefillReport.workflow_prewarm.source,
    "evaluation-prefill"
  );
  assert.equal(prefillReport.workflow_prewarm.profiled_trace_starts, 1);
});
