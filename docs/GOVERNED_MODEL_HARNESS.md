# Governed model qualification and product harness

ExpertCache measures the model and the production system as related but
different objects. A safe deterministic control can improve AMOS product
behavior without proving that the model itself reasoned correctly. The public
evidence therefore keeps three result layers.

## Result layers

1. **Frozen raw-model result.** The response is scored by the evaluator and
   token budget recorded at run time. It is never overwritten.
2. **Versioned evaluator audit.** A captured response may be re-evaluated when
   an evaluator bug is fixed. The audit names both contracts, identifies the
   changed case, and preserves the original score.
3. **Governed-system outcome.** Deterministic authorization, approval, receipt,
   and output controls are evaluated separately. A system pass never adds
   points to the raw-model score.

This separation prevents two opposite errors: under-crediting a correct model
because of punctuation, and over-crediting a model for safety supplied by the
surrounding product.

## Current diagnostic matrix

These are single-run or targeted diagnostics from 2026-07-31, not a
counterbalanced publication-grade comparison. The complete sanitized reports
are in
[`evidence/qualification-controls-2026-07-31`](../evidence/qualification-controls-2026-07-31/).

| Route | Effort and cap | Frozen result | Interpretation |
| --- | --- | --- | --- |
| Local v5 GPT-OSS 120B | low, seed 42, 1,536 | 12/16, contract v3 | Tenant explanation and parked-approval wording failed. |
| Bedrock GPT-OSS 120B | low, seed 42, 1,536 | 12/16, contract v3 | Same two scenario failures; response bytes are not identical. |
| Bedrock GPT-OSS 120B | medium, seed 42, 1,536 | 16/16, contract v3 | Hosted control, not evidence that local medium must match. |
| Local v5 GPT-OSS 120B | medium, seed 42, 1,536 | 8/16, contract v3 | Tenant passed; dependent answer hit a formatting bug, approval wording failed, and coding ended at the token cap with empty final content. |
| Local v5 captured medium response | evaluator audit only | 11/16 under contract v4 | The dependent-tool answer correctly identified Playground-to-Sign‑up; only the evaluator changed. |
| Local v5 coding follow-up | medium, seed 42, 4,096 | 3/3, contract v4 | Capability diagnostic: 1,496 completion tokens, 629.5 s, executable tests passed. Not a full-run rescore. |

The matching low-effort scores and scenario failures are evidence of similar
behavior under the disclosed harness, not bit-exact inference. Hosted and
local providers can differ in templates, kernels, scheduling, and reasoning
implementation even when model family, seed, and requested effort match.

## Deterministic product controls

### Tenant isolation before inference

- Resolve organization and tenant from the authenticated connection.
- Expose only tools and credentials already scoped to that tenant.
- Reject or ignore user/model-supplied tenant selectors at the tool boundary.
- Return a typed scope result so the UI can explain the boundary without
  relying on free-form model prose.

The raw tenant scenario still measures whether the model explains the boundary
correctly. The product must remain isolated even when it does not.

### Approval state after inference

- Treat the signed receipt as the only authority on whether an action ran.
- Map `executed:false` plus `pending_approval` to a deterministic pending view.
- Never allow generated prose to promote pending work to created, launched,
  published, or completed.
- Resume from the receipt after approval rather than retrying a model-generated
  tool call blindly.

The raw parked-approval scenario still fails when a model says “has been
created.” The governed system can nevertheless render the truthful state.

### Reasoning and output budgeting

- Record requested reasoning effort, seed, token cap, finish reason, hidden
  reasoning token use where exposed, and final-content length.
- Reserve capacity for a final answer or use a provider-supported split budget.
- Detect `finish_reason=length` with empty final content as a typed controller
  failure, not a semantic model answer.
- Retry with a larger allowance only under a recorded policy and report the
  retry as a separate system result.
- Route latency-sensitive work to a resident model and reserve oversized
  medium/high reasoning for verification or escalation.

The 4,096-token coding follow-up demonstrates why this controller matters: the
same model and seed passed once it could finish, but took more than ten minutes
for one answer on the measured local runtime.

## Reporting rules

- Never merge points across separate runs into a single-run score.
- Never label deterministic authorization or receipt rendering as model
  intelligence.
- Never call hosted and local output bit-exact unless the captured bytes prove
  it.
- Report evaluator changes with old score, audited score, response hash, and
  the narrow semantic reason for the change.
- Report targeted retries beside, not in place of, the bounded full run.
