# ExpertCache latency ceilings and route-window locality

## Decision

Batching exposes substantial headroom, but the current direct-view
implementation is limited by both per-route dispatch and real expert
residency. With a synthetic four-expert hot working set, the corrected pinned
Metal runtime processed a real 145-token prompt at **24.84 tokens/second** with
a 64-token batch. The same corrected path with real routing reached
**6.27 tokens/second**. The next implementation must group tokens by expert and
own or prefetch the bounded route window rather than launch one matrix-vector
operation per token/expert pair.

The real, content-free route trace is encouraging. Across sliding 64-token
windows, each layer used:

- 61.8 unique experts on average;
- 79 experts at p95 across individual layer-window observations; and
- 98 experts in the worst observed layer-window.

The corresponding full-model expert working set averaged **27.4 GiB** and
reached **30.2 GiB** in the worst observed window. This is a bounded locality
problem, not an immediate collapse to all 128 experts in every layer.

## Reproducible measurements

All measurements use:

- GPT-OSS 120B MXFP4, pinned artifact revision
  `238abdd290bb874b90a5da1b4549881b7d05c091`;
- llama.cpp revision
  `7e1e28cae36d41fe7bbe9dae7c9625de6565c063`;
- a 64 GB M1 Max Mac; and
- the same hidden AMOS optimization-coding diagnostic.

| Arm | Prompt tok/s | Decode tok/s | Wall time | Quality |
| --- | ---: | ---: | ---: | --- |
| Direct views, real routing, 1,536-token allowance | 3.58 | 3.58 aggregate | 320.6 s | 3/3 |
| Synthetic hot experts, batch 4 | 7.32 | 7.00 | 24.4 s | Invalid by design |
| Synthetic hot experts, batch 16 | 23.02 | 7.48 | 10.6 s | Invalid by design |
| Synthetic hot experts, corrected batch 64 | **24.84** | 5.40 | 11.8 s | Invalid by design |
| Real routing, corrected batch 64, 32-token cap | 6.27 | 3.12 | 33.4 s | Plausible but truncated |
| Real routing, corrected batch 64, 1,536-token allowance | **5.77** | **3.07** | **173.0 s** | **3/3** |
| Real routing, native low reasoning, 512-token cap | 2.96 | 3.79 | 183.6 s | 3/3 |

The hot-expert arms intentionally rewrite routing to four fixed experts. They
are performance ceilings only and cannot support a capability claim. Their
purpose is to isolate compute and dispatch from storage faults.

An earlier experimental batch-64 arm reported 74.24 prompt tokens/second. It
entered llama.cpp's matrix-matrix branch before the direct-view branch even
though the direct-view weight buffer was intentionally unset. That number is
invalid, is excluded from the table, and must not be used in a performance
claim.

An initial 256-token low-reasoning arm began a plausible implementation but hit
the output cap mid-function. After reverting an unrelated experimental
multi-token direct-view regression, the clean 512-token arm passed the hidden
optimum, tie-break, and immutability tests at 3/3. It used 511 generated tokens
and finished in 183.6 seconds. This preserves measured quality for one hard
coding case and cuts wall time by roughly 43% against the prior 320.6-second
direct-view result. It is not yet evidence that low reasoning preserves
governance, evidence synthesis, or multi-tool reliability across the full
qualification suite.

The corrected real-routing batch-64 arm generated 454 tokens and passed the
same hidden optimum, tie-break, and input-immutability tests. Its peak process
RSS was 47.4 GB on a host whose swap state had already been affected by prior
experiments, so the throughput and quality result is valid but the memory
measurement requires a clean reboot before publication.

## Rejected persistent-slot follow-up

A persistent compact-slot LRU was implemented after the route-window analysis
showed substantial reuse. The first implementation exposed two independent
correctness gates:

1. expert-cache candidacy was evaluated before the router had produced valid
   IDs, causing the runtime to submit the complete 2,020-node graph and hit
   Metal OOM; and
2. the packed compact-ID buffer retained the original padded per-token stride,
   so multi-token batches read the wrong IDs after token zero.

Both defects were isolated and corrected. A deterministic raw-output check
then matched the zero-copy trajectory character-for-character at both
micro-batch one and micro-batch four.

The corrected persistent cache nevertheless lost to zero-copy:

| Corrected arm | Prompt tok/s | Decode tok/s | Raw trajectory |
| --- | ---: | ---: | --- |
| Zero-copy, batch 4 | **4.11** | **2.33** | Reference |
| Persistent 16 slots, batch 4 | 1.88 | 1.94 | Exact match |
| Persistent 32 slots, batch 8 | 1.76 | 1.45 | Exact match |

These short arms ran after several memory-pressure experiments and are
decision-grade rather than publication-grade. The direction is unambiguous:
larger owned pools recreate unified-memory pressure faster than logical route
reuse repays the copy and residency cost. The persistent LRU remains a
documented rejected arm and is not included in the release patch.

## Real route-window growth

The analyzer reads only `ExpertCache stage` lines for the gate projection.
Prompt content and generated text are absent. Gate, up, and down projections
share routing IDs, so counting the gate once avoids tripling each selection.

| Window | Mean experts/layer | p95 experts/layer | Max experts/layer | Mean expert working set | Route reuse |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 4.0 | 4 | 4 | 1.77 GiB | 0.0% |
| 2 | 7.0 | 8 | 8 | 3.10 GiB | 12.5% |
| 4 | 11.9 | 15 | 16 | 5.25 GiB | 25.9% |
| 8 | 19.4 | 25 | 31 | 8.58 GiB | 39.5% |
| 16 | 30.1 | 40 | 56 | 13.36 GiB | 52.9% |
| 32 | 44.3 | 58 | 78 | 19.63 GiB | 65.4% |
| 64 | 61.8 | 79 | 98 | 27.38 GiB | 75.9% |

Reproduce the calculation with:

```bash
npm run experiment:route-unions -- \
  --log PATH_TO_LLAMA_SERVER_LOG \
  --output output/route-window-unions.json
```

The working-set estimate multiplies unique experts by 13,219,200 bytes for the
three expert projections and all 36 layers. It does not include shared model
weights, KV cache, runtime buffers, or the operating system.

## What the measurements change

The corrected 24.84 tok/s hot result is 3.4 times the earlier 7.32 tok/s hot
batch-4 prompt result, so batching is still material. It does not yet exceed
the approximately 45 tok/s verification throughput needed to support an
894-token response in 20 seconds. Serial autoregressive decode remains near
five tok/s even with hot experts, so ordinary one-token decode cannot reach
that target.

The real-routing result is 3.96 times slower than the corrected hot ceiling,
which separately exposes the expert-residency cost. The architecture should
therefore optimize for:

1. batched verification of proposed tokens;
2. explicit ownership of the bounded real expert working set;
3. expert-grouped compute so each resident expert is dispatched once for all
   routed tokens in the batch;
4. smaller adaptive batches when a route window exceeds the safe resident
   budget; and
5. receipt-backed routing between local inference and managed intelligence
   when local latency or confidence misses its contract.

The corrected real-routing batch-64 arm has passed its full targeted quality
gate. The next runtime milestone is an expert-grouped matrix path plus explicit
residency telemetry; speculative decoding should be layered only onto kernels
that retain the deterministic trajectory and hidden-test result.

## Expert-grouped dispatch result

The expert-grouped path is now implemented as
`GGML_METAL_EXPERT_CACHE_GROUPED` (runner flag `--expert-cache-grouped`,
requires zero-copy). `kernel_mul_mv_id_gathered` receives a per-expert
`(token, expert-use slot)` route map, so every token routed to one expert
shares a single dispatch against that expert's zero-copy weight view. The
kernel wraps the identical MXFP4 matrix-vector implementation, and grouping
only reorders independent output writes, so the math is unchanged by
construction. Single-token decode keeps the per-route path because grouping a
one-token batch is pure bookkeeping overhead.

Correctness was verified by character-for-character raw-trajectory comparison
against the per-route zero-copy control on the same deterministic 32-token
request, at micro-batch 4 and micro-batch 64, with both real routing and the
synthetic hot ceiling. All four comparisons matched exactly.

Measured on the same 64 GB M1 Max (decision-grade: the host had accumulated
swap and page-cache churn from repeated experiments; a clean-boot rerun is
required before publication):

| Arm (batch 64, 361-token prompt for hot, 99-token for real) | Prompt tok/s | Decode tok/s |
| --- | ---: | ---: |
| Hot ceiling, per-route | 25.3 | 5.0 |
| Hot ceiling, grouped | **78.0** | 5.0 |
| Real routing, per-route (contemporaneous control) | 4.0–5.1 | 2.2–3.1 |
| Real routing, grouped | 4.6–5.5 | 2.4–2.5 |

Two conclusions:

1. **The compute path now exceeds the ~45 tok/s verification target.** The
   grouped hot ceiling is 3.08 times the per-route hot ceiling, and unlike the
   retracted 74.24 number, this measurement goes through the quality-bearing
   kernel and is bit-exact against the validated control. Per-route dispatch
   overhead — not the M1 Max compute path — was the ceiling's limiter.
2. **Real-routing prefill is confirmed residency-bound.** Grouping moves real
   prompt throughput by roughly 10% at most (within host drift), while the
   same kernel is 3 times faster on hot experts. The ~14× gap between the
   grouped hot ceiling and grouped real routing is expert page faults, which
   no dispatch change can close. The next lever is explicit prefetch or
   ownership of the measured 27–30 GiB route window, and speculative
   verification batches that keep the routed working set warm.

## Async routed-union prefetch result

`GGML_METAL_EXPERT_CACHE_PREFETCH=N` (runner flag `--expert-cache-prefetch N`)
starts N background threads that touch mapped expert pages so cold page-ins
overlap GPU compute instead of serializing at command-buffer schedule time.
At CPU staging time — when a layer's routing is known — the workers (1) race
the Metal driver on this layer's routed ranges with parallel reads, and
(2) prefetch the recent route union (`_WINDOW`, default 16 builds) for the
next `_AHEAD` (default 3) expert tensors, wrapping so the last layer warms
layer 0 for the next token. The prefetcher only reads a read-only file
mapping: it can change latency, never bytes.

Deterministic 32-token raw-prompt A/B/A on the 361-token prompt, grouped
zero-copy runtime, batch 64 (decision-grade host, run order listed):

| Arm | Prompt tok/s | Decode tok/s | Output |
| --- | ---: | ---: | --- |
| Grouped, no prefetch (coldest) | 16.6 | 2.73 | reference |
| Grouped + prefetch 6 threads | **23.6** | **2.90** | bit-exact |
| Grouped, no prefetch (warmest, ran last) | 18.6 | 2.62 | bit-exact |

The prefetch arm beat the warmer-than-itself trailing control by 27% on
prompt throughput (42% against the colder leading control) and was the only
configuration to also lift decode. Twelve threads with lookahead 6 added ~3%
prompt but regressed decode to 2.38; six threads with lookahead 3 is the
default. The repetitive raw prompt routes more locally than the 99-token chat
prompt (16.6 versus ~5 tok/s base), so gains must also be confirmed on the
hidden coding gate before being quoted.

The confirmation passed. The full hidden coding gate with grouped dispatch
plus six prefetch threads scored **3/3** at batch 64 with the 1,536-token
allowance, generating exactly the same 1,128-token trajectory as the
no-prefetch grouped arm (bit-exactness held over the full generation, not
only the 32-token probes). Prompt evaluation on the real coding prompt rose
from 5.75 to **9.80 tok/s (+70%)**; decode was 3.24 versus 3.38 tok/s
(within host drift); system swap did not grow during the run. Wall time was
decode-dominated and therefore roughly flat — the prefetcher's value today
is prefill and batched verification, which is exactly the speculative-decoding
verifier profile.

The grouped arm passed the full hidden coding gate at batch 64/micro-batch 64
with a 1,536-token allowance: 3/3 (hidden optimum, tie-break, immutability),
1,128 generated tokens, 358.5 seconds on the contaminated host, 5.75 prompt
and 3.38 decode tok/s. The wall time is not comparable to the 173.0-second
per-route batch-64 arm because the runs used different reasoning trajectories
and host states; the comparable claims are the bit-exact 32-token equivalence
and the hot-ceiling ratio above. Because grouping only changes which launch
computes each output element — never the weights, inputs, or accumulation
order within an element — per-element math is identical to the per-route path
at any generation length, not merely the tested prefix.
