# Async routed-union prefetch evidence (2026-07-29)

Raw responses for the prefetch A/B/A in `docs/EXPERT_CACHE_CEILING_RESULTS.md`.
All arms: grouped zero-copy runtime (prefetch commit `def5ebc2` on
`amos/expert-grouped-dispatch`, base llama.cpp `7e1e28ca`), pinned GPT-OSS
120B MXFP4, batch/ubatch 64, temperature 0, seed 42, 32 generated tokens,
raw `/completion` with the same 361-token prompt. Run order as listed;
page cache persists across arms, so the trailing no-prefetch control bounds
the warming bias.

| Order | Arm | Prompt tok/s | Decode tok/s |
|---|---|---:|---:|
| 1 | pf-equiv-off (no prefetch, coldest) | 16.56 | 2.73 |
| 2 | pf-equiv-on (6 threads, ahead 3) | 23.60 | 2.90 |
| 3 | pf-off-2 (no prefetch, warmest) | 18.56 | 2.62 |
| 4 | pf-on-12t-a6 (12 threads, ahead 6) | 24.28 | 2.38 |

`content.txt` is identical across all arms (bit-exact under prefetch).
Decision-grade host (accumulated swap); clean-boot rerun before publication.
