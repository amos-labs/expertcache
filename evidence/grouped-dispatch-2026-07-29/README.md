# Grouped-dispatch equivalence and ceiling evidence (2026-07-29)

Raw responses from the deterministic A/B probes behind the expert-grouped
dispatch milestone in `docs/EXPERT_CACHE_CEILING_RESULTS.md`. Each arm ran the
pinned llama-server (runtime patch in `../llama-expert-cache-runtime.patch`,
llama.cpp base `7e1e28cae36d41fe7bbe9dae7c9625de6565c063`, grouped-dispatch
commit `51d22c5f` on branch `amos/expert-grouped-dispatch` of the local
runtime checkout) against the pinned GPT-OSS 120B MXFP4 artifact, temperature
0, seed 42, 32 generated tokens.

| Arm | Config | Result |
|---|---|---|
| control / grouped | real routing, ubatch 4 | content.txt identical |
| real-ungrouped-u64 / real-grouped-u64(-v2) | real routing, ubatch 64 | content.txt identical |
| hot-ungrouped-u64 / hot-grouped-u64 | synthetic hot ceiling, ubatch 64 | content.txt identical; prompt 25.3 vs 78.0 tok/s |

`response.json` includes the llama-server `timings` block for each arm. The
hot arms use the raw `/completion` endpoint because synthetic routing produces
deliberately invalid text that the Harmony chat parser rejects; their content
is meaningless by design and is compared only for determinism.

Host state was contaminated (accumulated swap from repeated 60 GB model
loads); the `-v2` control rerun quantifies that drift. Relative results are
decision-grade; absolute throughput requires a clean-boot rerun.
