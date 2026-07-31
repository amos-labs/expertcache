# ExpertCache roadmap

This roadmap keeps the research program, publication gates, and a possible
production architecture separate. A completed research milestone is not
automatically a shipping commitment.

Status: **done**, **active**, **planned**, **scoped out**, **external gate**, or
**rejected**.

## 1. Publication program

| Priority | Milestone | Status | Exit condition |
| --- | --- | --- | --- |
| P0 | Freeze claims and exclusions | done | Every numerical claim maps to the claim ledger and committed evidence. |
| P0 | Restore pinned 120B artifact and runtime | done | Exact size/revision verified; patch digest verified; native MXFP4 Metal self-test passes. |
| P0 | 64 GiB clean/cold and warm matrix | active | Three cold first-position runs per primary arm plus counterbalanced warm observations. |
| P0 | Full frozen quality suite | active | Version-2 seven-scenario, 16-point suite plus response hashes and public deterministic equivalence artifacts on the final runtime. |
| P0 | Complete host telemetry | planned | TTFT, prefill/decode, RSS, compressed memory, swap, page faults, bytes touched, energy and thermal state. |
| P2 | 32 GiB Apple Silicon replication | scoped out | Supplemental only: run the pinned protocol on physical hardware before making any 32 GiB claim. |
| P0 | Second oversized sparse checkpoint | planned | A second checkpoint executes through a declared compatible path; unsupported kernels are reported, not hidden. |
| P0 | Frozen artifact release | planned | Checksummed bundle, tagged source, compiled paper, and archived raw results. |
| P1 | Upstreamable runtime boundary | planned | Patch is reduced to a reviewable backend extension with tests and no AMOS dependency. |
| P1 | 16 GiB M1 Pro feasibility probe | external gate | Protected direct-view first-token test on physical hardware; a clean no-go is also a valid result. |

The final paper is blocked by every unfinished P0 row. The 32 GiB replication
is not a release gate because the primary claim is explicitly scoped to the
measured 64 GiB host; it becomes a gate only if the manuscript adds a 32 GiB
hardware claim. A preprint draft may be written before the P0 rows close, but
placeholder values may not be silently promoted into the abstract or
conclusion.

## 2. Production architecture

The likely production system is a portfolio rather than one oversized model.
Two small-model roles must remain distinct.

### 2.1 Task qualifier and escalation router

**Goal:** route a governed task to a resident workhorse, local verifier, or
hosted frontier model before expensive inference begins.

- Target: a sub-1B or similarly low-latency model with calibrated abstention.
- Inputs: workflow class, compiled-context shape, permitted tool surface,
  prior quality receipts, latency budget, and privacy/deployment policy.
- Outputs: route, confidence interval, required verification level, and reason
  code.
- Safety boundary: low confidence always escalates. The router cannot weaken a
  policy, approval, receipt, or hidden quality gate.
- Measurement: local completion rate and false-local rate per workflow class,
  never one aggregate “80–90%” number.

This is how an 80–90% local target becomes measurable: it is the fraction of a
real governed workload that passes its workflow-specific gate locally, not a
claim that a small model matches a frontier model in general.

### 2.2 Expert-residency predictor

**Goal:** forecast future expert page demand early enough to overlap storage
latency with compute.

- Candidate: a tiny sequence model over recent authoritative route IDs,
  layer position, phase, workflow fingerprint, and batch shape.
- Output: a ranked prefetch set and confidence, bounded by a byte and thermal
  budget.
- Correctness boundary: predictions are advisory. The authoritative 120B
  router still selects the experts used in the matrix operation; a wrong
  prediction may waste I/O but may never change model bytes or output math.
- Fallback: the measured routed-union heuristic remains the deterministic
  control and takes over on uncertainty, drift, or memory pressure.
- Kill criterion: retire the predictor if its end-to-end stall reduction does
  not repay model execution and excess-page cost under counterbalanced runs.

This is the production-grade form of “a small model loading the right things”:
speculative residency, not unverified replacement of the MoE router.

### 2.3 Resident draft, oversized verifier

**Goal:** use a fast resident 20–30B model for generation and ExpertCache 120B
for batched verification.

1. The resident model drafts `K` tokens or a bounded tool-plan segment.
2. The 120B verifier processes the proposed span as a batch.
3. Accepted tokens amortize route discovery, page-in, and grouped dispatch.
4. Rejected suffixes fall back to the verifier or hosted route under the same
   receipt contract.

The experiment proceeds only if measured acceptance-adjusted wall time beats
the resident model plus existing verification route. The synthetic 78 tok/s
hot ceiling is motivation, not a predicted production number.

## 3. Runtime hardening

| Capability | Status | Notes |
| --- | --- | --- |
| Page-aligned direct expert views | done | Primary architecture result. |
| Expert-grouped multi-token dispatch | done | Bit-exact against per-route control in tested arms. |
| Async routed-union prefetch | done | Six threads/lookahead three is the current decision-grade default. |
| Deterministic cancellation and restart | planned | Must interrupt workers, command buffers, and server lifecycle cleanly. |
| Memory-pressure governor | planned | Shrink batch/prefetch budgets before macOS swap becomes policy. |
| Reusable no-copy view metadata | planned | Reuse safe Metal view objects without duplicating expert weights. |
| Adaptive batch and route window | planned | Bound unique experts and bytes rather than using a fixed token count. |
| Residency/page-fault telemetry | planned | Record useful, wasted, late, and evicted prefetched bytes. |
| Multi-session scheduler | planned | Serialize by default; admit concurrency only inside shared memory/thermal gates. |
| Signed runtime/model manifest | planned | Versioned optional backend with rollback and digest verification. |
| Upstream llama.cpp interface | planned | Replace environment-variable patch surface with a reviewed backend API. |

## 4. Research backlog

### Near-term experiments

- **Speculative 20B-draft/120B-verify:** highest-value next runtime experiment
  because prefill is now the fast path while serial decode remains near 3
  tok/s.
- **Learned residency versus routed-union heuristic:** compare stall reduction,
  wasted bytes, compute overhead, and drift behavior.
- **GGUF expert layout:** test expert-contiguous or route-informed physical
  ordering so prefetch reads fewer, larger ranges.
- **Mixed-bit resident experts:** qualify a 2–3 bit expert-only variant while
  protecting shared tensors; compare quality and total residency.
- **Second MXFP4 MoE checkpoint:** immediate portability test for the existing
  kernel; a different quantization requires a separate correctness-bearing
  kernel rather than a compatibility claim.
- **Long context and long session stability:** 8K is the current controlled
  baseline; 32K/128K, cancellation, repeated sessions, and thermal saturation
  remain open.
- **Private multi-node pool:** expert or layer partitioning is the sovereign
  fallback if single-node latency, memory, or thermal gates fail.

### Retained negative results

- **Mapped-page advice as ownership:** rejected. `madvise`/prefetch changed
  logical state but could not enforce physical residency.
- **Persistent copied LRU slots:** rejected in the tested unified-memory form;
  it duplicated the OS page cache and increased pressure.
- **Parallel gate/up/down copies:** rejected; it moved contention without
  reducing wall time.
- **Wide cold expert blocks:** rejected; they expanded the physical burst and
  collapsed into paging/swap.
- **Static workflow popularity prewarm:** rejected as too blunt in the tested
  harness.

Negative arms remain in the artifact because they constrain future designs.
They may be revisited only when the ownership boundary or hardware changes,
not because a later run is warmer.

## 5. Product acceptance gates

A future optional ExpertCache backend is production-eligible only when it:

- improves a frozen quality/latency/cost contract over the resident model and
  managed verifier;
- has no unbounded swap growth, UI starvation, or memory-pressure termination;
- supports deterministic cancellation, restart, update, and rollback;
- preserves output equivalence for identical model math;
- exposes explicit startup, prefetch, memory, thermal, and fallback state;
- records a receipt for task routing, verification, and escalation decisions;
- keeps all prefetch predictions advisory and policy-bounded; and
- remains optional so AMOS access through Claude, Codex, GPT, or other clients
  is never downgraded by Desktop-specific runtime work.
