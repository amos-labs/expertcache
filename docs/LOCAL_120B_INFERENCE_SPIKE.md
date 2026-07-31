# Local 120B inference spike

> Historical design record. AMOS references describe the original product
> research context; ExpertCache is now a standalone experimental runtime.

## Question

Can AMOS run a materially stronger open-weight model such as GPT-OSS 120B on
64 GB-class hardware with usable latency and quality, without pretending that
SSD swap is equivalent to memory?

GPT-OSS 120B is a useful target because it is a sparse mixture-of-experts model:

- 116.8B total parameters and 5.13B active parameters per token;
- 36 layers;
- 128 experts per MoE layer with four selected per token;
- a 60.8 GiB MXFP4 checkpoint;
- more than 90% of parameters in the MoE weights; and
- a native 131,072-token context ceiling.

Sources: the
[OpenAI model card](https://deploymentsafety.openai.com/gpt-oss/openai-prs)
and [release notes](https://openai.com/index/introducing-gpt-oss/).

The stock checkpoint leaves insufficient working headroom on a 64 GB machine.
The opportunity is to exploit expert sparsity rather than load or stream the
model like a dense 120B network.

## Hypotheses

### 1. Mixed low-bit expert quantization

Keep embeddings, unembedding, attention, normalization, router projections, and
quantization-sensitive experts at their qualified precision. Requantize tolerant
expert matrices to calibrated 2–3 bit formats.

Measure:

- resident bytes and model-load time;
- perplexity and AMOS qualification deltas;
- router stability relative to the reference checkpoint;
- tool and structured-output failures;
- generation and prompt-processing throughput.

This is the fastest path to determining whether the complete model can remain
resident. It is not assumed that requantizing an MXFP4-trained checkpoint will
preserve quality.

### 2. ExpertCache

Keep the shared attention path, router, embeddings, and a hot set of experts in
unified memory. Store cold experts in a memory-mapped, independently compressed
expert store.

For each layer:

1. evaluate the router;
2. identify the four selected experts;
3. serve resident experts immediately;
4. prefetch likely cold experts into a bounded cache;
5. record miss latency, reuse distance, and eviction.

The first spike should replay real AMOS qualification traces to learn whether
expert selection has useful locality across adjacent tokens and recurring
workflows. If routing is effectively random at the cache level, SSD-backed
execution will not be interactive.

The cache must fail predictably under pressure. macOS swap is not the cache
policy.

### 3. Private inference pool

Distribute experts across two or more AMOS Desktop peers on an authenticated
local network. Keep the shared path replicated or assign pipeline stages, then
batch expert requests to reduce communication overhead.

Evaluate:

- two 64 GB Apple Silicon systems over Thunderbolt and 10 GbE;
- expert parallelism versus layer pipeline parallelism;
- first-token and steady-state latency;
- peer loss, reconnection, and task cancellation;
- encrypted transport and device authorization;
- whether private company context must leave the initiating machine.

This can become an enterprise deployment profile if it is reliable, but a
single-machine path remains necessary for offline portability.

### 4. Speculative local hierarchy

Use GPT-OSS 20B or another qualified fast model to draft tokens, tool plans, or
structured artifacts. Let 120B verify batches rather than produce every token
serially.

This reduces verifier computation only after the 120B weight-access problem is
solved. Acceptance rate must be measured on AMOS workflows.

### 5. AMOS-specialized student

Use the stronger model as a teacher for a 20B–30B student trained on:

- reviewed AMOS workflows and tool traces;
- approval and receipt state distinctions;
- context-compiler evidence packages;
- code and verification fixtures;
- human corrections and reversals;
- bounded business outcomes with clear attribution limits.

The objective is not a general frontier replacement. It is a smaller model that
outperforms generic local models on governed company operations. Private tenant
data must not enter shared training without an explicit, isolated data contract.

## Prototype sequence

1. Run the [ExpertCache trace experiment](EXPERTCACHE_EXPERIMENT.md) before
   modifying the runtime.
2. Establish reference results for 20B and 120B on the same GPU host.
3. Convert the checkpoint into independently addressable shared and expert
   tensors; verify byte-for-byte reference output before compression.
4. Produce calibrated mixed-bit variants and run the complete AMOS
   qualification suite.
5. Add expert-routing telemetry and measure expert locality without paging.
6. Implement a read-only memory-mapped expert cache and replay fixed traces.
7. Test a two-node expert-parallel prototype.
8. Compare all approaches against a task-specialized student model on quality,
   latency, cost, and operational complexity.

## Go/no-go thresholds

Continue single-machine ExpertCache work only if a 64 GB system can achieve:

- no unbounded swap or UI starvation;
- repeatable startup and cancellation;
- at least a useful background-task throughput class;
- a meaningful qualification gain over the best 20B–30B resident model; and
- acceptable cold-expert miss behavior on real AMOS traces.

If those thresholds fail, prioritize the private inference pool and specialized
student. Fitting 120B is not itself the product outcome; better governed work per
dollar and per second is.
