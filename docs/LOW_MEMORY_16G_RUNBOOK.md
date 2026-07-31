# Physical 16 GiB M1 Pro runbook

This is a real-hardware feasibility study for the complete pinned GPT-OSS
120B MXFP4 checkpoint. It is not a 32 GiB replication and does not begin as a
throughput or quality claim.

## Safety and evidence boundary

The first gate requests one decode step with direct expert views, no prefetch,
batch 4, micro-batch 1, and a 4,096-token context allocation. The controller
terminates the server if:

- swap grows by more than 2 GiB;
- system-wide memory free percentage falls below 3%; or
- the run exceeds 1,800 seconds.

A watchdog termination, OOM, or memory-pressure kill is a valid no-go result.
Do not retry it as a stock-placement run. Do not begin the full qualification
suite until both protected probe stages have been reviewed.

## Host preparation

1. Use the physical 16 GiB M1 Pro MacBook on AC power.
2. Confirm at least 80 GB of free local storage. Internal SSD placement is
   preferred; if an external SSD is used, record the device and interface.
3. Reboot, log in, close nonessential applications, and do not open AMOS
   Desktop or another local model runtime.
4. Clone the exact ExpertCache source revision selected for the experiment.
5. Install Node.js 22 or newer, CMake, and Xcode command-line tools.

## Restore and verify

```bash
npm test
npm run check
npm run runtime:prepare -- --dir .cache/runtime/llama.cpp
mkdir -p .cache/models
```

Copy `gpt-oss-120b-MXFP4.gguf` into `.cache/models/`, then verify both
immutable properties:

```bash
stat -f '%z' .cache/models/gpt-oss-120b-MXFP4.gguf
shasum -a 256 .cache/models/gpt-oss-120b-MXFP4.gguf
```

Expected size: `63387346208` bytes. Expected SHA-256:
`582bd40f6886200101f4c4ed9f25f3fe80cc14c86e9e2b37746cd8904a0c622d`.

Run the filtered native Metal operation check before model inference:

```bash
.cache/runtime/llama.cpp/build-expertcache-metal/bin/test-backend-ops \
  test -b MTL0 -o MUL_MAT_ID \
  -p 'type_a=mxfp4.*n_mats=32.*n_used=2.*m=2880' \
  --output csv -j 1
```

## Stage 1: one decode step

First print the plan:

```bash
npm run experiment:low-memory
```

Then execute once from a normal Terminal session so host telemetry is
available:

```bash
npm run experiment:low-memory -- \
  --execute \
  --confirm-low-memory-host \
  --probe-tokens 1
```

Stop after this command regardless of outcome. Preserve the complete output
directory and review `baseline.json` and `llama-server.log` before Stage 2.

## Stage 2: eight-token visible/reasoning probe

Run only if Stage 1 completed without watchdog activation or unbounded swap:

```bash
npm run experiment:low-memory -- \
  --execute \
  --confirm-low-memory-host \
  --probe-tokens 8
```

The report must include readiness, first completion event, first
content/reasoning token, separate prompt/decode timings, peak RSS, swap growth,
VM counters, memory pressure, power source, and thermal state. Missing fields
remain null; they are never inferred as zero.

## Promotion sequence

After human review, and only if both stages remain bounded:

1. run a deterministic short equivalence probe;
2. run the targeted 3/3 optimization-coding gate;
3. repeat the successful protected stage from a second clean boot; and
4. decide whether sustained generation is useful enough to study further.

The paper may claim execution on 16 GiB only after a reproducible run on this
physical host. A successful 16 GiB result makes 32 GiB promising, but it does
not replace a physical 32 GiB measurement.

## Distinct explicit-placement recovery arm

If the registered automatic-fit Stage 1 is preserved as a no-go, a separate
clean-boot engineering arm may test explicit placement. Do not overwrite or
reclassify the registered result. Use the same watchdogs and add both flags:

```bash
npm run experiment:low-memory -- \
  --execute \
  --confirm-low-memory-host \
  --probe-tokens 1 \
  --no-fit \
  --gpu-layers all
```

Review and preserve that result before running the corresponding eight-token
arm. The runtime patch skips whole-file mmap prefetch only while lazy
ExpertCache tensor mapping is active. Because the 2026-07-31 configuration
search did not isolate mmap-prefetch removal from automatic-fit removal, any
claim from this arm applies to the combined configuration.

The 2026-07-31 physical M1 Pro arm began with zero swap and passed one-token,
eight-token, and natural 50-token completion gates with a session peak of only
256 KiB swap. This supports a single-host execution claim for the combined
experimental configuration, not a stock-runtime or reproducibility claim. See
`docs/LOW_MEMORY_16G_RESULTS.md` and the machine-readable evidence summary for
the complete boundary and hashes.
