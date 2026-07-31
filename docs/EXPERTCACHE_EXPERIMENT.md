# ExpertCache experiment

> Historical design record. AMOS references describe the program in which the
> experiment originated; the current standalone boundary is documented in the
> repository README and `PROVENANCE.md`.

## Objective

Determine whether GPT-OSS 120B can deliver useful AMOS inference on a 64 GB
Apple Silicon machine by exploiting its sparse expert activation instead of
loading every expert into Metal or relying on uncontrolled macOS swap.

GPT-OSS 120B has 116.8B total parameters but activates about 5.13B per token.
Its official MXFP4 checkpoint is approximately 60.8 GiB and is intended to fit
an 80 GB accelerator. That is too close to the full memory of a 64 GB Mac once
KV cache, the shared path, runtime buffers, and the operating system are
included.

ExpertCache is successful only if it improves governed work per second and per
dollar. Merely producing a token from a nominally loaded 120B model is not a
product result.

The non-negotiable capability invariant is:

> Cache state may change latency and resource use. It must never change model
> numerics, selected experts, tool policy, or output.

A capability contract is valid only for the exact model digest, runtime
revision, quantization, cache policy, and slot layout that passed this
invariant.

## What upstream work changes

llama.cpp already exposes useful seams:

- `--cpu-moe` and `--n-cpu-moe` can keep expert tensors outside GPU memory;
- selected expert IDs are available in the scheduler before expert
  multiplication;
- model files are memory-mapped and can accept explicit readahead hints; and
- current experimental work is testing persistent expert-slot caches rather
  than copying selected rows into a full-size transient tensor every pass.

The most relevant upstream reports are:

- [two-tier expert cache proposal and Apple notes](https://github.com/ggml-org/llama.cpp/issues/20757);
- [current MoE cache RFC and benchmark discussion](https://github.com/ggml-org/llama.cpp/discussions/24528);
- [mmap and selected-expert prefetch experiments](https://github.com/ggml-org/llama.cpp/discussions/18758); and
- [official GPT-OSS 120B model card](https://huggingface.co/openai/gpt-oss-120b).

These reports also show the trap: a compact Metal cache added beside still-live
original expert tensors increases memory. The Apple path must prevent cold
experts from being loaded into Metal in the first place and load selected
expert bytes into a bounded slot pool.

## Architecture under test

```text
resident shared path
  embeddings + attention + routers + norms + output
                |
                v
        top-4 expert IDs / layer
                |
        +-------+--------+
        | persistent hit |
        | in Metal slots |
        +-------+--------+
                |
          miss / admission
                |
        mmap expert store on SSD
        + bounded RAM staging
        + async prefetch
```

The cache is per layer. A global expert ID is remapped to a compact resident
slot. The kernel consumes slot IDs, not offsets into a full 128-expert Metal
tensor.

## Phase 0 — trace before runtime work

Run the reference 120B checkpoint on an 80 GB accelerator and record, for every
token and layer:

- selected top-4 expert IDs;
- prefill versus decode phase;
- workflow, skill, tool surface, and context-compiler fingerprint;
- prompt and generation token counts;
- accepted speculative-draft spans, when present; and
- qualification result.

Use synthetic and company-safe AMOS tasks only. No tenant payload enters the
trace corpus without an explicit training/benchmark data contract.

Replay those traces through an offline simulator with:

- LRU, LFU, segmented LRU, and TinyLFU admission;
- 4, 8, 16, 32, 64, and 96 slots per layer;
- layer-ordered prefill streaming that never contaminates the decode cache;
- sorted adjacent range reads versus bounded overread;
- next-token, next-layer, and workflow-conditioned prefetch; and
- 32 GiB, 40 GiB, and 46 GiB resident budgets.

The simulator reports hit rate, cold bytes per accepted token, range count per
token, reuse distance, worst-case miss bursts, and p50/p95/p99 cache-induced
stall decomposed into range latency, SSD transfer, Metal upload, and slot
remapping. Policy ranking uses p95 stall, not hit rate alone. This is the
cheapest point at which to kill a weak hypothesis.

Do not infer a product result from one aggregate number. Reports are stratified
by workflow and decode position. The full run includes:

- one greedy reproducibility trace and a separately labelled sampled arm;
- single-stream and two-stream replay;
- verification batches of 1, 2, 4, and 8 tokens at measured acceptance rates;
- a GPT-OSS 20B control for every workflow; and
- train/evaluation splits for any workflow-conditioned prewarm profile.

Profiles must be learned only from the training split. A profile built from the
same trace it is evaluated on is data leakage, not evidence of locality.

Phase 0 now includes the privacy-safe
[routing trace contract](EXPERTCACHE_TRACE_FORMAT.md) and an executable policy
sweep:

```bash
npm run experiment:simulate -- \
  --trace test/fixtures/expert-cache-trace.jsonl \
  --policies lru,lfu,slru,tinylfu \
  --slots 4,8,16,32,64,96 \
  --budgets-gib 32,40,46 \
  --verify-batches 1,2,4,8 \
  --acceptance-rates 0.5,0.75,1 \
  --concurrency 1,2 \
  --profile-trace PATH_TO_SEPARATE_TRAINING_TRACE \
  --read-gib-s MEASURED_SSD_GIB_PER_SECOND \
  --range-latency-ms MEASURED_RANGE_LATENCY_MS \
  --upload-gib-s MEASURED_METAL_UPLOAD_GIB_PER_SECOND \
  --slot-remap-ms MEASURED_SLOT_REMAP_MS
```

The checked-in fixture proves parsing and cache accounting. It is not evidence
about GPT-OSS expert locality; that requires reference-model traces.

The latency inputs are mandatory for a stall-ranked go/no report and must be
measured on the target Mac. The simulator uses a deliberately conservative
additive model:

```text
stall = ranges × seek
      + cold bytes ÷ SSD bandwidth
      + cold bytes ÷ Metal upload bandwidth
      + misses × slot-remap cost
```

The prototype must then validate the modeled p95 against wall-clock telemetry.

The reference capture harness is checked in at
[the reproducibility harness](REPRODUCIBILITY.md). It pins the
official GPT-OSS checkpoint revision and Transformers implementation, rejects
extra input fields, requires an explicit safe-data acknowledgement, records no
prompt or generated text, and fails the run if its bounded writer drops any
routing record.

## Phase 1 — selective unified-memory loader

Phase 1 is complete with a **no-go** verdict for mmap page advice on the tested
64 GB M1 Max. The bounded SLRU arm made the page replay 2.37 times faster than
natural mmap, but p95 physical cold reads remained 449.8 MiB and task-boundary
bursts exceeded 700 MiB. See the
[Phase 1 results](PHASE_ONE_RESULTS.md). Per this
plan, AMOS stops this architecture before carrying a permanent llama.cpp fork
or making a local-120B product claim.

Phase 1 pins official llama.cpp in
[`runtime-manifest.json`](../runtime/runtime-manifest.json)
and treats the newer CUDA hybrid-cache branch as a design and correctness
reference, not as code to copy blindly.

The architecture changed after upstream published an important negative Metal
result: forcing `MUL_MAT_ID` onto Metal and remapping compact expert slots
introduced per-layer synchronization and ran roughly 2× slower than stock even
at a 97–99% cache hit rate. Apple silicon also has unified memory rather than a
discrete PCIe CPU→GPU boundary. The first Mac implementation therefore uses the
existing mmap-backed Metal buffers and explicitly manages their resident page
working set:

1. load and compute shared tensors through stock llama.cpp/Metal;
2. derive exact file byte ranges for every `ffn_*_exps` expert from the GGUF
   metadata;
3. keep the model file mapped without eagerly materializing every expert;
4. issue bounded `MADV_WILLNEED` hints and touch selected expert pages;
5. protect reused decode experts with a per-layer LRU or SLRU working set;
6. release unshared evicted pages with `MADV_DONTNEED` where the host supports
   it;
7. preserve `--mode natural` as the unmodified mmap control and
   `--mode disabled` as the hard-off microbenchmark arm; and
8. report page faults, resident memory, actual access latency, cold bytes,
   admissions, evictions, and cache hits without logging prompt content.

The page replay is deliberately separate from the live Metal graph first. It
must prove that the traced working set produces a real memory/latency advantage
on mapped GPT-OSS weights before a no-sync completion-hook prefetcher is added
to the runtime. If it does not, Phase 1 stops without carrying a permanent
llama.cpp fork.

Prepare and compile the exact control runtime:

```bash
npm run runtime:prepare
```

Build a byte layout from one or more GGUF shards:

```bash
npm run harness:layout -- \
  --gguf /models/gpt-oss-120b-part-1.gguf \
  --gguf /models/gpt-oss-120b-part-2.gguf \
  --gguf-python ~/.cache/expertcache/llama.cpp/gguf-py \
  --source-revision 7e1e28cae36d41fe7bbe9dae7c9625de6565c063 \
  --output output/gpt-oss-120b.layout.json
```

Replay the captured route against real model pages:

```bash
npm run experiment:phase-one -- \
  --gguf /models/gpt-oss-120b-MXFP4.gguf \
  --trace output/gpt-oss-120b.trace.jsonl \
  --gguf-python ~/.cache/expertcache/llama.cpp/gguf-py \
  --phase decode \
  --cache-candidate slru:63:1 \
  --output-dir output/phase-one
```

The runner executes hard-off, natural mmap, and each requested bounded
candidate as separate cold-start processes. A candidate uses
`POLICY:SLOTS:ADMIT_AFTER`; repeat `--cache-candidate` to compare policies.
Each arm issues `MADV_DONTNEED` across the clean mapping before timing.
`--trace-id` and `--workflow` can be repeated to select a held-out slice. The
report distinguishes policy-level logical hits from `mincore`-observed physical
page residency, stratifies every workflow and trace, and records the cold burst
at each task boundary. A logical hit whose pages were evicted is not presented
as a real cache hit. Use `experiment:expert-pages` directly for a single
diagnostic arm.

Two prewarm diagnostics are supported:

- `--profile-trace TRAIN.jsonl --prewarm-experts-per-layer N` ranks experts
  from a separate training split; and
- `--prewarm-from-prefill N` uses only routing already observed during the
  current task's prompt prefill.

`--prewarm-admission physical-only` keeps the diagnostic outside the logical
cache, while `cache` explicitly seeds it. Neither prewarm mode rescued the
tested mapped-page architecture; they remain in the harness so the negative
result is reproducible.

Once the page gate passes, first prove bit-equivalent model output because page
advice must never change the math. Quality comparisons before that equivalence
check are not meaningful.

Compare selected top-4 sets from the pinned Transformers reference and the
pinned llama.cpp/Metal runtime on the same greedy corpus. Near-tie differences
must be investigated before locality results are trusted.

```bash
npm run experiment:compare -- \
  --reference path/to/transformers.trace.jsonl \
  --candidate path/to/llama-cpp.trace.jsonl
```

The product integration target remains a small patch carried in AMOS's bundled
Ollama llama.cpp runtime, preserving one lifecycle, updater, and trust chain. A
separate runtime checkout is an experiment harness, not the shipping
architecture.

## Phase 2 — AMOS integration

Expose ExpertCache as an experimental background profile:

- never the first-run default;
- no silent system swap as an operating mode;
- cancellation and memory-pressure handling;
- explicit startup/prewarm status;
- signed model and runtime digests;
- local-only telemetry by default; and
- a capability contract tied to the exact runtime revision and cache policy.

GPT-OSS 20B can draft tool plans or response blocks. The 120B model verifies
batches only if measured speculative acceptance reduces total wall time.
`verify-batch K` replays the union of the next K tokens' expert sets and
amortizes misses over accepted tokens; the idealized 100% acceptance arm is
never presented as a production result.

Local concurrent jobs are serialized by default. Two-stream operation is
enabled only after the two-stream replay and prototype remain inside the same
stall, memory, and thermal gates.

## Go/no-go gates

Proceed from trace simulation to a Metal prototype only if at least one bounded
policy achieves:

- an aspirational 90% decode expert hit rate, with misses and stalls reported
  separately for every workflow and decode-position bucket;
- modeled p95 cache stall below 80 ms per accepted token on calibrated 64 GB
  Mac storage and upload measurements;
- cold reads below 250 MiB per generated token at p95;
- no unbounded miss burst caused by a workflow switch; and
- an estimated complete resident footprint at or below 46 GiB.

The hit-rate target is diagnostic rather than an independent pass: a lower hit
rate may proceed only if measured stall stays inside the hard bound. A high hit
rate with long miss stalls fails.

Proceed from prototype to product integration only if the 64 GB Mac achieves:

- at least 6 generated tokens/second for background work;
- first useful output within 20 seconds on a 4K compiled prompt;
- no swap growth, UI starvation, or memory-pressure termination;
- no thermal runaway or sustained battery drain that makes normal desktop work
  impractical;
- deterministic cancellation and restart;
- bit-equivalent output versus the stock runtime for the same quantized model;
- a statistically meaningful qualification gain over GPT-OSS 20B, including
  flipping the parked-approval narration and hard optimization-code floors;
- a measurable reduction in managed-frontier escalation rate; and
- a better quality-latency-cost point than managed 120B verification.

If the cache misses these gates, stop. Use a private two-node inference pool,
more aggressive qualified quantization, hosted 120B review, or the
AMOS-specialized student instead.

## Experimental matrix

| Variant | Shared path | Experts | Context | Purpose |
|---|---|---|---:|---|
| Reference | official precision | official MXFP4, resident on 80 GB GPU | 32K | Quality truth |
| Full Mac attempt | official | stock mmap/swap behavior | 8K | Establish failure mode only |
| Mixed-bit resident | protected shared tensors | calibrated 2–3 bit experts | 32K | Test complete residency |
| ExpertCache | protected shared tensors | MXFP4 cold store + Metal hot slots | 32K | Main hypothesis |
| Draft/verify | GPT-OSS 20B draft | ExpertCache 120B verify | 32K | Reduce verifier work |
| Two-node | shared path replicated | expert or layer partition | 32K | Private enterprise fallback |

Every row runs the same AMOS qualification and context suites.
