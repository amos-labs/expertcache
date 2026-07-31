# ExpertCache Phase 1 results

Date: 2026-07-28

## Verdict

**No-go for the mmap page-advice architecture on a 64 GB Apple Silicon
machine.**

The bounded SLRU working set produced a real mapped-page replay advantage, but
it did not satisfy the physical cold-read or workflow-switch bounds. AMOS
should not carry a llama.cpp runtime patch based on this design and should not
describe GPT-OSS 120B as locally production-ready on this hardware.

This is a page-replay result, not a model-throughput result. It does not claim
that inference ran 2.37 times faster.

## Exact test inputs

- Host: Apple M1 Max, 64 GiB unified memory, 10 logical CPUs
- Model: `ggml-org/gpt-oss-120b-GGUF`
- Model revision: `238abdd290bb874b90a5da1b4549881b7d05c091`
- Artifact: `gpt-oss-120b-MXFP4.gguf`
- Artifact size: 63,387,346,208 bytes
- Artifact Xet ETag:
  `582bd40f6886200101f4c4ed9f25f3fe80cc14c86e9e2b37746cd8904a0c622d`
- llama.cpp revision: `7e1e28cae36d41fe7bbe9dae7c9625de6565c063`
- Evaluation: four held-out workflows, 508 decode tokens, 73,152 expert
  accesses
- Workflows: document synthesis, company audit, tool orchestration, and
  approval review
- Cold start: clean mapped pages advised with `MADV_DONTNEED` before each arm

The harness parsed 36 router-bearing layers, 128 experts per layer, and
13,219,200 bytes per layer expert directly from the pinned GGUF.

## Held-out mapped-page result

| Arm | Elapsed | p95 access | p95 physical cold/token | Worst workflow p95 | Largest task-boundary burst |
|---|---:|---:|---:|---:|---:|
| Hard off | 459.1 s | 1,723 ms | 637.2 MiB | 670.0 MiB | 1,127.6 MiB |
| Natural mmap | 360.3 s | 1,765 ms | 538.3 MiB | 626.7 MiB | 817.6 MiB |
| SLRU, 63 slots/layer | 152.0 s | 594 ms | 449.8 MiB | 476.4 MiB | 725.2 MiB |

The bounded arm was:

- 2.37 times faster than natural mmap in the page replay;
- 66% lower at p95 mapped-page access latency than natural mmap;
- 16% lower at aggregate p95 physical cold bytes than natural mmap;
- above 90% logical hit rate across the four-workflow run; and
- approximately 31.9 GiB for complete expert slots plus the measured shared
  resident estimate.

Those gains do not override the failed hard gates:

- aggregate p95 physical cold reads were 449.8 MiB, not at or below 250 MiB;
- the worst workflow p95 was 476.4 MiB;
- two workflow transitions still produced physical cold bursts above
  700 MiB; and
- `mincore` showed that logical cache membership did not guarantee physical
  residency under macOS memory pressure.

## Rejected refinements

### Larger SLRU working set

An 81-slot calibration increased memory pressure and performed worse than the
63-slot arm. More logical capacity did not create more dependable physical
residency.

### Admit on second use

Requiring a second access before LRU admission lowered logical hit rate and
increased both elapsed time and physical cold reads. It was rejected.

### Training-derived workflow prewarm

A profile learned from the separate training split improved logical hits but
loaded approximately 10.6 GB before two calibration task starts, cost 11.6
seconds, and increased physical p95 cold reads. Static workflow popularity was
too blunt for this purpose.

### Current-prompt prefill prewarm

Using only experts observed during the current prompt's earlier prefill phase
was tested as an online signal, not as a trained evaluation profile. A
16-expert-per-layer physical prewarm brought the first decode token below the
250 MiB bound in the two-task calibration, but it displaced other useful
pages. Overall p95 cold reads increased, even after unused prewarm pages were
released after the first token.

This can be useful as a narrow first-token experiment, but it does not rescue
the mapped-page architecture.

## Engineering conclusion

The experiment validated two separate facts:

1. GPT-OSS expert routing has enough locality for a bounded cache to matter.
2. macOS mmap page advice cannot enforce that cache as physical residency.

A future 120B-on-Mac experiment must therefore change the ownership boundary,
not keep tuning page hints. Plausible paths are:

- a true explicitly allocated expert slot pool whose pages cannot be silently
  reclaimed, provided the Metal graph can consume compact slot IDs without
  per-layer synchronization erasing the gain;
- a more aggressive qualified quantization that permits complete residency;
- GPT-OSS 20B or an AMOS-specialized student as the dependable local model;
- hosted 120B review or verification; or
- a private multi-node inference pool for sovereign deployments.

Per the experiment plan, live Metal quality, output-equivalence, throughput,
thermal, and product-integration gates do not run after this page gate fails.

## Reproduce

Prepare the pinned runtime and use the exact model revision listed above. Then
run:

```bash
npm run experiment:phase-one -- \
  --gguf /models/gpt-oss-120b-MXFP4.gguf \
  --trace /traces/gpt-oss-120b.evaluation.greedy.trace.jsonl \
  --gguf-python /path/to/pinned-llama.cpp/gguf-py \
  --phase decode \
  --trace-id eval-injection-001 \
  --trace-id eval-evidence-001 \
  --trace-id eval-tenant-001 \
  --trace-id eval-approval-001 \
  --cache-candidate slru:63:1 \
  --output-dir /tmp/expertcache-phase-one
```

Raw model weights, route traces, and machine-local absolute paths are not
committed to this repository.
