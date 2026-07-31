# Physical 16 GB M1 Pro results

On 2026-07-31, the complete pinned 63.4 GB GPT-OSS 120B MXFP4 checkpoint
executed on a physical 16 GB Apple M1 Pro using an experimental ExpertCache
configuration with automatic fit disabled and all GPU layers selected
explicitly.

This does not replace the registered result. The original automatic-fit Stage
1 remains a watchdog no-go: it exceeded the 2 GiB swap-growth gate during
model planning before server readiness. The successful measurements below are
a distinct experimental arm developed after that result.

## Configuration

- Model: `gpt-oss-120b-MXFP4.gguf`
- Model size: 63,387,346,208 bytes
- Context: 4,096 tokens
- Batch / micro-batch: 4 / 1
- Automatic fit: off
- GPU layers: all
- ExpertCache slots: 128
- CPU fill: on
- Direct expert views: on
- Grouped dispatch: off
- Expert prefetch: off
- Warmup: off
- Swap-growth watchdog: 2 GiB
- Minimum free-memory watchdog: 3 percent

The runtime also disabled whole-file mmap prefetch when lazy ExpertCache tensor
mapping was active. The warm-host experiments did not isolate that change from
automatic-fit removal, so the result applies to the combined configuration.

## Clean-session results

The Mac was rebooted before this sequence. Preflight recorded zero swap, AC
power, no thermal warnings, and no prior model inference process. The exact
model and runtime identities were verified, and the filtered native Metal
MXFP4 `MUL_MAT_ID` check passed.

| Gate | Result | Prompt | Decode | Peak process RSS | Peak swap | Minimum free memory |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| One token | Passed | 0.71 tok/s | Not meaningful at one token | 273 MB | 0 | 51% |
| Eight tokens | Passed | 0.75 tok/s | 0.87 tok/s | 321 MB | 256 KiB | 51% |
| Natural completion, 128-token cap | Passed, stopped naturally at 50 tokens | 0.75 tok/s | 0.72 tok/s | 289 MB | 256 KiB | 49% |

The final arm returned the exact requested content:
`ExpertCache baseline ready`. None of the watchdogs triggered, and every server
process exited normally.

The 2 GiB gate was not too restrictive for the successful path: peak swap in
the complete clean session was only 256 KiB. It remains useful because it
caught both the registered automatic-fit failure and a warm-host automatic-fit
recovery attempt before they could apply unbounded pressure.

## Warm-host configuration search

Warm engineering diagnostics selected the clean configuration:

- explicit placement stayed stable through a natural 50-token completion;
- grouped dispatch was effectively neutral; and
- one expert-prefetch thread raised peak process RSS to 7.56 GB and reduced
  prompt/decode throughput by roughly 37-39 percent, so it was rejected.

## Evidence boundary

This is evidence that the complete pinned checkpoint can execute on this
physical 16 GB host with the combined experimental configuration. It is not a
claim about the stock runtime, a physical 32 GB host, model quality, long-form
throughput, or multi-host reproducibility.

The required SHA-256 verification sequentially read the complete model before
the first inference, so the first gate began with zero swap and no prior model
inference but not an untouched file cache. The later gates inherited a
progressively warmer inference-driven cache. A second clean-boot repeat remains
required before describing the result as reproducible.

The machine-readable record is
`evidence/low-memory-16g-2026-07-31/clean-explicit-summary.json`. Raw reports
remain under `output/low-memory/`; the summary records SHA-256 digests for each
`baseline.json` and `llama-server.log`.
