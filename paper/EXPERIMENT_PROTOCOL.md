# Registered publication experiment protocol

Protocol version: 1.0-draft, 2026-07-31.

Any departure from this protocol must be recorded in the run manifest before
the affected result is used. Runs are never deleted because they are slow or
negative; exclusions require a machine-readable reason.

## Research questions

1. Can selected-expert direct views execute an oversized sparse checkpoint
   within the practical Metal working-set limit while preserving output math?
2. How much do grouped dispatch and routed-union prefetch change prefill,
   decode, page-in, memory, energy, and thermal behavior?
3. Does the correctness-bearing path reproduce on a second official sparse
   checkpoint in the same model family, and---as an explicitly supplemental
   study---on lower-memory Apple Silicon?
4. Is the remaining decode ceiling primarily routing/residency latency, and
   does batched draft verification provide a viable next path?

## Frozen primary artifacts

- Model: `ggml-org/gpt-oss-120b-GGUF`, revision
  `238abdd290bb874b90a5da1b4549881b7d05c091`, file
  `gpt-oss-120b-MXFP4.gguf`, 63,387,346,208 bytes.
- Runtime: `ggml-org/llama.cpp` revision
  `7e1e28cae36d41fe7bbe9dae7c9625de6565c063`.
- Patch: SHA-256
  `6bb978ab189ded46b131edea81fbe0740d7d527797be553f91312e4704f76a63`.
- Context: 8,192 tokens for the primary matrix.
- Sampling: temperature 0, seed 42 where the endpoint exposes it.
- Quality: public deterministic probes plus the frozen seven-scenario,
  16-point AMOS suite;
  prompts, evaluators, complete synthetic response messages, finish reasons,
  token usage, and SHA-256 digests are disclosed in the artifact.

The registered secondary checkpoint is `ggml-org/gpt-oss-20b-GGUF`, revision
`ef9b12f2ff56c69cf32153a02784e7a3c88bf524`, file
`gpt-oss-20b-MXFP4.gguf`, 12,109,566,624 bytes, SHA-256
`27cd6c432c7672cb812a92f611cf3ba7bbc35928262bb1e1253ff4ee6ae35901`.
It is a same-family, same-quantization portability control. It is not
oversized on the primary host and is not a second model architecture.

## Arms

| ID | Description | Quality-bearing? | Primary purpose |
| --- | --- | --- | --- |
| `stock` | pinned unmodified placement | no token expected on 64 GiB | bounded failure control |
| `copied-slots` | selected expert copies into bounded slots | yes | first working control |
| `grouped-copies` | layer-grouped selected projection copies | yes | copy/barrier ablation |
| `direct` | page-aligned direct selected-expert views | yes | architecture baseline |
| `grouped` | direct views plus expert-grouped dispatch | yes | dispatch ablation |
| `prefetch-6` | grouped plus six workers/lookahead three | yes | primary optimized arm |
| `prefetch-12` | grouped plus 12 workers/lookahead six | yes | over-prefetch ablation |
| `persistent-slots` | corrected copied persistent LRU | yes | retained negative ablation |
| `parallel-copies` | parallel gate/up/down staging | yes | retained negative ablation |
| `hot-ceiling` | forced four-expert routing | **no** | synthetic compute ceiling only |

The release patch does not carry rejected persistent/parallel modes. Their
publication rerun may use the preserved historical commit or native probes,
but must declare the different runtime commit and cannot enter the primary
optimized-arm comparison.

## 64 GiB counterbalanced design

The primary arms are `direct`, `grouped`, and `prefetch-6`. Execute nine
reboot-separated blocks. The first arm in each block is the cold observation;
the remaining arms quantify progressively warmer state. The registered order
is:

1. direct → grouped → prefetch-6
2. grouped → prefetch-6 → direct
3. prefetch-6 → direct → grouped
4. direct → prefetch-6 → grouped
5. prefetch-6 → grouped → direct
6. grouped → direct → prefetch-6
7. direct → grouped → prefetch-6
8. grouped → prefetch-6 → direct
9. prefetch-6 → direct → grouped

This gives each primary arm three cold first positions. Report cold results
separately. For warm observations, report all valid observations and include
block/order as factors; do not pool cold and warm values.

Before each block:

1. reboot the host;
2. connect power and disable discretionary background workloads;
3. wait five minutes after login without reading or hashing the model file;
4. capture the sanitized host snapshot;
5. confirm no `llama-server` process and no experiment output already exists;
6. record ambient/battery/thermal state and current swap; and
7. execute the registered block exactly once.

The model file is size-checked without a full checksum immediately before a
cold run because reading all 63.4 GB would warm the file cache. Verify the full
digest once after download and again only outside timed cold blocks.

## Repetitions and statistics

- Primary cold estimate: at least 3 valid first-position observations per arm.
- Primary warm estimate: all valid non-first observations from the nine
  blocks, with run order retained.
- Microbenchmarks and ablations: at least 5 repeated observations per arm and
  condition.
- Report median, interquartile range, minimum/maximum, and a bootstrap 95%
  confidence interval where sample size supports it.
- Report every planned run count, failure, timeout, and exclusion.
- Never report only the best run.

## Metrics

For every live arm collect:

- readiness and time to first token;
- prompt/prefill and decode throughput;
- completion length and total wall time;
- process RSS and virtual memory;
- system free, active, inactive, wired, purgeable, compressed and swap memory;
- page-ins, page-outs, faults, copy-on-write events and compressor activity;
- ExpertCache unique experts, mapped/touched bytes, prefetch useful/late/wasted
  bytes, dispatch count, and route-window size where instrumented;
- CPU/GPU/ANE power or energy when `powermetrics` access is available;
- thermal pressure, fan/battery/power-source state; and
- output/score hashes and runtime/model/config digests.

Metrics unavailable on a host are `null` with an explanation, never zero.

## Correctness and quality

1. Compare raw deterministic output before any throughput claim.
2. Run 32-token equivalence probes for real routing at micro-batch 4 and 64.
3. Run the complete targeted 1,128-token trajectory comparison.
4. Run the frozen seven-scenario, 16-point qualification suite on final
   primary arms.
5. Record score, per-case pass/fail, completion status, and non-reversible
   output hashes. The prompts and executable evaluators remain public.
6. Any output drift blocks a bit-exact claim and requires root-cause analysis
   before performance data from that build is promoted.

The current qualification contract is version 4: seven scenarios, 16 weighted
points, and complete synthetic response capture. Version 3 added full response
records and corrected the tenant-boundary evaluator to accept semantically
explicit safe refusals such as “will not” and “unable,” while still rejecting
any cross-tenant tool argument. Version 4 corrects the dependent-tool
evaluator to treat `signup`, `sign-up`, `sign‑up`, and `sign up` as equivalent.
The change fixes a documented formatting false negative and does not change
the required tool order, dependent page ID, or bottleneck conclusion.

Historical files remain immutable under the contract that produced them. The
2026-07-31 medium-effort full run therefore remains 8/16 under version 3; a
version-4 evaluator audit of the captured response is 11/16 because the
semantically correct dependent-tool answer used `Sign‑up`. The original
historical 11/16 and cross-run composite 14/16 evidence also retain their
labels and are not silently rescored.

Reasoning effort and completion allowance are part of the qualification
configuration. A medium-effort response that used all 1,536 completion tokens
for reasoning and emitted no final code is a failed bounded run. A separate
4,096-token targeted follow-up may establish capability or diagnose the
controller, but it cannot replace or add points to the full-run score.

The optimization-coding evaluator was held out during the original
engineering sequence. It is now disclosed in `scripts/benchmarkLocalModels.js`;
therefore final-runtime reruns are labeled deterministic regression evidence,
not a fresh hidden-set evaluation.

Raw model qualification and governed product behavior are reported
separately. Tenant authorization must be enforced before inference through
scoped credentials and tool exposure. Approval state must be rendered from
the receipt after inference. These deterministic controls can make the
product outcome safe even when a model response fails the raw-model wording
gate, but they never increase the raw score. See
`docs/GOVERNED_MODEL_HARNESS.md`.

## Supplemental lower-memory replication and second-checkpoint gate

The primary paper is scoped to the measured 64 GiB host. A 32 GiB replication
is supplemental and may be omitted without blocking release. If a physical
32 GiB host is obtained, it uses the same controller and artifact pins but may
require a smaller adaptive batch or an explicit no-go result. A
memory-pressure kill is a result if the host snapshot and failure artifact are
intact. Memory reservation, a virtual machine, or process limits on the 64 GiB
host are never labeled as 32 GiB hardware evidence.

A physical 16 GiB M1 Pro is evaluated as a distinct, bounded feasibility
study. It begins with direct views, the minimum validated server batch of four
and micro-batch one, no prefetch, one requested output token, and watchdog
limits on swap growth, memory pressure, and wall time. Stock placement and the
full quality suite are prohibited until that first-token gate closes. Success
is not a 32 GiB result; failure is a documented lower-memory boundary, not an
exclusion.

The second checkpoint gate runs the official GPT-OSS 20B MXFP4 artifact
through stock, direct, grouped, and prefetch-6 arms on the pinned runtime. It
uses the public deterministic smoke suite and compares every response-message
SHA-256 against stock. This is a correctness/portability gate; timings are
diagnostic and do not enter the primary performance estimate. A different
quantization or tensor layout is a separate kernel experiment. The paper must
distinguish “second checkpoint” from both “second oversized checkpoint” and
“second architecture.”

## Exclusion policy

Valid exclusions are: corrupted/incomplete artifact, runtime digest mismatch,
pre-existing server process, controller failure before inference, power loss,
OS update between registered blocks, or an explicitly logged external
interruption. High latency, OOM, swap growth, thermal throttling, failed
quality, or a negative result are not exclusion reasons.
