# Experimental 16 GiB recovery plan

This plan begins only after preserving the registered Stage 1 no-go. Results
under this plan are engineering diagnostics and must not be presented as the
registered low-memory result.

## Hypothesis

The lazy tensor-map runtime prevents whole-model Metal resources, but the
loader still calls `init_mappings(true)`. On POSIX hosts this passes the full
63.4 GB file size to `posix_madvise(..., POSIX_MADV_WILLNEED)`. The registered
run's timeline is consistent with whole-file prefetch causing avoidable page
cache and swap pressure before server readiness.

## Variant A: no whole-file mmap prefetch

Apply `experimental-disable-mmap-prefetch.patch` on top of the pinned,
ExpertCache-patched llama.cpp runtime. When `GGML_METAL_LAZY_TENSOR_MAP` is
set, initialize the file mapping without `POSIX_MADV_WILLNEED`.

Use the registered Stage 1 configuration unchanged:

- clean reboot and 0 GiB starting swap;
- one-token cap;
- context 4,096, batch 4, micro-batch 1;
- direct expert views, CPU fill, 128 slots, no prefetch;
- 2 GiB maximum swap growth;
- 3% minimum system memory free; and
- 1,800-second wall-time limit.

The comparison is valid only if the server log contains the experimental
loader marker and all other registered configuration fields match.

## Decision sequence

1. If Variant A reaches readiness and one token under the original watchdog,
   preserve the raw result and repeat after another clean boot before changing
   any gate.
2. If Variant A still shows rapidly increasing swap, stop and instrument the
   loader by phase before considering a higher cap.
3. If Variant A nearly reaches readiness and swap clearly plateaus, run a
   separately labeled diagnostic with a higher absolute swap cap. Do not alter
   the registered 2 GiB result or describe the diagnostic as a runbook pass.
4. Consider replacing a single absolute swap limit with a policy that combines
   an absolute emergency cap, swap-growth slope, memory-free floor, and a
   post-readiness plateau requirement. Any such policy needs its own protocol.

## Required evidence

Preserve the complete output directory, configuration digest, server log,
swap/RSS/free-memory timeline, VM counter deltas, power and thermal state,
binary/source patch hashes, and a direct comparison with the registered
Stage 1 no-go.
