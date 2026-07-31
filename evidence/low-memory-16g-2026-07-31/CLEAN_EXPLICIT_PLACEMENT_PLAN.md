# Clean-session explicit-placement confirmation plan

This plan is an experimental recovery extension to
`docs/LOW_MEMORY_16G_RUNBOOK.md`. It does not rewrite the registered Stage 1
no-go. The registered automatic-fit run remains a valid failed result.

## Frozen runtime and configuration

- Source revision: `350677641c9f937d925adb77cc55c8286481fa45`
- Pinned llama.cpp revision: `7e1e28cae36d41fe7bbe9dae7c9625de6565c063`
- Registered runtime patch SHA-256:
  `0181578f465cb188ab4f34ba8a859b704a99cca5caa5bdec2d502ba3e48571b0`
- Experimental mmap-prefetch patch SHA-256:
  `41ecec081cb1fa61f34085b2bb38cefab7a889989f6386f0e12d8999a67eafb3`
- Experimental server launcher SHA-256:
  `5ee43d9a4f2c52ddfad7e566191e5539a94f901a4cc47549f8e7e8a3676366ff`
- Experimental runtime bundle SHA-256:
  `bb267e9ac5359977f1a52fde3d8dccf00a79d607fef0dee892e71f923b525710`

All confirmation arms use a 4,096-token context, batch 4, micro-batch 1,
128 ExpertCache slots, CPU fill, direct views, no warmup, automatic fit off,
and explicit `--gpu-layers all`. Grouped dispatch and expert prefetch remain
off. The watchdog retains its 2 GiB maximum swap growth, 3 percent minimum
free memory, and 1,800 second time limit.

The warm experiments did not isolate automatic-fit removal from whole-file
mmap-prefetch removal because an untouched registered binary was not retained.
The clean confirmation therefore validates the combined configuration only.

## Reboot handoff

1. Reboot the Mac once.
2. Log in with AC power attached and close nonessential applications.
3. Reopen this Codex task without launching another local model runtime.
4. Before inference, record swap, memory pressure, power, the model hash, the
   runtime bundle hash, and the filtered native Metal MXFP4 check.

Do not rebuild the runtime between reboot and the confirmation runs.

## Gate 1: clean-session one-token probe

Run the protected wrapper with `--no-fit --gpu-layers all` and an explicit
output directory. Stop and preserve the result if readiness fails, the
watchdog triggers, or swap growth exceeds 2 GiB.

Promotion criteria: server readiness, at least one completion token, no
watchdog, measurable swap telemetry, and no memory-pressure kill. A missing
content/reasoning timestamp is allowed at a one-token cap because the first
stream event can contain token accounting without visible text.

## Gate 2: same-session eight-token probe

Run only after reviewing Gate 1. Promotion criteria add a non-null first
content/reasoning token timestamp and valid prompt/decode timing separation.

## Gate 3: same-session natural-completion soak

Run only after reviewing Gate 2. Use the selected plain direct-view path with
a 128-token cap. The warm reference stopped naturally at 50 completion tokens
after producing `ExpertCache baseline ready`; the cap is a bound, not an
expected token count.

Promotion criteria add a natural successful completion, exact expected
content, valid prompt/decode timings, flat or bounded swap, and no watchdog.

## Evidence boundary

Gate 1 begins with zero swap and no prior model inference in the boot session,
but it is not an untouched file-cache observation: the runbook-required
SHA-256 verification sequentially reads the complete model before inference.
Gates 2 and 3 occur in the same clean boot session and inherit a progressively
warmer inference-driven file cache. The write-up must label those conditions
separately. One clean session can support a physical-16-GB execution claim for
the combined experimental configuration, but the runbook's second-clean-boot
step is still required before calling the result reproducible.
