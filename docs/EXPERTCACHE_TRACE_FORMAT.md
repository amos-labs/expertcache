# ExpertCache routing trace format

ExpertCache Phase 0 records only sparse router selections and non-sensitive
experiment labels. It must not record prompts, messages, documents, tool
arguments, company facts, tenant IDs, user IDs, email addresses, or generated
text.

The file is UTF-8 JSON Lines. The first record is metadata:

```json
{"type":"metadata","schema":"amos.expert-routing-trace","version":1,"model":"openai/gpt-oss-120b","layers":36,"experts_per_layer":128,"active_experts":4,"expert_bytes":12600000,"weight_store_bytes":65283502899,"shared_resident_bytes":7800000000,"source_revision":"pinned-runtime-sha","capture_mode":"sampled","sampling_temperature":0.7,"sampling_top_p":0.95,"sampling_seed":42,"created_at":"2026-07-28T00:00:00Z"}
```

Each remaining record represents one token:

```json
{"type":"token","trace_id":"random-run-id","token_index":0,"phase":"decode","workflow":"company-audit","experts":[[4,19,72,101],[7,18,55,89]]}
```

The abbreviated example has two layer arrays; GPT-OSS 120B records exactly 36.
Each layer contains four unique IDs from 0 through 127.

## Field rules

### Metadata

- `schema`: always `amos.expert-routing-trace`;
- `version`: currently `1`;
- `model`: exact model/checkpoint identifier;
- `layers`: router-bearing MoE layer count;
- `experts_per_layer`: total experts available in each layer;
- `active_experts`: experts selected per token and layer;
- `expert_bytes`: bytes required for one complete expert in one layer,
  calculated from the exact stored tensor representation;
- `weight_store_bytes`: optional complete checkpoint/store size;
- `shared_resident_bytes`: optional resident embeddings, attention, routers,
  norms, output, KV/runtime baseline, and other non-cached bytes;
- `source_revision`: pinned tracing runtime revision; and
- `capture_mode`: optional `greedy` or `sampled` arm label;
- `sampling_temperature`, `sampling_top_p`, and `sampling_seed`: present only
  for sampled arms; and
- `created_at`: trace creation time.

### Token

- `trace_id`: random experiment-run identifier with no company or user meaning;
- `token_index`: index within the run;
- `phase`: `prefill` or `decode`;
- `workflow`: bounded AMOS workflow class, not free-form customer text; and
- `experts`: one selected-expert array per layer.

Unknown fields fail parsing. This is deliberate: it prevents a convenient
diagnostic record from gradually becoming an ungoverned prompt log.

## Capture seam

The pinned reference capture harness lives in
[the reproducibility harness](REPRODUCIBILITY.md). It hooks
`GptOssTopKRouter` after top-k selection and before expert multiplication:

1. copy the small selected-expert ID tensor to the trace collector;
2. append a token record to a local buffered writer;
3. never block model execution on trace persistence;
4. flush at a bounded interval and on normal shutdown;
5. drop records, rather than application work, under trace backpressure; and
6. record dropped counts in a separate experiment summary.

The tracer is disabled by default and must use an explicit local output path.
It never sends traces to AMOS automatically.

The harness disables Transformers Hub kernel replacement. Some optimized
GPT-OSS paths replace the MLP forward method and can bypass the router module
or omit router-logit output. Capture correctness matters more than peak
reference throughput.

## Simulator

```bash
npm run experiment:simulate -- \
  --trace path/to/trace.jsonl \
  --policies lru,lfu,slru,tinylfu \
  --slots 4,8,16,32,64,96 \
  --budgets-gib 32,40,46 \
  --verify-batches 1,2,4,8 \
  --acceptance-rates 0.5,0.75,1 \
  --concurrency 1,2 \
  --profile-trace path/to/separate-training.trace.jsonl \
  --read-gib-s MEASURED_SSD_GIB_PER_SECOND \
  --range-latency-ms MEASURED_RANGE_LATENCY_MS \
  --upload-gib-s MEASURED_METAL_UPLOAD_GIB_PER_SECOND \
  --slot-remap-ms MEASURED_SLOT_REMAP_MS
```

Use `--json` for a machine-readable report. The simulator reports:

- decode, workflow, and early/middle/long-sequence hit rates;
- a separate sequential layer-streaming estimate for prefill that never warms
  or pollutes the decode cache;
- cold bytes and p50/p95/p99/max cold bytes per token;
- p50/p95/p99 cache stall decomposed into seek, read, upload, and remap time
  when calibrated target-host inputs are supplied;
- cache and estimated shared-plus-cache resident footprint;
- the per-layer slot count that fits each requested total memory budget; and
- verification batch, assumed acceptance, and concurrency dimensions; and
- every policy/slot combination in the requested sweep.

The offline simulator has no model or GPU dependency, so large trace sweeps can
run cheaply before a Metal implementation exists.

Once the pinned llama.cpp/Metal runtime emits the same format, compare its
selected expert sets with the Transformers reference:

```bash
npm run experiment:compare -- \
  --reference path/to/transformers.trace.jsonl \
  --candidate path/to/llama-cpp.trace.jsonl
```
