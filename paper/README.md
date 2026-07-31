# arXiv preparation

The repository is ready to serve as the software artifact, but the current
measurements are not yet sufficient for a defensible systems paper submission.

Required publication gates:

1. cold and warm runs repeated at least three times with median and dispersion;
2. counterbalanced run ordering on a clean host;
3. at least one 32 GiB and one 64 GiB Apple Silicon system;
4. a second oversized sparse MoE checkpoint;
5. the frozen full quality suite and deterministic output-equivalence checks;
6. TTFT, prefill/decode throughput, RSS, compressed memory, swap, page faults,
   bytes touched, energy, and thermal measurements;
7. stock failure, copied slots, grouped copies, persistent cache, parallel
   staging, direct views, grouping, and prefetch ablations; and
8. a frozen release tag plus checksummed machine-readable artifact bundle.

The paper should lead with the narrow result: page-aligned direct expert views
can execute a checkpoint larger than the practical Metal working set while
preserving the targeted output gate. It should not claim production readiness,
frontier parity, or universal superiority.

Suggested working title:

> ExpertCache: Page-Aware Direct Expert Views for Oversized Sparse Models on
> Apple Silicon
