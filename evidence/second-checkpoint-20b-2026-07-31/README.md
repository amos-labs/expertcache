# GPT-OSS 20B second-checkpoint gate, 2026-07-31

This bundle preserves the clean-source four-arm portability gate for the
official GPT-OSS 20B MXFP4 checkpoint. The artifact was 12,109,566,624 bytes
with SHA-256
`27cd6c432c7672cb812a92f611cf3ba7bbc35928262bb1e1253ff4ee6ae35901`.
Every arm used final runtime patch
`6bb978ab189ded46b131edea81fbe0740d7d527797be553f91312e4704f76a63`
from clean source revision `ea82da9`.

## Outcome

- Stock, direct, grouped, and prefetch-6 all completed the public smoke suite.
- The frozen contract-v4 files score 6/7 because the business evaluator
  rejected the semantically correct spelling `sign‑ups`.
- The contract-v5 audit scores every unchanged response set 7/7.
- Direct, grouped, and prefetch-6 are identical after canonicalizing only the
  server-generated opaque tool-call ID.
- Stock and the custom paths differ canonically at response indices 1, 3, and
  4. The registered stock-equivalence gate therefore remains incomplete.
- All four arms recorded zero swap growth during their runs.

Strict hashes remain in every frozen report. The canonical hash does not
normalize model content, reasoning, tool name, tool arguments, order, or
formatting.

## Diagnostic timing

| Arm | Frozen score | v5 audit | Suite wall time | Reported generation rate |
| --- | --- | --- | --- | --- |
| stock | 6/7 | 7/7 | 40.7 s | 30.2 tok/s |
| direct | 6/7 | 7/7 | 200.9 s | 6.1 tok/s |
| grouped | 6/7 | 7/7 | 394.5 s | 3.0 tok/s |
| prefetch-6 | 6/7 | 7/7 | 220.5 s | 5.4 tok/s |

These sequential single-run timings are diagnostic, not a publication
comparison. They nevertheless establish the product routing direction: when a
checkpoint fits efficiently in stock residency, the optional ExpertCache path
should be bypassed.

`frozen-summary.json` retains the original failed all-to-stock criterion.
`contract-v5-audit.json` is a no-inference audit of the complete captured
responses; no frozen result was edited.
