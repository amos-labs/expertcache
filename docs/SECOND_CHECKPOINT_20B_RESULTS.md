# GPT-OSS 20B portability result

The registered same-family control ran the official GPT-OSS 20B MXFP4
checkpoint through stock, direct-view, grouped, and prefetch-6 arms on the
final v5 runtime. All arms completed without watchdog failure or swap growth.

This closes the execution portion of the portability study but not its
stock-equivalence criterion. Under contract v5, every captured response set
scores 7/7, and direct/grouped/prefetch are canonical-hash equivalent. Stock
differs from all custom paths at three of six response records, even after
removing only opaque tool-call IDs. The source of that custom-kernel trajectory
drift was then narrowed with a cache-disabled token-probability diagnostic.

Two stock repetitions produced the same 265-token message, and two direct-path
repetitions produced the same 248-token message. The paths shared their first
179 generated tokens. At token 179, stock preferred ` sentence` over ` bott`
by 0.01444 log-prob while direct preferred ` bott` over ` sentence` by only
0.00036 log-prob. The largest selected-token log-prob delta anywhere in the
shared prefix was 0.01192. Both resulting answers pass the semantic evaluator.
This is consistent with a small numerical perturbation flipping a near-tied
token; it is not, by itself, proof of whole-kernel numerical equivalence.

The result narrows the boundary in two useful ways:

1. Grouping and prefetch add no response drift beyond the direct path on this
   checkpoint.
2. Stock is materially faster when the whole 20B checkpoint fits, so a
   production task/runtime router should not activate ExpertCache merely
   because it is available.
3. Greedy response hashes are too brittle to be the only kernel-equivalence
   criterion. The remaining gate is a registered teacher-forced logit test
   with explicit absolute and relative tolerances, reported alongside exact
   and semantic results.

The complete sanitized reports and versioned audit are in
[`evidence/second-checkpoint-20b-2026-07-31`](../evidence/second-checkpoint-20b-2026-07-31/).
This is same-family checkpoint-size evidence, not a second architecture or a
second oversized checkpoint.
