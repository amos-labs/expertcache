# ExpertCache direct-view research result

> Publication note (2026-07-31): the coding evaluator was held out during the
> original run. Its prompt and executable tests are now disclosed in
> `scripts/benchmarkLocalModels.js`; future reruns validate regression and
> reproducibility, not performance on a fresh hidden set.

Date: 2026-07-29

## Status

ExpertCache has crossed its first live quality-and-memory gate on a 64 GB
Apple Silicon Mac.

The result is narrower than “GPT-OSS 120B is production-ready on a laptop,”
but stronger than a simulator result: the complete official GPT-OSS 120B
MXFP4 checkpoint executed an unchanged hidden coding diagnostic, passed all
three tests, and avoided catastrophic swap. The direct-view implementation was
2.23 times faster than the preceding grouped-copy implementation on observed
full-length wall time and 2.31 times faster on reported generation throughput.
The grouped full-length control predates the clean-machine reset, so these are
not yet publication-grade multipliers. The clean short A/B measured 98.1
versus 71.4 seconds and 1.83 versus 3.39 reported generation tok/s.

This document freezes the evidence needed to reproduce, challenge, and later
extract the work into a standalone open-source project and arXiv artifact.

## Research question

Can a mixture-of-experts checkpoint larger than the practical Metal working
set execute useful local inference by exposing only the experts selected for
the current token, without copying those experts into a second weight pool or
weakening model quality?

## Test system and artifacts

- host: Apple M1 Max, 64 GiB unified memory;
- model: `ggml-org/gpt-oss-120b-GGUF`;
- model revision: `238abdd290bb874b90a5da1b4549881b7d05c091`;
- artifact: `gpt-oss-120b-MXFP4.gguf`;
- artifact size: 63,387,346,208 bytes;
- llama.cpp revision:
  `7e1e28cae36d41fe7bbe9dae7c9625de6565c063`;
- context: 8,192 tokens;
- batch/micro-batch: 4/1 for the direct-view qualification run;
- completion allowance: 1,536 tokens; and
- evaluation: deterministic optimization-coding prompt with hidden optimum,
  tie-break, and input-immutability tests.

Model weights, private absolute paths, and full hidden benchmark outputs are
not committed. Pins, harnesses, the runtime patch, and explicitly labelled
synthetic/public probe outputs are committed.

## Result

| Runtime | Score | Wall time | Prompt rate | Generation rate |
|---|---:|---:|---:|---:|
| Bedrock GPT-OSS 120B | 3/3 | 11.9 s | — | 119.0 tok/s |
| first bounded local slots | 3/3 | 1,048.0 s | 0.95 tok/s | 0.93 tok/s |
| layer-grouped bounded copies | 3/3 | 714.9 s | 1.03 tok/s | 1.56 tok/s |
| direct selected-expert views | 3/3 | 320.6 s | 2.05 tok/s | 3.58 tok/s |

The direct-view run peaked at 47,622,258,688 bytes of process RSS and
44,763,709 bytes of measured system swap. Server readiness took 22.07 seconds.
The response passed the same hidden tests as the hosted and copied local
controls.

The latest demonstrated component results cover 14/16 points: the prior full
local run scored 11/16, and the subsequently corrected optimization-coding
arm passed its 3/3 hidden gate at the required 1,536-token allowance. This is
a composite across runs, not a contemporaneous 14/16 full-suite result. The
entire seven-scenario suite must still be rerun on this milestone before the
paper promotes a final quality score.

The full-length table records observed runs, not a counterbalanced performance
study. A clean grouped/direct A/B in both orders is a publication gate.

## Architecture

The original bounded path worked but copied every selected expert projection
from the memory-mapped GGUF into shared Metal slot buffers. Gate, up, and down
projections were grouped behind one routing synchronization, which reduced
barriers but retained the copy.

Instrumentation showed that copy boundary was the dominant cost:

- ordinary graph work: 19.8 seconds, 19.4%;
- selected-expert staging: 68.0 seconds, 66.5%;
- expert math: 12.9 seconds, 12.6%;
- tail: 1.2 seconds, 1.2%; and
- 315.6 GiB staged at an effective 5.0 GB/s during the short trace.

The direct-view path instead:

1. keeps the checkpoint memory mapped;
2. waits only until route IDs for the current layer are visible;
3. validates each selected expert ID;
4. creates a page-aligned Metal view over the exact selected expert range
   using `newBufferWithBytesNoCopy`;
5. adjusts activation and destination offsets for that route;
6. dispatches the existing quantized matrix-vector kernel for the selected
   expert; and
7. never binds the full routed projection or allocates duplicate expert
   weights.

The operating system can still page the backing checkpoint, but the runtime no
longer pays an unconditional user-space copy into a parallel resident cache.

## Rejected ablations

### Persistent LRU slots

Route replay suggested a 12-slot cache could reach a 45.8% logical hit rate.
In live inference it reduced bytes copied but lowered effective transfer
throughput to 2.38 GB/s and took 112.9 seconds on the short probe. The
comparable warm grouped control took 98.1 seconds.

The explicit LRU duplicated macOS file-page caching: many logical hits were
already warm file pages, while the additional resident pool pressured the
pages that still mattered. It is rejected.

### Parallel gate/up/down copies

Parallel staging reduced measured copy time by approximately 7.8%, but the
short probe took 99.7 seconds versus the 98.1-second warm grouped control.
Contention moved time into ordinary graph work instead of improving total
latency. It is rejected.

### Wider expert blocks

Four- and 32-token blocks widened the cold checkpoint region too quickly.
They entered severe paging or swap stalls despite having modest explicit slot
allocations. Logical cache capacity is not the same as a bounded physical
working set.

## Current limitations

- The validated zero-copy path supports token-at-a-time routed expert work
  (`ne21 == 1`). Prefill is deliberately micro-batched at one token.
- It creates and encodes multiple selected-expert views per projection.
  Reusing safe views and reducing dispatch count may improve speed.
- One Mac and one oversized MoE checkpoint have been validated.
- The full qualification suite, long sessions, cancellation, thermal
  stability, and application-level concurrency require milestone reruns.
- The implementation is an experimental llama.cpp patch, not an upstream API
  or a released AMOS Desktop default.

## Open-source extraction boundary

The eventual standalone project should contain:

- a small llama.cpp patch or upstreamable backend extension;
- an architecture-neutral route/working-set trace schema;
- a pinned model and runtime manifest;
- benchmark and telemetry runners;
- synthetic/public evaluation prompts;
- cold/warm host-state capture;
- output-equivalence and quality checks;
- reproducible ablation switches; and
- machine-readable result bundles.

AMOS-specific product routing, company data, tenant policy, credentials, and
private receipts do not belong in that repository. AMOS should consume the
runtime as an inference backend rather than become the research artifact.

## Publication gates

Before an arXiv submission:

1. reproduce cold and warm runs at least three times;
2. publish median and dispersion, not a single best run;
3. keep 16/32 GiB physical-host studies supplemental unless their claims are
   added to the paper;
4. pass the pinned official GPT-OSS 20B MXFP4 same-family portability gate;
5. leave a second oversized architecture as a separately qualified follow-on;
6. run the frozen full quality suite and output-equivalence checks;
7. measure time to first token, prompt and decode throughput, RSS, compressed
   memory, swap, page faults, bytes touched, and energy/thermal behavior;
8. compare stock failure, copied slots, grouped copies, persistent cache,
   parallel staging, and direct views;
9. document all unsuccessful designs and evaluator limitations; and
10. package scripts, pins, and raw machine-readable measurements as an
   artifact.

The defensible claim today is:

> A bounded, page-aware direct-view Metal runtime executed an MoE checkpoint
> larger than the practical unified-memory working set on a 64 GB Mac,
> preserved the targeted task result, and avoided catastrophic swap.

Claims about universal quality, production readiness, or superiority across
models require the remaining experiments.
