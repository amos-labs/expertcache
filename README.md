# ExpertCache

ExpertCache is an experimental, page-aware Metal runtime and reproducibility
harness for running oversized sparse mixture-of-experts checkpoints on Apple
Silicon without binding or copying the complete expert tensor into the active
Metal working set.

The current artifact targets the official GPT-OSS 120B MXFP4 GGUF and a pinned
`llama.cpp` revision. It is research software, not a production inference
runtime and not an AMOS Desktop dependency.

## What has been demonstrated

On one 64 GiB Apple M1 Max system, the pinned artifact:

- executed the complete 63.4 GB GPT-OSS 120B MXFP4 checkpoint while avoiding
  catastrophic swap;
- preserved a targeted 3/3 hidden coding gate against hosted and copied local
  controls;
- exposed only selected expert ranges to Metal through page-aligned direct
  host-memory views;
- produced a bit-exact 1,128-token trajectory with grouped dispatch and async
  routed-union prefetch; and
- improved measured real-prompt prefill from 5.75 to 9.80 tokens/second (+70%)
  in the cited decision-grade A/B.

These are bounded results from one machine and one model. They do **not** show
frontier parity, general production readiness, universal model quality, or a
counterbalanced publication-grade performance result. Decode remained near
three tokens/second in the final gate and the full qualification suite has not
yet been rerun on the final milestone.

Read [the direct-view result](docs/EXPERT_CACHE_ZERO_COPY_RESULTS.md),
[latency ceilings and prefetch result](docs/EXPERT_CACHE_CEILING_RESULTS.md),
and [the failed mapped-page design](docs/PHASE_ONE_RESULTS.md) before quoting
the work.

## Repository map

- `runtime/` — pinned runtime manifest, `llama.cpp` patch, and native Metal
  probes.
- `harness/` — privacy-safe route capture, GGUF layout inspection, and mapped
  page replay.
- `src/` — architecture-neutral trace simulation and route-window analysis.
- `scripts/` — runtime preparation, benchmarks, ablations, and reports.
- `test/` — deterministic unit and replay tests.
- `evidence/` — committed, machine-readable decision-grade result bundles.
- `docs/REPRODUCIBILITY.md` — end-to-end experimental workflow.
- `paper/` — arXiv preparation gates and artifact plan.

## Quick validation

Requirements: Node.js 22 or newer and Python 3.11. The deterministic Node tests
have no package dependencies. The mapped-page replay tests require NumPy.

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r harness/requirements-replay.txt
npm test
npm run check
```

Preparing the live runtime clones the pinned `llama.cpp` revision, verifies the
patch digest, applies it, and builds the Metal binaries in
`~/.cache/expertcache/llama.cpp`:

```bash
npm run runtime:prepare
```

Model weights are not redistributed. Obtain the exact pinned model artifact
listed in [`runtime/runtime-manifest.json`](runtime/runtime-manifest.json),
verify its size and revision, and follow
[`docs/REPRODUCIBILITY.md`](docs/REPRODUCIBILITY.md).

## Relationship to AMOS

This work originated as an isolated experiment in
[`amos-labs/amos-agent`](https://github.com/amos-labs/amos-agent). The portable
runtime, harness, evidence, and tests now live here. AMOS keeps its product
routing, local-model qualification, company data, policy, approvals, receipts,
and deployment controls in the product repository. A future AMOS integration
should consume a versioned ExpertCache runtime as an optional backend; the
research repository must not depend on AMOS Desktop.

Historical machine-readable schemas retain their `amos.*` namespace so the
published evidence remains compatible with the original artifact.

## License and attribution

ExpertCache-authored code is Apache-2.0. The runtime patch applies to the
MIT-licensed `llama.cpp`; its license is preserved in
[`third_party/llama.cpp-LICENSE.txt`](third_party/llama.cpp-LICENSE.txt).
See [`NOTICE`](NOTICE) and [`PROVENANCE.md`](PROVENANCE.md).

## Citation

Use [`CITATION.cff`](CITATION.cff) for the software artifact. The arXiv paper
metadata will replace the provisional software citation after submission.
