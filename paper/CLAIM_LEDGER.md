# Claim ledger

This ledger is the source of truth for the manuscript. “Decision-grade” means
the result informed the next engineering decision but lacks the repetitions,
counterbalancing, host coverage, or telemetry required for a publication
estimate.

| ID | Claim | Current grade | Evidence | Publication action |
| --- | --- | --- | --- | --- |
| C1 | The complete 63,387,346,208-byte GPT-OSS 120B MXFP4 artifact executed on a 64 GiB M1 Max through selected expert views. | architecture-validated | `docs/EXPERT_CACHE_ZERO_COPY_RESULTS.md` | Repeat on frozen runtime; report exact artifact and host. |
| C2 | The direct-view path passed a targeted 3/3 optimization-code gate that was held out during the original run and is now disclosed; together with the prior 11/16 full run, the historical component evidence covers 14/16 points. A clean-source v4 medium-effort follow-up independently passed the coding gate at a 4,096-token cap. | targeted-quality-validated; cross-run composite and separate regression | `docs/EXPERT_CACHE_ZERO_COPY_RESULTS.md`, `evidence/qualification-controls-2026-07-31/` | Do not label the composite a contemporaneous full-suite score or add the targeted follow-up to a full-run score. |
| C3 | Grouped dispatch and prefetch produced the same 1,128-token trajectory as the no-prefetch grouped arm. | deterministic-equivalence-validated | `docs/EXPERT_CACHE_CEILING_RESULTS.md`, `evidence/prefetch-2026-07-29/full-gate-qualification.json` | Reproduce on final tagged runtime. |
| C4 | Prefetch raised real-prompt prefill from 5.75 to 9.80 tok/s (+70%) in the observed gate. | decision-grade | `docs/EXPERT_CACHE_CEILING_RESULTS.md`, `evidence/prefetch-2026-07-29/` | Replace single observation with counterbalanced median and dispersion. |
| C5 | Grouped dispatch reached a 78.0 tok/s synthetic hot-expert prompt ceiling versus 25.3 tok/s per-route. | decision-grade synthetic ceiling | `evidence/grouped-dispatch-2026-07-29/` | Repeat; label synthetic/quality-invalid in every table. |
| C6 | A 64-token route window averaged 61.8 experts/layer and an estimated 27.4 GiB expert working set. | trace-derived | `docs/EXPERT_CACHE_CEILING_RESULTS.md` | Publish trace corpus description, distribution, and estimator assumptions. |
| C7 | Stock placement produced no first token and entered Metal OOM; one run grew swap from 9.6 to 42.1 GiB. | observed negative control | `docs/LOCAL_120B_LIVE_BASELINE.md` | Reproduce one bounded stock failure per host; do not repeatedly damage host state. |
| C8 | Persistent copied slots and parallel projection copies lost to their contemporaneous controls. | decision-grade negative result | `docs/EXPERT_CACHE_ZERO_COPY_RESULTS.md` | Repeat as bounded ablations or retain as explicitly preliminary. |
| C9 | The final prefetch gate showed no swap growth during the run. | single-run observation | `docs/EXPERT_CACHE_CEILING_RESULTS.md` | Replace with repeated host telemetry and absolute before/after values. |
| C10 | The official GPT-OSS 20B MXFP4 checkpoint executes in stock, direct, grouped, and prefetch-6 arms; direct/grouped/prefetch are canonical-response equivalent, while stock-to-custom equivalence fails at three of six response records. | partial portability; stock-equivalence unresolved | `artifact/model-specs/gpt-oss-20b-mxfp4.json`, `evidence/second-checkpoint-20b-2026-07-31/` | Isolate stock/direct numerical drift before closing the gate; do not relabel it as second-architecture or oversized-checkpoint evidence. |
| C11 | Requested low effort and seed 42 produced 12/16 on both local v5 and Bedrock 120B with the same two scenario failures; the responses were not bit-exact. | single-run diagnostic | `evidence/qualification-controls-2026-07-31/` | Repeat under the final v4 contract; report local and hosted timings separately. |
| C12 | A physical 16 GiB M1 Pro completed protected one-token, eight-token, and natural 50-token gates under explicit placement, reaching 0.72 decode tok/s with 256 KiB peak session swap. | bounded one-boot feasibility | `docs/LOW_MEMORY_16G_RESULTS.md`, `evidence/low-memory-16g-2026-07-31/` | Require a second clean boot before a reproducibility claim; do not call this stock success or production speed. |
| C13 | Local medium coding failed at a 1,536-token cap with reasoning-only truncation and passed 3/3 in a separate clean-source 4,096-token follow-up. | targeted controller diagnostic | `evidence/qualification-controls-2026-07-31/` | Preserve the failed full run; evaluate final-answer reservation and adaptive retry as system controls. |

## Excluded or prohibited claims

- The retracted **74.24 tok/s** batch-64 number is invalid because it bypassed
  the quality-bearing direct-view branch. It must not appear as evidence.
- ExpertCache has not shown frontier parity, universal model quality,
  production readiness, or superiority across machines/models.
- The checkpoint is **not larger than physical RAM**. It is 63.4 GB decimal
  (about 59.0 GiB) on a 64 GiB machine and exceeds the practical Metal working
  set once OS, runtime, KV cache, and application headroom are included.
- The synthetic hot-expert ceiling is not a quality result and is not an
  expected real-routing throughput.
- The current +70% prefill result is not a publication estimate until the
  registered repeated/counterbalanced matrix is complete.
- The GPT-OSS 20B control is neither oversized on the primary host nor a
  second architecture, regardless of whether its portability gate passes.
- Deterministic tenant scoping, approval rendering, or retry logic may improve
  the governed product outcome but may not be counted as raw-model points.
- The local and Bedrock controls do not support a bit-exact claim; only their
  requested configuration, scores, and scenario outcomes matched.
