# Physical 16 GiB M1 Pro protected probe

This directory records the 2026-07-31 protected low-memory feasibility attempt
described in `docs/LOW_MEMORY_16G_RUNBOOK.md`.

The initial preflight was stopped before inference because starting swap was
4,440.19 MiB, above the runbook's 2 GiB maximum. After a clean reboot, starting
swap was 0 MiB and the protected one-token Stage 1 probe was run exactly once.
The watchdog terminated the server during model loading after swap growth
exceeded 2 GiB. The server did not become ready and no token was generated.

This is a Stage 1 no-go under the registered low-memory configuration. It is
not evidence that no alternative placement can execute on 16 GiB, but the
runbook explicitly forbids retrying this outcome as a stock-placement run.
Stage 2 was not run.

The source tests passed 22/22 using Node.js 24.14.0 and the bundled Python
runtime with NumPy 2.3.5. JavaScript syntax checks passed. The exact pinned
`llama.cpp` revision was built with the verified ExpertCache patch, and the
filtered native Metal MXFP4 operation check passed on the Apple M1 Pro.

See `preflight.json` for the first preflight attempt,
`stage1-summary.json` for the protected probe result, and
`native-mxfp4-ops.csv` for the filtered native operation result. The complete
raw `baseline.json` and `llama-server.log` are preserved under
`output/low-memory/2026-07-31-m1-pro-stage1-1-token/`; their SHA-256 digests
are retained in the sanitized summary.

## Warm-host recovery diagnostics

Additional explicitly non-registered diagnostics were then run without rebooting.
Disabling whole-file mmap prefetch alone did not reach its loader marker:
automatic fitting grew swap by 2.30 GiB and triggered the watchdog in 26.3
seconds. An explicit placement with automatic fitting disabled reached
readiness in about four seconds, completed both one-token and eight-token
probes, and created no additional swap. The eight-token run measured 0.92
tokens/second prompt processing and 0.99 tokens/second decode.

The explicit-placement direct-view path remained stable for a 32-token capped
probe and a natural 50-token completion, with 0.88-0.89 tokens/second decode
and about 325 MB peak process RSS. Grouped dispatch was effectively neutral.
One prefetch thread was rejected: it increased peak process RSS to 7.56 GB and
reduced prompt/decode throughput by roughly 37-39 percent despite flat swap.
An invalid 128-token launch attempt also exposed and led to fixes for the
default-port parser, fail-closed swap telemetry, and runtime-bundle identity;
it never began model loading and is listed separately from valid runs.
The hardened recovery harness passed 23/23 source tests and the full JavaScript
syntax check before the clean-session plan was frozen.

These warm-host results are promising engineering evidence, not clean-host
feasibility results. They began with about 3.3 GiB of swap and a warm file
cache. See `warm-recovery-summary.json`; the raw directories and their hashes
are listed there. A clean-boot repeat is required before promoting the
explicit-placement configuration. The selected clean-session matrix is a
one-token gate, an eight-token gate, and a natural-completion soak, all with
automatic fit disabled, all GPU layers explicitly selected, no grouped
dispatch, no prefetch, and the 2 GiB swap-growth watchdog retained.

## Clean-session explicit-placement result

After a second reboot, the selected experimental configuration passed all
three gates. The session began with zero swap. The one-token gate peaked at
zero swap, the eight-token gate introduced only 256 KiB, and the natural
completion retained that same 256 KiB peak. The final arm stopped naturally at
50 completion tokens, returned `ExpertCache baseline ready`, measured 0.75
tokens/second prompt processing and 0.72 tokens/second decode, and used 289 MB
peak process RSS. No watchdog triggered; minimum system free memory was 49%.

This is a distinct combined experimental arm and does not supersede the
registered automatic-fit no-go. The required full-model SHA-256 scan occurred
before the first gate, so the clean-session result began with zero swap and no
prior inference but not an untouched file cache. A second successful clean
boot is still needed for a reproducibility claim.

See `clean-explicit-summary.json` for the machine-readable result,
`clean-explicit-preflight-host.json` for the pre-inference host snapshot,
`clean-native-mxfp4-ops.csv` for the repeated native operation check, and
`docs/LOW_MEMORY_16G_RESULTS.md` for the human-readable report.

## Warm 8K quality qualification

The later warm-host engineering suite completed all seven qualification
scenarios at an 8,192-token context. The raw harness recorded 11/16. Exact
replay of the multi-tool response through the regression-tested punctuation
fix yields a 14/16 functional result; the original 0/3 raw report is retained
unchanged. The only genuine miss was the parked-approval outcome.

The first distractor-heavy attempt was interrupted and preserved after macOS
sleep events consumed most of its HTTP timeout. A fresh attempt wrapped in
`caffeinate -i -s` completed in 5,339.7 seconds and passed 2/2. Across the
seven completed scenarios, peak process RSS was 453 MiB, peak swap was 4.81
MiB, and minimum free memory was 38 percent.

See `quality-summary.json` for the aggregate, `quality-raw/` for the sanitized
gate, scenario, and interrupted-attempt corpus, and
`quality-raw-manifest.json` for original/published hashes. Rebuild these files
from the ignored local outputs with
`node scripts/publishLowMemoryQualityEvidence.js`.

The complete low-memory raw corpus is published under `raw/` after replacing
only machine-local paths, the host fingerprint, and the battery device ID.
`raw-manifest.json` maps every sanitized file to the original and published
SHA-256 digests. The 63.4 GB model and compiled `.cache` tree remain excluded.
