# Provenance

ExpertCache was extracted from `amos-labs/amos-agent` at commit
`ec9e4de2` on 2026-07-31. The research sequence is preserved in the source
repository and includes:

- PR #37 — initial ExpertCache trace experiment;
- PR #38 — hardened experimental gates;
- PR #40 — mapped-page feasibility and the Phase 1 no-go;
- PR #41 — live direct-view runtime validation;
- PR #42 — latency ceilings and expert-grouped dispatch; and
- PR #43 — bit-exact async routed-union prefetch and the measured +70% prefill
  result.

The extraction moves only portable research code, tests, runtime patches,
public/synthetic harness material, and already committed evidence. It excludes
AMOS product routing, tenant data, credentials, policy, approvals, receipts,
and Desktop packaging.

Historical `amos.*` schema identifiers are intentionally unchanged. They are
artifact identifiers, not runtime dependencies.
