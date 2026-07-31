# Claim ledger

This ledger is the source of truth for the manuscript. “Decision-grade” means
the result informed the next engineering decision but lacks the repetitions,
counterbalancing, host coverage, or telemetry required for a publication
estimate.

| ID | Claim | Current grade | Evidence | Publication action |
| --- | --- | --- | --- | --- |
| C1 | The complete 63,387,346,208-byte GPT-OSS 120B MXFP4 artifact executed on a 64 GiB M1 Max through selected expert views. | architecture-validated | `docs/EXPERT_CACHE_ZERO_COPY_RESULTS.md` | Repeat on frozen runtime; report exact artifact and host. |
| C2 | The direct-view path passed the targeted 3/3 hidden optimization-code gate; together with the prior 11/16 full run, the latest component evidence covers 14/16 points. | targeted-quality-validated; cross-run composite | `docs/EXPERT_CACHE_ZERO_COPY_RESULTS.md` | Do not label the composite a contemporaneous full-suite score; rerun the frozen seven-scenario, 16-point suite and publish public equivalence hashes. |
| C3 | Grouped dispatch and prefetch produced the same 1,128-token trajectory as the no-prefetch grouped arm. | deterministic-equivalence-validated | `docs/EXPERT_CACHE_CEILING_RESULTS.md`, `evidence/prefetch-2026-07-29/full-gate-qualification.json` | Reproduce on final tagged runtime. |
| C4 | Prefetch raised real-prompt prefill from 5.75 to 9.80 tok/s (+70%) in the observed gate. | decision-grade | `docs/EXPERT_CACHE_CEILING_RESULTS.md`, `evidence/prefetch-2026-07-29/` | Replace single observation with counterbalanced median and dispersion. |
| C5 | Grouped dispatch reached a 78.0 tok/s synthetic hot-expert prompt ceiling versus 25.3 tok/s per-route. | decision-grade synthetic ceiling | `evidence/grouped-dispatch-2026-07-29/` | Repeat; label synthetic/quality-invalid in every table. |
| C6 | A 64-token route window averaged 61.8 experts/layer and an estimated 27.4 GiB expert working set. | trace-derived | `docs/EXPERT_CACHE_CEILING_RESULTS.md` | Publish trace corpus description, distribution, and estimator assumptions. |
| C7 | Stock placement produced no first token and entered Metal OOM; one run grew swap from 9.6 to 42.1 GiB. | observed negative control | `docs/LOCAL_120B_LIVE_BASELINE.md` | Reproduce one bounded stock failure per host; do not repeatedly damage host state. |
| C8 | Persistent copied slots and parallel projection copies lost to their contemporaneous controls. | decision-grade negative result | `docs/EXPERT_CACHE_ZERO_COPY_RESULTS.md` | Repeat as bounded ablations or retain as explicitly preliminary. |
| C9 | The final prefetch gate showed no swap growth during the run. | single-run observation | `docs/EXPERT_CACHE_CEILING_RESULTS.md` | Replace with repeated host telemetry and absolute before/after values. |
| C10 | The ExpertCache correctness path is portable to the official GPT-OSS 20B MXFP4 checkpoint. | registered; unmeasured | `artifact/model-specs/gpt-oss-20b-mxfp4.json` | Require exact stock/direct/grouped/prefetch response-hash equivalence; do not relabel it as second-architecture or oversized-checkpoint evidence. |

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
